import {
  DEFAULT_PAGE_LIMIT,
  EVENT_TYPES,
  MAX_PAGE_LIMIT,
  encodeSeqCursor,
  isStoredEvent,
  newEventId,
  tryDecodePageCursor,
} from '@openharness/protocol'
import type {
  AgentMessageEvent,
  ContentBlock,
  EventId,
  ListEventsQuery,
  ListEventsResponse,
  ModelRequestEndEvent,
  ModelRequestStartEvent,
  RetryStatusType,
  Session,
  SessionDeletedEvent,
  SessionError,
  SessionErrorType,
  StoredEvent,
  StoredEventDelta,
  StoredEventStart,
  StreamEvent,
  Supersedes,
  UserEvent,
  UserEventInput,
  UserInterruptEvent,
  UserMessageEvent,
} from '@openharness/protocol'

import type { StreamOptions } from '../events/stream'
import { AsyncQueue, sleep } from '../internal/async'
import { deepFreeze } from './freeze'
import { deriveFakeSessionTitle } from './titles'

/**
 * The in-memory brain behind one fake session: its log, its script and its turn loop.
 *
 * Everything here mirrors what the server does, in the order the epic describes it. A turn is
 * `session.status_running`, then per model request `span.model_request_start` → the chunks
 * (`event_start` and deltas, stored as they stream) → the stored `agent.message` →
 * `span.model_request_end`, and finally `session.status_idle`. A retryable failure inserts
 * `session.error` and `session.status_rescheduled` before the next request; a terminal one
 * ends the turn.
 *
 * Two D9 properties hold here too:
 *
 * - **The log is append-only.** Every event is deep-frozen before it is stored or delivered,
 *   and nothing rewrites one. The brain's "I have picked this message up" note lives beside
 *   the log ({@link FakeBrain} keeps it private) and reads derive `processed_at` from it.
 * - **It speaks the server's dialect (P4).** Streamed chunks are stored events with a `seq`,
 *   a span start claims the messages its request answers in `consumes`, the event that ends a
 *   request or a turn claims the interrupts it ends on, and the event that finishes a reply
 *   supersedes its chunk range. A component tested against this fake is a test against what
 *   the real server writes.
 * - **A model on a user message switches the session (epic #116, U1).** The event stores the
 *   choice and the session header moves to it, so the next `span.model_request_start` carries
 *   the new id — while a session created with a model still runs it.
 * - **A deleted session ends its streams (#111).** {@link FakeBrain.markDeleted} delivers one
 *   final `session.deleted` event, closes every subscriber behind it, and drops the log; after
 *   that the fake answers 404 for the session.
 */

/** A reply the fake's brain produces for the next model request. */
export interface FakeReply {
  /** The text of the `agent.message`. */
  readonly text: string
  /** How the preview is chunked: a count, or the exact fragments in order. */
  readonly chunks: number | readonly string[] | undefined
  /** Milliseconds between preview deltas; falls back to the client's `delayMs`. */
  readonly delayMs: number | undefined
}

/** A failure the fake's brain reports for the next model request. */
export interface FakeFailure {
  /** The `session.error` type. */
  readonly type: SessionErrorType
  /** The `session.error` message. */
  readonly message: string
  /** What the server is doing about it; `retrying` continues the turn. */
  readonly retryStatus: RetryStatusType
  /** Milliseconds before the failure is reported; falls back to the client's `delayMs`. */
  readonly delayMs: number | undefined
}

/** What the brain does for the next model request. */
export type FakeScript =
  { kind: 'reply'; reply: FakeReply } | { kind: 'failure'; failure: FakeFailure }

/**
 * Token usage every fake model request reports.
 *
 * Share the protocol's constants rather than inventing numbers: a test that sums a turn's
 * usage against the log should see what the fixtures see.
 */
export const FAKE_MODEL_USAGE = {
  input_tokens: 512,
  output_tokens: 32,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
} as const

/** The largest number of fragments a reply is split into, so `chunks` cannot spin forever. */
const MAX_CHUNKS = 1000

/** One live subscriber of a session's stream. */
class Subscriber {
  readonly queue = new AsyncQueue<StreamEvent>()
  readonly wantsDeltas: boolean
  #lastSeq: number

