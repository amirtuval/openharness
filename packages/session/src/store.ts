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
   * @throws RangeError when an event's `id` is not a valid event id
   */
  appendEvents(
    sessionId: SessionId,
    events: AppendableEvent[],
    options?: AppendEventsOptions,
  ): Promise<StoredEvent[]>

  /**
   * Mark user events as processed, and return those that were still pending.
   *
   * `processed_at` is set to the clock's current instant. Events that are already processed, ids
   * that name no event of this session, and ids of events that are not user events are ignored,
   * so marking twice is a no-op — the call is a claim, not an assertion, and what it returns is
   * what this call took.
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
   * @throws SessionNotFoundError when the session does not exist
   */
  publishEphemeral(sessionId: SessionId, event: StreamOnlyEvent): Promise<void>

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
