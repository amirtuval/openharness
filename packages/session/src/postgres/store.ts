import {
  DEFAULT_EVENT_ORDER,
  DEFAULT_PARTITION_COUNT,
  EVENT_TYPES,
  encodeKeyCursor,
  encodeSeqCursor,
  newAgentId,
  newEventId,
  newSessionId,
  partitionOf,
  type Agent,
  type AgentId,
  type CreateAgentRequest,
  type EventId,
  type KeyCursor,
  type ListAgentsResponse,
  type ListEventsResponse,
  type ListSessionsResponse,
  type ModelConfig,
  type ModelRequestStartEvent,
  type Session,
  type SessionId,
  type SessionStatus,
  type StoredEvent,
  type StreamEvent,
  type UpdateAgentRequest,
  type UserEvent,
  type UserId,
  type UserPreferences,
} from '@openharness/protocol'
import {
  Kysely,
  PostgresDialect,
  sql,
  type Insertable,
  type RawBuilder,
  type SqlBool,
  type Transaction,
} from 'kysely'
import { Pool, type ClientConfig } from 'pg'

import { type Clock, systemClock } from '../clock'
import {
  AgentNotFoundError,
  ClaimConflictError,
  DuplicateEventIdError,
  FencedError,
  SessionNotFoundError,
} from '../errors'
import {
  carriesConsumes,
  cutoffOf,
  isUserEventType,
  supersessionsOf,
  type SupersessionRecord,
} from '../events'
import { deepFreeze } from '../freeze'
import {
  assertEventIds,
  assertTtl,
  decodeKeyPage,
  decodeSeqPage,
  effectiveSessionConfig,
  pageSize,
} from '../inputs'
import type {
  AppendableEvent,
  AppendEventsOptions,
  CompactOptions,
  CreateSessionOptions,
  ListAgentsOptions,
  ListEventsOptions,
  ListSessionsOptions,
  OwnerScope,
  UnscopedListEventsOptions,
  PartitionFence,
  PartitionLease,
  PartitionSignal,
  PartitionSignalInput,
  PartitionSignalListener,
  AuthSessionId,
  AuthSessionRevocationListener,
  SessionEventListener,
  SessionStore,
  TurnState,
  Unsubscribe,
  UpdateSessionRequest,
} from '../store'
import { ListenConnection } from './listen'
import {
  instant,
  agentFromRow,
  AUTH_SESSION_REVOCATION_CHANNEL,
  decodeAuthSessionRevocationNotification,
  encodeAuthSessionRevocationNotification,
  encodePartitionNotification,
  encodeSessionDeletedNotification,
  encodeStoredNotification,
  eventFromRow,
  isPartitionChannel,
  partitionChannel,
  decodePartitionNotification,
  decodeSessionDeletedNotification,
  decodeStoredNotification,
  sessionChannel,
  sessionFromRow,
  timestampOf,
  type AgentRow,
  type EventsTable,
  type EventWithClaimRow,
  type PartitionLeaseRow,
  type PostgresSchema,
  type SessionRow,
} from './schema'

/**
 * The Postgres `SessionStore`: the durable implementation of the contract in `store.ts`.
 *
 * It passes the same conformance suite as `InMemorySessionStore`, and the two behave
 * identically wherever the contract speaks — the differences are the ones the contract leaves
 * open, and they are all about being shared rather than about being different:
 *
 * - **Live delivery is `LISTEN`/`NOTIFY`.** A store keeps one dedicated listening connection
 *   (see `listen.ts`); appends notify on the session's channel inside the append
 *   transaction, so a subscriber hears about an event when it commits. Notifications carry
 *   the event's `seq`, not the event, and the subscriber fetches the range — which is what
 *   makes coalesced, repeated or missed notifications harmless. A session's deletion is
 *   announced on the same channel, in the delete transaction: a subscriber delivers one final
 *   `session.deleted` event and ends the subscription instead of fetching anything after it
 *   (see {@link PostgresSessionStore.deleteSession}).
 * - **Signals are process-wide.** A partition's signal is a notification on that partition's
 *   channel, so every server instance listening for that partition hears it, not just the one
 *   that sent it.
 * - **Time is still the store's.** Every timestamp and every lease comparison uses the
 *   injected clock, passed to Postgres as a parameter. Nothing here calls the database's
 *   `now()`.
 *
 * ## What a caller has to provide
 *
 * The tables have to exist: run {@link migrate} against the same database before the first
 * call. The store does not create its schema, and it does not validate what it is given —
 * the protocol schemas do that at the edges, exactly as they do for the in-memory store.
 *
 * ## What is not covered by the contract
 *
 * A listener that misses events because its connection died catches up through the
 * reconnected listening connection, but **signals missed while disconnected are gone**: they
 * are hints, not a queue, and a partition's new owner recovers by calling
 * `findSessionsNeedingWork`, exactly as the contract says.
 */
export class PostgresSessionStore implements SessionStore {
  readonly #db: Kysely<PostgresSchema>

  readonly #pool: Pool

  /** Whether this store opened the pool: only then does {@link PostgresSessionStore.close} end it. */
  readonly #ownsPool: boolean

  readonly #clock: Clock

  readonly #partitionCount: number

  /** One entry per session someone is subscribed to, keyed by the session's id. */
  readonly #sessions = new Map<SessionId, SessionSubscription>()

  /** The channel each subscribed session is announced on, for routing what comes back. */
  readonly #channels = new Map<string, SessionId>()

  /** One entry per partition someone is listening for signals on. */
  readonly #signals = new Map<number, Set<PartitionSignalListener>>()

  /**
   * Everyone listening for auth-session revocations (epic #65, issue #76). One set, not a map:
   * every revocation is announced on the same channel, and the payload names the session.
   */
  readonly #revocations = new Set<AuthSessionRevocationListener>()

  /** Whether the revocation channel is being listened on, so it is `LISTEN`ed once. */
  #listeningForRevocations = false

  #listen: ListenConnection | null = null

  /** The delivery queue: notifications are handled in the order they arrived. */
  #queue: Promise<unknown> = Promise.resolve()

  #closed = false

  /** How the dedicated listening connection reaches the same database. */
  readonly #clientConfig: ClientConfig

  /** Where a lost listening connection is reported; silent by default. */
  readonly #onError: (error: Error) => void

  constructor(options: PostgresSessionStoreOptions = {}) {
    const { pool, connectionString } = options
    if (pool !== undefined && connectionString !== undefined) {
      throw new TypeError('pass either `pool` or `connectionString`, not both')
    }
    if (pool === undefined && connectionString === undefined) {
      throw new TypeError('pass either `pool` or `connectionString`')
    }
    if (pool !== undefined) {
      this.#pool = pool
      this.#ownsPool = false
    } else {
      this.#pool = new Pool({ connectionString })
      this.#ownsPool = true
    }
    this.#db = new Kysely<PostgresSchema>({ dialect: new PostgresDialect({ pool: this.#pool }) })
    this.#clock = options.now ?? systemClock
    this.#partitionCount = options.partitionCount ?? DEFAULT_PARTITION_COUNT
    this.#onError = options.onError ?? (() => undefined)
    this.#clientConfig = pool === undefined ? { connectionString } : pool.options
  }

  // ------------------------------------------------------------------ agents

  async createAgent(input: CreateAgentRequest, ownerId: UserId): Promise<Agent> {
    const now = this.#clock()
    const row: AgentRow = {
      id: newAgentId(now),
      owner_id: ownerId,
      name: input.name,
      description: input.description ?? null,
      model_id: input.model.id,
      system: input.system ?? null,
      created_at: instant(now),
      updated_at: instant(now),
    }
    await this.#db.insertInto('agents').values(row).execute()
    return agentFromRow(row)
  }