  constructor(options: StreamOptions) {
    this.wantsDeltas = options.deltas ?? false
    this.#lastSeq = options.afterSeq ?? 0
  }

  /**
   * Hand an event to this subscriber, unless it is a chunk it did not ask for or one it has
   * already seen.
   *
   * A reply's chunks are stored events, but the stream still gates them on the connection's
   * `deltas` opt-in — the same filter the server applies in both halves of its stream. The
   * `lastSeq` check is the server-side half of the resume rule — the client drops events at or
   * below its own position, and the fake never sends one below the subscriber's — and it
   * applies to stored events only: `session.deleted` (#111) has no `seq` and is delivered to
   * whoever is subscribed, whatever their resume position is.
   */
  deliver(event: StreamEvent): void {
    if (isChunk(event) && !this.wantsDeltas) {
      return
    }
    if (isStoredEvent(event)) {
      if (event.seq <= this.#lastSeq) {
        return
      }
      this.#lastSeq = event.seq
    }
    this.queue.push(event)
  }
}

/**
 * Whether an event is one of a reply's chunks — an `event_start` or an `event_delta`.
 *
 * Chunks are stored events like any other (D9), but they are the kind a connection opts into
 * with `deltas`: the server sends them only to a connection that asked.
 */
export function isChunk(event: StreamEvent): event is StoredEventStart | StoredEventDelta {
  return event.type === EVENT_TYPES.eventStart || event.type === EVENT_TYPES.eventDelta
}

/** The in-memory brain of one fake session. */
export class FakeBrain {
  /**
   * The session header this brain keeps up to date.
   *
   * **Replaced, never mutated** when the brain names the session (the way the real server's
   * row changes without touching a copy a client already holds): a caller that fetched the
   * session earlier keeps its stale copy — `title: null` — until it re-reads, which is the
   * behaviour the frontends' one-re-read flow (#35) exists to handle. A mutated-in-place
   * object would make the client's stale copy silently fresh and skip that flow entirely.
   */
  session: Session

  readonly #log: StoredEvent[] = []
  readonly #scripts: FakeScript[] = []
  readonly #subscribers = new Set<Subscriber>()
  readonly #delayMs: number
  readonly #now: () => Date
  /**
   * When the brain reached each queued user event, keyed by its id.
   *
   * The log itself is never rewritten (D9): a user event says `processed_at: null` from the
   * moment it is written, and "the brain has picked this up" is a note kept beside it, which
   * reads derive from. That is also what the real store does from phase P2a on — the column
   * becomes a value derived on read — so a test that reads the log later sees exactly what a
   * test against the server would.
   */
  readonly #processedAt = new Map<string, string>()
  #seq = 0
  #turn: Promise<void> | null = null
  #interruptRequested = false
  #deleted = false

  constructor(session: Session, delayMs: number, now: () => Date) {
    this.session = session
    this.#delayMs = delayMs
    this.#now = now
  }

  /** Whether a turn is running right now. */
  get running(): boolean {
    return this.#turn !== null
  }

  /**
   * Whether the session was deleted (#111): the log is gone and the session is gone with it,
   * so every wire call for it is answered 404.
   */
  get deleted(): boolean {
    return this.#deleted
  }

  /** Queue what the next model request should do. */
  script(script: FakeScript): void {
    this.#scripts.push(script)
  }

  /**
   * The session's log, in the order a server would have written it.
   *
   * A read derives the user events' `processed_at` from the brain's notes; the log's own
   * copies are never rewritten.
   */
  history(): readonly StoredEvent[] {
    return this.#log.map((event) => this.#view(event))
  }

