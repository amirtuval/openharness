import {
  DEFAULT_EVENT_ORDER,
  DEFAULT_PARTITION_COUNT,
  DEFAULT_USER_THEME,
  EVENT_TYPES,
  StoredEventSchema,
  encodeKeyCursor,
  encodeSeqCursor,
  MAX_MODES_PER_USER,
  SUMMARY_MODEL_SAME_AS_CHAT,
  newAgentId,
  newEventId,
  newModeId,
  newProviderCredentialId,
  newSessionId,
  partitionOf,
  type Agent,
  type AgentId,
  type CreateAgentRequest,
  type CreateModeRequest,
  type EventId,
  type KeyCursor,
  type KeyCursorPosition,
  type ListAgentsResponse,
  type ListEventsResponse,
  type ListSessionsResponse,
  type Mode,
  type ModeId,
  type ModelRequestStartEvent,
  type NextPage,
  type ProviderCredential,
  type Session,
  type SessionId,
  type StoredEvent,
  type Supersedes,
  type SummaryModel,
  type Timestamp,
  type UpdateAgentRequest,
  type UpdateModeRequest,
  type UserEvent,
  type UserId,
  type UserPreferences,
  type UserTheme,
} from '@openharness/protocol'

import { type Clock, systemClock, timestampAt } from './clock'
import type {
  CredentialKey,
  CredentialStore,
  ListCredentialsOptions,
  SealedProviderCredential,
  UpsertCredentialInput,
} from './credentials'
import {
  AgentNotFoundError,
  ClaimConflictError,
  DuplicateEventIdError,
  DuplicateModeNameError,
  FencedError,
  ModeLimitReachedError,
  SessionNotFoundError,
} from './errors'
import {
  assertRewinds,
  carriesConsumes,
  cutoffOf,
  isSuperseded,
  isUserEventType,
  supersessionsOf,
  type AppendedEvent,
  type SupersessionRecord,
} from './events'
import { deepFreeze } from './freeze'
import {
  assertEventIds,
  assertLivenessWindow,
  assertTtl,
  decodeKeyPage,
  decodeSeqPage,
  effectiveSessionConfig,
  pageSize,
  usageWindowOf,
} from './inputs'
import type {
  AppendableEvent,
  AppendEventsOptions,
  AuthSessionId,
  AuthSessionRevocationListener,
  CompactOptions,
  CreateSessionOptions,
  ListAgentsOptions,
  ListEventsOptions,
  ListModelRequestsOptions,
  ListSessionsOptions,
  ModelRequestUsage,
  OwnerScope,
  UnscopedListEventsOptions,
  PartitionFence,
  PartitionLease,
  PartitionSignal,
  PartitionSignalInput,
  PartitionSignalListener,
  SessionEventListener,
  SessionStore,
  TurnState,
  TurnStateKind,
  Unsubscribe,
  UpdateSessionRequest,
} from './store'

/**
 * The in-memory stores: `InMemorySessionStore` here, and `InMemoryCredentialStore` below it —
 * the test fakes for every other package, and the reference behaviour for the contracts in
 * `store.ts` and `credentials.ts`.
 *
 * The session store holds everything in `Map`s — agents, sessions and their logs, per-user
 * preferences (#111), leases, scheduler memberships (#122), listeners — and is
 * single-process by construction: two instances share nothing, and a lease or a membership
 * in one is invisible to the other. That is the one place it cannot be Postgres-like, so the
 * conformance suite only tests what a shared store can also do.
 *
 * Four implementation details are worth knowing, because they are choices the contract leaves
 * open and tests may rely on:
 *
 * - **Time is injectable** ({@link InMemorySessionStoreOptions.now}). Timestamps, event ids and
 *   lease expiry all come from that clock, so a test can move time forward instead of waiting.
 * - **Delivery is asynchronous.** Stored events and partition signals reach listeners in a
 *   microtask, not while the append is still on the stack, which is the shape a
 *   `LISTEN`/`NOTIFY` store will have. Awaiting the call that appended an event is enough for
 *   the listener to have seen it, but the contract does not promise that: read state, do not
 *   assume a listener ran.
 * - **A deleted session is announced.** `deleteSession` removes the session's state first and
 *   then hands each of its listeners one final `session.deleted` event, in a microtask like
 *   every other delivery, and forgets the subscription — a subscriber learns the session is
 *   gone instead of waiting for events that can never come.
 * - **Everything handed out is a copy, and events are deep-frozen.** Read a session, an agent
 *   or an event and you own it; mutating a session or an agent cannot reach into the store.
 *   Events go further, because the log is immutable (D9, issue #46): what is stored is frozen
 *   — and so is every copy handed out — so writing to one throws instead of forking the log
 *   the caller holds from the log the store wrote. Each appended event is also rebuilt through
 *   `StoredEventSchema`, so what comes back out is exactly the wire shape — and an event the
 *   schema rejects leaves the log untouched, because an append is all-or-nothing.
 */
export class InMemorySessionStore implements SessionStore {
  readonly #clock: Clock

  readonly #partitionCount: number

  readonly #agents = new Map<string, Agent>()

  /**
   * Every user's modes, keyed by id — the in-memory `modes` table (epic #245, M6). The owner is
   * on the mode itself, so a scoped read filters rather than indexing; a user holds at most
   * `MAX_MODES_PER_USER` of them, which is why the map is not paginated.
   */
  readonly #modes = new Map<string, Mode>()

  readonly #sessions = new Map<string, SessionRecord>()

  /**
   * Every id in the log, across sessions: an event id is one event's identity for the whole
   * store, so a caller-supplied id has to be free here and not only in its own session. The
   * Postgres store gets the same guarantee from the primary key on `events.id`.
   */
  readonly #eventIds = new Set<EventId>()

  /**
   * Every claim recorded so far, keyed by the claimed event's id — the in-memory
   * `event_claims` table (D9, issue #46). Claims are facts about user events: a claim makes
   * the event read with a `processed_at`, takes it out of the pending list, and can never be
   * taken again. Nothing here is ever updated or removed; compaction does not touch claims.
   */
  readonly #claims = new Map<EventId, ClaimRecord>()

  /** The chunk ranges each session's stored events have superseded, oldest first. */
  readonly #supersessions = new Map<SessionId, SupersessionRecord[]>()

  readonly #leases = new Map<number, LeaseRecord>()

  /**
   * The scheduler instances that have heartbeated, by id, with the clock instant of their
   * last announcement — the in-memory `scheduler_instances` table (issue #122). A membership
   * is live while that instant is within the window a reader asks for; nothing else is kept,
   * because nothing else is needed.
   */
  readonly #instances = new Map<string, number>()

  readonly #sessionListeners = new Map<string, Set<SessionEventListener>>()