  async getAgent(agentId: AgentId, options: OwnerScope): Promise<Agent | null> {
    // The owner is part of the lookup, not a filter afterwards: an agent somebody else owns
    // matches no row, which is the same `null` an unknown id answers (A4).
    const row = await this.#db
      .selectFrom('agents')
      .selectAll()
      .where('id', '=', agentId)
      .where('owner_id', '=', options.ownerId)
      .executeTakeFirst()
    return row === undefined ? null : agentFromRow(row)
  }

  async listAgents(options: ListAgentsOptions): Promise<ListAgentsResponse> {
    const cursor = options.page === undefined ? null : decodeKeyPage(options.page)
    const limit = pageSize(options.limit)
    let query = this.#db.selectFrom('agents').selectAll().where('owner_id', '=', options.ownerId)
    if (cursor !== null) {
      query = query.where(keyset(cursor, 'asc'))
    }
    const rows = await query
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(limit + 1)
      .execute()
    const data = rows.slice(0, limit).map(agentFromRow)
    return {
      data,
      next_page: rows.length > limit ? encodeKeyCursor(lastOf(data)) : null,
    }
  }

  async updateAgent(agentId: AgentId, update: UpdateAgentRequest): Promise<Agent | null> {
    const now = this.#clock()
    return this.#db.transaction().execute(async (trx) => {
      // Read, patch and write in one transaction: an update is a partial one, so what it
      // leaves alone has to be what was stored when it started.
      const row = await trx
        .selectFrom('agents')
        .selectAll()
        .where('id', '=', agentId)
        .forUpdate()
        .executeTakeFirst()
      if (row === undefined) {
        return null
      }
      const updated: AgentRow = {
        ...row,
        name: update.name ?? row.name,
        description: update.description === undefined ? row.description : update.description,
        model_id: update.model?.id ?? row.model_id,
        system: update.system === undefined ? row.system : update.system,
        updated_at: instant(now),
      }
      await trx.updateTable('agents').set(updated).where('id', '=', agentId).execute()
      return agentFromRow(updated)
    })
  }

  // ---------------------------------------------------------------- sessions

  async createSession(agentId: AgentId | null, options: CreateSessionOptions): Promise<Session> {
    const now = this.#clock()
    const id = newSessionId(now)
    return this.#db.transaction().execute(async (trx) => {
      // The owner is part of the lookup: an agent that belongs to somebody else is "not
      // found" for this session, the same answer an unknown id gets (A4) — otherwise the
      // snapshot would hand the other user's agent configuration over.
      const agent =
        agentId === null
          ? undefined
          : await trx
              .selectFrom('agents')
              .selectAll()
              .where('id', '=', agentId)
              .where('owner_id', '=', options.ownerId)
              .executeTakeFirst()
      if (agentId !== null && agent === undefined) {
        throw new AgentNotFoundError(agentId)
      }
      // What the session runs: the caller's model/system, or the agent's (issue #93). Throws
      // when neither side names a model — a model-first session needs one. The agent row's
      // `model_id` is the snapshot's model, not the session's.
      const config = effectiveSessionConfig(
        agent === undefined ? null : { model: { id: agent.model_id }, system: agent.system },
        options,
      )
      const row: SessionRow = {
        id,
        owner_id: options.ownerId,
        status: 'idle',
        partition: partitionOf(id, this.#partitionCount),
        title: options.title ?? null,
        metadata: { ...options.metadata },
        model: config.model,
        system: config.system,
        // The snapshot columns are written together: all four, or none for a model-first
        // session. What it runs lives in `model`/`system` above, never here.
        agent_id: agent?.id ?? null,
        agent_name: agent?.name ?? null,
        agent_model_id: agent?.model_id ?? null,
        agent_system: agent?.system ?? null,
        created_at: instant(now),
        updated_at: instant(now),
      }
      await trx.insertInto('sessions').values(row).execute()
      // `initial_events` belong to the creation transaction: they are in the log before this
      // returns, so nothing can observe the session without them.
      const initial = options.initial_events ?? []
      await this.#append(trx, id, initial, now)
      // The append projects a model-carrying `user.message` onto the session row (#111), so
      // when there were events the answer is the row as it is now, not the one inserted above.
      const created = initial.length === 0 ? row : ((await readSession(trx, id)) ?? row)
      return sessionFromRow(created)
    })
  }

  async getSession(sessionId: SessionId, options: OwnerScope): Promise<Session | null> {
    const row = await readSession(this.#db, sessionId)
    if (row === undefined || !ownsRow(row, options)) {
      return null
    }
    return sessionFromRow(row)
  }

  async getSessionUnscoped(sessionId: SessionId): Promise<Session | null> {
    const row = await readSession(this.#db, sessionId)
    return row === undefined ? null : sessionFromRow(row)
  }

  async updateSession(sessionId: SessionId, update: UpdateSessionRequest): Promise<Session | null> {
    const now = this.#clock()
    return this.#db.transaction().execute(async (trx) => {
      // Read, patch and write in one transaction, like `updateAgent`: an update is a partial
      // one, so what it leaves alone has to be what was stored when it started.
      const row = await trx
        .selectFrom('sessions')
        .selectAll()
        .where('id', '=', sessionId)
        .forUpdate()
        .executeTakeFirst()
      if (row === undefined) {
        return null
      }
      const updated: SessionRow = {
        ...row,
        title: update.title === undefined ? row.title : update.title,
        updated_at: instant(now),
      }
      await trx.updateTable('sessions').set(updated).where('id', '=', sessionId).execute()
      return sessionFromRow(updated)
    })
  }

  async deleteSession(sessionId: SessionId, options: OwnerScope): Promise<boolean> {
    return this.#db.transaction().execute(async (trx) => {
      // The session's row lock, exactly as an append takes it: an append in flight either
      // commits before this and its events are deleted with the rest, or starts afterwards
      // and finds no session. Somebody else's session is not this caller's to delete, and it
      // answers `false` — the same answer an id nothing has gets, so nothing leaks (A4).
      const session = await lockSession(trx, sessionId)
      if (session === undefined || !ownsRow(session, options)) {
        return false
      }
      // Every table with a session column, in one transaction. The events would cascade from
      // `sessions`, but are named anyway so the delete says what it removes; `event_claims`
      // and `event_supersessions` carry no foreign key on purpose (see `0007_event_claims.sql`),
      // so nothing else would ever remove their rows.
      await trx.deleteFrom('events').where('session_id', '=', sessionId).execute()
      await trx.deleteFrom('event_claims').where('session_id', '=', sessionId).execute()
      await trx.deleteFrom('event_supersessions').where('session_id', '=', sessionId).execute()
      await trx.deleteFrom('sessions').where('id', '=', sessionId).execute()
      // Announced on the session's own channel, inside the transaction: Postgres delivers the
      // notification when this commits, so a subscriber hears that the session is gone only
      // once it really is — whichever store, or process, deleted it.
      await sql`select pg_notify(${sessionChannel(sessionId)}, ${encodeSessionDeletedNotification(
        sessionId,
      )})`.execute(trx)
      return true
    })
  }

  // ------------------------------------------------------------- preferences

  async getPreferences(userId: UserId): Promise<UserPreferences> {
    const row = await this.#db
      .selectFrom('user_preferences')
      .select('default_model')
      .where('user_id', '=', userId)
      .executeTakeFirst()
    // No row is "no stored default", not an error and not a null: the protocol's one shape.
    return deepFreeze({ default_model: row?.default_model ?? null })
  }

  async putPreferences(userId: UserId, preferences: UserPreferences): Promise<UserPreferences> {
    const at = instant(this.#clock())
    // One statement, like the credential upsert: `user_id` is the primary key, so a second
    // put replaces the row rather than accumulating, and the replacement is atomic against a
    // concurrent one.
    await this.#db
      .insertInto('user_preferences')
      .values({ user_id: userId, default_model: preferences.default_model, updated_at: at })
      .onConflict((conflict) =>
        conflict.column('user_id').doUpdateSet({
          default_model: preferences.default_model,
          updated_at: at,
        }),
      )
      .execute()
    return deepFreeze({ default_model: preferences.default_model })
  }

  async listSessions(options: ListSessionsOptions): Promise<ListSessionsResponse> {
    const cursor = options.page === undefined ? null : decodeKeyPage(options.page)
    const limit = pageSize(options.limit)
    let query = this.#db.selectFrom('sessions').selectAll().where('owner_id', '=', options.ownerId)
    if (options.agentId !== undefined) {
      query = query.where('agent_id', '=', options.agentId)
    }
    if (cursor !== null) {
      query = query.where(keyset(cursor, 'desc'))
    }
    // Newest first: the list order is `(created_at, id)` descending, which is the order the
    // cursors seek into. The `C` collation on `id` makes the SQL order the one the cursor
    // encodes — byte order, exactly what the in-memory store compares.
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute()
    const data = rows.slice(0, limit).map(sessionFromRow)
    return {
      data,
      next_page: rows.length > limit ? encodeKeyCursor(lastOf(data)) : null,
    }
  }

  // ----------------------------------------------------------------- events

  async appendEvents(
    sessionId: SessionId,
    events: AppendableEvent[],
    options: AppendEventsOptions = {},
  ): Promise<StoredEvent[]> {
    const now = this.#clock()
    const supplied = suppliedIdsOf(events)
    try {
      return await this.#db.transaction().execute(async (trx) => {
        // The session row is the append lock: every append to a session takes it, so `seq` is
        // assigned gap-free and in the order the appends committed. It is also the existence
        // check, and the row the status update lands on.
        const session = await lockSession(trx, sessionId)
        if (session === undefined) {
          throw new SessionNotFoundError(sessionId)
        }
        assertFence(await this.#leaseOf(trx, options.fence), options.fence, 'appendEvents', now)
        return this.#append(trx, sessionId, events, now)
      })
    } catch (error) {
      // A caller-supplied id that the log already holds is refused by the unique constraint on
      // `events.id`: the insert fails, and the transaction that carried it rolls back whole, so
      // nothing of the batch is stored. The row it collided with is committed — an insert that
      // meets an uncommitted one waits for it, and only ends in a violation if it commits — so
      // a read here names the id the refusal is about.
      if (supplied.length === 0 || !isEventIdUniqueViolation(error)) {
        throw error
      }
      const taken = await this.#storedEventId(supplied)
      throw taken === null ? error : new DuplicateEventIdError(sessionId, taken)
    }
  }

  async listEvents(sessionId: SessionId, options: ListEventsOptions): Promise<ListEventsResponse> {
    const session = await readSession(this.#db, sessionId)
    // Somebody else's session is answered exactly like one that does not exist, so the 404 a
    // user-facing route derives from this leaks nothing (epic #65, A4).
    if (session === undefined || !ownsRow(session, options)) {
      throw new SessionNotFoundError(sessionId)
    }
    return this.#readEvents(sessionId, options)
  }

  async listEventsUnscoped(
    sessionId: SessionId,
    options: UnscopedListEventsOptions = {},
  ): Promise<ListEventsResponse> {
    if ((await readSession(this.#db, sessionId)) === undefined) {
      throw new SessionNotFoundError(sessionId)
    }
    return this.#readEvents(sessionId, options)
  }

  async #readEvents(
    sessionId: SessionId,
    options: UnscopedListEventsOptions,
  ): Promise<ListEventsResponse> {
    const order = options.order ?? DEFAULT_EVENT_ORDER
    const cursor = options.page === undefined ? null : decodeSeqPage(options.page)
    const limit = pageSize(options.limit)
    if (options.types !== undefined && options.types.length === 0) {
      return { data: [], next_page: null }
    }
    // The claim is joined in, not stored on the row: a user event's `processed_at` is the
    // `claimed_at` of the claim that took it, so a read always sees the fact as it is now.
    let query = this.#db
      .selectFrom('events as e')
      .leftJoin('event_claims as c', 'c.event_id', 'e.id')
      .selectAll('e')
      .select('c.claimed_at as claimed_at')
      .where('e.session_id', '=', sessionId)
    if (options.includeSuperseded !== true) {
      // Replay skips superseded chunks: an `event_start` / `event_delta` in a recorded range
      // does not come back. The filter is part of the query, so a page is a page of what a
      // reader gets and the `seq` cursor keeps seeking exactly the same way.
      query = query.where(sql<SqlBool>`not exists (
        select 1
          from event_supersessions s
         where s.session_id = e.session_id
           and e.type in (${EVENT_TYPES.eventStart}, ${EVENT_TYPES.eventDelta})
           and e.seq between s.from_seq and s.to_seq
      )`)
    }
    if (cursor !== null) {
      query = query.where('e.seq', order === 'asc' ? '>' : '<', cursor.seq)
    }
    if (options.afterSeq !== undefined) {
      query = query.where('e.seq', '>', options.afterSeq)
    }
    if (options.types !== undefined) {
      query = query.where('e.type', 'in', options.types)
    }
    const rows = await query
      .orderBy('e.seq', order)
      .limit(limit + 1)
      .execute()
    const data = rows.slice(0, limit)
    return {
      data: data.map(eventFromRow),
      next_page: rows.length > limit ? encodeSeqCursor(lastOf(data).seq) : null,
    }
  }

  async getPendingUserEvents(sessionId: SessionId): Promise<UserEvent[]> {
    if ((await readSession(this.#db, sessionId)) === undefined) {
      throw new SessionNotFoundError(sessionId)
    }
    // Pending is "no claim", not "no `processed_at`": the claim is the fact, and the events
    // that do not have one are the ones a turn has not folded in yet, in `seq` order.
    const rows = await this.#db
      .selectFrom('events as e')
      .leftJoin('event_claims as c', 'c.event_id', 'e.id')
      .selectAll('e')
      .select('c.claimed_at as claimed_at')
      .where('e.session_id', '=', sessionId)
      .where('e.type', 'in', [EVENT_TYPES.userMessage, EVENT_TYPES.userInterrupt])
      .where('c.event_id', 'is', null)
      .orderBy('e.seq', 'asc')
      .execute()
    return rows.map(eventFromRow).filter(isUserEvent)
  }

  async getTurnState(sessionId: SessionId): Promise<TurnState> {
    if ((await readSession(this.#db, sessionId)) === undefined) {
      throw new SessionNotFoundError(sessionId)
    }
    const lastStatus = await this.#db
      .selectFrom('events')
      .select('type')
      .where('session_id', '=', sessionId)
      .where('type', 'in', [
        EVENT_TYPES.sessionStatusRunning,
        EVENT_TYPES.sessionStatusIdle,
        EVENT_TYPES.sessionStatusRescheduled,
      ])
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst()
    if (lastStatus === undefined || lastStatus.type === EVENT_TYPES.sessionStatusIdle) {
      return { state: 'idle', openSpan: null }
    }
    const openSpan = await this.#openSpan(sessionId)
    return openSpan === null
      ? { state: 'unfinished', openSpan: null }
      : { state: 'running', openSpan }
  }

  async compact(options: CompactOptions): Promise<number> {
    const cutoff = cutoffOf(options)
    // One statement: delete what a recorded supersession covers, that is a chunk, that is old
    // enough — and nothing else. Two instances running this at once simply split the rows
    // between them; a second run finds nothing and deletes nothing, because the rows a first
    // run deleted are gone rather than merely matched again.
    const deleted = await sql<{ count: number }>`
      with deleted as (
        delete from events e
         using event_supersessions s
         where e.session_id = s.session_id
           and e.type in (${EVENT_TYPES.eventStart}, ${EVENT_TYPES.eventDelta})
           and e.seq between s.from_seq and s.to_seq
           and e.created_at < ${instant(cutoff)}
        returning e.id
      )
      select count(*)::int as count from deleted
    `.execute(this.#db)
    return deleted.rows[0]?.count ?? 0
  }

  // ------------------------------------------------------- live subscription

  async subscribe(sessionId: SessionId, listener: SessionEventListener): Promise<Unsubscribe> {
    const channel = sessionChannel(sessionId)
    // Where the new listener starts. A subscription never replays the log: whatever is
    // already stored when it is established is read through `listEvents`, so the snapshot is
    // taken first and everything after it is delivered — including anything that lands
    // between the snapshot and the `LISTEN`, which the catch-up fetch below picks up.
    const from = await this.#maxSeqOrThrow(sessionId)
    let subscription = this.#sessions.get(sessionId)
    if (subscription === undefined) {
      subscription = { channel, fetched: from, listeners: new Map() }
      this.#sessions.set(sessionId, subscription)
      this.#channels.set(channel, sessionId)
      try {
        await this.#connection().listen(channel)
      } catch (error) {
        this.#sessions.delete(sessionId)
        this.#channels.delete(channel)
        throw error
      }
    }
    subscription.listeners.set(listener, from)
    if (subscription.listeners.size === 1) {
      // The catch-up fetch: anything that landed between the snapshot and the `LISTEN` was
      // never announced to this store, and the notification for it is what we just missed.
      await this.#enqueue(() => this.#flush(sessionId))
    }
    return once(() => {
      const current = this.#sessions.get(sessionId)
      if (current === undefined) {
        return
      }
      current.listeners.delete(listener)
      if (current.listeners.size === 0) {
        this.#sessions.delete(sessionId)
        this.#channels.delete(current.channel)
        // `Unsubscribe` is synchronous, so the `UNLISTEN` is best effort: the channel stays
        // listened to until it lands, which only costs a notification nobody routes.
        void this.#listen?.unlisten(current.channel).catch(() => undefined)
      }
    })
  }

  // -------------------------------------------------------- scheduler support

  async signalPartition(partition: number, signal: PartitionSignalInput): Promise<void> {
    const payload: PartitionSignal = {
      partition,
      sessionId: signal.sessionId,
      kind: signal.kind,
    }
    // Announced on the partition's channel so every instance listening for that partition
    // hears it, not just this one. Nobody listening means the signal is dropped, which the
    // contract allows: recovery reads `findSessionsNeedingWork`, not the signals.
    await sql`select pg_notify(${partitionChannel(partition)}, ${encodePartitionNotification(payload)})`.execute(
      this.#db,
    )
  }

  async onPartitionSignal(
    partition: number,
    listener: PartitionSignalListener,
  ): Promise<Unsubscribe> {
    const channel = partitionChannel(partition)
    let listeners = this.#signals.get(partition)
    if (listeners === undefined) {
      listeners = new Set()
      this.#signals.set(partition, listeners)
      try {
        await this.#connection().listen(channel)
      } catch (error) {
        this.#signals.delete(partition)
        throw error
      }
    }
    listeners.add(listener)
    return once(() => {
      const current = this.#signals.get(partition)
      if (current === undefined) {
        return
      }
      current.delete(listener)
      if (current.size === 0) {
        this.#signals.delete(partition)
        void this.#listen?.unlisten(channel).catch(() => undefined)
      }
    })
  }

  // ------------------------------------------------- auth-session revocation

  async notifyAuthSessionRevoked(authSessionId: AuthSessionId): Promise<void> {
    // Announced on the one revocation channel so every instance listening hears it, not just
    // the one that handled the sign-out. Only the id travels: the payload is plaintext on the
    // channel, and the token is the credential.
    await sql`select pg_notify(${AUTH_SESSION_REVOCATION_CHANNEL}, ${encodeAuthSessionRevocationNotification(
      authSessionId,
    )})`.execute(this.#db)
  }

  async onAuthSessionRevoked(listener: AuthSessionRevocationListener): Promise<Unsubscribe> {
    if (!this.#listeningForRevocations) {
      // `ListenConnection.listen` is idempotent per channel, so a second subscriber arriving
      // while this one is still awaiting the `LISTEN` costs nothing.
      await this.#connection().listen(AUTH_SESSION_REVOCATION_CHANNEL)
      this.#listeningForRevocations = true
    }
    this.#revocations.add(listener)
    return once(() => {
      this.#revocations.delete(listener)
      if (this.#revocations.size === 0) {
        this.#listeningForRevocations = false
        // `Unsubscribe` is synchronous, so the `UNLISTEN` is best effort: the channel stays
        // listened to until it lands, which only costs a notification nobody routes.
        void this.#listen?.unlisten(AUTH_SESSION_REVOCATION_CHANNEL).catch(() => undefined)
      }
    })
  }

  async findSessionsNeedingWork(partitions: readonly number[]): Promise<SessionId[]> {
    if (partitions.length === 0) {
      return []
    }
    // Derived from the log alone — no lease, no signal, no transient state — so a partition
    // that has just been taken over gets the same answer as one that is running normally.
    // A session with pending user events *and* an open turn matches once, because it is one
    // row with two conditions.
    const found = await sql<{ id: string }>`
      select s.id
        from sessions s
       where s.partition = any(${[...partitions]}::int[])
         and (
           exists (
             select 1
               from events e
              where e.session_id = s.id
                and e.type in (${EVENT_TYPES.userMessage}, ${EVENT_TYPES.userInterrupt})
                and not exists (
                  select 1 from event_claims c where c.event_id = e.id
                )
           )
           -- An open turn: the last status event is not session.status_idle. A log with no
           -- status event at all is idle, which is what the coalesce supplies.
           or coalesce((
             select e2.type
               from events e2
              where e2.session_id = s.id
                and e2.type in (
                  ${EVENT_TYPES.sessionStatusRunning},
                  ${EVENT_TYPES.sessionStatusIdle},
                  ${EVENT_TYPES.sessionStatusRescheduled}
                )
              order by e2.seq desc
              limit 1
           ), ${EVENT_TYPES.sessionStatusIdle}) <> ${EVENT_TYPES.sessionStatusIdle}
         )
       order by s.created_at asc, s.id asc
    `.execute(this.#db)
    return found.rows.map((row) => row.id as SessionId)
  }

  // ------------------------------------------------------------ partition leases

  async acquirePartition(
    partition: number,
    owner: string,
    ttlMs: number,
  ): Promise<PartitionLease | null> {
    assertTtl(ttlMs)
    const now = this.#clock()
    // One statement, so the "is it free?" test and the take are atomic: the conditional
    // `do update` matches an unleased row, the same owner, or an expired lease, and every
    // take — even by the owner that already held it — opens a new tenure and advances the
    // epoch. No row comes back when a live lease is held by somebody else.
    const taken = await sql<PartitionLeaseRow>`
      insert into partition_leases (partition, owner, epoch, expires_at)
      values (${partition}, ${owner}, 1, ${instant(now + ttlMs)})
      on conflict (partition) do update
         set owner = excluded.owner,
             epoch = partition_leases.epoch + 1,
             expires_at = excluded.expires_at
       where partition_leases.owner is null
          or partition_leases.owner = excluded.owner
          or partition_leases.expires_at <= ${instant(now)}
      returning partition, owner, epoch, expires_at
    `.execute(this.#db)
    const row = taken.rows[0]
    return row === undefined ? null : leaseFromRow(row)
  }

  async renewPartition(
    partition: number,
    owner: string,
    epoch: number,
    ttlMs: number,
  ): Promise<boolean> {
    assertTtl(ttlMs)
    const now = this.#clock()
    const renewed = await sql`
      update partition_leases
         set expires_at = ${instant(now + ttlMs)}
       where partition = ${partition}
         and owner = ${owner}
         and epoch = ${epoch}
         and expires_at > ${instant(now)}
      returning partition
    `.execute(this.#db)
    return renewed.rows.length > 0
  }

  async releasePartition(partition: number, owner: string, epoch: number): Promise<void> {
    // Releasing what this owner does not hold is a no-op, so the statement matches on both
    // owner and epoch and simply does nothing otherwise. The epoch still advances, so a write
    // still in flight from the released tenure is fenced rather than landing in the next one.
    await sql`
      update partition_leases
         set owner = null,
             expires_at = null,
             epoch = epoch + 1
       where partition = ${partition}
         and owner = ${owner}
         and epoch = ${epoch}
    `.execute(this.#db)
  }

  async currentEpoch(partition: number): Promise<number> {
    const row = await this.#db
      .selectFrom('partition_leases')
      .select('epoch')
      .where('partition', '=', partition)
      .executeTakeFirst()
    return row?.epoch ?? 0
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Give up the store's own resources: drop the listening connection, and end the pool when
   * this store opened it.
   *
   * A store built on a pool the caller owns leaves that pool alone — the caller may be
   * sharing it with the rest of the application. Idempotent, and nothing else may be called
   * afterwards.
   */
  async close(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#sessions.clear()
    this.#channels.clear()
    this.#signals.clear()
    this.#revocations.clear()
    const listen = this.#listen
    this.#listen = null
    if (listen !== null) {
      await listen.close()
    }
    if (this.#ownsPool) {
      await this.#db.destroy()
    }
  }

  // ------------------------------------------------------------------ internals

  /**
   * Append events to a session's log inside an open transaction, assign `seq` from the log's
   * own end, record the claims and supersessions the batch carries, follow the batch's
   * projections onto the session row — its status events, and a model-carrying
   * `user.message` (#111) — and announce what was written.
   *
   * The caller has already taken the session's row lock and checked the fence, so this is
   * where the append actually happens: one multi-row insert, one claim insert, one
   * supersession insert, one session update, and one notification per event — all in the
   * caller's transaction, which is what makes a subscription hear about an event exactly when
   * it commits, and what makes the whole batch one transaction.
   *
   * An event that brought its own id is written under it, and the unique constraint on
   * `events.id` is what refuses one the log already holds: the insert fails and the
   * transaction rolls back whole. {@link PostgresSessionStore.appendEvents} turns that into a
   * `DuplicateEventIdError`.
   *
   * The batch's claims and supersessions are checked inside this transaction, and both kinds
   * of refusal — a claim that cannot be made, a range that does not fit — abort it whole:
   * nothing of the batch is stored, nothing is claimed, and no range is recorded.
   */
  async #append(
    trx: Transaction<PostgresSchema>,
    sessionId: SessionId,
    events: readonly AppendableEvent[],
    now: number,
  ): Promise<StoredEvent[]> {
    if (events.length === 0) {
      // Nothing to write: no rows, no status change, and `updated_at` stays where it was.
      return []
    }
    assertEventIds(sessionId, events)
    const base = await this.#maxSeq(sessionId, trx)
    const at = instant(now)
    const rows: Insertable<EventsTable>[] = events.map((input, index) => {
      // The id is a column, so a supplied one is written there and not repeated in the body:
      // `payload` is the event as the caller sent it, without the fields the store assigns.
      const { id, ...payload } = input
      return {
        id: id ?? newEventId(now),
        session_id: sessionId,
        seq: base + index + 1,
        type: input.type,
        payload,
        created_at: at,
        // A user event is queued until a turn claims it, and its `processed_at` is derived
        // from that claim on read; the column is *never written* for one (P4) — `undefined`
        // leaves it out of the insert, so the row keeps the column's null. Everything else
        // happened now, and reads its `processed_at` back from here.
        processed_at: isUserEventType(input.type) ? undefined : at,
      }
    })
    // What the batch records beside its events, checked before anything commits. The events
    // go in first so the claim rows can reference the span starts that carry them; a refusal
    // rolls the whole transaction back, so nothing of the batch survives it.
    const claims = claimsOf(events, rows)
    const supersessions = supersessionsOf(appendedEvents(events, rows), now)
    await trx.insertInto('events').values(rows).execute()
    if (claims.length > 0) {
      const conflicts = await this.#claim(trx, sessionId, claims, at)
      if (conflicts !== null) {
        throw new ClaimConflictError(sessionId, conflicts)
      }
    }
    if (supersessions.length > 0) {
      await this.#recordSupersessions(trx, sessionId, supersessions, at)
    }
    const status = statusAfter(events)
    const model = modelAfter(events)
    await trx
      .updateTable('sessions')
      .set({
        // The projections of the batch onto the session row, in the append's transaction: the
        // status the last status event implies, and the model the last model-carrying
        // `user.message` switches to (#111). Either is left alone when the batch does not
        // speak about it.
        ...(status === null ? {} : { status }),
        ...(model === null ? {} : { model }),
        updated_at: at,
      })
      .where('id', '=', sessionId)
      .execute()
    // Inside the transaction on purpose: Postgres delivers the notification when it commits,
    // so a subscriber never reads a log an append has not finished writing.
    const channel = sessionChannel(sessionId)
    const payloads = rows.map((row) => encodeStoredNotification(row.seq))
    await sql`select pg_notify(${channel}, payload) from unnest(${payloads}::text[]) as payload`.execute(
      trx,
    )
    // Nothing this batch wrote can be claimed yet — a `consumes` list names events already in
    // the log — so the returned events carry no claim, and a user event among them is queued.
    // `processed_at` is `null` on these rows either way: the insert left it out for a user
    // event, and the in-memory row object never fetched it back.
    return rows.map((row) =>
      eventFromRow({
        ...row,
        payload: row.payload ?? null,
        processed_at: row.processed_at ?? null,
        claimed_at: null,
      }),
    )
  }

  /**
   * Claim the user events a batch's `consumes` lists, in the append's transaction.
   *
   * One insert, insert-only. The select joins each requested id to the log, so an id that names
   * no event of this session, an event of another type, or an event another claim already took
   * never becomes a row; `on conflict (event_id) do nothing` is what decides a race with a
   * concurrent claim — the loser writes nothing — without failing the statement. An id the
   * batch names twice is caught here too: it is deduplicated for the insert, and reported.
   *
   * The events are already in the transaction (the append inserts them first, so a claim can
   * reference the span start that carries it), so a refusal throws and the caller's rollback
   * takes them back out: an append that cannot claim what it says it does is not stored.
   *
   * @returns the ids that are not left pending — already claimed, foreign, not user events, or
   *   named twice — or `null` when every claim landed
   */
  async #claim(
    trx: Transaction<PostgresSchema>,
    sessionId: SessionId,
    claims: readonly ConsumedClaim[],
    at: Date,
  ): Promise<EventId[] | null> {
    const unique = new Map<EventId, ConsumedClaim>()
    for (const claim of claims) {
      if (!unique.has(claim.eventId)) {
        unique.set(claim.eventId, claim)
      }
    }
    const asked = [...unique.values()]
    const inserted = await sql<{ event_id: string }>`
      insert into event_claims (session_id, event_id, claimed_by_event_id, claimed_at)
      select ${sessionId}, claim.event_id, claim.by_event_id, ${at}::timestamptz
        from unnest(${asked.map((claim) => claim.eventId)}::text[], ${asked.map((claim) => claim.byEventId)}::text[])
             as claim (event_id, by_event_id)
        join events e
          on e.id = claim.event_id
         and e.session_id = ${sessionId}
         and e.type in (${EVENT_TYPES.userMessage}, ${EVENT_TYPES.userInterrupt})
      on conflict (event_id) do nothing
      returning event_id
    `.execute(trx)
    const claimed = new Set(inserted.rows.map((row) => row.event_id))
    const seen = new Set<EventId>()
    const conflicts: EventId[] = []
    for (const claim of claims) {
      const duplicated = seen.has(claim.eventId)
      seen.add(claim.eventId)
      if ((duplicated || !claimed.has(claim.eventId)) && !conflicts.includes(claim.eventId)) {
        conflicts.push(claim.eventId)
      }
    }
    return conflicts.length === 0 ? null : conflicts
  }

  /** Record the chunk ranges a batch supersedes, in the append's transaction. Insert-only. */
  async #recordSupersessions(
    trx: Transaction<PostgresSchema>,
    sessionId: SessionId,
    supersessions: readonly SupersessionRecord[],
    at: Date,
  ): Promise<void> {
    await sql`
      insert into event_supersessions (session_id, from_seq, to_seq, by_event_id, by_seq, created_at)
      select ${sessionId}, range.from_seq, range.to_seq, range.by_event_id, range.by_seq, ${at}::timestamptz
        from unnest(
               ${supersessions.map((range) => range.fromSeq)}::int[],
               ${supersessions.map((range) => range.toSeq)}::int[],
               ${supersessions.map((range) => range.byEventId)}::text[],
               ${supersessions.map((range) => range.bySeq)}::int[]
             ) as range (from_seq, to_seq, by_event_id, by_seq)
    `.execute(trx)
  }

  /** The `seq` of the session's last event, or `0` when the log is empty. */
  async #maxSeq(sessionId: SessionId, db: Queryable = this.#db): Promise<number> {
    const row = await db
      .selectFrom('events')
      .select(sql<number>`coalesce(max(seq), 0)`.as('seq'))
      .where('session_id', '=', sessionId)
      .executeTakeFirstOrThrow()
    return row.seq
  }

  /**
   * Which of these ids the log already holds, earliest in the batch first, or `null` when it
   * holds none of them.
   *
   * Read outside the transaction of the append that was refused, which has rolled back by
   * then. An id is unique across the whole table, not just within a session, so this looks at
   * every session's events.
   */
  async #storedEventId(eventIds: readonly EventId[]): Promise<EventId | null> {
    const rows = await this.#db
      .selectFrom('events')
      .select('id')
      .where('id', 'in', [...eventIds])
      .execute()
    const stored = new Set<string>(rows.map((row) => row.id))
    for (const id of eventIds) {
      if (stored.has(id)) {
        return id
      }
    }
    return null
  }

  /** The partition's lease row, or `undefined` when the partition has never been leased. */
  async #leaseOf(
    trx: Transaction<PostgresSchema>,
    fence: PartitionFence | undefined,
  ): Promise<PartitionLeaseRow | undefined> {
    if (fence === undefined) {
      return undefined
    }
    return trx
      .selectFrom('partition_leases')
      .selectAll()
      .where('partition', '=', fence.partition)
      .executeTakeFirst()
  }

  /** The oldest `span.model_request_start` in the log that no end event closed, or `null`. */
  async #openSpan(sessionId: SessionId): Promise<ModelRequestStartEvent | null> {
    const rows = await sql<EventWithClaimRow>`
      select e.*, c.claimed_at
        from events e
        left join event_claims c on c.event_id = e.id
       where e.session_id = ${sessionId}
         and e.type = ${EVENT_TYPES.modelRequestStart}
         and not exists (
           select 1
             from events x
            where x.session_id = e.session_id
              and x.type = ${EVENT_TYPES.modelRequestEnd}
              and x.payload ->> 'model_request_start_id' = e.id
         )
       order by e.seq asc
       limit 1
    `.execute(this.#db)
    const row = rows.rows[0]
    return row === undefined ? null : (eventFromRow(row) as ModelRequestStartEvent)
  }

  /**
   * The session's current last `seq`, in one round trip with the existence check.
   *
   * A subscription starts after this position, which is the contract's "never called for an
   * event that was already in the log when the subscription was established".
   *
   * @throws SessionNotFoundError when the session does not exist
   */
  async #maxSeqOrThrow(sessionId: SessionId): Promise<number> {
    const found = await sql<{ max_seq: number }>`
      select coalesce((select max(seq) from events e where e.session_id = s.id), 0) as max_seq
        from sessions s
       where s.id = ${sessionId}
    `.execute(this.#db)
    const row = found.rows[0]
    if (row === undefined) {
      throw new SessionNotFoundError(sessionId)
    }
    return row.max_seq
  }

  /** The listening connection, opened on the first subscription. */
  #connection(): ListenConnection {
    if (this.#closed) {
      throw new Error('this session store is closed')
    }
    this.#listen ??= new ListenConnection({
      clientConfig: this.#clientConfig,
      onNotification: (channel, payload) => {
        // Queued, not handled here: the handler is synchronous and may need to query, and
        // notifications have to be processed one at a time and in the order they arrived.
        void this.#enqueue(() => this.#dispatch(channel, payload))
      },
      onReconnect: () => this.#enqueue(() => this.#catchUp()),
      onError: (error) => {
        this.#onError(error)
      },
    })
    return this.#listen
  }

  /**
   * Run `task` after the tasks already queued, one at a time.
   *
   * Delivery is serialized because it is stateful — a fetch advances a session's position and
   * hands the rows to listeners — and two flushes of the same session interleaving would
   * hand the same event out twice. A task's failure is its own: the queue carries on.
   */
  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task, task)
    this.#queue = result.catch(() => undefined)
    return result
  }

  /** Hand one notification to whoever it belongs to. */
  async #dispatch(channel: string, payload: string): Promise<void> {
    if (channel === AUTH_SESSION_REVOCATION_CHANNEL) {
      const authSessionId = decodeAuthSessionRevocationNotification(payload)
      if (authSessionId !== null) {
        deliverTo(this.#revocations, authSessionId)
      }
      return
    }
    if (isPartitionChannel(channel)) {
      const signal = decodePartitionNotification(payload)
      if (signal !== null) {
        deliverTo(this.#signals.get(signal.partition), signal)
      }
      return
    }
    const sessionId = this.#channels.get(channel)
    if (sessionId === undefined) {
      return
    }
    // A deleted session is announced on its own channel, in place of a stored-seq hint: the
    // payload names the session the channel belongs to, and it is the last thing that
    // subscription hears (#111). Anything else on the channel is a stored-seq hint.
    const deleted = decodeSessionDeletedNotification(payload)
    if (deleted !== null && deleted === sessionId) {
      this.#endSubscription(sessionId, sessionDeletedEvent(sessionId))
      return
    }
    if (decodeStoredNotification(payload) === null) {
      return
    }
    // The payload named a `seq`, not an event: fetch everything this session's listeners have
    // not seen. Repeated or coalesced notifications cost one empty query each.
    await this.#flush(sessionId)
  }

  /**
   * Hand a session's listeners one last `session.deleted` event and forget the subscription:
   * the session is gone, so nothing is fetched for it afterwards.
   *
   * The stored position goes with the subscription — a later queued flush finds no
   * subscription and returns — and the `UNLISTEN` is best effort, like every other: a channel
   * that stays listened to until it lands only costs a notification nobody routes.
   */
  #endSubscription(sessionId: SessionId, event: StreamEvent): void {
    const subscription = this.#sessions.get(sessionId)
    if (subscription === undefined) {
      return
    }
    this.#sessions.delete(sessionId)
    this.#channels.delete(subscription.channel)
    void this.#listen?.unlisten(subscription.channel).catch(() => undefined)
    deliverTo(subscription.listeners.keys(), event)
  }

  /**
   * Deliver everything stored after what this session's listeners have already seen.
   *
   * One query per batch, and the batch position — `fetched` — advances with the query rather
   * than with what a particular listener needed, so a listener that joined late cannot make
   * the loop fetch the same rows again. A notification that arrives while a batch is in
   * flight is queued behind this call, and finds nothing left to do.
   */
  async #flush(sessionId: SessionId): Promise<void> {
    for (;;) {
      const subscription = this.#sessions.get(sessionId)
      if (subscription === undefined || subscription.listeners.size === 0) {
        return
      }
      const rows = await this.#eventsAfter(sessionId, subscription.fetched)
      const current = this.#sessions.get(sessionId)
      if (current !== subscription) {
        return
      }
      const last = rows[rows.length - 1]
      if (last === undefined) {
        return
      }
      subscription.fetched = last.seq
      for (const row of rows) {
        const event = eventFromRow(row)
        for (const [listener, delivered] of [...subscription.listeners]) {
          if (row.seq <= delivered) {
            continue
          }
          subscription.listeners.set(listener, row.seq)
          deliverTo([listener], event)
        }
      }
    }
  }

  /**
   * A batch of stored events, in `seq` order, from just after `afterSeq`.
   *
   * Live delivery hands out every event, superseded chunks included — a subscriber hears what
   * happened, and reconciliation by `seq` and `id` is the reader's business. The claim join is
   * what makes a delivered user event carry the `processed_at` a read of the same event gives.
   */
  async #eventsAfter(sessionId: SessionId, afterSeq: number): Promise<EventWithClaimRow[]> {
    return this.#db
      .selectFrom('events as e')
      .leftJoin('event_claims as c', 'c.event_id', 'e.id')
      .selectAll('e')
      .select('c.claimed_at as claimed_at')
      .where('e.session_id', '=', sessionId)
      .where('e.seq', '>', afterSeq)
      .orderBy('e.seq', 'asc')
      .limit(FETCH_BATCH_SIZE)
      .execute()
  }

  /** Catch up every subscription after a reconnect: notifications were missed while gone. */
  async #catchUp(): Promise<void> {
    if (this.#closed) {
      return
    }
    for (const sessionId of [...this.#sessions.keys()]) {
      await this.#flush(sessionId)
    }
  }
}

