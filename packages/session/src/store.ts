import type {
  Agent,
  AgentId,
  CreateAgentRequest,
  EventId,
  ListAgentsResponse,
  ListEventsResponse,
  ListOrder,
  ListSessionsResponse,
  Metadata,
  ModelRequestStartEvent,
  Session,
  SessionId,
  StoredEvent,
  StoredEventType,
  StreamEvent,
  StreamOnlyEvent,
  Timestamp,
  UserEvent,
  UserEventInput,
  UpdateAgentRequest,
} from '@openharness/protocol'

/**
 * The storage and signaling contract the brain and the server code against.
 *
 * A session is a durable, append-only event log, and this interface is the only way to read or
 * write one. Two implementations exist: `InMemorySessionStore` — the test fake every other
 * package uses, and the reference behaviour — and `PostgresSessionStore`, which passes the
 * same conformance suite.
 *
 * ## What every implementation must guarantee
 *
 * - **Ordering.** Events are appended with a per-session `seq` that starts at `1` and increases
 *   by one, in the order the events were given. `seq` is the only ordering key: timestamps are
 *   metadata, not order. Reads return events in `seq` order (ascending by default), and a
 *   subscription delivers stored events in `seq` order with no gaps and no duplicates.
 * - **Atomically assigned fields.** `seq` and the event's internal creation time are assigned
 *   inside one transaction — and so is `id`, unless the caller supplied one, which is stored
 *   as given (see {@link SessionStore.appendEvents}) — so a turn can never observe half an
 *   append. The events returned to the caller are the stored events: `StoredEvent` exactly,
 *   with no extra field (notably no `created_at` — the protocol has none).
 * - **Immutability.** No stored event is ever modified: the log is append-only, appends are
 *   the only way in, and the one deletion — {@link SessionStore.compact} — removes superseded
 *   stream chunks and nothing else. Every implementation hands out events it will never
 *   change, and both implementations deep-freeze what they return, so a caller that tries to
 *   write to one throws instead of forking the log it was handed.
 * - **Claims.** A turn's claim on the user events it answers is itself in the log: the append
 *   of a `span.model_request_start` carrying `consumes` claims those ids (D9, issue #46), and
 *   {@link SessionStore.markProcessed} is the equivalent for writers that have not moved to
 *   that form yet. A claim is recorded once and never removed; `processed_at` on a user event
 *   is derived from it on every read. An event that is claimed cannot be claimed again.
 * - **Durability per append.** An append is one transaction. `initial_events` on
 *   {@link SessionStore.createSession} are part of the session's creation transaction, not
 *   appends that follow it.
 * - **Fencing.** A write that carries `fence: { partition, epoch }` is accepted only while the
 *   lease on that partition is live and holds that epoch; otherwise it fails with
 *   {@link FencedError}. Fencing is opt-in: a write without a fence is never refused. The brain
 *   always fences; the API server, which appends a user message before it knows who owns the
 *   partition, does not have to.
 * - **Turn state.** {@link SessionStore.getTurnState} answers from the log alone — no lease, no
 *   clock, no in-memory bookkeeping — so it means the same thing in every implementation, and
 *   a server that just took a partition over can ask it before it has done anything.
 * - **Signals are hints.** {@link SessionStore.signalPartition} delivers at most once, to the
 *   listeners attached at that moment; a signal nobody is listening for is dropped. Nothing may
 *   depend on receiving one: recovery runs {@link SessionStore.findSessionsNeedingWork}.
 * - **Async.** Every method is asynchronous. Nothing may assume synchronous delivery: a store
 *   built on `LISTEN`/`NOTIFY`, or one that commits a transaction before it notifies, delivers
 *   subscriptions and signals a tick later than it stored the event.
 *
 * See `AGENTS.md` for how to run the conformance suite against a new implementation. This
 * interface is a contract between packages: the Postgres store, the brain and the server are
 * written against it, so it changes only when v1 as a whole does.
 */
export interface SessionStore {
  // ------------------------------------------------------------------ agents

  /**
   * Create an agent, with `created_at` and `updated_at` set to the clock's current instant.
   *
   * @param input the agent's fields, as `POST /v1/agents` receives them
   */
  createAgent(input: CreateAgentRequest): Promise<Agent>