  /** Append a user event as the server would: with an `id`, a `seq` and a `processed_at`. */
  appendUserEvent(input: UserEventInput): UserEvent {
    const stored: UserEvent =
      input.type === EVENT_TYPES.userMessage
        ? {
            id: newEventId(),
            type: EVENT_TYPES.userMessage,
            seq: this.#nextSeq(),
            processed_at: null,
            content: input.content,
            ...(input.model === undefined ? {} : { model: input.model }),
          }
        : {
            id: newEventId(),
            type: EVENT_TYPES.userInterrupt,
            seq: this.#nextSeq(),
            processed_at: null,
          }
    deepFreeze(stored)
    this.#log.push(stored)
    // A message that carries a model switches what the session runs (epic #116, U1): the
    // event stores the choice, and the session header — the live projection a reader sees —
    // moves with it, so the next `span.model_request_start` carries the new id.
    if (stored.type === EVENT_TYPES.userMessage && stored.model !== undefined) {
      this.session.model = { id: stored.model.id }
    }
    // A session is named by the first message it is sent, in the same request that stores it
    // (`apps/server/src/titles.ts`); the fake keeps the same promise so a frontend test about
    // titles is a test against the behaviour, not against a workaround.
    if (stored.type === EVENT_TYPES.userMessage && this.session.title === null) {
      const title = deriveFakeSessionTitle(stored.content.map((block) => block.text).join('\n'))
      if (title !== null) {
        this.session = { ...this.session, title }
      }
    }
    // Subscribers and callers get the stored event itself: it is frozen, and it says what
    // the wire says — a queued message, `processed_at: null` — however much later it is read.
    this.#broadcast(stored)
    if (stored.type === EVENT_TYPES.userInterrupt) {
      this.#interruptRequested = true
    }
    return stored
  }

  /**
   * Delete the session (#111): tell the subscribers, end their streams, and drop the log.
   *
   * `session.deleted` is stream-only — it has no `seq` and never lands in a log — so it is
   * delivered rather than emitted: every subscriber gets it exactly once, as the last event
   * of its stream, and the queue closes behind it. From here on the brain answers nothing:
   * `deleted` is what the fake turns into its 404s.
   */
  markDeleted(): void {
    if (this.#deleted) {
      return
    }
    this.#deleted = true
    const event: SessionDeletedEvent = {
      type: EVENT_TYPES.sessionDeleted,
      session_id: this.session.id,
    }
    deepFreeze(event)
    for (const subscriber of this.#subscribers) {
      subscriber.deliver(event)
      subscriber.queue.close()
    }
    this.#subscribers.clear()
    this.#log.length = 0
  }

  /**
   * Start a turn unless one is already running.
   *
   * A message that arrives while the session is running does not start a second turn: it is
   * queued, and the loop below picks it up as a steering message.
   */
  startTurn(): void {
    if (this.#turn !== null) {
      return
    }
    const turn = this.#runTurn()
    this.#turn = turn
    void turn.finally(() => {
      if (this.#turn === turn) {
        this.#turn = null
      }
    })
  }

  /** Resolve once no turn is running. */
  async waitForIdle(): Promise<void> {
    while (this.#turn !== null) {
      await this.#turn
    }
  }

  /** A new subscriber's queue, with the backlog it asked for already in it. */
  subscribe(options: StreamOptions): Subscriber {
    const subscriber = new Subscriber(options)
    for (const event of this.backlog(options.afterSeq)) {
      subscriber.deliver(event)
    }
    this.#subscribers.add(subscriber)
    return subscriber
  }

  /** Stop delivering to a subscriber; its stream has ended. */
  unsubscribe(subscriber: Subscriber): void {
    this.#subscribers.delete(subscriber)
    subscriber.queue.close()
  }

  /** The stored events after `afterSeq`, in order; nothing when `afterSeq` is omitted. */
  backlog(afterSeq: number | undefined): readonly StoredEvent[] {
    return afterSeq === undefined
      ? []
      : this.#log.filter((event) => event.seq > afterSeq).map((event) => this.#view(event))
  }