/** Everything {@link PostgresSessionStore} takes. */
export interface PostgresSessionStoreOptions {
  /** A connection string this store opens (and, on {@link PostgresSessionStore.close}, ends) itself. */
  readonly connectionString?: string
  /** A pool to borrow. The store never ends it; the caller owns its lifecycle. */
  readonly pool?: Pool
  /**
   * The store's time source. Defaults to {@link systemClock}; pass a controllable clock in
   * tests, which is what the conformance suite does. Nothing in this store reads the
   * database's `now()`.
   */
  readonly now?: Clock
  /**
   * Number of partitions sessions hash into, used by
   * {@link PostgresSessionStore.findSessionsNeedingWork}. Defaults to the protocol's
   * `DEFAULT_PARTITION_COUNT`; a store only agrees with a server whose partitions match.
   */
  readonly partitionCount?: number
  /**
   * Called when the listening connection is lost or cannot be re-established.
   *
   * The store reconnects and catches up on its own, so this is for logging rather than for
   * recovery: a store with no reporter stays silent instead of writing to a console it does
   * not own.
   */
  readonly onError?: (error: Error) => void
}

/** How the two ways of reaching Postgres are written: a connection string, or a pool. */
export type PostgresSessionStoreConfig =
  { readonly connectionString: string } | { readonly pool: Pool }