  /** Read one agent, or `null` when no agent has that id. */
  getAgent(agentId: AgentId): Promise<Agent | null>

  /**
   * List agents, oldest first, ordered by `(created_at, id)`.
   *
   * `page` and `next_page` are the protocol's opaque keyset cursor, passed through untouched.
   */
  listAgents(options?: ListAgentsOptions): Promise<ListAgentsResponse>

  /**
   * Apply a partial update to an agent and return it, or `null` when no agent has that id.
   *
   * An omitted field keeps its stored value; `null` clears a nullable one. `updated_at` is set
   * from the clock. Sessions snapshot the agent at creation, so this never rewrites the
   * configuration an existing session runs with.
   */
  updateAgent(agentId: AgentId, update: UpdateAgentRequest): Promise<Agent | null>

  // ---------------------------------------------------------------- sessions

  /**
   * Create a session that snapshots the agent's `{ id, name, model, system }`.
   *
   * `initial_events` are appended in the creation transaction, with `seq` starting at `1` and
   * `processed_at: null`. The session is `idle` with no status events.
   *
   * @throws AgentNotFoundError when `agentId` names no agent
   */
  createSession(agentId: AgentId, options?: CreateSessionOptions): Promise<Session>

  /** Read a session's header (the log's metadata, not its events), or `null` when it does not exist. */
  getSession(sessionId: SessionId): Promise<Session | null>

  /**
   * List sessions, newest first, ordered by `(created_at, id)` descending.
   *
   * `page` and `next_page` are the protocol's opaque keyset cursor, passed through untouched.
   */
  listSessions(options?: ListSessionsOptions): Promise<ListSessionsResponse>

  /**
   * Change a session's title, and return the session as it is afterwards — or `null` when no
   * session has that id.
   *
   * The title is the session's label: what a session list shows to tell one chat from another.
   * A frontend that knows it at creation passes it to {@link SessionStore.createSession}; one
   * that does not — anything that names a chat after the first message — sets it here once the
   * message is stored. An omitted `title` keeps the stored one, and `null` clears it, exactly
   * as {@link SessionStore.updateAgent} treats its nullable fields.
   *
   * `updated_at` is set from the clock. Nothing else moves: not the status, not the agent
   * snapshot, and not the log — a title is metadata about a session, never a reason to run one.
   *
   * The title is stored as given, like every other input (see the notes on validation below):
   * a caller sets it from the protocol's `Session.title`, and one that derives a title from a
   * message is the one that has to fit it into `SESSION_TITLE_MAX_LENGTH`.
   */
  updateSession(sessionId: SessionId, update: UpdateSessionRequest): Promise<Session | null>

  // ----------------------------------------------------------------- events