  readonly #partitionListeners = new Map<number, Set<PartitionSignalListener>>()

  /**
   * Everyone listening for auth-session revocations (epic #65, issue #76). One set for the
   * whole store rather than a map: unlike a session's events or a partition's signals, a
   * revocation has no channel to key on — the notification names the session itself.
   */
  readonly #revocationListeners = new Set<AuthSessionRevocationListener>()

  /**
   * The settings each user has saved, keyed by user id — the in-memory `user_preferences`
   * table (#111, epic #116 U1). One entry per user who ever wrote one; a user who never did
   * is absent, and reads as the protocol's default rather than as an error.
   */
  readonly #preferences = new Map<UserId, PreferencesRecord>()

  constructor(options: InMemorySessionStoreOptions = {}) {
    this.#clock = options.now ?? systemClock
    this.#partitionCount = options.partitionCount ?? DEFAULT_PARTITION_COUNT
  }

  // ------------------------------------------------------------------ agents

  createAgent(input: CreateAgentRequest, ownerId: UserId): Promise<Agent> {
    const now = this.#clock()
    const at = timestampAt(now)
    const agent: Agent = {
      id: newAgentId(now),
      type: 'agent',
      owner_id: ownerId,
      name: input.name,
      description: input.description ?? null,
      model: { id: input.model.id },
      system: input.system ?? null,
      created_at: at,
      updated_at: at,
    }
    this.#agents.set(agent.id, agent)
    return resolved(clone(agent))
  }

  getAgent(agentId: AgentId, options: OwnerScope): Promise<Agent | null> {
    const agent = this.#agents.get(agentId)
    if (agent === undefined || !matchesOwner(agent, options)) {
      return resolved(null)
    }
    return resolved(clone(agent))
  }

