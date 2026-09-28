import { EVENT_TYPES, isStoredEvent } from '@openharness/protocol'
import type {
  AgentMessageEvent,
  RetryStatusType,
  SessionErrorType,
  SessionStatus,
  StoredEvent,
  StreamEvent,
  UserMessageEvent,
} from '@openharness/protocol'

/**
 * The transcript: session events in, UI state out.
 *
 * One pure reducer, shared by the web app and the TUI, so the two render the same conversation
 * from the same events. It is written for a live stream but reads history just as well — a
 * reload loads the log with `sessions.events.list` and feeds it through the same function, then
 * continues from `lastSeq`:
 *
 * ```ts
 * const transcript = createTranscript()
 * for await (const event of client.sessions.events.iterate(sessionId)) transcript.apply(event)
 * for await (const event of client.sessions.events.stream(sessionId, { deltas: true, afterSeq: transcript.getState().lastSeq })) {
 *   transcript.apply(event)
 * }
 * ```
 *
 * The state is plain data — arrays, strings, numbers — so a framework can hold it in a store,
 * snapshot it, or send it to a devtool. Nothing here knows about React.
 */

/**
 * One message in the transcript.
 *
 * User and agent messages look the same on purpose: a UI renders a list, not two lists.
 */
export interface TranscriptMessage {
  /** The `sevt_` id of the event. A preview is identified by the event it previews. */
  readonly id: string
  /** Who said it. */
  readonly role: 'user' | 'agent'
  /** The message's text: the blocks below, joined. What a UI shows. */
  readonly text: string
  /** The content blocks as they have arrived; `text` is `blocks.join('')`. */
  readonly blocks: readonly string[]
  /**
   * A user message the brain has not reached yet.
   *
   * True while the stored event's `processed_at` is `null`, and also for a message that was
   * queued while a turn was running — the events that follow a model request starting are
   * what say the queue has been picked up.
   */
  readonly pending: boolean
  /** An `agent.message` being previewed by `event_delta`s, not yet stored. */
  readonly streaming: boolean
}

/** The latest `session.error`, as the UI shows it. */
export interface TranscriptError {
  /** The error kind, e.g. `model_overloaded_error`. */
  readonly type: SessionErrorType
  /** The server's human-readable message. */
  readonly message: string
  /** What the server is doing about it: `retrying`, `exhausted` or `terminal`. */
  readonly retryStatus: RetryStatusType
}

/** Everything a UI needs to render a session. */
export interface TranscriptState {
  /** The conversation, in order. */
  readonly messages: readonly TranscriptMessage[]
  /** Whether the agent is working. */
  readonly status: SessionStatus
  /** The most recent `session.error`, until a reply supersedes it. */
  readonly lastError: TranscriptError | null
  /**
   * The `seq` of the last stored event the transcript has seen.
   *
   * Feed it back as `afterSeq` when reconnecting: it is exactly where the transcript got to.
   */
  readonly lastSeq: number
}

/**
 * The state for a session with no events yet.
 *
 * `lastSeq` is `0`, the protocol's "from the start": passing it as `afterSeq` replays the
 * whole log.
 */
export function initialTranscriptState(): TranscriptState {
  return { messages: [], status: 'idle', lastError: null, lastSeq: 0 }
}

/**
 * Fold one event into the transcript.
 *
 * Pure: the state that comes back is a new object, and the one that went in is untouched, so
 * a framework can compare them by reference.
 *
 * Stored events are idempotent — an event at or below `state.lastSeq` is dropped — which is
 * what lets history and a resumed stream overlap without doubling a message. Stream-only
 * previews have no `seq` and are always applied.
 *
 * @param state the transcript so far
 * @param event the next event, from `iterate`, `stream`, or anywhere else
 */