  /** One page of the log, honoring `limit`, `order`, `page`, `types[]` and `after_seq`. */
  pageEvents(params: ListEventsQuery): ListEventsResponse {
    const afterSeq = params.after_seq ?? cursorSeq(params.page)
    let events = this.#log.filter((event) => afterSeq === undefined || event.seq > afterSeq)
    if (params.types !== undefined) {
      const types = new Set<string>(params.types)
      events = events.filter((event) => types.has(event.type))
    }
    if (params.order === 'desc') {
      events = [...events].reverse()
    }
    const limit = clampLimit(params.limit)
    const page = events.slice(0, limit).map((event) => this.#view(event))
    const last = page.at(-1)
    return {
      data: page,
      next_page:
        events.length > page.length && last !== undefined ? encodeSeqCursor(last.seq) : null,
    }
  }

  /** The turn loop: model requests until the queue is empty and no retry is pending. */
  async #runTurn(): Promise<void> {
    this.#interruptRequested = false
    this.#emit(this.#statusRunning())
    let retry = false

    for (;;) {
      // An interrupt with nothing running — before the first request, or during a backoff —
      // has no request to end, so the turn's idle event claims it (P4), exactly as the real
      // brain's does.
      const interrupts = this.#queuedInterrupts()
      if (interrupts.length > 0) {
        this.#emit(this.#statusIdle(interrupts.map((event) => event.id)))
        return
      }
      const queued = this.#queuedUserMessages()
      if (queued.length === 0 && !retry) {
        break
      }
      retry = false

      const start = this.#modelRequestStart(queued.map((message) => message.id))
      const script = this.#scripts.shift() ?? {
        kind: 'reply',
        reply: defaultReply(queued),
      }

      if (script.kind === 'failure') {
        await this.#failRequest(start, script.failure)
        if (script.failure.retryStatus === 'retrying') {
          this.#emit(this.#statusRescheduled())
          this.#emit(this.#statusRunning())
          retry = true
          continue
        }
        break
      }

      if (await this.#streamReply(start, script.reply)) {
        break
      }
    }