  /**
   * Append events to a session's log, in order, and return them as stored.
   *
   * The store assigns `seq` and the internal creation time in one transaction, and `id` too
   * unless the event carries one of its own. A user event is stored with `processed_at: null`;
   * every other event is stored with `processed_at` set to the clock's current instant. The
   * session's `status` follows `session.status_running` and `session.status_idle` in the same
   * transaction, its `updated_at` advances, and subscribers are notified after the append is
   * committed.
   *
   * The input carries only the fields the caller owns — an `AppendableEvent` is a `StoredEvent`
   * without the assigned ones. Inputs are stored as given and not validated: callers validate
   * with the protocol schemas.
   *
   * ## Stored chunks, claims and supersession
   *
   * Three of the shapes an append can carry since D9 (issue #46) do more than land in the log
   * — each in the same transaction as the events themselves, so a reader never sees half of
   * any of them:
   *
   * - **Stored chunks.** An `event_start` or `event_delta` in its stored form is an ordinary
   *   event: it gets a `seq` and a `processed_at` like everything else, is delivered to
   *   subscribers like everything else, and is skipped by replay once superseded. It is the
   *   same shape the stream-only preview of the same name carries, plus the envelope.
   * - **`consumes`.** A `span.model_request_start` whose `consumes` names user events claims
   *   them: the store records a claim per id, and from then on those events read with
   *   `processed_at` set (see {@link SessionStore.markProcessed}) and no longer count as
   *   pending. Every id must be a pending `user.message` / `user.interrupt` of this session
   *   that no earlier claim took, or the whole append is refused with
   *   {@link ClaimConflictError} and nothing is stored.
   * - **`supersedes`.** An `agent.message` or `span.model_request_end` that carries
   *   `supersedes` records the chunk range it replaces: replay skips the range and
   *   {@link SessionStore.compact} deletes it after the retention window. The range has to lie
   *   within this session and end before the superseding event's own `seq`, or the append is
   *   refused with a `RangeError`.
   *
   * ## Supplying an id
   *
   * An event may bring its own `id` (see {@link AppendableEvent}), and the store then writes it
   * under exactly that id. This is what lines a stored `agent.message` up with the previews
   * that came before it: the brain generates a `sevt_` id, publishes `event_start` and
   * `event_delta` under it with {@link SessionStore.publishEphemeral}, and appends the final
   * event with the same id — so a client replaces the preview with the stored message by id,
   * and the two are one event throughout.
   *
   * An id has to be one the store can use, and an append that carries one it cannot is refused
   * whole — nothing from that batch is stored:
   *
   * - it must be a valid `sevt_` id; anything else is a `RangeError`;
   * - it must not already be in the store, and must not appear twice in this batch; either way
   *   the append fails with {@link DuplicateEventIdError}. An event id identifies one event for
   *   the whole store rather than one per session, so the id of an event in another session is
   *   taken too — `PostgresSessionStore` enforces that with a unique constraint on `events.id`.
   *
   * `seq` stays the store's either way: a supplied id changes which event an append writes,
   * not where in the log it lands.
   *
   * @throws SessionNotFoundError when the session does not exist
   * @throws FencedError when `options.fence` is not the partition's current live lease
   * @throws DuplicateEventIdError when an event id is already stored, or repeated in the batch
   * @throws ClaimConflictError when a `consumes` id is not a pending user event of this session
   * @throws RangeError when an event's `id` is not a valid event id, or when a `supersedes`
   *   range does not lie within this session before the superseding event's own `seq`
   */
  appendEvents(
    sessionId: SessionId,
    events: AppendableEvent[],
    options?: AppendEventsOptions,
  ): Promise<StoredEvent[]>

  /**
   * Claim user events, and return those that were still pending.
   *
   * This is the pre-D9 way to record a turn's claim, kept working for the writers that have not
   * moved to `consumes` yet (D9, issue #46): it records a claim per id — the same claim
   * {@link SessionStore.appendEvents} records for a `span.model_request_start` — and from then
   * on those events read with `processed_at` set to the clock's instant at the claim. Nothing
   * about the stored events changes; a claim is a fact recorded beside them, not an edit.
   *
   * Events that are already claimed, ids that name no event of this session, and ids of events
   * that are not user events are ignored, so claiming twice is a no-op — the call is a claim,
   * not an assertion, and what it returns is what this call took.
   *
   * @throws SessionNotFoundError when the session does not exist
   * @throws FencedError when `options.fence` is not the partition's current live lease
   */
  markProcessed(
    sessionId: SessionId,
    eventIds: EventId[],
    options?: MarkProcessedOptions,
  ): Promise<UserEvent[]>

  /**
   * Read a page of the log.
   *
   * `order` defaults to `asc` (oldest first). `after_seq` keeps only events with a greater
   * `seq`, whatever the order; `types` keeps only those event types (`[]` keeps none). `page`
   * resumes at a `seq` position. `next_page` is `null` on the last page.
   *
   * This is the replay read, so since D9 (issue #46) it **skips superseded chunks**: a stored
   * `event_start` / `event_delta` whose `seq` a recorded `supersedes` range covers is left out,
   * which is what lets a client resuming by `seq` see a reply once, whole, however far into the
   * stream it was when it disconnected. The chunks of a message still in flight are not
   * superseded by anything, so they are included. Cursors stay `seq` positions and skipping
   * leaves gaps in them; nothing else about reading changes. Pass `includeSuperseded: true` to
   * read the raw log instead — for debugging and tests.
   *
   * @throws SessionNotFoundError when the session does not exist
   * @throws RangeError when `page` is not a `seq` cursor
   */
  listEvents(sessionId: SessionId, options?: ListEventsOptions): Promise<ListEventsResponse>