/**
 * Build a Postgres-backed session store.
 *
 * ```ts
 * const store = createPostgresSessionStore(
 *   { connectionString: process.env.DATABASE_URL },
 *   { clock: systemClock },
 * )
 * ```
 *
 * The tables have to exist: run {@link migrate} against the same database first.
 */
export function createPostgresSessionStore(
  config: PostgresSessionStoreConfig,
  options: Omit<PostgresSessionStoreOptions, 'connectionString' | 'pool'> = {},
): PostgresSessionStore {
  return new PostgresSessionStore({ ...config, ...options })
}

/** Something Kysely can run a query against: the database itself, or one of its transactions. */
type Queryable = Kysely<PostgresSchema> | Transaction<PostgresSchema>

/**
 * Everything the store knows about one subscribed session.
 *
 * Each listener carries its own position, because a subscription never replays the log: a
 * listener that arrives later starts later, and one that is still catching up does not make
 * another one re-see an event. `fetched` is how far the *queries* have read, which is what
 * keeps a catch-up loop from asking for the same batch twice when the listeners are at
 * different positions.
 */
interface SessionSubscription {
  /** The channel the session's events are announced on. */
  readonly channel: string
  /** The highest `seq` a fetch has read; only ever moves forward. */
  fetched: number
  /** Each listener, and the `seq` of the last event it was given. */
  readonly listeners: Map<SessionEventListener, number>
}

