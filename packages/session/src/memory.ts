import {
  DEFAULT_EVENT_ORDER,
  DEFAULT_PARTITION_COUNT,
  EVENT_TYPES,
  StoredEventSchema,
  encodeKeyCursor,
  encodeSeqCursor,
  newAgentId,
  newEventId,
  newSessionId,
  partitionOf,
  type Agent,
  type AgentId,
  type CreateAgentRequest,
  type DeepReadonly,
  type EventId,
  type ImmutableStreamEvent,
  type ImmutableStoredEvent,
  type ImmutableUserInterruptEvent,
  type ImmutableUserMessageEvent,
  type KeyCursor,
  type KeyCursorPosition,
  type ListAgentsResponse,
  type ListEventsResponse,
  type ListSessionsResponse,
  type ModelRequestStartEvent,
  type NextPage,
  type Session,
  type SessionId,
  type StoredEvent,
  type StreamOnlyEvent,
  type Timestamp,
  type UpdateAgentRequest,
  type UserEvent,
} from '@openharness/protocol'

import { type Clock, systemClock, timestampAt } from './clock'
import {
  AgentNotFoundError,
  ClaimConflictError,
  DuplicateEventIdError,
  FencedError,
  SessionNotFoundError,
} from './errors'
import {
  cutoffOf,
  isSupersededChunk,
  isUserEventType,
  supersessionsOf,
  type SupersessionRecord,
} from './events'
import { deepFreeze } from './freeze'
import { assertEventIds, assertTtl, decodeKeyPage, decodeSeqPage, pageSize } from './inputs'
import type {
  AppendableEvent,
  AppendEventsOptions,
  CompactOptions,
  CreateSessionOptions,
  ListAgentsOptions,
  ListEventsOptions,
  ListSessionsOptions,
  MarkProcessedOptions,
  PartitionFence,
  PartitionLease,
  PartitionSignal,
  PartitionSignalInput,
  PartitionSignalListener,
  SessionEventListener,
  SessionPreview,
  SessionStore,
  TurnState,
  TurnStateKind,
  Unsubscribe,
  UpdateSessionRequest,
} from './store'

/**
 * The user events, deep-readonly. The protocol has no `ImmutableUserEvent` yet — the domain
 * sub-unions have no immutable twin until P4 — so this is the union of the two members that do.
 */
type ImmutableUserEvent = ImmutableUserMessageEvent | ImmutableUserInterruptEvent

/** The stream-only events, deep-readonly; the protocol has no alias for these two yet either. */
type ImmutableStreamOnlyEvent = DeepReadonly<StreamOnlyEvent>