export function reduceTranscript(state: TranscriptState, event: StreamEvent): TranscriptState {
  // The `typeof` check is not redundant for a caller that feeds this reducer raw events: a
  // newer server's stream-only event type carries no `seq`, and without the check it would
  // arrive with `seq: undefined` and move `lastSeq` to nowhere.
  if (isStoredEvent(event) && typeof event.seq === 'number') {
    if (event.seq <= state.lastSeq) {
      // Already folded in: a resumed stream replaying from before where we got to, or the
      // same history loaded twice.
      return state
    }
    const reduced = reduceStoredEvent(state, event)
    return { ...reduced, lastSeq: event.seq }
  }

  switch (event.type) {
    case EVENT_TYPES.eventStart:
      // A preview may only touch a message that is still being previewed: once the stored
      // event has landed, it is the record, and a late preview cannot rewrite it.
      return isPreviewable(state, event.event.id)
        ? upsertMessage(state, emptyPreview(event.event.id))
        : state
    case EVENT_TYPES.eventDelta:
      return isPreviewable(state, event.event_id)
        ? appendDelta(state, event.event_id, event.delta.index, event.delta.content.text)
        : state
    default:
      // Unreachable for a value that came from the protocol's schemas; a hand-built event
      // could still land here, and dropping it beats crashing a UI.
      return state
  }
}

/**
 * Fold a whole sequence into the transcript: history, or every event of a stream.
 *
 * @param state the transcript so far
 * @param events the events, in order
 */
export function reduceTranscriptAll(
  state: TranscriptState,
  events: Iterable<StreamEvent>,
): TranscriptState {
  let next = state
  for (const event of events) {
    next = reduceTranscript(next, event)
  }
  return next
}

/** The stored-event half of {@link reduceTranscript}. */
function reduceStoredEvent(state: TranscriptState, event: StoredEvent): TranscriptState {
  switch (event.type) {
    case EVENT_TYPES.userMessage:
      return upsertMessage(state, messageFromUserEvent(event))

    case EVENT_TYPES.agentMessage:
      return { ...upsertMessage(state, messageFromAgentEvent(event)), lastError: null }

    case EVENT_TYPES.userInterrupt:
      // An interrupt is not something anyone said: it cuts a reply short, and what is left of
      // that reply arrives as an `agent.message` right behind it.
      return state

    case EVENT_TYPES.sessionStatusRunning:
    case EVENT_TYPES.sessionStatusRescheduled:
      // A rescheduled session is retrying, which is not idle: only `status_idle` is.
      return { ...state, status: 'running' }

    case EVENT_TYPES.sessionStatusIdle:
      return { ...state, status: 'idle' }

    case EVENT_TYPES.sessionError:
      return {
        ...state,
        lastError: {
          type: event.error.type,
          message: event.error.message,
          retryStatus: event.error.retry_status.type,
        },
      }

    case EVENT_TYPES.modelRequestStart:
      // The brain folds every queued user message into the request it is about to make, so a
      // message that is still pending when a request starts has just been picked up. The log
      // never says so explicitly — the stored event keeps its `processed_at: null` — so this
      // is where "queued" becomes "delivered".
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.pending ? { ...message, pending: false } : message,
        ),
      }

    case EVENT_TYPES.modelRequestEnd:
      // A preview that was never replaced by its stored event belongs to a request that
      // failed or was interrupted before the reply could be written; there is nothing to
      // keep. (A reconciled preview is no longer `streaming`, so it survives.)
      return {
        ...state,
        messages: state.messages.filter((message) => !message.streaming),
      }

    default:
      return state
  }
}

/** The transcript message for a stored `user.message`. */
function messageFromUserEvent(event: UserMessageEvent): TranscriptMessage {
  const blocks = event.content.map((block) => block.text)
  return {
    id: event.id,
    role: 'user',
    blocks,
    text: blocks.join(''),
    pending: event.processed_at === null,
    streaming: false,
  }
}

/** The transcript message for a stored `agent.message`, reconciled with any preview of it. */
function messageFromAgentEvent(event: AgentMessageEvent): TranscriptMessage {
  const blocks = event.content.map((block) => block.text)
  return {
    id: event.id,
    role: 'agent',
    blocks,
    text: blocks.join(''),
    pending: false,
    streaming: false,
  }
}

/**
 * Whether a preview may still write to the message `id`.
 *
 * True when nothing carries that id yet, or when what does is itself still a preview.
 */
function isPreviewable(state: TranscriptState, id: string): boolean {
  const existing = state.messages.find((message) => message.id === id)
  return existing === undefined || existing.streaming
}

/** A preview of `id` with no text yet, so a UI can show that the reply has started. */
function emptyPreview(id: string): TranscriptMessage {
  return { id, role: 'agent', blocks: [], text: '', pending: false, streaming: true }
}