    this.#emit(this.#statusIdle())
  }

  /** Emit a reply: the chunks as they stream, then the stored event; `true` when interrupted. */
  async #streamReply(start: ModelRequestStartEvent, reply: FakeReply): Promise<boolean> {
    const messageId = newEventId()
    const fragments = chunkText(reply.text, reply.chunks)
    const delay = reply.delayMs ?? this.#delayMs

    const chunkStart = this.#emit(this.#chunkStart(messageId))
    let lastChunkSeq = chunkStart.seq
    let partial = ''
    for (const fragment of fragments) {
      if (this.#interruptRequested) {
        break
      }
      await sleep(delay)
      partial += fragment
      lastChunkSeq = this.#emit(this.#chunkDelta(messageId, fragment)).seq
    }
    const range: Supersedes = { from_seq: chunkStart.seq, to_seq: lastChunkSeq }

    const interrupted = this.#interruptRequested
    // An interrupt that cut an open request short is claimed by that request's span end (P4).
    const claim = interrupted ? this.#queuedInterrupts().map((event) => event.id) : []
    const text = interrupted ? partial : reply.text
    if (text === '') {
      // No message: an empty `agent.message` would be a reply the model did not make, and an
      // interrupted request with nothing streamed has none to keep. The span end supersedes
      // the orphaned chunk instead, exactly as the real brain's does.
      this.#emit(
        this.#modelRequestEnd(start, {
          is_error: interrupted ? true : null,
          ...(interrupted
            ? {
                error: { type: 'interrupted', message: 'Interrupted by the user.' },
                consumes: claim,
              }
            : {}),
          supersedes: range,
        }),
      )
      return interrupted
    }
    // Whatever the model produced before the interrupt is still a message; the span says why
    // the request ended.
    this.#emit(this.#agentMessage(messageId, text, range))
    this.#emit(
      this.#modelRequestEnd(
        start,
        interrupted
          ? {
              is_error: true,
              error: { type: 'interrupted', message: 'Interrupted by the user.' },
              consumes: claim,
            }
          : { is_error: null },
      ),
    )
    return interrupted
  }

  /** Emit a failed model request: its span, then the session error. */
  async #failRequest(start: ModelRequestStartEvent, failure: FakeFailure): Promise<void> {
    await sleep(failure.delayMs ?? this.#delayMs)
    this.#emit(
      this.#modelRequestEnd(start, {
        is_error: true,
        error: { type: 'model_error', message: failure.message },
      }),
    )
    const error: SessionError = {
      type: failure.type,
      message: failure.message,
      retry_status: { type: failure.retryStatus },
    }
    this.#emit({
      id: newEventId(),
      type: EVENT_TYPES.sessionError,
      seq: this.#nextSeq(),
      processed_at: this.#timestamp(),
      error,
    })
  }

  /** User messages the brain has not folded into a request yet. */
  #queuedUserMessages(): UserMessageEvent[] {
    return this.#log.filter(
      (event): event is UserMessageEvent =>
        event.type === EVENT_TYPES.userMessage && !this.#processedAt.has(event.id),
    )
  }

  /** User interrupts nothing has claimed yet. */
  #queuedInterrupts(): UserInterruptEvent[] {
    return this.#log.filter(
      (event): event is UserInterruptEvent =>
        event.type === EVENT_TYPES.userInterrupt && !this.#processedAt.has(event.id),
    )
  }

  /**
   * The event as a read of the log shows it: the stored value, with the user events'
   * `processed_at` derived from the brain's notes. The log's own object is left alone.
   */
  #view(event: StoredEvent): StoredEvent {
    if (
      (event.type === EVENT_TYPES.userMessage || event.type === EVENT_TYPES.userInterrupt) &&
      event.processed_at === null
    ) {
      const at = this.#processedAt.get(event.id)
      if (at !== undefined) {
        return deepFreeze({ ...event, processed_at: at })
      }
    }
    return event
  }

  /** Write a stored event to the log, move the session header along, and deliver it live. */
  #emit<T extends StoredEvent>(event: T): T {
    // The log is append-only (D9): every event is frozen before anything can hold it.
    deepFreeze(event)
    if (this.#deleted) {
      // The session and its log are gone: a turn still finishing after a delete has nowhere
      // to write and no one to tell.
      return event
    }
    this.#log.push(event)
    // The claim is the append (P4): an event's `consumes` list is what takes the user events
    // it names, recorded beside the log the way the real store's `event_claims` table is.
    // Only a server-produced event carries `consumes`, and its `processed_at` is never null.
    if (event.processed_at !== null) {
      for (const claimed of consumesOf(event)) {
        this.#processedAt.set(claimed, event.processed_at)
      }
    }
    if (event.type === EVENT_TYPES.sessionStatusRunning) {
      this.session.status = 'running'
    } else if (event.type === EVENT_TYPES.sessionStatusIdle) {
      this.session.status = 'idle'
    }
    this.session.updated_at = this.#timestamp()
    this.#broadcast(event)
    return event
  }

  /** Hand an event to every subscriber; each decides whether it wants it. */
  #broadcast(event: StreamEvent): void {
    for (const subscriber of this.#subscribers) {
      subscriber.deliver(event)
    }
  }

  #statusRunning(): StoredEvent {
    return {
      id: newEventId(),
      type: EVENT_TYPES.sessionStatusRunning,
      seq: this.#nextSeq(),
      processed_at: this.#timestamp(),
    }
  }

  #statusIdle(consumes: readonly EventId[] = []): StoredEvent {
    return {
      id: newEventId(),
      type: EVENT_TYPES.sessionStatusIdle,
      seq: this.#nextSeq(),
      processed_at: this.#timestamp(),
      stop_reason: { type: 'end_turn' },
      ...(consumes.length === 0 ? {} : { consumes: [...consumes] }),
    }
  }

  #statusRescheduled(): StoredEvent {
    return {
      id: newEventId(),
      type: EVENT_TYPES.sessionStatusRescheduled,
      seq: this.#nextSeq(),
      processed_at: this.#timestamp(),
    }
  }

  #modelRequestStart(consumes: readonly EventId[]): ModelRequestStartEvent {
    const event: ModelRequestStartEvent = {
      id: newEventId(),
      type: EVENT_TYPES.modelRequestStart,
      seq: this.#nextSeq(),
      processed_at: this.#timestamp(),
      consumes: [...consumes],
      // The model the session runs, which is its own field since #93 — an agent-less,
      // model-first session has none to read the model off.
      model: this.session.model.id,
    }
    this.#emit(event)
    return event
  }

  #modelRequestEnd(
    start: ModelRequestStartEvent,
    outcome: {
      is_error: boolean | null
      error?: ModelRequestEndEvent['error']
      supersedes?: Supersedes
      consumes?: readonly EventId[]
    },
  ): ModelRequestEndEvent {
    return {
      id: newEventId(),
      type: EVENT_TYPES.modelRequestEnd,
      seq: this.#nextSeq(),
      processed_at: this.#timestamp(),
      model_request_start_id: start.id,
      model_usage: { ...FAKE_MODEL_USAGE },
      is_error: outcome.is_error,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      ...(outcome.supersedes === undefined ? {} : { supersedes: outcome.supersedes }),
      ...(outcome.consumes === undefined || outcome.consumes.length === 0
        ? {}
        : { consumes: [...outcome.consumes] }),
    }
  }

  /** A reply's opening chunk, stored as the real brain stores one. */
  #chunkStart(messageId: EventId): StoredEventStart {
    return {
      id: newEventId(),
      type: EVENT_TYPES.eventStart,
      seq: this.#nextSeq(),
      processed_at: this.#timestamp(),
      event: { type: EVENT_TYPES.agentMessage, id: messageId },
    }
  }

  /** One streamed fragment, stored under the id of the message it belongs to. */
  #chunkDelta(messageId: EventId, text: string): StoredEventDelta {
    return {
      id: newEventId(),
      type: EVENT_TYPES.eventDelta,
      seq: this.#nextSeq(),
      processed_at: this.#timestamp(),
      event_id: messageId,
      delta: { type: 'content_delta', index: 0, content: { type: 'text', text } },
    }
  }

  #agentMessage(id: EventId, text: string, supersedes: Supersedes): AgentMessageEvent {
    // The protocol's text blocks are non-empty, so an empty reply is never stored as a
    // message at all — `#streamReply` supersedes the chunks on the span end instead.
    const content: ContentBlock[] = text === '' ? [] : [{ type: 'text', text }]
    return {
      id,
      type: EVENT_TYPES.agentMessage,
      seq: this.#nextSeq(),
      processed_at: this.#timestamp(),
      content,
      supersedes,
    }
  }

  #nextSeq(): number {
    this.#seq += 1
    return this.#seq
  }

  #timestamp(): string {
    return this.#now().toISOString()
  }
}