/**
 * The in-memory `SessionStore`: the test fake for every other package, and the reference
 * behaviour for the contract in `store.ts`.
 *
 * It holds everything in `Map`s — agents, sessions and their logs, leases, listeners — and is
 * single-process by construction: two instances share nothing, and a lease in one is invisible
 * to the other. That is the one place it cannot be Postgres-like, so the conformance suite
 * only tests what a shared store can also do.
 *
 * Three implementation details are worth knowing, because they are choices the contract leaves
 * open and tests may rely on:
 *
 * - **Time is injectable** ({@link InMemorySessionStoreOptions.now}). Timestamps, event ids and
 *   lease expiry all come from that clock, so a test can move time forward instead of waiting.
 * - **Delivery is asynchronous.** Stored events, ephemeral events and partition signals reach
 *   listeners in a microtask, not while the append is still on the stack, which is the shape a
 *   `LISTEN`/`NOTIFY` store will have. Awaiting the call that published an event is enough for
 *   the listener to have seen it, but the contract does not promise that: read state, do not
 *   assume a listener ran.
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

  /**
   * The preview in flight for each session whose current `agent.message` is being streamed:
   * the id its `event_start` named and the text its deltas have accumulated. An entry appears
   * on `event_start` and goes when the previewed event is stored or a `span.model_request_end`
   * is appended — see {@link SessionStore.getPreview}.
   */
  readonly #previews = new Map<string, PreviewRecord>()

  readonly #leases = new Map<number, LeaseRecord>()

  readonly #sessionListeners = new Map<string, Set<SessionEventListener>>()

  readonly #partitionListeners = new Map<number, Set<PartitionSignalListener>>()

  constructor(options: InMemorySessionStoreOptions = {}) {
    this.#clock = options.now ?? systemClock
    this.#partitionCount = options.partitionCount ?? DEFAULT_PARTITION_COUNT
  }

  // ------------------------------------------------------------------ agents

  createAgent(input: CreateAgentRequest): Promise<Agent> {
    const now = this.#clock()
    const at = timestampAt(now)
    const agent: Agent = {
      id: newAgentId(now),
      type: 'agent',
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

  getAgent(agentId: AgentId): Promise<Agent | null> {
    const agent = this.#agents.get(agentId)
    return resolved(agent === undefined ? null : clone(agent))
  }

  listAgents(options: ListAgentsOptions = {}): Promise<ListAgentsResponse> {
    const cursor = options.page === undefined ? null : decodeKeyPage(options.page)
    const agents = [...this.#agents.values()].sort(compareKeys)
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

  // ---------------------------------------------------------------- sessions

  createSession(agentId: AgentId, options: CreateSessionOptions = {}): Promise<Session> {
    const agent = this.#agents.get(agentId)
    if (agent === undefined) {
      throw new AgentNotFoundError(agentId)
    }
    const now = this.#clock()
    const at = timestampAt(now)
    const session: Session = {
      id: newSessionId(now),
      type: 'session',
      status: 'idle',
      title: options.title ?? null,
      metadata: { ...options.metadata },
      agent: {
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

  getSession(sessionId: SessionId): Promise<Session | null> {
    const record = this.#sessions.get(sessionId)
    return resolved(record === undefined ? null : clone(record.session))
  }

  listSessions(options: ListSessionsOptions = {}): Promise<ListSessionsResponse> {
    const cursor = options.page === undefined ? null : decodeKeyPage(options.page)
    const wanted = options.agentId
    const sessions = [...this.#sessions.values()]
      .map((record) => record.session)
      .filter((session) => wanted === undefined || session.agent.id === wanted)
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

  markProcessed(
    sessionId: SessionId,
    eventIds: EventId[],
    options: MarkProcessedOptions = {},
  ): Promise<UserEvent[]> {
    const record = this.#requireSession(sessionId)
    this.#assertFence(options.fence, 'markProcessed')
    const wanted = new Set<string>(eventIds)
    const now = this.#clock()
    const claimedAt = timestampAt(now)
    const marked: UserEvent[] = []
    for (const entry of record.events) {
      const event = entry.event
      if (!isUserEvent(event) || !wanted.has(event.id) || this.#claims.has(event.id)) {
        continue
      }
      this.#claims.set(event.id, { claimedAtMs: now, claimedByEventId: null })
      marked.push(this.#shareUser(event, claimedAt))
    }
    return resolved(marked)
  }

  listEvents(sessionId: SessionId, options: ListEventsOptions = {}): Promise<ListEventsResponse> {
    const record = this.#requireSession(sessionId)
    const order = options.order ?? DEFAULT_EVENT_ORDER
    const cursor = options.page === undefined ? null : decodeSeqPage(options.page)
    const afterSeq = options.afterSeq
    const types = options.types === undefined ? null : new Set<string>(options.types)
    let events = record.events.map((entry) => entry.event)
    if (options.includeSuperseded !== true) {
      const ranges = this.#supersessions.get(sessionId)
      events = events.filter((event) => !isSupersededChunk(event, ranges))
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
    return resolved({ data: data.map((event) => this.#share(event)), next_page })
  }

  getPendingUserEvents(sessionId: SessionId): Promise<UserEvent[]> {
    const record = this.#requireSession(sessionId)
    // Pending is "no claim", not "no `processed_at`": the claim is the fact, and the
    // timestamp a reader sees is derived from it.
    const pending = record.events
      .map((entry) => entry.event)
      .filter(
        (event): event is ImmutableUserEvent => isUserEvent(event) && !this.#claims.has(event.id),
      )
      .map((event) => this.#shareUser(event, null))
    return resolved(pending)
  }

  getTurnState(sessionId: SessionId): Promise<TurnState> {
    const state = turnStateOf(this.#requireSession(sessionId))
    const openSpan = state.openSpan
    return resolved(
      openSpan === null
        ? { state: state.state, openSpan: null }
        : {
            state: state.state,
            // The cast is the boundary until P4 makes the contract's types readonly: what the
            // store hands out is the immutable event, under the mutable name callers expect.
            openSpan: this.#share(openSpan) as ModelRequestStartEvent,
          },
    )
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
        if (isSupersededChunk(entry.event, ranges) && entry.createdAtMs < cutoffMs) {
          // The one deletion in this store. The id goes back into the free pool with the row,
          // exactly as deleting the row does in Postgres — and no reader is affected, because
          // replay already skipped the chunk.
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

  publishEphemeral(sessionId: SessionId, event: StreamOnlyEvent): Promise<void> {
    this.#requireSession(sessionId)
    this.#trackPreview(sessionId, event)
    this.#deliver(sessionId, clone(event))
    return resolved(undefined)
  }

  getPreview(sessionId: SessionId): Promise<SessionPreview | null> {
    this.#requireSession(sessionId)
    const preview = this.#previews.get(sessionId)
    return resolved(preview === undefined ? null : { eventId: preview.eventId, text: preview.text })
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
    if (
      held === undefined ||
      held.owner !== owner ||
      held.epoch !== epoch ||
      held.expiresAtMs <= now
    ) {
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

  // ------------------------------------------------------------------ internals

  /** The session's log record, or a {@link SessionNotFoundError} for an id nothing has. */
  #requireSession(sessionId: SessionId): SessionRecord {
    const record = this.#sessions.get(sessionId)
    if (record === undefined) {
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
   * pending user event of this session, or a `supersedes` range that does not fit — leaves the
   * log exactly as it was, because an append is one transaction.
   */
  #append(record: SessionRecord, events: readonly AppendableEvent[], now: number): StoredEvent[] {
    assertEventIds(record.session.id, events)
    const processedAt = timestampAt(now)
    const stored: StoredEvent[] = []
    let seq = record.nextSeq
    for (const input of events) {
      // The event's own id when it brought one — the one its previews carried — and a fresh
      // one otherwise. Either way the id is checked against the whole log before anything is
      // written, so a batch with a taken id is refused whole.
      const id = input.id ?? newEventId(now)
      if (this.#eventIds.has(id)) {
        throw new DuplicateEventIdError(record.session.id, id)
      }
      stored.push(storedEventFrom(input, { id, seq, processedAt }))
      seq += 1
    }
    // Everything this batch records beside the events is checked first, so a batch that cannot
    // be recorded whole is refused whole — nothing stored, nothing claimed.
    const claims = this.#claimsFor(record, stored, now)
    const supersessions = supersessionsOf(stored, now)
    for (const event of stored) {
      // Frozen before it reaches the log: the store's own state is immutable too, not only the
      // copies it hands out.
      record.events.push({ event: deepFreeze(event), createdAtMs: now })
      this.#eventIds.add(event.id)
    }
    record.nextSeq = seq
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
      }
    }
    if (stored.length > 0) {
      record.session.updated_at = timestampAt(now)
    }
    if (endsPreview(this.#previews.get(record.session.id), stored)) {
      this.#previews.delete(record.session.id)
    }
    return stored
  }

  /**
   * The claims a batch is allowed to record: every id its `span.model_request_start` events
   * name in `consumes`, checked against the log as it is now.
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
      if (event.type !== EVENT_TYPES.modelRequestStart || event.consumes === undefined) {
        continue
      }
      for (const consumed of event.consumes) {
        const target = eventWithId(record, consumed)
        if (
          namedHere.has(consumed) ||
          target === undefined ||
          !isUserEvent(target) ||
          this.#claims.has(consumed)
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
   * The cast is the boundary until P4 turns the contract's types readonly: the store keeps and
   * hands out an immutable event (see {@link EventRecord}), and the mutable names
   * (`StoredEvent`, `UserEvent`) are what today's callers expect.
   */
  #share(event: ImmutableStoredEvent): StoredEvent {
    const claim = this.#claims.get(event.id)
    return deepFreeze({
      ...structuredClone(event),
      processed_at: derivedProcessedAt(event, claim),
    }) as StoredEvent
  }

  /** {@link InMemorySessionStore.#share} for a user event, at the user-event type callers take. */
  #shareUser(event: ImmutableUserEvent, processedAt: Timestamp | null): UserEvent {
    return deepFreeze({ ...structuredClone(event), processed_at: processedAt }) as UserEvent
  }

  /**
   * Fold an ephemeral event into the session's in-flight preview.
   *
   * An `event_start` begins a preview — replacing whatever the session was previewing before,
   * because there is only ever one — and an `event_delta` extends the preview of the id it
   * names, and nothing else: a delta for another event (one whose `event_start` this store
   * never saw, or one that has been cleared) is delivered as it always was and leaves the
   * preview alone.
   */
  #trackPreview(sessionId: SessionId, event: StreamOnlyEvent): void {
    if (event.type === EVENT_TYPES.eventStart) {
      this.#previews.set(sessionId, { eventId: event.event.id, text: '' })
      return
    }
    const preview = this.#previews.get(sessionId)
    if (preview !== undefined && preview.eventId === event.event_id) {
      preview.text += event.delta.content.text
    }
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
    const pending = record.events.some(
      (entry) => isUserEvent(entry.event) && !this.#claims.has(entry.event.id),
    )
    return pending || turnStateOf(record).state !== 'idle'
  }

  /**
   * Hand an event to a session's subscribers, in a microtask each: a store that notifies after
   * it commits, and one that notifies over a connection, are both allowed to be late, and the
   * conformance suite may not depend on synchronous delivery.
   *
   * The payload is a deep-frozen copy — derived the way a read derives it when it is a stored
   * event — so no listener can write to what another listener of the same event holds.
   */
  #deliver(sessionId: SessionId, event: ImmutableStreamEvent): void {
    const listeners = this.#sessionListeners.get(sessionId)
    if (listeners === undefined || listeners.size === 0) {
      return
    }
    const payload = isStored(event) ? this.#share(event) : shareStreamOnly(event)
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

/** One event in a session's log, with the internal creation time the protocol has no field for. */
interface EventRecord {
  /**
   * The event as stored: deep-frozen, and read-only in the types too, so nothing in this store
   * can write to it even by accident. Every hand-out clones it through
   * {@link InMemorySessionStore} `#share`, which is also where a derived `processed_at` comes
   * from — the log itself never carries one on a user event.
   */
  event: ImmutableStoredEvent
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
 * The in-memory half of `event_claims` (D9, issue #46). A claim taken by
 * {@link SessionStore.markProcessed} has no claiming event — `claimedByEventId` is `null` —
 * and one taken by a `span.model_request_start`'s `consumes` names that span.
 */
interface ClaimRecord {
  /** When the claim was made, as the injected clock read it. */
  readonly claimedAtMs: number
  /** The `span.model_request_start` that claimed the event, or `null` for `markProcessed`. */
  readonly claimedByEventId: EventId | null
}

/** A claim a batch wants to record, before it is recorded: {@link ClaimRecord} with its event. */
interface PendingClaim extends ClaimRecord {
  readonly eventId: EventId
}

/** The preview in flight for one session: the id its `event_start` named, and the text so far. */
interface PreviewRecord {
  readonly eventId: EventId
  text: string
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
 * Build the stored event from what the caller owns plus what the store assigns.
 *
 * Through the protocol's schema on purpose: the fake must hand back exactly the wire shape, and
 * parsing is what guarantees that — a field the caller slipped in that the protocol does not
 * have is dropped here, not stored.
 */
function storedEventFrom(input: AppendableEvent, assigned: AssignedEventFields): StoredEvent {
  return StoredEventSchema.parse({
    ...input,
    id: assigned.id,
    seq: assigned.seq,
    processed_at: isUserEventType(input.type) ? null : assigned.processedAt,
  })
}

/** Whether a stored event is a user event. */
function isUserEvent(event: ImmutableStoredEvent): event is ImmutableUserEvent {
  return isUserEventType(event.type)
}

/** Whether a stream or stored event is one the log holds, i.e. one with a `seq`; see the protocol. */
function isStored(event: ImmutableStreamEvent): event is ImmutableStoredEvent {
  return 'seq' in event
}

/**
 * A deep-frozen copy of a stream-only event — at the type the contract uses, which for these
 * two happens to be structurally identical to their immutable twin (neither carries an array).
 */
function shareStreamOnly(event: ImmutableStreamOnlyEvent): StreamOnlyEvent {
  return deepFreeze(structuredClone(event))
}

/**
 * The `processed_at` a reader sees: a user event's comes from the claim that took it — `null`
 * while none has — and every other event keeps the one the store wrote when it appended it.
 */
function derivedProcessedAt(
  event: ImmutableStoredEvent,
  claim: ClaimRecord | undefined,
): Timestamp | null {
  if (isUserEvent(event)) {
    return claim === undefined ? null : timestampAt(claim.claimedAtMs)
  }
  return event.processed_at
}

/** The session's event with this id, or `undefined` when the log holds none. */
function eventWithId(record: SessionRecord, eventId: EventId): ImmutableStoredEvent | undefined {
  return record.events.find((entry) => entry.event.id === eventId)?.event
}

/**
 * The turn state of a log: no open turn is `idle`, an open turn with a model request in flight
 * is `running`, and an open turn with nothing in flight is `unfinished`. See
 * {@link SessionStore.getTurnState}.
 */
function turnStateOf(record: SessionRecord): {
  readonly state: TurnStateKind
  readonly openSpan: ImmutableStoredEvent | null
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
function findLastStatusEvent(events: readonly ImmutableStoredEvent[]): ImmutableStoredEvent | null {
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
function findOpenSpan(events: readonly ImmutableStoredEvent[]): ImmutableStoredEvent | null {
  const unclosed = new Map<EventId, ImmutableStoredEvent>()
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
 * Whether an append ends the session's preview: the event the preview was for is now stored —
 * the log is the authority, and the preview was its display stand-in — or the model request the
 * preview belonged to ended, whether or not it produced a message.
 */
function endsPreview(
  preview: PreviewRecord | undefined,
  stored: readonly ImmutableStoredEvent[],
): boolean {
  if (preview === undefined) {
    return false
  }
  return stored.some(
    (event) => event.id === preview.eventId || event.type === EVENT_TYPES.modelRequestEnd,
  )
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
