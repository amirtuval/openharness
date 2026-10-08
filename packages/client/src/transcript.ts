import { EVENT_TYPES } from '@openharness/protocol'
import type {
  AgentMessageEvent,
  ModelRequestEndEvent,
  ModelRequestStartEvent,
  ModelUsage,
  StreamEvent,
  StoredEvent,
  UserMessageEvent,
  RetryStatusType,
  SessionErrorType,
  SessionRewindEvent,
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
 * sort position ({@link TranscriptMessage.position}). A reply's chunks and the reply itself
 * share an id, so the reply replaces the accumulated chunks — wherever the client picked the
 * reply up — and sorts where the reply started. A message a client never saw the chunks of (a
 * reload, a join mid-reply, a log whose chunks were already superseded) still sorts in the
 * same place: the `supersedes` range the stored reply carries says where its chunks were. The
 * whole conversation therefore renders identically however much of a reply a client witnessed.
 *
 * The state is plain data — arrays, strings, numbers — so a framework can hold it in a store,
 * snapshot it, or send it to a devtool. Nothing here knows about React.
 */

/**
 * A message's text — the one part type v1 stores (epic #201, X1).
 *
 * A user message carries one per content block, the agent's reply one per block it produced
 * and a streaming preview one per block its deltas extend.
 */
export interface TextPart {
  readonly type: 'text'
  /** The text of this part. */
  readonly text: string
}

/**
 * One part of a message (epic #201, X1).
 *
 * A discriminated union on `type`. A frontend renders {@link TranscriptMessage.parts} through
 * a lookup from `type` to a renderer, so a new kind of part is a new member here and a new
 * entry there — never a change to how a message is laid out.
 *
 * Only `text` is implemented today. The members the next phases add, in the shape the epic
 * agreed, are:
 *
 * - `thinking` — the model's reasoning;
 * - `tool_use` — a tool call the agent made;
 * - `tool_result` — what a tool answered;
 * - `question` — an `ask_user` question waiting for the user;
 * - `approval` — a tool call waiting for the user's approval.
 *
 * They are named here and deliberately not implemented: the protocol has no event for them
 * yet, and the union is what they extend when it does. A message's `text` stays the
 * concatenation of its text parts, so a caller that only wants the words keeps working.
 */
export type MessagePart = TextPart

/**
 * The tokens a reply used, summed over the model requests it took (epic #201, U1).
 *
 * `total` is `input + output`: the two numbers a reader thinks in. The protocol's `ModelUsage`
 * also carries the cache creation and cache read counts; a reply's headline cost is not them,
 * and the log itself is where a caller that wants them reads them.
 */
export interface TranscriptUsage {
  readonly input: number
  readonly output: number
  readonly total: number
}

/**
 * What a reply cost, read off the turn's span events (epic #201, X1).
 *
 * A field is **absent when the log does not say — never `0`**. A log with no span events at
 * all (a pre-#201 session, a session whose request never opened a span) leaves the whole
 * `meta` off the message; a request whose span start named no model leaves `model` off; a
 * request whose span end never arrived leaves `durationMs` and `usage` off. `0` is a number a
 * model really did report, and a UI must be able to tell that from "unknown".
 */
export interface TranscriptMessageMeta {
  /** The model that served the reply: the last one the turn's requests named. */
  readonly model?: string
  /**
   * How long the reply took, in milliseconds: the turn's first request start to its last
   * request end.
   *
   * A retried reply therefore reports the time a reader actually waited — the failed attempt,
   * the backoff between the two requests and the retry — not just the request that answered.
   */
  readonly durationMs?: number
  /** The tokens the reply's requests reported, summed. */
  readonly usage?: TranscriptUsage
}

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
  /** The message's text: its text parts, joined. What a UI shows. */
  readonly text: string
  /** The message's content, as it has arrived. `text` is this list's text parts, joined. */
  readonly parts: readonly MessagePart[]
  /**
   * What the reply cost, when the log says (epic #201, U1). Agent messages only.
   *
   * Built from the turn's `span.model_request_start` / `span.model_request_end` events: the
   * span start names the model, the span end the tokens, and the two timestamps the duration.
   * A reply that took several requests (the brain retried) adds them all up, which is why a
   * reply's metadata arrives with the *last* span end — see {@link TranscriptState.pendingRequests}.
   */
  readonly meta?: TranscriptMessageMeta
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
   * Everything is a stored event since P4, so every position is a real `seq`: a user message
   * at its own, a reply at the `from_seq` of the chunk range it supersedes — which is where
   * the reply started — and a reply whose chunks were never stored (a log from before D9) at
   * its own `seq`, or at the position of the preview it replaces. See
   * {@link reduceTranscript}.
   */
  readonly position: number
  /**
   * The model this message switched the session to, when it switched one (epic #116, U1).
   *
   * A `user.message` carrying a `model` whose id differs from the model the log last said
   * switches the session, and a UI renders this message as the marker. The **first** model a
   * message carries is not a change — {@link TranscriptState.model} is `null` until then, and
   * the message sets it silently — and a message naming the model already in effect is not a
   * change either. Absent on every other message.
   */
  readonly modelChangedTo?: string
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

/**
 * One model request the transcript is still accounting for (epic #201, U1).
 *
 * Bookkeeping for {@link TranscriptMessage.meta}, not something a UI renders. A
 * `span.model_request_start` opens one — the model it named, when it started — and its
 * `span.model_request_end` closes it with the tokens it used and when it ended. The reply the
 * requests produced takes them all as its metadata; a request that produced no reply (a failed
 * attempt the brain retried) stays here until the reply that follows picks it up, which is
 * what makes a retried reply's tokens add up. Each one is erased as it is used: once its end
 * has been folded into its reply, and all of them when the turn ends.
 */
export interface PendingModelRequest {
  /** The `sevt_` id of the `span.model_request_start`. */
  readonly id: string
  /** The `provider/model` the span named that served the request; a pre-D9 span names none. */
  readonly model?: string
  /** When the request started, in epoch milliseconds, from the span's `processed_at`. */
  readonly startedAt?: number
  /** When it ended, in epoch milliseconds, from the span end's `processed_at`. */
  readonly endedAt?: number
  /** The tokens it reported, as {@link TranscriptMessageMeta.usage} sums them. */
  readonly usage?: TranscriptUsage
  /** The reply the request has been attributed to, once one has been stored. */
  readonly messageId?: string
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
  /**
   * Whether the session was deleted (#111, epic #116 U5).
   *
   * A `session.deleted` event — the stream-only last event of a deleted session — sets this
   * once and for all: it is a terminal end state a UI can react to (close the view, stop
   * offering to send) rather than the end of an iteration. A log read back from the server
   * never carries the event, because deletion removes the log.
   */
  readonly deleted: boolean
  /**
   * The model the session is running, as the log last said it (epic #116, U1).
   *
   * The id a `user.message` carrying a `model` switched the session to, or `null` until a
   * message carries one. It is what tells a model **change** — a message whose id differs
   * from it, marked with {@link TranscriptMessage.modelChangedTo} — from the first model a
   * message names.
   */
  readonly model: string | null
  /**
   * The model requests of the turn in progress, for the reply's metadata (epic #201, U1).
   *
   * Bookkeeping the reducer keeps for {@link TranscriptMessage.meta} — a UI renders messages,
   * not these. A request is dropped once its span end has been folded into the reply it
   * belongs to, and the list is emptied when the turn ends (`session.status_idle`), so it
   * never outlives the turn that opened the requests.
   */
  readonly pendingRequests: readonly PendingModelRequest[]
}

/**
 * The state for a session with no events yet.
 *
 * `lastSeq` is `0`, the protocol's "from the start": passing it as `afterSeq` replays the
 * whole log. `deleted` is `false` and `model` is `null`: nothing has happened yet.
 */
export function initialTranscriptState(): TranscriptState {
  return {
    messages: [],
    status: 'idle',
    lastError: null,
    lastSeq: 0,
    deleted: false,
    model: null,
    pendingRequests: [],
  }
}

/**
 * Fold one event into the transcript.
 *
 * Pure: the state that comes back is a new object, and the one that went in is untouched — an
 * incoming event is only ever read, never written — so a framework can compare states by
 * reference and a caller can hand over a shared, frozen event.
 *
 * Events are idempotent — an event at or below `state.lastSeq` is dropped — which is what lets
 * history and a resumed stream overlap without doubling a message. Since D9 the streamed chunks
 * of a reply are stored events too (`event_start` / `event_delta` with a `seq`), so they take
 * the same path: they are deduplicated by `seq`, they advance `lastSeq`, and a client that
 * resumes mid-reply gets the rest of the chunks rather than skipping them. The pre-D9
 * stream-only previews — a chunk with no envelope — were removed in phase P4: apart from the
 * stream-only `session.deleted` (handled below), every event this reducer takes is a
 * `StoredEvent`.
 *
 * The rules, in one place:
 *
 * - **A delta appends to its message's preview**, creating the preview if the client missed
 *   (`event_delta` carries the id of the message being previewed). A delta for a message that
 *   is already stored is ignored: the stored event is the record.
 * - **A stored `agent.message` replaces whatever the transcript holds for its id** — a whole
 *   preview, a partial one, or nothing at all. It never merges.
 * - **A stored preview sits where its chunks started**: at its `event_start`'s `seq`, or at
 *   its first delta's `seq` when the start was skipped (a client that joined mid-reply).
 * - **A finished reply sits where it started.** An `agent.message` that carries `supersedes`
 *   sorts at `from_seq`, whether or not the client saw the chunks, so a steer sent mid-reply
 *   stays behind the reply in every view. A reply with no range — a log stored before D9 —
 *   keeps the position of the preview it replaces, or, with no preview to replace, its own
 *   `seq`.
 * - **Unfinished previews are dropped when the turn moves on**: `span.model_request_end` and
 *   `session.status_idle` discard previews still streaming (#40), which since D9 includes the
 *   previews of a chunk range a span end supersedes. An interrupt is not this case: its
 *   partial reply is stored as an `agent.message` before the span closes.
 * - **`pending` clears on the claim.** The event that answers a user message names it in its
 *   `consumes`: a `span.model_request_start` claims the messages its request folds in (P3),
 *   and a `span.model_request_end` or `session.status_idle` claims the interrupts it ends on
 *   (P4). A claim event with no list at all — a log stored before D9 — keeps the old reading:
 *   a span start says everything pending was picked up, and a span end or an idle says
 *   nothing.
 * - **`session.deleted` is terminal, seq-less and idempotent.** It has no `seq` (it is
 *   stream-only), so it is folded in *before* the dedupe below — a replayed log has no
 *   position for it — and the only thing it does is set `deleted` to `true`. The stream ends
 *   after it, so a UI can react to the state rather than to the end of an iteration, and a
 *   second one changes nothing.
 * - **A `session.rewind` drops the conversation it replaced** (#238). Editing a message
 *   restarts the session from it: the rewind carries the range it replaces — from the edited
 *   message through the last event before it — and everything a client is showing from there
 *   on belongs to a branch the session is no longer on. A client that followed the log live
 *   has all of it on screen (a reload would never have shown it, since replay skips the
 *   range), so the rewind drops those messages, the error it replaced, and the requests of
 *   the turn it replaced. The test is each message's {@link TranscriptMessage.position}: a
 *   user message sits at its own `seq` and a reply at the `from_seq` of the chunks it
 *   replaced, so everything at or after the range's `from_seq` is inside it.
 * - **A `user.message` carrying a `model` may switch the session's model.** When its id
 *   differs from `state.model`, the message carries `modelChangedTo` so a UI can draw the
 *   marker, and `state.model` becomes the new id. The first model the log shows is not a
 *   change — `state.model` starts at `null` — so it sets the state silently, and a message
 *   naming the model already in effect changes nothing. A message with no `model` leaves
 *   `state.model` alone.
 * - **A reply carries what it cost** (epic #201, U1). Its {@link TranscriptMessage.meta}
 *   comes from the turn's spans: a `span.model_request_start` names the model and opens a
 *   tracked request, its `span.model_request_end` reports the tokens and closes it, and the
 *   reply takes them all. Since the span end follows the reply, the metadata is written
 *   twice — the model when the reply lands, the tokens and the duration when the end arrives
 *   — and a reply the brain retried takes the request that failed too, so its tokens add up.
 *   Nothing the log does not say is invented: an absent field is `undefined`, never `0`, and
 *   a turn that ends (`session.status_idle`) drops the requests no reply claimed.
 *
 * @param state the transcript so far
 * @param event the next event, from `iterate`, `stream`, or anywhere else
 */
export function reduceTranscript(state: TranscriptState, event: StreamEvent): TranscriptState {
  if (event.type === EVENT_TYPES.sessionDeleted) {
    // A terminal, stream-only event with no `seq` (#111): folded in before the position
    // dedupe — which cannot apply to it — and idempotent, so a client that sees it twice
    // keeps the same state.
    return state.deleted ? state : { ...state, deleted: true }
  }
  if (event.type === EVENT_TYPES.sessionRewind) {
    // A rewind is applied wherever it arrives (#238). A client that sent the edit applies the
    // stored message the moment the request answers, and the rewind the stream echoes behind
    // it carries the *lower* `seq` of the range it replaced — the ordinary dedupe would throw
    // away the one event that takes the replaced branch off the screen. Applying it twice
    // changes nothing, and it never moves `lastSeq` back.
    const reduced = reduceStoredEvent(state, event)
    if (reduced === state && event.seq <= state.lastSeq) {
      return state
    }
    return { ...reduced, lastSeq: Math.max(state.lastSeq, event.seq) }
  }
  if (event.seq <= state.lastSeq) {
    // Already folded in: a resumed stream replaying from before where we got to, or the
    // same history loaded twice. A value that did not come from the protocol's schemas and
    // carries no `seq` compares false and is folded in; the switch below drops what it
    // cannot read.
    return state
  }
  const reduced = reduceStoredEvent(state, event)
  return { ...reduced, lastSeq: event.seq }
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
      return fromUserMessage(state, event)

    case EVENT_TYPES.agentMessage:
      return fromAgentMessage(state, event)

    case EVENT_TYPES.userInterrupt:
      // An interrupt is not something anyone said: it cuts a reply short, and what is left of
      // that reply arrives as an `agent.message` right behind it.
      return state

    case EVENT_TYPES.eventStart:
      // The reply's chunks are log events (D9), so a client that resumes mid-reply meets
      // them here. The preview opens where the reply started — this event's `seq`.
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
      // renders it (#40). An idle that ended a turn on an interrupt also carries that
      // interrupt's claim (P4).
      //
      // The turn's model requests go with it (epic #201, U1): a request no reply ever claimed
      // belongs to a reply that never happened, and leaving it behind would fold its tokens
      // into the *next* turn's reply.
      return clearClaimedPending(
        {
          ...state,
          status: 'idle',
          messages: withoutPreviews(state.messages),
          pendingRequests: [],
        },
        event.consumes,
      )

    case EVENT_TYPES.sessionRewind:
      return dropRewound(state, event)

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
      // the request that claims it. A span start with no list at all is a log from before
      // the claims existed (or one written before P4, whose writer claimed out of band), and
      // keeps the older reading: everything pending when a request starts has just been
      // picked up.
      //
      // The request itself is tracked for the reply's metadata (epic #201, U1): it names the
      // model that serves the reply and, through its `processed_at`, when the reply began.
      return clearClaimedPending(
        { ...state, pendingRequests: [...state.pendingRequests, openedRequest(event)] },
        event.consumes,
        { absentMeansAll: true },
      )

    case EVENT_TYPES.modelRequestEnd:
      // A preview that was never replaced by its stored event belongs to a request that
      // failed, was interrupted before a reply could be stored, or was closed by a recovering
      // brain; there is nothing to keep. (A reconciled preview is no longer `streaming`, so
      // it survives.) A span end that carries `supersedes` says the same about a specific
      // range — the previews of the chunks it replaces sit inside it — and those previews are
      // streaming, so this is the rule that drops them. A span end that ended a request on an
      // interrupt also carries that interrupt's claim (P4).
      return closeRequest(
        clearClaimedPending(
          { ...state, messages: withoutPreviews(state.messages) },
          event.consumes,
        ),
        event,
      )

    default:
      return state
  }
}