/** How many events a catch-up fetch reads at a time. */
const FETCH_BATCH_SIZE = 500

/** The session's row, locked for the rest of the transaction. */
async function lockSession(
  trx: Transaction<PostgresSchema>,
  sessionId: SessionId,
): Promise<SessionRow | undefined> {
  return trx
    .selectFrom('sessions')
    .selectAll()
    .where('id', '=', sessionId)
    .forUpdate()
    .executeTakeFirst()
}

/** The session's row, or `undefined` when no session has that id. */
async function readSession(db: Queryable, sessionId: SessionId): Promise<SessionRow | undefined> {
  return db.selectFrom('sessions').selectAll().where('id', '=', sessionId).executeTakeFirst()
}

/**
 * Whether a row belongs to the owner a read was scoped to.
 *
 * An unscoped read — no `ownerId` — matches any row: that is the brain's and the scheduler's
 * form, and they act for a session rather than for a user. A scoped read matches only the
 * owner's own rows, which is how a user-facing route answers the same "not found" for
 * somebody else's resource as for one that does not exist (epic #65, A4).
 */
function ownsRow(row: { readonly owner_id: string }, options: OwnerScope): boolean {
  return row.owner_id === options.ownerId
}

/**
 * The keyset predicate of a list cursor: the items that come strictly after the cursor's
 * position in the list's own order.
 *
 * Both sides are cast explicitly: the cursor arrives as a string from the wire, and the id
 * is compared under the `C` collation the column is declared with, so the SQL order is the
 * byte order the cursor was encoded from.
 */