  /**
   * The user events waiting to be folded into a turn: `processed_at` is `null`, ordered by `seq`.
   *
   * The brain reads these at the start of every iteration of its loop and
   * {@link SessionStore.markProcessed} them before it acts on them.
   *
   * @throws SessionNotFoundError when the session does not exist
   */
  getPendingUserEvents(sessionId: SessionId): Promise<UserEvent[]>

  /**
   * What the session's turn looks like, from the log alone.
   *
   * `idle` when no turn is open — the last status event is `session.status_idle`, or there is
   * none. Otherwise a turn is open, and `state` says which kind it is:
   *
   * - `running` — a model request is in flight (a `span.model_request_start` with no matching
   *   `span.model_request_end`). `openSpan` is that start event.
   * - `unfinished` — nothing is in flight. Either the brain holding the turn is gone, or it
   *   wrote `session.status_rescheduled` and never came back — a reschedule does not end a turn,
   *   only a `session.status_idle` does.
   *
   * A brain that finds anything other than `idle` is looking at a turn it did not start: it
   * closes `openSpan` if there is one (`span.model_request_end` with `error.type: "brain_lost"`,
   * pointing at it) and runs the turn again.
   *
   * @throws SessionNotFoundError when the session does not exist
   */
  getTurnState(sessionId: SessionId): Promise<TurnState>

  /**
   * Delete the stored stream chunks a supersession covers — older than the retention window —
   * and return how many went.
   *
   * This is physical compaction, and the **only** way an event is ever deleted from a log
   * (D9, issue #46). It deletes stored `event_start` / `event_delta` events whose `seq` a
   * recorded `supersedes` range covers, and nothing else, ever: a chunk that is not superseded
   * (one still in flight) and a superseded chunk inside the window stay where they are.
   *
   * Deleting changes no reader's answer: replay with
   * {@link SessionStore.listEvents} already skips superseded chunks, so correctness does not
   * depend on this having run, or on the window's length. The window is what keeps raw chunks
   * around for debugging and what keeps deletes off the append path; a server runs this
   * periodically with its retention window (`OPENHARNESS_DELTA_RETENTION_MS`).
   *
   * Idempotent, and safe to run from several instances at once: whoever deletes a row first
   * owns it, and everyone else simply finds fewer rows. `seq` values are never reused — a
   * superseded chunk is always followed by the event that superseded it, which is not a chunk
   * and is never deleted — so gaps in the sequence are the normal state of a compacted log.
   *
   * @param options.olderThan the cutoff: only a chunk the store wrote strictly before this
   *   instant is deleted. A `Date`, or milliseconds since the Unix epoch.
   * @throws RangeError when `olderThan` is not a valid instant
   */
  compact(options: CompactOptions): Promise<number>

  // ------------------------------------------------------- live subscription

  /**
   * Listen to everything that happens in a session: stored events as they are appended, and
   * ephemeral ones as they are published, interleaved in the order they occurred.
   *
   * Delivery may be asynchronous, and a listener is never called for an event that was already
   * in the log when the subscription was established: a client that needs the history reads it
   * with {@link SessionStore.listEvents} first (or passes `after_seq`) and subscribes after.
   * Every listener is called for every event, in `seq` order; the order the listeners are
   * called in is not part of the contract, and a listener that throws does not affect the store
   * or the other listeners.
   *
   * @returns the function that ends the subscription
   */
  subscribe(sessionId: SessionId, listener: SessionEventListener): Promise<Unsubscribe>

  /**
   * Publish a stream-only event — an `event_start` or an `event_delta` — to a session's
   * subscribers without storing it.
   *
   * Ephemeral events are a display aid, not the record: the log holds the event they preview,
   * under the same `sevt_` id — the one the append that stores it supplies (see
   * {@link AppendableEvent}).
   *
   * Publishing also maintains the session's in-flight preview, which is what lets a connection
   * that opens mid-stream see the text already sent: an `event_start` begins one, and each
   * `event_delta` for that id extends it. {@link SessionStore.getPreview} is the read.
   *
   * @throws SessionNotFoundError when the session does not exist
   */
  publishEphemeral(sessionId: SessionId, event: StreamOnlyEvent): Promise<void>