/**
 * Drop the conversation a `session.rewind` replaced (#238).
 *
 * The message at the range's `from_seq`, its reply, and everything after them are what the
 * reader took back: they are no longer part of what the session is. A client that watched the
 * log live is showing them, so this is where the two views agree — a client that loads the
 * session later never receives them at all, because replay skips the range.
 *
 * The turn's requests go with them, for the reason `session.status_idle` drops them: a
 * request no reply ever claimed would otherwise fold its tokens into the next turn's reply.
 * The error goes too: whatever it was about was inside the range.
 *
 * `position` is the test — a message's own `seq` for a user message, the `from_seq` of the
 * chunks it replaced for a reply — so a message the reader saw before the edit stays exactly
 * where it was.
 */
function dropRewound(state: TranscriptState, event: SessionRewindEvent): TranscriptState {
  // The range, not "everything from `from_seq` on": the message that *follows* the rewind in
  // the log — the edit itself — sits past `to_seq`, and a client that already showed it (its
  // own send applies the stored message before the stream echoes the rewind) must keep it.
  const messages = state.messages.filter(
    (message) =>
      message.position < event.supersedes.from_seq || message.position > event.supersedes.to_seq,
  )
  if (
    messages.length === state.messages.length &&
    state.lastError === null &&
    state.pendingRequests.length === 0
  ) {
    return state
  }
  return { ...state, messages, lastError: null, pendingRequests: [] }
}