function keyset(cursor: KeyCursor, direction: 'asc' | 'desc'): RawBuilder<SqlBool> {
  const comparison = direction === 'asc' ? sql`>` : sql`<`
  return sql<SqlBool>`(created_at, id) ${comparison} (${cursor.created_at}::timestamptz, ${cursor.id}::text collate "C")`
}

/**
 * Refuse a fenced write whose epoch is not the partition's live one; unfenced writes always
 * pass.
 *
 * The liveness test is the same comparison the contract makes everywhere else — a lease is
 * expired from the instant `expires_at` names, inclusive — and it reads the injected clock,
 * never the database's.
 */
function assertFence(
  lease: PartitionLeaseRow | undefined,
  fence: PartitionFence | undefined,
  operation: string,
  now: number,
): void {
  if (fence === undefined) {
    return
  }
  if (lease !== undefined && lease.owner !== null && lease.expires_at !== null) {
    if (lease.epoch === fence.epoch && lease.expires_at.getTime() > now) {
      return
    }
  }
  throw new FencedError({
    partition: fence.partition,
    epoch: fence.epoch,
    currentEpoch: lease?.epoch ?? 0,
    operation,
  })
}

/** The lease a held row describes. Every row the acquire statement returns is held. */
function leaseFromRow(row: PartitionLeaseRow): PartitionLease {
  if (row.owner === null || row.expires_at === null) {
    throw new Error(`partition ${row.partition} has a lease row with no owner or expiry`)
  }
  return {
    partition: row.partition,
    owner: row.owner,
    epoch: row.epoch,
    expires_at: timestampOf(row.expires_at),
  }
}