  /**
   * The preview in flight for the session's current `agent.message`: the `sevt_` id its
   * `event_start` announced, and the text its `event_delta`s have accumulated so far — or
   * `null` when nothing is in flight.
   *
   * This is the read a connection that arrives late needs. Previews are delivered only to the
   * listeners attached when they are published, so a client that was reloaded, or that opened
   * a second tab, cannot see what the deltas before it contained; the store keeps the
   * accumulation instead, and the server sends it as `event_start` plus one `event_delta`
   * before it follows live.
   *
   * ## The lifecycle
   *
   * {@link SessionStore.publishEphemeral} with an `event_start` begins a preview: `eventId` is
   * the id it announced and `text` is empty. Each `event_delta` published for that id appends
   * its text, in publish order, so `text` is what a listener attached at that moment would have
   * accumulated. There is **at most one preview per session**, and a new `event_start`
   * replaces the previous one.
   *
   * The preview ends — this answers `null` from then on — when either
   *
   * - **the event it previews is stored**: an append carrying that id, which is how the
   *   `agent.message` the deltas were for takes the preview's place (see
   *   {@link AppendableEvent}); or
   * - **a `span.model_request_end` is appended** for the session, which ends the model request
   *   the preview belonged to whether or not it produced a message.
   *
   * Deltas stay best-effort, and so does the preview: a delta for an id that is not the current
   * preview's is ignored rather than starting one, and one an implementation had to drop (a
   * Postgres store cannot publish an ephemeral event bigger than a `NOTIFY` payload) is not
   * accumulated either — what this returns is what was actually published.
   *
   * @throws SessionNotFoundError when the session does not exist
   */
  getPreview(sessionId: SessionId): Promise<SessionPreview | null>

  // -------------------------------------------------------- scheduler support

  /**
   * Signal a partition that a session needs attention: new user events to run (`work`), or a
   * turn to abort (`interrupt`).
   *
   * The signal reaches the listeners attached to that partition at that moment, once each; if
   * none are attached it is dropped, because signals are a latency optimization and not a
   * durable queue. Nothing may depend on one arriving — see
   * {@link SessionStore.findSessionsNeedingWork}.
   */
  signalPartition(partition: number, signal: PartitionSignalInput): Promise<void>

  /**
   * Listen to the signals of one partition, which is what a partition's owner does.
   *
   * @returns the function that ends the subscription
   */
  onPartitionSignal(partition: number, listener: PartitionSignalListener): Promise<Unsubscribe>

  /**
   * The sessions in `partitions` that need work: pending user events, or an open turn.
   *
   * This is recovery's starting point, and it is deliberately log-derived — it does not consult
   * leases, signals or any other transient state, so it answers the same thing for a partition
   * that has just been taken over as it does for one that is running normally. A session with
   * pending user events *and* an open turn is returned once.
   *
   * The result is ordered by `(created_at, id)` ascending: oldest session first.
   */
  findSessionsNeedingWork(partitions: readonly number[]): Promise<SessionId[]>

  // ------------------------------------------------------------ partition leases

  /**
   * Take the lease on a partition, or return `null` when a live lease holds it.
   *
   * The lease is granted when the partition is unleased, when the previous lease has expired,
   * or when the same owner asks again — in which case the epoch still advances, because every
   * successful acquire opens a new tenure. The returned epoch is what a fenced write must
   * carry, and the lease expires `ttlMs` after the clock's current instant (a lease is expired
   * from the instant `expires_at` names, inclusive).
   *
   * @throws RangeError when `ttlMs` is not a positive, finite number
   */
  acquirePartition(partition: number, owner: string, ttlMs: number): Promise<PartitionLease | null>

  /**
   * Extend a lease by `ttlMs`, from the clock's current instant.
   *
   * @returns `false` when the lease is not held by this owner at this epoch any more — expired,
   *   released, or taken over — in which case the owner has been fenced and must re-acquire
   */
  renewPartition(partition: number, owner: string, epoch: number, ttlMs: number): Promise<boolean>

  /**
   * Give a lease up, and advance the partition's epoch so that writes still in flight with the
   * released epoch are fenced.
   *
   * Releasing a lease this owner does not hold is a no-op: release is not an assertion, so a
   * shutdown path can call it unconditionally.
   */
  releasePartition(partition: number, owner: string, epoch: number): Promise<void>