/**
 * Clear the `pending` flag of the messages a claim reaches.
 *
 * The claim is the event's `consumes` list — a `span.model_request_start` naming the messages
 * its request folds in, or a `span.model_request_end` / `session.status_idle` naming the
 * interrupts it ended on (P4). Only what the list names is cleared, and a message that is
 * already delivered is left alone, so the state keeps its identity when nothing changes.
 *
 * `absentMeansAll` is the pre-D9 fallback, for a log whose writer claimed out of band: a span
 * start with no list says everything pending when a request starts has just been picked up,
 * which is how every message was read before the claims existed. For the other two event
 * types an absent list claims nothing — their older form never claimed anything.
 *
 * @param state the transcript so far
 * @param consumes the ids the event claims, or `undefined` when it carries no list
 * @param options.absentMeansAll what a missing list means; `false` by default
 */
function clearClaimedPending(
  state: TranscriptState,
  consumes: readonly string[] | undefined,
  options: { readonly absentMeansAll?: boolean } = {},
): TranscriptState {
  if (consumes === undefined && options.absentMeansAll !== true) {
    return state
  }
  const claimed = consumes === undefined ? null : new Set(consumes)
  let changed = false
  const messages = state.messages.map((message) => {
    if (!message.pending || (claimed !== null && !claimed.has(message.id))) {
      return message
    }
    changed = true
    return { ...message, pending: false }
  })
  return changed ? { ...state, messages } : state
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

/**
 * Fold a stored `user.message` in, applying the model-switch rule (epic #116, U1).
 *
 * A message that carries a `model` switches the session to it: the state's `model` moves to
 * the new id, and the message carries {@link TranscriptMessage.modelChangedTo} when that id
 * differs from the one already in effect — a change a UI marks. The first model a message
 * carries is not a change (the state was `null`), so the marker is left off and the state is
 * set silently; a message naming the model already in effect is left off too.
 */
function fromUserMessage(state: TranscriptState, event: UserMessageEvent): TranscriptState {
  const model = event.model?.id
  const parts = textParts(event.content.map((block) => block.text))
  const message: TranscriptMessage = {
    id: event.id,
    role: 'user',
    parts,
    text: joinedText(parts),
    pending: event.processed_at === null,
    streaming: false,
    position: event.seq,
    ...(model !== undefined && state.model !== null && model !== state.model
      ? { modelChangedTo: model }
      : {}),
  }
  return { ...upsertMessage(state, message), model: model ?? state.model }
}

/**
 * Fold a stored `agent.message` in: the reply, plus the model requests it answers (epic #201,
 * U1).
 *
 * The reply takes every request the turn has opened and no earlier reply claimed — the failed
 * attempt a retry followed, and the retry itself — as its {@link TranscriptMessage.meta}. The
 * requests keep the message's id, so the span ends still to come know which reply to add their
 * tokens and their duration to: the span end of a reply arrives *after* the reply itself.
 */
function fromAgentMessage(state: TranscriptState, event: AgentMessageEvent): TranscriptState {
  const claimed = state.pendingRequests.filter((request) => request.messageId === undefined)
  const message = messageFromAgentEvent(
    event,
    agentMessagePosition(state, event),
    metaFrom(claimed),
  )
  const pendingRequests = [
    // A request an earlier reply already took keeps its attribution until its end lands.
    ...state.pendingRequests.filter((request) => request.messageId !== undefined),
    ...claimed.map((request) => ({ ...request, messageId: event.id })),
  ]
  return { ...upsertMessage(state, message), lastError: null, pendingRequests }
}

/** The transcript message for a stored `agent.message`, reconciled with any preview of it. */
function messageFromAgentEvent(
  event: AgentMessageEvent,
  position: number,
  meta: TranscriptMessageMeta | undefined,
): TranscriptMessage {
  const parts = textParts(event.content.map((block) => block.text))
  return {
    id: event.id,
    role: 'agent',
    parts,
    text: joinedText(parts),
    pending: false,
    streaming: false,
    position,
    ...(meta === undefined ? {} : { meta }),
  }
}

/** The text parts of a stored message: v1's content blocks are text only. */
function textParts(blocks: readonly string[]): readonly MessagePart[] {
  return blocks.map((text): MessagePart => ({ type: 'text', text }))
}

/** A message's text: its text parts, joined. */
function joinedText(parts: readonly MessagePart[]): string {
  return parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

/** The request a `span.model_request_start` opens (epic #201, U1). */
function openedRequest(event: ModelRequestStartEvent): PendingModelRequest {
  const startedAt = epochMs(event.processed_at)
  return {
    id: event.id,
    ...(event.model === undefined ? {} : { model: event.model }),
    ...(startedAt === undefined ? {} : { startedAt }),
  }
}

/**
 * Close the request a `span.model_request_end` names, and fold what it reported into the reply
 * it belongs to (epic #201, U1).
 *
 * The span end arrives *after* the reply it produced, which is why the metadata is written
 * here rather than when the reply lands: the end carries the tokens and the time. A request
 * that no reply has claimed yet — a failed attempt the brain then retried — is only marked
 * ended here; it stays tracked so the reply the retry produces sums both requests. A span end
 * whose start the client never saw (it joined mid-request) still opens an entry, so a reply
 * the turn stores after it takes those tokens; one stored *before* it is left alone, because
 * the end names the request that opened it and a client that missed that event has nothing to
 * tie the end to.
 */
function closeRequest(state: TranscriptState, event: ModelRequestEndEvent): TranscriptState {
  const existing = state.pendingRequests.find(
    (request) => request.id === event.model_request_start_id,
  )
  const endedAt = epochMs(event.processed_at)
  const closed: PendingModelRequest = {
    ...(existing ?? { id: event.model_request_start_id }),
    ...(endedAt === undefined ? {} : { endedAt }),
    usage: usageFrom(event.model_usage),
  }
  const requests =
    existing === undefined
      ? [...state.pendingRequests, closed]
      : state.pendingRequests.map((request) => (request.id === closed.id ? closed : request))
  const messageId = closed.messageId
  if (messageId === undefined) {
    return { ...state, pendingRequests: requests }
  }
  // The reply takes the tokens of every request attributed to it — this one included, which is
  // why the metadata is read before the request is dropped.
  const attributed = requests.filter((request) => request.messageId === messageId)
  return withMeta(
    { ...state, pendingRequests: requests.filter((request) => request.id !== closed.id) },
    messageId,
    metaFrom(attributed),
  )
}

/** Write `meta` onto the reply `id`, when it is a message the transcript holds. */
function withMeta(
  state: TranscriptState,
  id: string,
  meta: TranscriptMessageMeta | undefined,
): TranscriptState {
  const message = meta === undefined ? undefined : state.messages.find((each) => each.id === id)
  return message === undefined ? state : upsertMessage(state, { ...message, meta })
}

/**
 * The metadata a set of model requests adds up to, or `undefined` when they say nothing.
 *
 * The model is the last one they named — a reply that took several requests ran on the model
 * that finally answered it — and the duration runs from the first request's start to the last
 * one's end, so a retried reply reports the time it really took. Tokens are summed over the
 * requests that reported any, which is how a retried reply's cost includes the attempt that
 * failed before it.
 */
function metaFrom(requests: readonly PendingModelRequest[]): TranscriptMessageMeta | undefined {
  const model = requests.reduce<string | undefined>(
    (last, request) => request.model ?? last,
    undefined,
  )
  const usage = summedUsage(requests)
  const durationMs = spanMs(requests)
  if (model === undefined && usage === undefined && durationMs === undefined) {
    return undefined
  }
  return {
    ...(model === undefined ? {} : { model }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(usage === undefined ? {} : { usage }),
  }
}

/** The tokens the requests reported, summed; `undefined` when not one of them reported any. */
function summedUsage(requests: readonly PendingModelRequest[]): TranscriptUsage | undefined {
  let input = 0
  let output = 0
  let reported = false
  for (const request of requests) {
    if (request.usage === undefined) {
      continue
    }
    input += request.usage.input
    output += request.usage.output
    reported = true
  }
  return reported ? { input, output, total: input + output } : undefined
}

/**
 * How long the requests took, from the earliest start to the latest end.
 *
 * `undefined` when the log does not say — a client that joined after the start, a request
 * whose span end never arrived — and for a negative span: `processed_at` is not monotonic
 * across a crash (D9), and a reply that took less than no time is not a duration a UI can
 * print.
 */
function spanMs(requests: readonly PendingModelRequest[]): number | undefined {
  const starts = requests.flatMap((request) =>
    request.startedAt === undefined ? [] : [request.startedAt],
  )
  const ends = requests.flatMap((request) =>
    request.endedAt === undefined ? [] : [request.endedAt],
  )
  if (starts.length === 0 || ends.length === 0) {
    return undefined
  }
  const elapsed = Math.max(...ends) - Math.min(...starts)
  return elapsed < 0 ? undefined : elapsed
}

/** The tokens a `span.model_request_end` reported, in the shape a message's metadata takes. */
function usageFrom(usage: ModelUsage): TranscriptUsage {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    total: usage.input_tokens + usage.output_tokens,
  }
}

/** A timestamp as epoch milliseconds, or `undefined` when it is not a date at all. */
function epochMs(timestamp: string): number | undefined {
  const ms = Date.parse(timestamp)
  return Number.isNaN(ms) ? undefined : ms
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
function agentMessagePosition(state: TranscriptState, event: AgentMessageEvent): number {
  if (event.supersedes !== undefined) {
    return event.supersedes.from_seq
  }
  return state.messages.find((message) => message.id === event.id)?.position ?? event.seq
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
  return { id, role: 'agent', parts: [], text: '', pending: false, streaming: true, position }
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

/**
 * Whether an upsert would change nothing, so the state can keep its identity.
 *
 * `text` is compared through `parts` — it is their text, joined — so a message whose metadata
 * a span end filled in is a change and one a replayed event restates is not.
 */
function isSameMessage(current: TranscriptMessage | undefined, next: TranscriptMessage): boolean {
  return (
    current !== undefined &&
    sameParts(current.parts, next.parts) &&
    current.pending === next.pending &&
    current.streaming === next.streaming &&
    current.position === next.position &&
    current.role === next.role &&
    sameMeta(current.meta, next.meta)
  )
}

/** Whether two part lists render the same. */
function sameParts(current: readonly MessagePart[], next: readonly MessagePart[]): boolean {
  return (
    current.length === next.length &&
    current.every((part, index) => {
      const other = next[index]
      return other !== undefined && other.type === part.type && other.text === part.text
    })
  )
}

/** Whether two replies report the same metadata. */
function sameMeta(
  current: TranscriptMessageMeta | undefined,
  next: TranscriptMessageMeta | undefined,
): boolean {
  if (current === next) {
    return true
  }
  return (
    current !== undefined &&
    next !== undefined &&
    current.model === next.model &&
    current.durationMs === next.durationMs &&
    current.usage?.input === next.usage?.input &&
    current.usage?.output === next.usage?.output &&
    current.usage?.total === next.usage?.total
  )
}

/**
 * Extend a preview with a delta.
 *
 * Deltas carry the index of the content block they extend, so they accumulate per index and
 * `text` is the parts in order — the same string the stored event will carry once it
 * replaces the preview. A delta for an event whose `event_start` was missed (a connection
 * that opened mid-reply) still lands: it opens the preview itself, at `createPosition` —
 * the delta's own `seq`. A delta for a message that is already stored changes nothing.
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
  const parts = current.parts.slice()
  // A block's deltas extend its part; the block a delta names is text until the protocol has
  // another block type to stream (a `tool_use` input, say), which is when this becomes a
  // switch rather than an append.
  parts[index] = { type: 'text', text: (parts[index]?.text ?? '') + text }
  return upsertMessage(state, {
    ...current,
    parts,
    text: joinedText(parts),
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