  listAgents(options: ListAgentsOptions): Promise<ListAgentsResponse> {
    const cursor = options.page === undefined ? null : decodeKeyPage(options.page)
    const agents = [...this.#agents.values()]
      .filter((agent) => matchesOwner(agent, options))
      .sort(compareKeys)
    const { data, next_page } = paginate(agents, pageSize(options.limit), cursor, 'asc')
    return resolved({ data: data.map(clone), next_page })
  }

  updateAgent(agentId: AgentId, update: UpdateAgentRequest): Promise<Agent | null> {
    const agent = this.#agents.get(agentId)
    if (agent === undefined) {
      return resolved(null)
    }
    const updated: Agent = {
      ...agent,
      name: update.name ?? agent.name,
      description: update.description === undefined ? agent.description : update.description,
      model: { id: update.model?.id ?? agent.model.id },
      system: update.system === undefined ? agent.system : update.system,
      updated_at: timestampAt(this.#clock()),
    }
    this.#agents.set(agentId, updated)
    return resolved(clone(updated))
  }

  // ------------------------------------------------------------------- modes

  createMode(input: CreateModeRequest, ownerId: UserId): Promise<Mode> {
    const owned = [...this.#modes.values()].filter((mode) => mode.owner_id === ownerId)
    if (owned.some((mode) => mode.name === input.name)) {
      throw new DuplicateModeNameError(ownerId, input.name)
    }
    if (owned.length >= MAX_MODES_PER_USER) {
      throw new ModeLimitReachedError(ownerId, MAX_MODES_PER_USER)
    }
    const now = this.#clock()
    const at = timestampAt(now)
    const mode: Mode = {
      id: newModeId(now),
      type: 'mode',
      owner_id: ownerId,
      name: input.name,
      model: input.model,
      reasoning_effort: input.reasoning_effort ?? null,
      system_prompt_addition: input.system_prompt_addition ?? null,
      created_at: at,
      updated_at: at,
    }
    this.#modes.set(mode.id, mode)
    return resolved(clone(mode))
  }

  getMode(modeId: ModeId, options: OwnerScope): Promise<Mode | null> {
    const mode = this.#modes.get(modeId)
    if (mode === undefined || !matchesOwner(mode, options)) {
      return resolved(null)
    }
    return resolved(clone(mode))
  }

  listModes(options: OwnerScope): Promise<Mode[]> {
    const modes = [...this.#modes.values()]
      .filter((mode) => matchesOwner(mode, options))
      .sort(compareKeys)
    return resolved(modes.map(clone))
  }

  updateMode(modeId: ModeId, update: UpdateModeRequest, options: OwnerScope): Promise<Mode | null> {
    const mode = this.#modes.get(modeId)
    if (mode === undefined || !matchesOwner(mode, options)) {
      return resolved(null)
    }
    const name = update.name ?? mode.name
    const collides = [...this.#modes.values()].some(
      (other) => other.id !== modeId && other.owner_id === mode.owner_id && other.name === name,
    )
    if (collides) {
      throw new DuplicateModeNameError(mode.owner_id, name)
    }
    const updated: Mode = {
      ...mode,
      name,
      model: update.model ?? mode.model,
      reasoning_effort:
        update.reasoning_effort === undefined ? mode.reasoning_effort : update.reasoning_effort,
      system_prompt_addition:
        update.system_prompt_addition === undefined
          ? mode.system_prompt_addition
          : update.system_prompt_addition,
      updated_at: timestampAt(this.#clock()),
    }
    this.#modes.set(modeId, updated)
    return resolved(clone(updated))
  }

  deleteMode(modeId: ModeId, options: OwnerScope): Promise<boolean> {
    const mode = this.#modes.get(modeId)
    if (mode === undefined || !matchesOwner(mode, options)) {
      return resolved(false)
    }
    this.#modes.delete(modeId)
    // A chat that followed the mode keeps running on the model it last ran: one transaction
    // with the delete in Postgres, and here the same step on the record the delete already
    // reached. The mode id is globally unique, so no owner filter is needed to find its chats.
    for (const record of this.#sessions.values()) {
      if (record.session.mode === modeId) {
        record.session.mode = null
      }
    }
    return resolved(true)
  }

  // ---------------------------------------------------------------- sessions

  createSession(agentId: AgentId | null, options: CreateSessionOptions): Promise<Session> {
    const agent = agentId === null ? null : (this.#agents.get(agentId) ?? null)
    // Somebody else's agent is not a session this caller may create: the same "not found" as
    // an id nothing names, so the answer does not leak that the agent exists (A4).
    if (agentId !== null && (agent === null || agent.owner_id !== options.ownerId)) {
      throw new AgentNotFoundError(agentId)
    }
    // What the session runs: the caller's model/system, or the agent's (issue #93). Throws
    // when neither side names a model — a model-first session needs one.
    const config = effectiveSessionConfig(agent, options)
    const now = this.#clock()
    const at = timestampAt(now)
    const session: Session = {
      id: newSessionId(now),
      type: 'session',
      owner_id: options.ownerId,
      status: 'idle',
      title: options.title ?? null,
      metadata: { ...options.metadata },
      model: config.model,
      system: config.system,
      mode: options.mode ?? null,
      agent:
        agent === null
          ? null
          : {
              id: agent.id,
              name: agent.name,
              model: { id: agent.model.id },
              system: agent.system,
            },
      created_at: at,
      updated_at: at,
    }
    const record: SessionRecord = { session, events: [], nextSeq: 1 }
    this.#sessions.set(session.id, record)
    // `initial_events` belong to the creation transaction: they are in the log before this
    // returns, so nothing can observe the session without them.
    this.#append(record, options.initial_events ?? [], now)
    return resolved(clone(session))
  }

  getSession(sessionId: SessionId, options: OwnerScope): Promise<Session | null> {
    const record = this.#sessions.get(sessionId)
    if (record === undefined || !matchesOwner(record.session, options)) {
      return resolved(null)
    }
    return resolved(clone(record.session))
  }

  getSessionUnscoped(sessionId: SessionId): Promise<Session | null> {
    const record = this.#sessions.get(sessionId)
    return resolved(record === undefined ? null : clone(record.session))
  }

  listSessions(options: ListSessionsOptions): Promise<ListSessionsResponse> {
    const cursor = options.page === undefined ? null : decodeKeyPage(options.page)
    const wanted = options.agentId
    const sessions = [...this.#sessions.values()]
      .map((record) => record.session)
      .filter((session) => matchesOwner(session, options))
      // The `agentId` filter narrows to sessions created with that agent; a model-first
      // session has no agent and no agent id to match (issue #93).
      .filter((session) => wanted === undefined || session.agent?.id === wanted)
    // Newest first: the list order is `(created_at, id)` descending, which is the order the
    // cursors seek into.
    sessions.sort((left, right) => compareKeys(right, left))
    const { data, next_page } = paginate(sessions, pageSize(options.limit), cursor, 'desc')
    return resolved({ data: data.map(clone), next_page })
  }

  updateSession(sessionId: SessionId, update: UpdateSessionRequest): Promise<Session | null> {
    const record = this.#sessions.get(sessionId)
    if (record === undefined) {
      return resolved(null)
    }
    if (update.title !== undefined) {
      record.session.title = update.title
    }
    record.session.updated_at = timestampAt(this.#clock())
    return resolved(clone(record.session))
  }

  deleteSession(sessionId: SessionId, options: OwnerScope): Promise<boolean> {
    const record = this.#sessions.get(sessionId)
    // Somebody else's session is not this caller's to delete: `false`, exactly as for an id
    // nothing has, so the answer does not leak that the session exists (A4).
    if (record === undefined || !matchesOwner(record.session, options)) {
      return resolved(false)
    }
    // The second deletion in this store, beside compaction: the whole log goes, so the state
    // a reader could reach goes with it — the events, the ids they held, their claims and
    // their supersessions — and nothing is left to find. `nextSeq` goes with the record; a
    // later session has a new id, and an id the deleted session held is free again.
    for (const entry of record.events) {
      this.#eventIds.delete(entry.event.id)
      this.#claims.delete(entry.event.id)
    }
    this.#supersessions.delete(sessionId)
    this.#sessions.delete(sessionId)
    // Announced after the state is gone, so a listener that runs cannot read a session that
    // no longer exists — and every subscription for the session ends with this delivery.
    const listeners = this.#sessionListeners.get(sessionId)
    this.#sessionListeners.delete(sessionId)
    if (listeners !== undefined) {
      const event = deepFreeze({
        type: EVENT_TYPES.sessionDeleted,
        session_id: sessionId,
      })
      for (const listener of [...listeners]) {
        queueMicrotask(() => void listener(event))
      }
    }
    return resolved(true)
  }

  // ------------------------------------------------------------- preferences

  getPreferences(userId: UserId): Promise<UserPreferences> {
    const stored = this.#preferences.get(userId)
    // A user who never saved one reads the protocol's defaults: no row, no error, one shape.
    return resolved(
      deepFreeze({
        default_model: stored?.defaultModel ?? null,
        theme: stored?.theme ?? DEFAULT_USER_THEME,
        compaction_threshold: stored?.compactionThreshold ?? null,
        summary_model: stored?.summaryModel ?? SUMMARY_MODEL_SAME_AS_CHAT,
        summary_max_passes: stored?.summaryMaxPasses ?? null,
      }),
    )
  }

  putPreferences(userId: UserId, preferences: UserPreferences): Promise<UserPreferences> {
    // One value per user: a second put replaces the first rather than accumulating, exactly
    // as the `user_preferences` row's `on conflict` decides in Postgres.
    this.#preferences.set(userId, {
      defaultModel: preferences.default_model,
      theme: preferences.theme,
      compactionThreshold: preferences.compaction_threshold,
      summaryModel: preferences.summary_model,
      summaryMaxPasses: preferences.summary_max_passes,
      updatedAtMs: this.#clock(),
    })
    return resolved(
      deepFreeze({
        default_model: preferences.default_model,
        theme: preferences.theme,
        compaction_threshold: preferences.compaction_threshold,
        summary_model: preferences.summary_model,
        summary_max_passes: preferences.summary_max_passes,
      }),
    )
  }

  // ----------------------------------------------------------------- events

  appendEvents(
    sessionId: SessionId,
    events: AppendableEvent[],
    options: AppendEventsOptions = {},
  ): Promise<StoredEvent[]> {
    const record = this.#requireSession(sessionId)
    this.#assertFence(options.fence, 'appendEvents')
    const stored = this.#append(record, events, this.#clock())
    for (const event of stored) {
      this.#deliver(sessionId, event)
    }
    return resolved(stored.map((event) => this.#share(event)))
  }

  listEvents(sessionId: SessionId, options: ListEventsOptions): Promise<ListEventsResponse> {
    const record = this.#requireSession(sessionId, options)
    return resolved(this.#readEvents(record, options))
  }

  listEventsUnscoped(
    sessionId: SessionId,
    options: UnscopedListEventsOptions = {},
  ): Promise<ListEventsResponse> {
    const record = this.#requireSession(sessionId)
    return resolved(this.#readEvents(record, options))
  }

  #readEvents(record: SessionRecord, options: UnscopedListEventsOptions): ListEventsResponse {
    const sessionId = record.session.id
    const order = options.order ?? DEFAULT_EVENT_ORDER
    const cursor = options.page === undefined ? null : decodeSeqPage(options.page)
    const afterSeq = options.afterSeq
    const types = options.types === undefined ? null : new Set<string>(options.types)
    let events = record.events.map((entry) => entry.event)
    if (options.includeSuperseded !== true) {
      const ranges = this.#supersessions.get(sessionId)
      events = events.filter((event) => !isSuperseded(event, ranges))
    }
    if (cursor !== null) {
      events = events.filter((event) =>
        order === 'asc' ? event.seq > cursor.seq : event.seq < cursor.seq,
      )
    }
    if (afterSeq !== undefined) {
      events = events.filter((event) => event.seq > afterSeq)
    }
    if (types !== null) {
      events = events.filter((event) => types.has(event.type))
    }
    if (order === 'desc') {
      events.reverse()
    }
    const limit = pageSize(options.limit)
    const data = events.slice(0, limit)
    const next_page = events.length > limit ? encodeSeqCursor(lastOf(data).seq) : null
    return { data: data.map((event) => this.#share(event)), next_page }
  }

  getPendingUserEvents(sessionId: SessionId): Promise<UserEvent[]> {
    const record = this.#requireSession(sessionId)
    // Pending is "no claim", not "no `processed_at`": the claim is the fact, and the
    // timestamp a reader sees is derived from it. A superseded event is neither: a message a
    // rewind replaced (#238) is not waiting for an answer and never will be.
    const ranges = this.#supersessions.get(sessionId)
    const pending = record.events
      .map((entry) => entry.event)
      .filter(
        (event): event is UserEvent =>
          isUserEvent(event) && !this.#claims.has(event.id) && !isSuperseded(event, ranges),
      )
      .map((event) => this.#share(event))
    return resolved(pending)
  }

  getTurnState(sessionId: SessionId): Promise<TurnState> {
    const state = turnStateOf(this.#requireSession(sessionId))
    const openSpan = state.openSpan
    return resolved(
      openSpan === null
        ? { state: state.state, openSpan: null }
        : { state: state.state, openSpan: this.#share(openSpan) },
    )
  }

  // ------------------------------------------------------------- usage reads

  listModelRequests(options: ListModelRequestsOptions): Promise<ModelRequestUsage[]> {
    const { fromMs, toMs } = usageWindowOf(options)
    const requests: ModelRequestUsage[] = []
    const sessions = [...this.#sessions.values()]
      .filter((record) => matchesOwner(record.session, options))
      .sort((left, right) => compareIds(left.session.id, right.session.id))
    for (const record of sessions) {
      const ranges = this.#supersessions.get(record.session.id)
      // The model a request ran on is on its own span start, so the log is walked once for the
      // starts and once for the ends — the pair the Postgres read joins on
      // `model_request_start_id`. A start the log never had leaves the request's model `null`.
      const modelOf = new Map<EventId, string | undefined>()
      for (const entry of record.events) {
        if (entry.event.type === EVENT_TYPES.modelRequestStart) {
          modelOf.set(entry.event.id, entry.event.model)
        }
      }
      for (const entry of record.events) {
        const event = entry.event
        if (event.type !== EVENT_TYPES.modelRequestEnd) {
          continue
        }
        const atMs = new Date(event.processed_at).getTime()
        // The window is half-open, and what a recorded range covers is not read — a request a
        // rewind replaced is not billed (#238), exactly as replay leaves it out.
        if (atMs < fromMs || atMs >= toMs || isSuperseded(event, ranges)) {
          continue
        }
        requests.push(
          deepFreeze({
            model: modelOf.get(event.model_request_start_id) ?? null,
            usage: { ...event.model_usage },
            processed_at: event.processed_at,
          }),
        )
      }
    }
    return resolved(requests)
  }

  compact(options: CompactOptions): Promise<number> {
    const cutoffMs = cutoffOf(options)
    let deleted = 0
    for (const [sessionId, ranges] of this.#supersessions) {
      const record = this.#sessions.get(sessionId)
      if (record === undefined) {
        continue
      }
      const kept: EventRecord[] = []
      for (const entry of record.events) {
        if (isSuperseded(entry.event, ranges) && entry.createdAtMs < cutoffMs) {
          // One of this store's two deletions, beside `deleteSession`. The id goes back into
          // the free pool with the row, exactly as deleting the row does in Postgres — and no
          // reader is affected, because replay already skipped the chunk.
          this.#eventIds.delete(entry.event.id)
          deleted += 1
        } else {
          kept.push(entry)
        }
      }
      record.events.splice(0, record.events.length, ...kept)
    }
    return resolved(deleted)
  }

  // ------------------------------------------------------- live subscription

  subscribe(sessionId: SessionId, listener: SessionEventListener): Promise<Unsubscribe> {
    this.#requireSession(sessionId)
    const listeners = this.#sessionListeners.get(sessionId) ?? new Set<SessionEventListener>()
    listeners.add(listener)
    this.#sessionListeners.set(sessionId, listeners)
    return resolved(() => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.#sessionListeners.delete(sessionId)
      }
    })
  }

  // -------------------------------------------------------- scheduler support

  signalPartition(partition: number, signal: PartitionSignalInput): Promise<void> {
    const listeners = this.#partitionListeners.get(partition)
    if (listeners !== undefined) {
      const payload: PartitionSignal = {
        partition,
        sessionId: signal.sessionId,
        kind: signal.kind,
      }
      for (const listener of [...listeners]) {
        queueMicrotask(() => void listener(payload))
      }
    }
    return resolved(undefined)
  }

  onPartitionSignal(partition: number, listener: PartitionSignalListener): Promise<Unsubscribe> {
    const listeners = this.#partitionListeners.get(partition) ?? new Set<PartitionSignalListener>()
    listeners.add(listener)
    this.#partitionListeners.set(partition, listeners)
    return resolved(() => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.#partitionListeners.delete(partition)
      }
    })
  }

  // ------------------------------------------------- auth-session revocation

  notifyAuthSessionRevoked(authSessionId: AuthSessionId): Promise<void> {
    // Like a partition signal: at most once, to the listeners attached right now, in a
    // microtask each so no listener runs while the notifier is still on the stack.
    for (const listener of [...this.#revocationListeners]) {
      queueMicrotask(() => void listener(authSessionId))
    }
    return resolved(undefined)
  }

  onAuthSessionRevoked(listener: AuthSessionRevocationListener): Promise<Unsubscribe> {
    this.#revocationListeners.add(listener)
    return resolved(() => {
      this.#revocationListeners.delete(listener)
    })
  }

  findSessionsNeedingWork(partitions: readonly number[]): Promise<SessionId[]> {
    const wanted = new Set(partitions)
    const found = [...this.#sessions.values()]
      .sort((left, right) => compareKeys(left.session, right.session))
      .filter((record) => wanted.has(partitionOf(record.session.id, this.#partitionCount)))
      .filter((record) => this.#needsWork(record))
      .map((record) => record.session.id)
    return resolved(found)
  }

  // ------------------------------------------------------------ partition leases

  acquirePartition(
    partition: number,
    owner: string,
    ttlMs: number,
  ): Promise<PartitionLease | null> {
    assertTtl(ttlMs)
    const now = this.#clock()
    const held = this.#leases.get(partition)
    if (
      held !== undefined &&
      held.owner !== null &&
      held.owner !== owner &&
      held.expiresAtMs > now
    ) {
      return resolved(null)
    }
    // Every successful acquire opens a new tenure — the same owner asking again advances the
    // epoch too, which is what makes a partition's epochs a single increasing sequence.
    const epoch = (held?.epoch ?? 0) + 1
    const expiresAtMs = now + ttlMs
    this.#leases.set(partition, { owner, epoch, expiresAtMs })
    return resolved({ partition, owner, epoch, expires_at: timestampAt(expiresAtMs) })
  }

  renewPartition(partition: number, owner: string, epoch: number, ttlMs: number): Promise<boolean> {
    assertTtl(ttlMs)
    const now = this.#clock()
    const held = this.#leases.get(partition)
    // A lapse makes a lease stealable, not lost: a row that still names this owner at this
    // epoch is this owner's to renew, however long ago it lapsed. Only an `acquire` — which
    // opens a new tenure — takes it away, and that moves the owner and the epoch out from
    // under this check. The Postgres store says why in `renewPartition`.
    if (held === undefined || held.owner !== owner || held.epoch !== epoch) {
      return resolved(false)
    }
    held.expiresAtMs = now + ttlMs
    return resolved(true)
  }

  releasePartition(partition: number, owner: string, epoch: number): Promise<void> {
    const held = this.#leases.get(partition)
    if (held !== undefined && held.owner === owner && held.epoch === epoch) {
      // `owner: null` means the partition is free; the epoch still advances, so a write that
      // was in flight with the released tenure is fenced rather than landing in the next one.
      this.#leases.set(partition, { owner: null, epoch: held.epoch + 1, expiresAtMs: 0 })
    }
    return resolved(undefined)
  }

  currentEpoch(partition: number): Promise<number> {
    return resolved(this.#leases.get(partition)?.epoch ?? 0)
  }

  // ------------------------------------------------------ scheduler membership

  heartbeatInstance(instanceId: string): Promise<void> {
    this.#instances.set(instanceId, this.#clock())
    return resolved(undefined)
  }

  listLiveInstances(withinMs: number): Promise<string[]> {
    assertLivenessWindow(withinMs)
    const cutoff = this.#clock() - withinMs
    const live = [...this.#instances.entries()]
      .filter(([, lastSeenMs]) => lastSeenMs > cutoff)
      .map(([instanceId]) => instanceId)
      .sort()
    return resolved(live)
  }

  removeInstance(instanceId: string): Promise<void> {
    this.#instances.delete(instanceId)
    return resolved(undefined)
  }

  // ------------------------------------------------------------------ internals

  /**
   * The session's log record, or a {@link SessionNotFoundError} for an id nothing has — and
   * for one that belongs to another owner than a scoped read named: both are the same answer,
   * so a user-facing 404 leaks nothing (epic #65, A4).
   */
  #requireSession(sessionId: SessionId, options: OwnerScope | null = null): SessionRecord {
    const record = this.#sessions.get(sessionId)
    if (record === undefined || (options !== null && !matchesOwner(record.session, options))) {
      throw new SessionNotFoundError(sessionId)
    }
    return record
  }

  /**
   * Append into a live record: assign the fields the caller does not own, record the claims
   * and supersessions the batch carries, advance the session's status and `updated_at`, and
   * hand back the stored events. Delivery is the caller's job, so that a subscription is only
   * notified once the whole append — or the whole creation — landed.
   *
   * Build first, commit second: an event this store refuses — one the protocol schema rejects,
   * an id that is not an event id or one the log already holds, a `consumes` id that is not a
   * pending user event of this session, a `supersedes` range that does not fit, or a rewind
   * whose `from_seq` is not a still-visible `user.message` of this session (#238) — leaves the
   * log exactly as it was, because an append is one transaction.
   */
  #append(record: SessionRecord, events: readonly AppendableEvent[], now: number): StoredEvent[] {
    assertEventIds(record.session.id, events)
    const processedAt = timestampAt(now)
    // The batch as it will be recorded: the id and the `seq` this store gives each event. The
    // ranges are checked in this shape before anything is built, so a `from_seq` the log
    // cannot honour is refused as a range rather than as a malformed event — and the stored
    // events follow only once the batch is known to be usable.
    const appended: AppendedEvent[] = events.map((input, index) => ({
      ...input,
      id: input.id ?? newEventId(now),
      seq: record.nextSeq + index,
    }))
    for (const event of appended) {
      // The event's own id when it brought one — the one its previews carried — and a fresh
      // one otherwise. Either way the id is checked against the whole log before anything is
      // written, so a batch with a taken id is refused whole.
      if (this.#eventIds.has(event.id)) {
        throw new DuplicateEventIdError(record.session.id, event.id)
      }
    }
    const recorded = this.#supersessions.get(record.session.id) ?? []
    assertRewinds(appended, (at) => {
      const event = eventAtSeq(record, at)
      return event === undefined
        ? undefined
        : { type: event.type, superseded: isSuperseded(event, recorded) }
    })
    const stored = appended.map((event) =>
      storedEventFrom(event, { id: event.id, seq: event.seq, processedAt }),
    )
    // Everything this batch records beside the events is checked first, so a batch that cannot
    // be recorded whole is refused whole — nothing stored, nothing claimed, no range recorded.
    const claims = this.#claimsFor(record, stored, now)
    const supersessions = supersessionsOf(appended, now)
    for (const event of stored) {
      // Frozen before it reaches the log: the store's own state is immutable too, not only the
      // copies it hands out.
      record.events.push({ event: deepFreeze(event), createdAtMs: now })
      this.#eventIds.add(event.id)
    }
    record.nextSeq += events.length
    for (const claim of claims) {
      this.#claims.set(claim.eventId, {
        claimedAtMs: claim.claimedAtMs,
        claimedByEventId: claim.claimedByEventId,
      })
    }
    if (supersessions.length > 0) {
      const ranges = this.#supersessions.get(record.session.id) ?? []
      ranges.push(...supersessions)
      this.#supersessions.set(record.session.id, ranges)
    }
    for (const event of stored) {
      if (event.type === EVENT_TYPES.sessionStatusRunning) {
        record.session.status = 'running'
      } else if (event.type === EVENT_TYPES.sessionStatusIdle) {
        record.session.status = 'idle'
      } else if (event.type === EVENT_TYPES.userMessage) {
        // The model projection (#111): a message that carries a model switches the session to
        // it, in the same append, and a message without one leaves the session's model alone.
        // Within a batch the later message wins, because this walks the events in order.
        if (event.model !== undefined) {
          record.session.model = { id: event.model.id }
          // ...and a plain model detaches the chat from any mode: it follows one or the other
          // (epic #245, M6).
          if (event.mode === undefined) {
            record.session.mode = null
          }
        }
        // The mode projection (#245, M6): a message that carries a mode switches it, `null`
        // detaches, and a message that carries neither leaves it alone.
        if (event.mode !== undefined) {
          record.session.mode = event.mode
        }
      } else if (
        event.type === EVENT_TYPES.modelRequestStart &&
        event.model !== undefined &&
        event.purpose !== 'summary'
      ) {
        // The model a request *ran*, projected onto the session: for a chat on a mode this is
        // the mode's resolved model, which is what makes `model` mean "the model this chat
        // last ran" — and the fallback a chat continues on once its mode is deleted (#245, M6).
        //
        // A **summary** request is left out (epic #277, C2): its span start names the model that
        // summarized, not the model the chat runs, and projecting it would move the chat onto
        // the summarizer.
        record.session.model = { id: event.model }
      }
    }
    if (stored.length > 0) {
      record.session.updated_at = timestampAt(now)
    }
    return stored
  }

  /**
   * The claims a batch is allowed to record: every id its `consumes`-carrying events name,
   * checked against the log as it is now.
   *
   * Three event types carry the list (P4): a `span.model_request_start` claims the messages
   * its request answers, a `span.model_request_end` claims the interrupts that cut its request
   * short, and a `session.status_idle` claims the interrupts an idle turn ended on.
   *
   * A claim is rejected — and with it the whole append — when the id names no event of this
   * session, an event that is not a user event, one that is already claimed, or one this same
   * batch names twice. All the offending ids are collected so the error names them together.
   */
  #claimsFor(record: SessionRecord, stored: readonly StoredEvent[], now: number): PendingClaim[] {
    const claims: PendingClaim[] = []
    const namedHere = new Set<EventId>()
    const conflicts: EventId[] = []
    for (const event of stored) {
      if (!carriesConsumes(event) || event.consumes === undefined) {
        continue
      }
      for (const consumed of event.consumes) {
        const target = eventWithId(record, consumed)
        if (
          namedHere.has(consumed) ||
          target === undefined ||
          !isUserEvent(target) ||
          this.#claims.has(consumed) ||
          // A message a rewind replaced (#238) answers nothing: nothing outside a range may
          // claim into it.
          isSuperseded(target, this.#supersessions.get(record.session.id))
        ) {
          conflicts.push(consumed)
          continue
        }
        namedHere.add(consumed)
        claims.push({ eventId: consumed, claimedByEventId: event.id, claimedAtMs: now })
      }
    }
    if (conflicts.length > 0) {
      throw new ClaimConflictError(record.session.id, conflicts)
    }
    return claims
  }

  /**
   * The event a caller sees: the stored value with the fields the store derives — today only a
   * user event's `processed_at`, from the claim that took it — deep-frozen so the copy cannot
   * be written to.
   *
   * The one cast builds the derived field on a clone; the event itself is handed out as the
   * deep-readonly type it is (D9, issue #46).
   */
  #share<T extends StoredEvent>(event: T): T {
    const claim = this.#claims.get(event.id)
    return deepFreeze({
      ...structuredClone(event),
      processed_at: derivedProcessedAt(event, claim),
    })
  }

  /** Refuse a fenced write whose epoch is not the partition's live one; unfenced writes always pass. */
  #assertFence(fence: PartitionFence | undefined, operation: string): void {
    if (fence === undefined) {
      return
    }
    const now = this.#clock()
    const held = this.#leases.get(fence.partition)
    const live = held !== undefined && held.owner !== null && held.expiresAtMs > now
    if (live && held.epoch === fence.epoch) {
      return
    }
    throw new FencedError({
      partition: fence.partition,
      epoch: fence.epoch,
      currentEpoch: held?.epoch ?? 0,
      operation,
    })
  }

  /** Whether a session has work waiting: a pending user event, or an open turn. */
  #needsWork(record: SessionRecord): boolean {
    const ranges = this.#supersessions.get(record.session.id)
    const pending = record.events.some(
      (entry) =>
        isUserEvent(entry.event) &&
        !this.#claims.has(entry.event.id) &&
        !isSuperseded(entry.event, ranges),
    )
    return pending || turnStateOf(record).state !== 'idle'
  }

  /**
   * Hand an event to a session's subscribers, in a microtask each: a store that notifies after
   * it commits, and one that notifies over a connection, are both allowed to be late, and the
   * conformance suite may not depend on synchronous delivery.
   *
   * The payload is a deep-frozen copy — derived the way a read derives it — so no listener can
   * write to what another listener of the same event holds.
   */
  #deliver(sessionId: SessionId, event: StoredEvent): void {
    const listeners = this.#sessionListeners.get(sessionId)
    if (listeners === undefined || listeners.size === 0) {
      return
    }
    const payload = this.#share(event)
    for (const listener of [...listeners]) {
      queueMicrotask(() => void listener(payload))
    }
  }
}

/** Everything {@link InMemorySessionStore} takes. */
export interface InMemorySessionStoreOptions {
  /**
   * The store's time source. Defaults to {@link systemClock}; pass a controllable clock in
   * tests, which is what the conformance suite does.
   */
  readonly now?: Clock
  /**
   * Number of partitions sessions hash into, used by
   * {@link InMemorySessionStore.findSessionsNeedingWork}. Defaults to the protocol's
   * `DEFAULT_PARTITION_COUNT`; a store only agrees with a server whose partitions match.
   */
  readonly partitionCount?: number
}

/**
 * The in-memory `CredentialStore` (epic #65, A5): the test fake for the contract in
 * `credentials.ts`, and the reference behaviour for the Postgres one.
 *
 * It holds the sealed blobs in nested `Map`s — one per user, keyed by name — and follows
 * the same three choices {@link InMemorySessionStore} makes:
 *
 * - **Time is injectable** ({@link InMemoryCredentialStoreOptions.now}): `created_at` and
 *   `updated_at` come from that clock, so a test can assert the exact instants.
 * - **Nothing is shared with the caller**: every answer is a fresh object.
 * - **Answers are deep-frozen**: a sealed blob is a value, and neither it nor the metadata
 *   beside it can be written to after the store hands it out.
 *
 * There are no users to cascade from here — the real cascade is the Postgres schema's foreign
 * key — so the fake simply never has a credential for a user it was not given one for.
 */
export class InMemoryCredentialStore implements CredentialStore {
  readonly #clock: Clock

  /** One entry per user, holding that user's credentials keyed by name. */
  readonly #credentials = new Map<UserId, Map<string, StoredCredential>>()

  constructor(options: InMemoryCredentialStoreOptions = {}) {
    this.#clock = options.now ?? systemClock
  }

  upsert(input: UpsertCredentialInput): Promise<ProviderCredential> {
    const now = this.#clock()
    const at = timestampAt(now)
    const stored = this.#forUser(input.userId)
    const existing = stored.get(input.name)
    // A replacement keeps the id and `created_at` it is replacing — one credential per
    // `(user, name)`, so a second save is the same credential with a new secret.
    // The metadata is a discriminated union on `type`, and the store's caller decides which
    // variant it is: the cast is the store boundary's — a `type` and its own `details` are
    // consistent by construction (the contract's `UpsertCredentialInput`), and the record's
    // own `type` is the wide union the caller passed.
    const record: StoredCredential = {
      id: existing?.id ?? newProviderCredentialId(now),
      type: input.type,
      name: input.name,
      last4: input.last4,
      // Absent stays absent, and the object is copied rather than aliased: a credential whose
      // type publishes no public facts has no `details` key at all (matching the Postgres
      // store's `null` column), and the store never hands back the caller's own object.
      ...(input.details === undefined ? {} : { details: { ...input.details } }),
      created_at: existing?.created_at ?? at,
      updated_at: at,
      validated_at: input.validatedAt,
      sealed: { ...input.sealed },
    } as StoredCredential
    stored.set(input.name, record)
    return resolved(deepFreeze(metadataOf(record)))
  }

  get(key: CredentialKey): Promise<SealedProviderCredential | null> {
    const record = this.#credentials.get(key.userId)?.get(key.name)
    return resolved(record === undefined ? null : deepFreeze(structuredClone(record)))
  }

  list(options: ListCredentialsOptions): Promise<ProviderCredential[]> {
    const stored = this.#credentials.get(options.userId)
    if (stored === undefined) {
      return resolved([])
    }
    const metadata = [...stored.values()]
      .sort((left, right) => compareIds(left.name, right.name))
      .map((record) => deepFreeze(metadataOf(record)))
    return resolved(metadata)
  }

  delete(key: CredentialKey): Promise<boolean> {
    const stored = this.#credentials.get(key.userId)
    if (stored === undefined) {
      return resolved(false)
    }
    const deleted = stored.delete(key.name)
    if (stored.size === 0) {
      this.#credentials.delete(key.userId)
    }
    return resolved(deleted)
  }

  /** One user's credentials, created on first use. */
  #forUser(userId: UserId): Map<string, StoredCredential> {
    let stored = this.#credentials.get(userId)
    if (stored === undefined) {
      stored = new Map()
      this.#credentials.set(userId, stored)
    }
    return stored
  }
}

/** Everything {@link InMemoryCredentialStore} takes. */
export interface InMemoryCredentialStoreOptions {
  /**
   * The store's time source. Defaults to {@link systemClock}; pass a controllable clock in
   * tests, which is what the conformance suite does.
   */
  readonly now?: Clock
}

/** A stored credential: {@link SealedProviderCredential} as the in-memory store keeps it. */
type StoredCredential = SealedProviderCredential

/** The metadata of a stored credential, without its sealed blob: what `upsert` and `list` answer. */
function metadataOf(record: SealedProviderCredential): ProviderCredential {
  const { sealed: _sealed, ...metadata } = record
  return metadata
}

/**
 * Byte order for two ids — the `C` collation the SQL orders by.
 *
 * The `name` ordering the credential `list` promises, and the session ordering
 * `listModelRequests` reads a user's requests in: in both places the in-memory store has to
 * answer in the order the Postgres store's `order by` does, and the two agree on this one
 * comparison.
 */
function compareIds(left: string, right: string): number {
  if (left === right) {
    return 0
  }
  return left < right ? -1 : 1
}

/** One event in a session's log, with the internal creation time the protocol has no field for. */
interface EventRecord {
  /**
   * The event as stored: deep-frozen, and deep-readonly in the types too (D9, issue #46), so
   * nothing in this store can write to it even by accident. Every hand-out clones it through
   * {@link InMemorySessionStore} `#share`, which is also where a derived `processed_at` comes
   * from — the log itself never carries one on a user event.
   */
  event: StoredEvent
  /**
   * When the store wrote the event. Never leaves the store: the protocol's stored events carry
   * `seq` and `processed_at` and no `created_at`, and the conformance suite asserts that what a
   * read returns is exactly a `StoredEvent`.
   */
  readonly createdAtMs: number
}

/**
 * A recorded claim: when a user event was claimed, and by what.
 *
 * The in-memory half of `event_claims` (D9, issue #46). Every claim is taken by an event that
 * carries `consumes` (P4 removed the out-of-band `markProcessed`), so `claimedByEventId` names
 * the event that claimed it. The Postgres column stays nullable for rows the pre-P4
 * `markProcessed` wrote.
 */
interface ClaimRecord {
  /** When the claim was made, as the injected clock read it. */
  readonly claimedAtMs: number
  /** The event whose `consumes` claimed this one. */
  readonly claimedByEventId: EventId
}

/** A claim a batch wants to record, before it is recorded: {@link ClaimRecord} with its event. */
interface PendingClaim extends ClaimRecord {
  readonly eventId: EventId
}

/** A session's header and its log. */
interface SessionRecord {
  readonly session: Session
  readonly events: EventRecord[]
  /** The `seq` the next appended event gets. */
  nextSeq: number
}

/** A partition's tenure: who holds it, at which epoch, and until when. `owner: null` = unleased. */
interface LeaseRecord {
  owner: string | null
  epoch: number
  expiresAtMs: number
}

/** One user's stored preferences, as the in-memory `user_preferences` row keeps them (#111). */
interface PreferencesRecord {
  /** The `provider/model` a new session starts with, or `null` for none. */
  readonly defaultModel: string | null
  /** The web theme name (#203); the column's default until a user chooses one. */
  readonly theme: UserTheme
  /** The compaction share (epic #277, C3), or `null` for the server's own (#282). */
  readonly compactionThreshold: number | null
  /** Which model writes summaries (epic #277, K3); `same-as-chat` until a user picks one. */
  readonly summaryModel: SummaryModel
  /** The summary pass limit (epic #277, K5), or `null` for the engine's own. */
  readonly summaryMaxPasses: number | null
  /** When `putPreferences` last wrote it, as the injected clock read it. */
  readonly updatedAtMs: number
}

/** The fields the store assigns to an appended event. */
interface AssignedEventFields {
  readonly id: EventId
  readonly seq: number
  readonly processedAt: Timestamp
}

/**
 * The store is synchronous — every answer is already in memory — so its methods hand back a
 * resolved promise instead of being `async`, which is also why none of them can be awaited into
 * a different order than they were called in.
 */
function resolved<T>(value: T): Promise<T> {
  return Promise.resolve(value)
}

/** A deep copy, so a caller cannot reach into the store's state through what it was handed. */
function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Whether a resource belongs to the owner a read was scoped to.
 *
 * An unscoped read — no `ownerId` — matches anything: it is the brain's and the scheduler's
 * form, and they act for a session rather than for a user. A scoped read matches only the
 * owner's own resources (epic #65, A4).
 */
function matchesOwner(resource: { readonly owner_id?: UserId }, options: OwnerScope): boolean {
  return resource.owner_id === options.ownerId
}

/**
 * Build the stored event from what the caller owns plus what the store assigns.
 *
 * Through the protocol's schema on purpose: the fake must hand back exactly the wire shape, and
 * parsing is what guarantees that — a field the caller slipped in that the protocol does not
 * have is dropped here, not stored.
 */
function storedEventFrom(input: AppendableEvent, assigned: AssignedEventFields): StoredEvent {
  return StoredEventSchema.parse({
    ...storedPayload(input, assigned),
    id: assigned.id,
    seq: assigned.seq,
    processed_at: isUserEventType(input.type) ? null : assigned.processedAt,
  })
}

/**
 * The body of the event to store: the caller's, with the one field the store fills in.
 *
 * A `session.rewind` (#238) arrives as the message the session restarts from; how far the
 * restart reaches is the log's own answer, and the event being written right behind the end
 * of the log is what makes it `seq - 1`. That range is what the stored event records, so a
 * reader never has to work it out.
 */
function storedPayload(
  input: AppendableEvent,
  assigned: AssignedEventFields,
): AppendableEvent | StoredRewindBody {
  if (input.type === EVENT_TYPES.sessionRewind) {
    return { type: input.type, supersedes: { from_seq: input.from_seq, to_seq: assigned.seq - 1 } }
  }
  return input
}

/** A stored rewind's body: the type, and the range the store recorded for it (#238). */
interface StoredRewindBody {
  readonly type: string
  readonly supersedes: Supersedes
}

/** The stored event at a `seq` of this log, or `undefined` when the log has none. */
function eventAtSeq(record: SessionRecord, seq: number): StoredEvent | undefined {
  return record.events.find((entry) => entry.event.seq === seq)?.event
}

/** Whether a stored event is a user event. */
function isUserEvent(event: StoredEvent): event is UserEvent {
  return isUserEventType(event.type)
}

/**
 * The `processed_at` a reader sees: a user event's comes from the claim that took it — `null`
 * while none has — and every other event keeps the one the store wrote when it appended it.
 */
function derivedProcessedAt(event: StoredEvent, claim: ClaimRecord | undefined): Timestamp | null {
  if (isUserEvent(event)) {
    return claim === undefined ? null : timestampAt(claim.claimedAtMs)
  }
  return event.processed_at
}

/** The session's event with this id, or `undefined` when the log holds none. */
function eventWithId(record: SessionRecord, eventId: EventId): StoredEvent | undefined {
  return record.events.find((entry) => entry.event.id === eventId)?.event
}

/**
 * The turn state of a log: no open turn is `idle`, an open turn with a model request in flight
 * is `running`, and an open turn with nothing in flight is `unfinished`. See
 * {@link SessionStore.getTurnState}.
 */
function turnStateOf(record: SessionRecord): {
  readonly state: TurnStateKind
  readonly openSpan: ModelRequestStartEvent | null
} {
  const events = record.events.map((entry) => entry.event)
  const lastStatus = findLastStatusEvent(events)
  if (lastStatus === null || lastStatus.type === EVENT_TYPES.sessionStatusIdle) {
    return { state: 'idle', openSpan: null }
  }
  const openSpan = findOpenSpan(events)
  return { state: openSpan === null ? 'unfinished' : 'running', openSpan }
}

/** The last status event in a log, or `null` when the log has none. */
function findLastStatusEvent(events: readonly StoredEvent[]): StoredEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) {
      continue
    }
    if (
      event.type === EVENT_TYPES.sessionStatusRunning ||
      event.type === EVENT_TYPES.sessionStatusIdle ||
      event.type === EVENT_TYPES.sessionStatusRescheduled
    ) {
      return event
    }
  }
  return null
}

/**
 * The oldest `span.model_request_start` that no `span.model_request_end` closed, or `null`.
 *
 * A turn opens one span at a time, so the answer is the only open span in practice; if a log
 * somehow holds several, the oldest is the one a recovering brain has to close first.
 */
function findOpenSpan(events: readonly StoredEvent[]): ModelRequestStartEvent | null {
  const unclosed = new Map<EventId, ModelRequestStartEvent>()
  for (const event of events) {
    if (event.type === EVENT_TYPES.modelRequestStart) {
      unclosed.set(event.id, event)
    } else if (event.type === EVENT_TYPES.modelRequestEnd) {
      unclosed.delete(event.model_request_start_id)
    }
  }
  for (const start of unclosed.values()) {
    return start
  }
  return null
}

/**
 * The list order of both agents and sessions: `(created_at, id)`, ascending.
 *
 * Timestamps are compared as strings, which is chronological here because every timestamp the
 * store writes, and every cursor it encodes, is canonical UTC from {@link timestampAt}.
 */
function compareKeys(left: KeyCursorPosition, right: KeyCursorPosition): number {
  if (left.created_at !== right.created_at) {
    return left.created_at < right.created_at ? -1 : 1
  }
  if (left.id === right.id) {
    return 0
  }
  return left.id < right.id ? -1 : 1
}

/**
 * One page of a list that is already sorted in its own order, plus the cursor of the next one.
 *
 * `direction` is that list order: `asc` for agents (oldest first), `desc` for sessions (newest
 * first). The page after a cursor is the items that come strictly after the cursor's position
 * when reading the list, and `next_page` is only written when something follows the page.
 */
function paginate<T extends KeyCursorPosition>(
  items: readonly T[],
  limit: number,
  cursor: KeyCursor | null,
  direction: 'asc' | 'desc',
): { data: T[]; next_page: NextPage } {
  const after =
    cursor === null
      ? [...items]
      : items.filter((item) =>
          direction === 'asc' ? compareKeys(item, cursor) > 0 : compareKeys(item, cursor) < 0,
        )
  const data = after.slice(0, limit)
  const next_page = after.length > limit ? encodeKeyCursor(lastOf(data)) : null
  return { data, next_page }
}

/** The last item of an array the pagination code has already proved non-empty. */
function lastOf<T>(items: readonly T[]): T {
  const last = items[items.length - 1]
  if (last === undefined) {
    throw new RangeError('lastOf() needs a non-empty array')
  }
  return last
}