  /**
   * The partition's current epoch: the one a fenced write must carry.
   *
   * It starts at `1` on the first acquire and advances on every acquire and every release, so it
   * never repeats a tenure. `0` means the partition has never been leased, and no fence can
   * match it: an epoch has to have been handed out by a successful acquire.
   */
  currentEpoch(partition: number): Promise<number>
}

/**
 * The events a caller may append: a `StoredEvent` without the fields the store assigns.
 *
 * Derived from the protocol's union rather than restated, so adding an event type to the
 * protocol makes it appendable without touching this package. The omitted fields are the
 * store's to write — `seq` identifies the event's position in the log, and `processed_at` is
 * `null` for user events and the clock's instant for everything else — with one exception:
 * `id`, which a caller may supply and the store then stores as given.
 *
 * Supplying an id is how a stored event keeps the identity its stream-only previews already
 * had: the brain mints a `sevt_` id, publishes `event_start` and `event_delta` under it with
 * {@link SessionStore.publishEphemeral}, and appends the final `agent.message` carrying the
 * same id. The id it supplies has to be a valid event id and one the store does not already
 * hold, or the append is refused whole; see {@link SessionStore.appendEvents}.
 */
export type AppendableEvent = DistributiveOmit<StoredEvent, 'id' | 'seq' | 'processed_at'> & {
  /**
   * The event's id, when the caller already has one — the id its previews were published
   * under. Omitted, the store generates one, as it does for every event that does not
   * preview itself.
   */
  readonly id?: EventId
}

/** `Omit` that distributes over a union, so the members of a discriminated union stay discriminated. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** The in-flight preview of a session's current `agent.message`; what {@link SessionStore.getPreview} returns. */
export interface SessionPreview {
  /** The `sevt_` id the previewing `event_start` announced — the id its deltas carry. */
  readonly eventId: EventId
  /**
   * Every `event_delta` text published for that id so far, concatenated in publish order.
   *
   * It is a *prefix* of the `content[index].text` of the `agent.message` the id will be stored
   * under: deltas are best-effort, so one that was dropped never makes it here, and the text of
   * blocks other than index `0` is not distinguished — a preview is one string.
   */
  readonly text: string
}

/** What {@link SessionStore.updateSession} changes. */
export interface UpdateSessionRequest {
  /**
   * The session's title: a string to set, `null` to clear, or omitted to keep what is stored.
   * It is written as given; the protocol's `SESSION_TITLE_MAX_LENGTH` is the caller's business.
   */
  readonly title?: string | null
}

/** Fields to give {@link SessionStore.createSession} beyond the agent. */
export interface CreateSessionOptions {
  /** The session title, or `null` for none. */
  readonly title?: string | null
  /** Caller metadata, stored with the session. */
  readonly metadata?: Metadata
  /**
   * Events to append in the creation transaction, in order. They are stored exactly as events
   * sent later to the events endpoint would be, so they are user events and start unprocessed.
   */
  readonly initial_events?: UserEventInput[]
}

/** Query of {@link SessionStore.listAgents}. */
export interface ListAgentsOptions {
  /** Page size; defaults to `DEFAULT_PAGE_LIMIT` and is capped at `MAX_PAGE_LIMIT`. */
  readonly limit?: number
  /** `next_page` from a previous call, passed back untouched. */
  readonly page?: string
}

/** Query of {@link SessionStore.listSessions}. */
export interface ListSessionsOptions {
  /** Page size; defaults to `DEFAULT_PAGE_LIMIT` and is capped at `MAX_PAGE_LIMIT`. */
  readonly limit?: number
  /** `next_page` from a previous call, passed back untouched. */
  readonly page?: string
  /** Return only sessions created with this agent. The protocol's `agent_id` filter. */
  readonly agentId?: AgentId
}