/**
 * The session status an append leaves behind: the one the last status event in the batch
 * names, or `null` when the batch does not speak about status at all — a
 * `session.status_rescheduled` neither opens nor closes a turn, so it changes nothing.
 */
function statusAfter(events: readonly AppendableEvent[]): SessionStatus | null {
  let status: SessionStatus | null = null
  for (const event of events) {
    if (event.type === EVENT_TYPES.sessionStatusRunning) {
      status = 'running'
    } else if (event.type === EVENT_TYPES.sessionStatusIdle) {
      status = 'idle'
    }
  }
  return status
}

/**
 * The model a batch leaves on the session: the one its last model-carrying `user.message`
 * names, or `null` when the batch says nothing about the model at all (#111).
 *
 * The projection is one value rather than a rewrite of history: the message's `model` is
 * stored on the event either way, and the session row follows the last one in the batch. A
 * message without a `model` contributes nothing, so a batch that carries none leaves the
 * session's current model alone.
 */
function modelAfter(events: readonly AppendableEvent[]): ModelConfig | null {
  let model: ModelConfig | null = null
  for (const event of events) {
    if (event.type === EVENT_TYPES.userMessage && event.model !== undefined) {
      model = { id: event.model.id }
    }
  }
  return model
}

/** The final stream event a deleted session's subscribers receive (#111). */
function sessionDeletedEvent(sessionId: SessionId): StreamEvent {
  return deepFreeze({ type: EVENT_TYPES.sessionDeleted, session_id: sessionId })
}

