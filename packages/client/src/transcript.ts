import { EVENT_TYPES } from '@openharness/protocol'
import type {
  ImmutableAgentMessageEvent,
  ImmutableModelRequestStartEvent,
  ImmutableStoredEvent,
  ImmutableStreamEvent,
  ImmutableUserMessageEvent,
  RetryStatusType,
  SessionErrorType,
  SessionStatus,
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
 * Messages are keyed by the `sevt_` id of the event that wrote them, and every message has a
 * sort position ({@link TranscriptMessage.position}). A preview and the reply it previews
 * share an id, so the reply replaces the preview — wherever the client picked the reply up —
 * and sorts where the reply started. A message a client never saw the preview of (a reload,
 * a join mid-reply, a log whose chunks were already superseded) still sorts in the same place:
 * the `supersedes` range the stored event carries says where its chunks were. The whole
 * conversation therefore renders identically however much of a reply a client witnessed.
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
   * queued while a turn was running — the `consumes` list on the next model request, or a
   * request starting at all on a server too old to write one, is what says the queue has been
   * picked up.
   */
  readonly pending: boolean
  /** An `agent.message` being previewed by `event_delta`s, not yet stored. */
  readonly streaming: boolean
  /**
   * Where the message sorts, in the log's own numbering. `messages` is kept in this order.
   *
   * A stored message sits at its `seq` — a finished reply at the `from_seq` of the chunk
   * range it supersedes, which is where the reply started — and a stream-only preview (a
   * server from before D9, whose chunks carry no `seq`) just after the last stored event, so
   * today's placement of a streaming bubble is unchanged. See {@link reduceTranscript}.
   */
  readonly position: number
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
  /** The conversation, in order (`position`). */
  readonly messages: readonly TranscriptMessage[]
  /** Whether the agent is working. */
  readonly status: SessionStatus
  /** The most recent `session.error`, until a reply supersedes it. */
  readonly lastError: TranscriptError | null
  /**
   * The `seq` of the last stored event the transcript has seen.
   *
   * Feed it back as `afterSeq` when reconnecting: it is exactly where the transcript got to.
   * Stored chunks carry a `seq` like any other event, so a client that disconnects mid-reply
   * resumes mid-reply.
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
 * Pure: the state that comes back is a new object, and the one that went in is untouched — an
 * incoming event is only ever read, never written — so a framework can compare states by
 * reference and a caller can hand over a shared, frozen event.
 *
 * Stored events are idempotent — an event at or below `state.lastSeq` is dropped — which is
 * what lets history and a resumed stream overlap without doubling a message. Since D9 the
 * streamed chunks of a reply are stored events too (`event_start` / `event_delta` with a
 * `seq`), so they take the same path: they are deduplicated by `seq`, they advance `lastSeq`,
 * and a client that resumes mid-reply gets the rest of the chunks rather than skipping them.
 * Stream-only previews (a server from before D9) have no `seq` and are always applied.
 *
 * The rules, in one place:
 *
 * - **A delta appends to its message's preview**, creating the preview if the client missed
 *   (`event_delta` carries the id of the message being previewed — stored or stream-only). A
 *   delta for a message that is already stored is ignored: the stored event is the record.
 * - **A stored `agent.message` replaces whatever the transcript holds for its id** — a whole
 *   preview, a partial one, or nothing at all. It never merges.
 * - **A stored preview sits where its chunks started**: at its `event_start`'s `seq`, or at
 *   its first delta's `seq` when the start was skipped (a client that joined mid-reply).
 * - **A stream-only preview sits after everything stored so far** (`lastSeq + 0.5`): with no
 *   `seq` of its own, the place its bubble opened is the only position it can claim, and
 *   keeping it there is what today's servers already do.
 * - **A finished reply sits where it started.** An `agent.message` that carries `supersedes`
 *   sorts at `from_seq`, whether or not the client saw the chunks, so a steer sent mid-reply
 *   stays behind the reply in every view. A reply with no range keeps the position of the
 *   preview it replaces — where the old server's bubble opened — or, with no preview to
 *   replace, its own `seq`.
 * - **Unfinished previews are dropped when the turn moves on**: `span.model_request_end` and
 *   `session.status_idle` discard previews still streaming (#40), which since D9 includes the
 *   previews of a chunk range a span end supersedes. An interrupt is not this case: its
 *   partial reply is stored as an `agent.message` before the span closes.
 *
 * @param state the transcript so far
 * @param event the next event, from `iterate`, `stream`, or anywhere else
 */
export function reduceTranscript(
  state: TranscriptState,
  event: ImmutableStreamEvent,
): TranscriptState {
  // The `typeof` check is not redundant for a caller that feeds this reducer raw events: a
  // newer server's stream-only event type carries no `seq`, and without the check it would
  // arrive with `seq: undefined` and move `lastSeq` to nowhere.
  if (isStored(event) && typeof event.seq === 'number') {
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
      return startPreview(state, event.event.id, previewPosition(state))
    case EVENT_TYPES.eventDelta:
      return appendDelta(
        state,
        event.event_id,
        event.delta.index,
        event.delta.content.text,
        previewPosition(state),
      )
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
  events: Iterable<ImmutableStreamEvent>,
): TranscriptState {
  let next = state
  for (const event of events) {
    next = reduceTranscript(next, event)
  }
  return next
}

/** The stored-event half of {@link reduceTranscript}. */
function reduceStoredEvent(state: TranscriptState, event: ImmutableStoredEvent): TranscriptState {
  switch (event.type) {
    case EVENT_TYPES.userMessage:
      return upsertMessage(state, messageFromUserEvent(event))

    case EVENT_TYPES.agentMessage:
      return {
        ...upsertMessage(state, messageFromAgentEvent(event, agentMessagePosition(state, event))),
        lastError: null,
      }

    case EVENT_TYPES.userInterrupt:
      // An interrupt is not something anyone said: it cuts a reply short, and what is left of
      // that reply arrives as an `agent.message` right behind it.
      return state

    case EVENT_TYPES.eventStart:
      // The stored form of a preview (D9): the reply's chunks are log events, so a client
      // that resumes mid-reply meets them here rather than as stream-only previews. The
      // preview opens where the reply started — this event's `seq`.
      return startPreview(state, event.event.id, event.seq)

    case EVENT_TYPES.eventDelta:
      return appendDelta(
        state,
        event.event_id,
        event.delta.index,
        event.delta.content.text,
        event.seq,
      )

    case EVENT_TYPES.sessionStatusRunning:
    case EVENT_TYPES.sessionStatusRescheduled:
      // A rescheduled session is retrying, which is not idle: only `status_idle` is.
      return { ...state, status: 'running' }

    case EVENT_TYPES.sessionStatusIdle:
      // A turn that has ended cannot have a reply still streaming: the stored `agent.message`
      // precedes this, so a preview still open is one nothing will ever replace. That is the
      // same statement as the span end below, and it is the backstop for the case where the
      // span end never arrived at all — a stored event this client cannot parse is skipped
      // (`events/stream.ts`), and a preview no longer watched by anything would otherwise stay
      // streaming for the life of the session, drawing an empty bubble in a frontend that
      // renders it (#40).
      return { ...state, status: 'idle', messages: withoutPreviews(state.messages) }

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
      // The brain folds every queued user message into the request it is about to make, and
      // since D9 the request says which ones: its `consumes` list. That is where "queued"
      // becomes "delivered" — a message sent while the turn was running stays pending until
      // the request that claims it. A span start with no list at all is a server from before
      // the claims existed, and keeps the older reading: everything pending when a request
      // starts has just been picked up.
      return {
        ...state,
        messages: state.messages.map((message) =>
          isClaimed(event, message) ? { ...message, pending: false } : message,
        ),
      }

    case EVENT_TYPES.modelRequestEnd:
      // A preview that was never replaced by its stored event belongs to a request that
      // failed, was interrupted before a reply could be stored, or was closed by a recovering
      // brain; there is nothing to keep. (A reconciled preview is no longer `streaming`, so
      // it survives.) A span end that carries `supersedes` says the same about a specific
      // range — the previews of the chunks it replaces sit inside it — and those previews are
      // streaming, so this is the rule that drops them.
      return { ...state, messages: withoutPreviews(state.messages) }

    default:
      return state
  }
}

/**
 * Whether a stream event was persisted.
 *
 * The protocol's `isStoredEvent` answers the same question for a mutable event; this is the
 * deep-readonly spelling of it (`readonly T[]` is not assignable to `T[]`, so a caller that
 * types its events with the `Immutable*` aliases cannot reuse the predicate directly). `seq`
 * is the test, not the type: since D9 a stored chunk and a stream-only preview share one.
 */
function isStored(event: ImmutableStreamEvent): event is ImmutableStoredEvent {
  return 'seq' in event
}

/**
 * Whether this model request reaches `message`: the `consumes` list it claims, or — with no
 * list, on a server from before D9 — everything still pending.
 */
function isClaimed(event: ImmutableModelRequestStartEvent, message: TranscriptMessage): boolean {
  if (!message.pending) {
    return false
  }
  if (event.consumes === undefined) {
    return true
  }
  return event.consumes.some((id) => id === message.id)
}

/**
 * The messages that outlive a reply that is not coming: everything that is not still a preview.
 *
 * A preview the log never reconciled has no text anyone stored, so there is nothing to keep —
 * what it stood in for did not happen.
 */
function withoutPreviews(messages: readonly TranscriptMessage[]): readonly TranscriptMessage[] {
  return messages.filter((message) => !message.streaming)
}

/** The transcript message for a stored `user.message`. */
function messageFromUserEvent(event: ImmutableUserMessageEvent): TranscriptMessage {
  const blocks = event.content.map((block) => block.text)
  return {
    id: event.id,
    role: 'user',
    blocks,
    text: blocks.join(''),
    pending: event.processed_at === null,
    streaming: false,
    position: event.seq,
  }
}

/** The transcript message for a stored `agent.message`, reconciled with any preview of it. */
function messageFromAgentEvent(
  event: ImmutableAgentMessageEvent,
  position: number,
): TranscriptMessage {
  const blocks = event.content.map((block) => block.text)
  return {
    id: event.id,
    role: 'agent',
    blocks,
    text: blocks.join(''),
    pending: false,
    streaming: false,
    position,
  }
}

/**
 * Where a stored `agent.message` sorts.
 *
 * `supersedes.from_seq` when it carries the range: that is where the reply started, whatever
 * the client saw of its chunks — a client that joined mid-reply, one whose chunks were
 * deleted, and one that watched every delta all sort the reply identically (D9). With no
 * range — a server from before D9, or a reply whose chunks were never stored — it keeps the
 * position of the preview it replaces, where the bubble opened; and a message that replaces
 * nothing lands at its own `seq`.
 */
function agentMessagePosition(state: TranscriptState, event: ImmutableAgentMessageEvent): number {
  if (event.supersedes !== undefined) {
    return event.supersedes.from_seq
  }
  return state.messages.find((message) => message.id === event.id)?.position ?? event.seq
}

/**
 * The position of a stream-only preview: just after everything stored so far.
 *
 * A preview from a server that stores none of its chunks has no `seq` to sit at, so the only
 * place it can claim is the one its bubble opens at — after every stored event the client has
 * seen. `lastSeq + 0.5` is that place in the log's own numbering: a stored event that follows
 * still sorts after it, and today's servers, which place the bubble when its preview starts,
 * render exactly as before.
 */
function previewPosition(state: TranscriptState): number {
  return state.lastSeq + 0.5
}

/**
 * Open the preview of `id` at `position`, unless a message with that id is already final.
 */
function startPreview(state: TranscriptState, id: string, position: number): TranscriptState {
  // A preview may only touch a message that is still being previewed: once the stored event
  // has landed, it is the record, and a late preview cannot rewrite it.
  return isPreviewable(state, id) ? upsertMessage(state, emptyPreview(id, position)) : state
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
function emptyPreview(id: string, position: number): TranscriptMessage {
  return { id, role: 'agent', blocks: [], text: '', pending: false, streaming: true, position }
}

/**
 * Put `message` in the transcript: replacing the message with the same id, or inserting it
 * among the others by position.
 *
 * Replacing is what reconciles a preview with the stored event that supersedes it, and what
 * makes a re-delivered event a no-op rather than a duplicate. `messages` stays sorted by
 * position, so a stored reply that carries `supersedes` moves back to where it started —
 * ahead of a steering message it was interleaved with — and every client renders the same
 * conversation whether it followed the reply's chunks or joined afterwards.
 */
function upsertMessage(state: TranscriptState, message: TranscriptMessage): TranscriptState {
  const existing = state.messages.find((candidate) => candidate.id === message.id)
  if (existing !== undefined && isSameMessage(existing, message)) {
    return state
  }
  const rest = state.messages.filter((candidate) => candidate.id !== message.id)
  const index = rest.findIndex((candidate) => candidate.position > message.position)
  const messages =
    index === -1 ? [...rest, message] : [...rest.slice(0, index), message, ...rest.slice(index)]
  return { ...state, messages }
}

/** Whether an upsert would change nothing, so the state can keep its identity. */
function isSameMessage(current: TranscriptMessage | undefined, next: TranscriptMessage): boolean {
  return (
    current !== undefined &&
    current.text === next.text &&
    current.pending === next.pending &&
    current.streaming === next.streaming &&
    current.position === next.position &&
    current.role === next.role
  )
}

/**
 * Extend a preview with a delta.
 *
 * Deltas carry the index of the content block they extend, so they accumulate per index and
 * `text` is the blocks in order — the same string the stored event will carry once it
 * replaces the preview. A delta for an event whose `event_start` was missed (a connection
 * that opened mid-reply) still lands: it opens the preview itself, at `createPosition` —
 * the delta's own `seq` for a stored chunk, just after the log for a stream-only one. A delta
 * for a message that is already stored changes nothing.
 *
 * @param state the transcript so far
 * @param eventId the id of the event being previewed
 * @param index the content block the delta extends
 * @param text the fragment to append
 * @param createPosition where to open the preview, if there is none yet
 */
function appendDelta(
  state: TranscriptState,
  eventId: string,
  index: number,
  text: string,
  createPosition: number,
): TranscriptState {
  if (!isPreviewable(state, eventId)) {
    return state
  }
  const current =
    state.messages.find((message) => message.id === eventId) ??
    emptyPreview(eventId, createPosition)
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
  apply(event: ImmutableStreamEvent): TranscriptState

  /** Fold a sequence in — history, or a batch of stream events — and return the new state. */
  applyAll(events: Iterable<ImmutableStreamEvent>): TranscriptState

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