/**
 * The ids an event claims: the `consumes` list of a `span.model_request_start`, a
 * `span.model_request_end` or a `session.status_idle` (P4), or none for anything else.
 */
function consumesOf(event: StoredEvent): readonly EventId[] {
  if (
    (event.type === EVENT_TYPES.modelRequestStart ||
      event.type === EVENT_TYPES.modelRequestEnd ||
      event.type === EVENT_TYPES.sessionStatusIdle) &&
    event.consumes !== undefined
  ) {
    return event.consumes
  }
  return []
}

/** The reply the brain produces when nothing has been scripted. */
export function defaultReply(queued: readonly UserMessageEvent[]): FakeReply {
  const last = queued.at(-1)
  return {
    text: last === undefined ? 'Hello!' : `Fake reply: ${textOf(last)}`,
    chunks: undefined,
    delayMs: undefined,
  }
}

/** The text of a stored user message: its blocks, joined. */
export function textOf(message: UserMessageEvent): string {
  return message.content.map((block) => block.text).join('')
}

/**
 * Split `text` into the fragments a preview is streamed in.
 *
 * A count spreads the text into that many roughly equal pieces; explicit fragments are used
 * as they are. Either way the fragments concatenate back to `text`, which is the guarantee
 * the transcript relies on when it accumulates deltas.
 *
 * @param text the whole reply
 * @param chunks a fragment count, the fragments themselves, or `undefined` for one piece
 */
export function chunkText(text: string, chunks: number | readonly string[] | undefined): string[] {
  if (text === '') {
    return []
  }
  if (isFragmentList(chunks)) {
    return [...chunks]
  }
  const count = chunks === undefined ? 1 : Math.max(1, Math.min(Math.floor(chunks), MAX_CHUNKS))
  if (count <= 1) {
    return [text]
  }
  const size = Math.ceil(text.length / count)
  const fragments: string[] = []
  for (let index = 0; index < text.length; index += size) {
    fragments.push(text.slice(index, index + size))
  }
  return fragments
}

/** Whether `chunks` is the list of fragments itself rather than a count of them. */
function isFragmentList(
  chunks: number | readonly string[] | undefined,
): chunks is readonly string[] {
  return Array.isArray(chunks)
}

/** The `seq` a `page` cursor points at; `undefined` when it is not a `seq` cursor. */
function cursorSeq(page: string | undefined): number | undefined {
  if (page === undefined) {
    return undefined
  }
  const cursor = tryDecodePageCursor(page)
  return cursor?.kind === 'seq' ? cursor.seq : undefined
}

/** A page size within the protocol's bounds. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_PAGE_LIMIT
  }
  return Math.max(1, Math.min(Math.floor(limit), MAX_PAGE_LIMIT))
}