/** Whether a stored event is a user event. */
function isUserEvent(event: StoredEvent): event is UserEvent {
  return isUserEventType(event.type)
}

/** A claim a batch wants to record: the consumed event, and the event that consumes it. */
interface ConsumedClaim {
  readonly eventId: EventId
  readonly byEventId: EventId
}

/**
 * The claims a batch carries: for every event with a `consumes` list — a
 * `span.model_request_start`, a `span.model_request_end` or a `session.status_idle` (P4) —
 * each id it names, paired with that event's id, read off the row, which is where the id the
 * store assigned (or the caller supplied) lives.
 */
function claimsOf(
  events: readonly AppendableEvent[],
  rows: readonly Insertable<EventsTable>[],
): ConsumedClaim[] {
  const claims: ConsumedClaim[] = []
  events.forEach((input, index) => {
    if (!carriesConsumes(input) || input.consumes === undefined) {
      return
    }
    const row = rows[index]
    if (row === undefined) {
      return
    }
    for (const consumed of input.consumes) {
      claims.push({ eventId: consumed, byEventId: row.id as EventId })
    }
  })
  return claims
}

/**
 * The batch as events with their assigned ids and seqs — what `supersessionsOf` reads. The
 * events are not stored yet; the `seq` an append gives them is `rows[index].seq`.
 */
function appendedEvents(
  events: readonly AppendableEvent[],
  rows: readonly Insertable<EventsTable>[],
): (AppendableEvent & { readonly id: EventId; readonly seq: number })[] {
  return events.flatMap((input, index) => {
    const row = rows[index]
    return row === undefined ? [] : [{ ...input, id: row.id as EventId, seq: row.seq }]
  })
}

/** The last item of an array the caller has already proved non-empty. */
function lastOf<T>(items: readonly T[]): T {
  const last = items[items.length - 1]
  if (last === undefined) {
    throw new RangeError('lastOf() needs a non-empty array')
  }
  return last
}

/** The ids a batch supplied, in the order it supplied them. */
function suppliedIdsOf(events: readonly AppendableEvent[]): EventId[] {
  const supplied: EventId[] = []
  for (const event of events) {
    if (event.id !== undefined) {
      supplied.push(event.id)
    }
  }
  return supplied
}

/** Postgres's SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505'

/**
 * The constraints a duplicate event id can be reported under: the primary key on `events.id`
 * (`0003_events.sql`) and the unique index `0005_events_id_unique.sql` declares beside it.
 * Both enforce the same thing, and Postgres does not promise which one it names.
 */
const EVENT_ID_CONSTRAINTS = new Set(['events_pkey', 'events_id_key'])

/**
 * Whether `error` is Postgres refusing a write because an event id is already taken.
 *
 * Only the id's own constraints count: a violation of `events (session_id, seq)` is a
 * different bug — the append lock means it cannot happen — and it surfaces as itself.
 * `constraint` is an identifier, so this does not depend on the database's locale.
 */
function isEventIdUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const { code, constraint } = error as { readonly code?: unknown; readonly constraint?: unknown }
  return (
    code === UNIQUE_VIOLATION &&
    typeof constraint === 'string' &&
    EVENT_ID_CONSTRAINTS.has(constraint)
  )
}

/** A function that runs at most once, whatever it is called: an `Unsubscribe`. */
function once(action: () => void): Unsubscribe {
  let done = false
  return () => {
    if (done) {
      return
    }
    done = true
    action()
  }
}

/**
 * Call each listener with `event`, and let none of them affect the store or the others.
 *
 * A listener is called for its side effects, not for its answer: an implementation that
 * needs to wait for a listener does so on its own, and one that throws — or rejects — is
 * simply not called again for this event.
 */
function deliverTo<T>(
  listeners: Iterable<(value: T) => void | Promise<void>> | undefined,
  event: T,
): void {
  if (listeners === undefined) {
    return
  }
  for (const listener of [...listeners]) {
    try {
      void Promise.resolve(listener(event)).catch(() => undefined)
    } catch {
      // A listener that throws is the listener's problem: the store keeps delivering.
    }
  }
}