/** Query of {@link SessionStore.listEvents}. */
export interface ListEventsOptions {
  /** `asc` (default, oldest first) or `desc`. */
  readonly order?: ListOrder
  /** Page size; defaults to `DEFAULT_PAGE_LIMIT` and is capped at `MAX_PAGE_LIMIT`. */
  readonly limit?: number
  /** `next_page` from a previous call: a `seq` position, the last event of that page. */
  readonly page?: string
  /** Return only events with a greater `seq`; `0` means "from the start of the log". */
  readonly afterSeq?: number
  /** Return only these event types; an empty array returns none. Omit for all of them. */
  readonly types?: StoredEventType[]
  /**
   * Return superseded chunks too. `false` (the default) makes this the replay read, which
   * skips stored `event_start` / `event_delta` events a recorded `supersedes` range covers;
   * `true` reads the raw log — for debugging and tests, not for a client's transcript.
   */
  readonly includeSuperseded?: boolean
}

/** Options of {@link SessionStore.compact}. */
export interface CompactOptions {
  /**
   * The retention cutoff: a stored chunk covered by a supersession is deleted only when the
   * store wrote it strictly before this instant. A `Date`, or milliseconds since the epoch.
   */
  readonly olderThan: Date | number
}

/** Options of {@link SessionStore.appendEvents}. */
export interface AppendEventsOptions {
  /**
   * The partition lease this write is made under. Omitted, the write is not fenced — which is
   * how the API appends a user event: it does not know who owns the partition, and the owner
   * finds the event through {@link SessionStore.findSessionsNeedingWork} if the signal is lost.
   */
  readonly fence?: PartitionFence
}

/** Options of {@link SessionStore.markProcessed}. */
export interface MarkProcessedOptions {
  /** The partition lease this write is made under; see {@link AppendEventsOptions.fence}. */
  readonly fence?: PartitionFence
}

/**
 * Proof that a write is made by the partition's current owner.
 *
 * `partition` is the one the protocol's `partitionOf(sessionId)` computes. `epoch` is what
 * {@link SessionStore.acquirePartition} handed out; a write carrying an older one is refused
 * with {@link FencedError}.
 */
export interface PartitionFence {
  /** The partition the writing session belongs to. */
  readonly partition: number
  /** The epoch the writer's lease gave it. */
  readonly epoch: number
}

/** A lease on a partition: who holds it, at which epoch, until when. */
export interface PartitionLease {
  /** The leased partition. */
  readonly partition: number
  /** The leaseholder's id — one per server instance, stable for its lifetime. */
  readonly owner: string
  /** The epoch of this tenure: what fenced writes must carry. */
  readonly epoch: number
  /** When the lease lapses, `ttlMs` after it was acquired or last renewed. */
  readonly expires_at: Timestamp
}

/** What a partition is being signalled about. */
export type PartitionSignalKind =
  /** The session has user events waiting: run its turn. */
  | 'work'
  /** The user asked the session to stop: abort the running turn. */
  | 'interrupt'

/** The signal to send, as {@link SessionStore.signalPartition} receives it. */
export interface PartitionSignalInput {
  /** The session the signal is about; it lives in the signalled partition. */
  readonly sessionId: SessionId
  /** What the owner should do. */
  readonly kind: PartitionSignalKind
}

/** The signal a partition's owner receives. */
export interface PartitionSignal {
  /** The partition that was signalled. */
  readonly partition: number
  /** The session the signal is about. */
  readonly sessionId: SessionId
  /** What the owner should do. */
  readonly kind: PartitionSignalKind
}

/** What `getTurnState` reports about the session's turn. */
export type TurnStateKind =
  /** No turn is open: the agent is waiting for input. */
  | 'idle'
  /** A turn is open and a model request is in flight. */
  | 'running'
  /** A turn is open with nothing in flight: the brain that opened it is gone. */
  | 'unfinished'

/** The state of a session's turn, and the span a recovering brain has to close. */
export interface TurnState {
  /** Which of the three states the log is in; see {@link SessionStore.getTurnState}. */
  readonly state: TurnStateKind
  /**
   * The `span.model_request_start` that no `span.model_request_end` has closed, or `null` when
   * there is none. It is not `null` exactly when `state` is `running`.
   */
  readonly openSpan: ModelRequestStartEvent | null
}

/** Called for every event of a subscribed session, stored or ephemeral. */
export type SessionEventListener = (event: StreamEvent) => void | Promise<void>

/** Called for every signal of a subscribed partition. */
export type PartitionSignalListener = (signal: PartitionSignal) => void | Promise<void>

/** Ends a subscription; what {@link SessionStore.subscribe} returns. Calling it twice is a no-op. */
export type Unsubscribe = () => void