/**
 * Put `message` in the transcript: replacing the message with the same id, or appending it.
 *
 * Replacing is what reconciles a preview with the stored event that supersedes it, and what
 * makes a re-delivered event a no-op rather than a duplicate. Position is preserved, so a
 * reply does not jump to the end of the conversation when it is stored.
 */
function upsertMessage(state: TranscriptState, message: TranscriptMessage): TranscriptState {
  const index = state.messages.findIndex((candidate) => candidate.id === message.id)
  if (index === -1) {
    return { ...state, messages: [...state.messages, message] }
  }
  if (isSameMessage(state.messages[index], message)) {
    return state
  }
  const messages = state.messages.slice()
  messages[index] = message
  return { ...state, messages }
}

/** Whether an upsert would change nothing, so the state can keep its identity. */
function isSameMessage(current: TranscriptMessage | undefined, next: TranscriptMessage): boolean {
  return (
    current !== undefined &&
    current.text === next.text &&
    current.pending === next.pending &&
    current.streaming === next.streaming &&
    current.role === next.role
  )
}

/**
 * Extend a preview with a delta.
 *
 * Deltas carry the index of the content block they extend, so they accumulate per index and
 * `text` is the blocks in order — the same string the stored event will carry once it
 * replaces the preview. A delta for an event whose `event_start` was missed (a connection
 * that opened mid-reply) still lands, as an empty-preview-turned-message.
 *
 * @param state the transcript so far
 * @param eventId the id of the event being previewed
 * @param index the content block the delta extends
 * @param text the fragment to append
 */
function appendDelta(
  state: TranscriptState,
  eventId: string,
  index: number,
  text: string,
): TranscriptState {
  const current = state.messages.find((message) => message.id === eventId) ?? emptyPreview(eventId)
  const blocks = current.blocks.slice()
  blocks[index] = (blocks[index] ?? '') + text
  return upsertMessage(state, {
    ...current,
    blocks,
    text: blocks.join(''),
    streaming: true,
  })
}

/** The messages, in order. */
export function selectMessages(state: TranscriptState): readonly TranscriptMessage[] {
  return state.messages
}

/** Whether the agent is working. */
export function selectIsRunning(state: TranscriptState): boolean {
  return state.status === 'running'
}

/** The last message, or `null` in an empty transcript. */
export function selectLastMessage(state: TranscriptState): TranscriptMessage | null {
  return state.messages.at(-1) ?? null
}

/** The `agent.message` being previewed right now, or `null`. */
export function selectStreamingMessage(state: TranscriptState): TranscriptMessage | null {
  return state.messages.find((message) => message.streaming) ?? null
}

/** The stateful wrapper {@link createTranscript} hands out. */
export interface Transcript {
  /** The current state. Stable between changes, so a framework can compare by reference. */
  getState(): TranscriptState

  /** Fold one event in, notify subscribers, and return the new state. */
  apply(event: StreamEvent): TranscriptState

  /** Fold a sequence in — history, or a batch of stream events — and return the new state. */
  applyAll(events: Iterable<StreamEvent>): TranscriptState

  /** Start over from {@link initialTranscriptState}, notifying subscribers. */
  reset(): TranscriptState

  /**
   * Watch the state.
   *
   * Framework-free, and shaped for the ones that ask for this: React's
   * `useSyncExternalStore(subscribe, getState)` takes exactly this pair.
   *
   * @param listener called with the new state after every change
   * @returns unsubscribe
   */
  subscribe(listener: (state: TranscriptState) => void): () => void
}

/**
 * Create a transcript store.
 *
 * The reducer functions are exported on their own for callers that would rather hold the
 * state themselves (a reducer in a framework, a test asserting on one event); this is the
 * wrapper that keeps it.
 *
 * @param initial starting state; defaults to {@link initialTranscriptState}
 */
export function createTranscript(initial: TranscriptState = initialTranscriptState()): Transcript {
  let state = initial
  const listeners = new Set<(state: TranscriptState) => void>()

  const setState = (next: TranscriptState): TranscriptState => {
    state = next
    for (const listener of listeners) {
      listener(state)
    }
    return state
  }

  return {
    getState: () => state,
    apply: (event) => setState(reduceTranscript(state, event)),
    applyAll: (events) => setState(reduceTranscriptAll(state, events)),
    reset: () => setState(initialTranscriptState()),
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
