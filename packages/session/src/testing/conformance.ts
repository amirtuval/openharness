import {
  AgentSchema,
  EVENT_TYPES,
  MAX_PAGE_LIMIT,
  SESSION_TITLE_MAX_LENGTH,
  SessionSchema,
  StoredEventSchema,
  decodePageCursor,
  encodeKeyCursor,
  encodeSeqCursor,
  isStoredEvent,
  newEventId,
  partitionOf,
  type Agent,
  type AgentId,
  type CreateAgentRequest,
  type EventId,
  type KeyCursorPosition,
  type ModelRequestStartEvent,
  type NextPage,
  type Session,
  type SessionId,
  type StoredEvent,
  type StreamEvent,
  type UserId,
} from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { timestampAt } from '../clock'
import {
  AGENT_NOT_FOUND_ERROR_CODE,
  CLAIM_CONFLICT_ERROR_CODE,
  DUPLICATE_EVENT_ID_ERROR_CODE,
  DuplicateEventIdError,
  FENCED_ERROR_CODE,
  SESSION_NOT_FOUND_ERROR_CODE,
  isFencedError,
} from '../errors'
import type {
  AppendableEvent,
  AppendEventsOptions,
  ListModelRequestsOptions,
  PartitionLease,
  SessionStore,
} from '../store'
import { type TestClock, createTestClock } from './clock'

/**
 * The conformance suite every `SessionStore` implementation has to pass.
 *
 * It is the contract's executable form: `InMemorySessionStore` passes it today, and the
 * Postgres store must pass the same suite unchanged. That is why it only asks for what the
 * contract promises — ordering by `seq`, atomically assigned fields, the `processed_at`
 * lifecycle, turn state, pagination cursors, fencing, at-most-once signals, and leases that
 * acquire, renew (a lapse is stealable, not lost), expire and are stolen after expiry. It
 * never reaches into an implementation, and it never assumes synchronous delivery: a store may
 * notify subscriptions a tick later, or over a connection, so the tests wait for a delivery
 * instead of requiring one to have happened already.
 *
 * ## Writing the factory
 *
 * ```ts
 * import { InMemorySessionStore } from '@openharness/session'
 * import { runSessionStoreConformance } from '@openharness/session/testing'
 *
 * runSessionStoreConformance(
 *   (clock) => new InMemorySessionStore({ now: clock.now }),
 *   { name: 'InMemorySessionStore' },
 * )
 * ```
 *
 * The factory is called once per test with a fresh {@link TestClock}, and the store it returns
 * must take its time from that clock — timestamps, `processed_at` and lease expiry alike. A
 * store that reads the wall clock instead fails the tests that move time forward; that is
 * deliberate, because moving time is the only way to test lease expiry without sleeping. The
 * factory may be asynchronous (a Postgres store has to connect) and is called again for each
 * test, so it must not hand out state it shares with an earlier store.
 *
 * ## What the suite covers
 *
 * - **agents** — create, get, update, and keyset pagination, including `created_at` ties.
 * - **sessions** — the agent snapshot, the effective `model`/`system` (the agent's, the
 *   request's override of either, or a model-first session's inline model with `agent: null`,
 *   issue #93), creation options, `initial_events`, newest-first pagination, the agent filter,
 *   not-found behaviour, and the title an `updateSession` sets, keeps or clears.
 * - **ownership** (epic #65, A4) — the owner a created resource carries, the scoped reads
 *   (a second user gets `null` or an empty list for the first user's agents and sessions,
 *   and `SessionNotFoundError` for their events), the explicitly named unscoped methods that
 *   read any owner's session and log (`getSessionUnscoped`, `listEventsUnscoped`), and the
 *   refusal to create a session from somebody else's agent.
 * - **preferences** (#111, epic #116 U1) — the protocol's default for a user who saved none,
 *   the put/get round-trip, replace-in-place, clearing with `null`, two users kept apart, and
 *   a deep-frozen answer.
 * - **appending events** — `id`/`seq` assignment, `processed_at` per event kind, and the shape
 *   of what comes back.
 * - **the model projection** (#111) — a `user.message` carrying a `model` switches the
 *   session's model in the append's transaction, a message without one leaves it, the last
 *   message in a batch wins, and `initial_events` project like any other append.
 * - **caller-supplied event ids** — an id the caller brings is the stored event's id and keeps
 *   a reply's chunks and its message one identity, `seq` is still the store's, and a batch is
 *   refused whole when an id is taken, repeated in it, or not a valid event id.
 * - **the `processed_at` lifecycle** — pending events, the derived `processed_at` a claim
 *   produces, claiming twice, and ids that are not pending user events.
 * - **claims** (D9, issue #46) — `processed_at` derived from the claim on every read; claiming
 *   through the `consumes` list of any of the three event types that carry one (a
 *   `span.model_request_start`, a `span.model_request_end`, a `session.status_idle`); the
 *   `ClaimConflictError` a claim that cannot be made raises; and one event never being claimed
 *   twice.
 * - **stored chunks** — `event_start` / `event_delta` appended as stored events, with a `seq`,
 *   a `processed_at` and a delivery like any other event.
 * - **supersession and replay** — a recorded `supersedes` range skipped by reads but included
 *   still in flight, `includeSuperseded` as the debugging read, and the `RangeError` a range
 *   that does not fit raises.
 * - **rewind** (#238) — a `session.rewind` stored as an ordinary event with a range over the
 *   tail from the edited `user.message`, replay showing the conversation restarted from it,
 *   the replaced events gone from the pending list and from `findSessionsNeedingWork`, a
 *   claim into the range refused, the `RangeError` a `from_seq` that is not a still-visible
 *   message raises, the `RangeError` a batch whose rewind is not its first event — or that
 *   carries two — raises, an earlier rewind surviving a later one, and overlapping ranges
 *   treated as one union by replay and compaction.
 * - **compaction** — the retention window, only what a recorded range covers deleted
 *   (a reply's chunks, a rewind's whole tail), idempotence, and readers seeing the same log
 *   before and after.
 * - **deletion** (#111, epic #116 U5) — `deleteSession`: owner-scoped `true`/`false`, the
 *   whole log gone from every read, the event ids it held free again, and a subscription that
 *   ends with one final `session.deleted` delivery and nothing after it.
 * - **immutability** — a returned event is deep-frozen, so writing to it throws.
 * - **status updates** — the session `status` mirroring the log, and a reschedule not ending a
 *   turn.
 * - **turn state** — `idle`, `running` (with the open span) and `unfinished`, from the log.
 * - **model requests in a window** (epic #245, A2; issue #247) — `listModelRequests`: the
 *   `span.model_request_end` / `span.model_request_start` pairing that names each request's
 *   model, the half-open window (`from` in, `to` out), owner scoping, the `model: null` a
 *   request nothing attributes gets, the `(session_id, seq)` order, a rewind's branch left
 *   out, and the `RangeError` a window that is not one raises.
 * - **reading the log** — order, `after_seq`, `types`, `seq` pagination and bad cursors.
 * - **subscriptions** — stored events in `seq` order, chunk delivery interleaved, isolation,
 *   unsubscribe, and the final `session.deleted` a deleted session's subscribers receive.
 * - **partition signals** — delivery, fan-out to a partition's listeners, and dropping.
 * - **findSessionsNeedingWork** — pending events and open turns, scoped to partitions.
 * - **partition leases** — acquire, renew (including through a lapse nobody took over), expiry
 *   at `expires_at`, steal after expiry, release.
 * - **scheduler membership** (#122) — a heartbeat recording an instance, the window that keeps
 *   it live (and drops it, inclusively, at the edge), removal, and the window's argument check.
 * - **fencing** — a stale, expired, released or never-leased epoch is refused, and an unfenced
 *   write never is.
 */
export function runSessionStoreConformance(
  makeStore: MakeSessionStore,
  options: SessionStoreConformanceOptions = {},
): void {
  const name = options.name ?? 'SessionStore'

  /**
   * A store for one test, built on a clock that test can move — with the suite's two owners
   * existing as users by the time the first of them creates anything, because a store whose
   * schema references the user table (Postgres) cannot hold an owner the database has never
   * heard of.
   */
  async function setup(): Promise<{ store: SessionStore; clock: TestClock }> {
    const clock = createTestClock(START_MS)
    const store = await makeStore(clock)
    await options.ensureUsers?.([OWNER_A, OWNER_B])
    return { store, clock }
  }

  describe(`${name} conformance`, () => {
    // ------------------------------------------------------------------ agents

    describe('agents', () => {
      it('creates an agent stamped with the clock instant', async () => {
        const { store, clock } = await setup()
        const agent = await store.createAgent(agentInput(), OWNER_A)
        expect(agent).toMatchObject({
          type: 'agent',
          name: 'Summarizer',
          description: null,
          model: { id: 'anthropic/claude-sonnet-5' },
          system: 'You are concise.',
          created_at: timestampAt(clock.currentMs),
          updated_at: timestampAt(clock.currentMs),
        })
        expect(agent.id).toMatch(/^agent_/)
        expectExact(AgentSchema, agent, 'an agent')
      })

      it('reads an agent back, and answers null for an id nobody has', async () => {
        const { store } = await setup()
        const agent = await store.createAgent(agentInput(), OWNER_A)
        expect(await store.getAgent(agent.id, { ownerId: OWNER_A })).toEqual(agent)
        expect(await store.getAgent(unknownAgentId(), { ownerId: OWNER_A })).toBeNull()
      })

      it('lists agents oldest first, and ends the list with next_page: null', async () => {
        const { store, clock } = await setup()
        const first = await store.createAgent(agentInput('First'), OWNER_A)
        clock.advance(SECOND)
        const second = await store.createAgent(agentInput('Second'), OWNER_A)
        clock.advance(SECOND)
        const third = await store.createAgent(agentInput('Third'), OWNER_A)
        const page = await store.listAgents({ ownerId: OWNER_A })
        expect(page.data.map((agent) => agent.id)).toEqual([first.id, second.id, third.id])
        expect(page.next_page).toBeNull()
      })

      it('pages through agents with the keyset cursor, without gaps or duplicates', async () => {
        const { store, clock } = await setup()
        const created: Agent[] = []
        for (let index = 0; index < 5; index += 1) {
          created.push(await store.createAgent(agentInput(`Agent ${index}`), OWNER_A))
          clock.advance(SECOND)
        }
        const page = await store.listAgents({ ownerId: OWNER_A, limit: 2 })
        expect(page.data.map((agent) => agent.id)).toEqual([created[0]?.id, created[1]?.id])
        expect(decodePageCursor(nextPageOf(page))).toEqual({
          kind: 'key',
          created_at: created[1]?.created_at,
          id: created[1]?.id,
        })
        const all = await readAllPages((cursor) =>
          store.listAgents({ ownerId: OWNER_A, limit: 2, page: cursor }),
        )
        expect(all.map((agent) => agent.id)).toEqual(created.map((agent) => agent.id))
      })

      it('pages agents that share a created_at by id', async () => {
        const { store } = await setup()
        const created: Agent[] = []
        for (let index = 0; index < 4; index += 1) {
          created.push(await store.createAgent(agentInput(`Agent ${index}`), OWNER_A))
        }
        // All four share an instant, so the tie is broken by id: that is what makes the cursor
        // a position in a total order rather than in a list that shifts under a paging client.
        expect(new Set(created.map((agent) => agent.created_at)).size).toBe(1)
        const expected = [...created].sort(byKeysAsc).map((agent) => agent.id)
        const all = await readAllPages((cursor) =>
          store.listAgents({ ownerId: OWNER_A, limit: 2, page: cursor }),
        )
        expect(all.map((agent) => agent.id)).toEqual(expected)
      })

      it('updates an agent, keeping what it omits and clearing what it nulls', async () => {
        const { store, clock } = await setup()
        const agent = await store.createAgent(agentInput(), OWNER_A)
        clock.advance(5 * SECOND)
        const updated = await store.updateAgent(agent.id, { name: 'Renamed', system: null })
        expect(updated).toMatchObject({
          id: agent.id,
          name: 'Renamed',
          description: agent.description,
          model: agent.model,
          system: null,
          created_at: agent.created_at,
          updated_at: timestampAt(clock.currentMs),
        })
        expect(await store.getAgent(agent.id, { ownerId: OWNER_A })).toEqual(updated)
      })

      it('answers null when updating an agent that does not exist', async () => {
        const { store } = await setup()
        expect(await store.updateAgent(unknownAgentId(), { name: 'Nobody' })).toBeNull()
      })

      it('rejects a session for an agent that does not exist', async () => {
        const { store } = await setup()
        const error = await thrownBy(() =>
          store.createSession(unknownAgentId(), { ownerId: OWNER_A }),
        )
        expectErrorIdentity(error, 'AgentNotFoundError', AGENT_NOT_FOUND_ERROR_CODE)
      })
    })

    // ---------------------------------------------------------------- sessions

    describe('sessions', () => {
      it('snapshots the agent onto the session, and stops tracking it afterwards', async () => {
        const { store, clock } = await setup()
        const agent = await store.createAgent(agentInput(), OWNER_A)
        const session = await store.createSession(agent.id, { ownerId: OWNER_A })
        expect(session).toMatchObject({
          type: 'session',
          status: 'idle',
          title: null,
          metadata: {},
          agent: {
            id: agent.id,
            name: agent.name,
            model: agent.model,
            system: agent.system,
          },
          created_at: timestampAt(clock.currentMs),
          updated_at: timestampAt(clock.currentMs),
        })
        // The configuration the session runs is the agent's, copied beside the snapshot
        // (issue #93): what it runs and where it came from are two different fields.
        expect(session.model).toEqual(agent.model)
        expect(session.system).toBe(agent.system)
        expect(session.id).toMatch(/^sesn_/)
        expectExact(SessionSchema, session, 'a session')

        await store.updateAgent(agent.id, { name: 'Renamed', model: { id: 'other/model' } })
        const reread = await store.getSession(session.id, { ownerId: OWNER_A })
        expect(reread?.agent?.name).toBe(agent.name)
        expect(reread?.agent?.model.id).toBe(agent.model.id)
        expect(reread?.model).toEqual(agent.model)
      })

      it('creates a model-first session: no agent, the model it was given, system null', async () => {
        const { store, clock } = await setup()
        const session = await store.createSession(null, {
          ownerId: OWNER_A,
          model: { id: 'openai/gpt-4.1-mini' },
          title: 'From a model',
        })
        expect(session).toMatchObject({
          type: 'session',
          status: 'idle',
          title: 'From a model',
          metadata: {},
          model: { id: 'openai/gpt-4.1-mini' },
          system: null,
          agent: null,
          created_at: timestampAt(clock.currentMs),
          updated_at: timestampAt(clock.currentMs),
        })
        expect(session.id).toMatch(/^sesn_/)
        expectExact(SessionSchema, session, 'a model-first session')
        // It reads back the same way — a model-first session is a stored session like any
        // other, and this read is the one a backfilled row also goes through.
        expect(await store.getSession(session.id, { ownerId: OWNER_A })).toEqual(session)
      })

      it('takes the effective model and system from the request, overriding the agent', async () => {
        const { store } = await setup()
        const agent = await store.createAgent(agentInput(), OWNER_A)
        const session = await store.createSession(agent.id, {
          ownerId: OWNER_A,
          model: { id: 'openai/gpt-4.1-mini' },
        })
        // The model is the request's, the system is still the agent's — one override does not
        // silently take the other with it.
        expect(session.model).toEqual({ id: 'openai/gpt-4.1-mini' })
        expect(session.system).toBe(agent.system)
        // The snapshot is untouched: it records what the agent was, not what it contributed.
        expect(session.agent).toMatchObject({ id: agent.id, model: agent.model })

        const cleared = await store.createSession(agent.id, {
          ownerId: OWNER_A,
          model: agent.model,
          system: null,
        })
        expect(cleared.system).toBeNull()
        expect(cleared.agent?.system).toBe(agent.system)
      })

      it('refuses a session with neither an agent nor a model', async () => {
        const { store } = await setup()
        const error = await thrownBy(() => store.createSession(null, { ownerId: OWNER_A }))
        expect(error).toBeInstanceOf(RangeError)
      })

      it('stores the title and metadata it was created with', async () => {
        const { store } = await setup()
        const { agent } = await seed(store)
        const session = await store.createSession(agent.id, {
          ownerId: OWNER_A,
          title: 'A chat',
          metadata: { ticket: 'OH-4' },
        })
        expect(session.title).toBe('A chat')
        expect(session.metadata).toEqual({ ticket: 'OH-4' })
        expect(await store.getSession(session.id, { ownerId: OWNER_A })).toEqual(session)
      })

      it('sets a title after creation, and advances updated_at', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        clock.advance(5 * SECOND)
        const updated = await store.updateSession(session.id, { title: 'A chat about widgets' })
        expect(updated).toMatchObject({
          id: session.id,
          title: 'A chat about widgets',
          status: session.status,
          metadata: session.metadata,
          agent: session.agent,
          created_at: session.created_at,
          updated_at: timestampAt(clock.currentMs),
        })
        expect(await store.getSession(session.id, { ownerId: OWNER_A })).toEqual(updated)
        expectExact(SessionSchema, updated, 'a session')
        // A title is metadata, not an event: the log is untouched.
        expect(await store.listEventsUnscoped(session.id)).toEqual({ data: [], next_page: null })
      })

      it('keeps the title it omits, clears the one it nulls, and answers null for an unknown session', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        await store.updateSession(session.id, { title: 'First' })
        clock.advance(SECOND)
        expect((await store.updateSession(session.id, {}))?.title).toBe('First')
        clock.advance(SECOND)
        expect((await store.updateSession(session.id, { title: null }))?.title).toBeNull()
        expect((await store.getSession(session.id, { ownerId: OWNER_A }))?.title).toBeNull()
        expect(await store.updateSession(unknownSessionId(), { title: 'Nobody' })).toBeNull()
      })

      it('stores a title of exactly the protocol maximum, as it was given', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const title = 'x'.repeat(SESSION_TITLE_MAX_LENGTH)
        const updated = await store.updateSession(session.id, { title })
        expect(updated?.title).toBe(title)
        const reread = await store.getSession(session.id, { ownerId: OWNER_A })
        expect(reread?.title).toBe(title)
        expect(reread?.updated_at).toBe(updated?.updated_at)
      })

      it('appends initial_events in the creation transaction, unprocessed and numbered from 1', async () => {
        const { store } = await setup()
        const agent = await store.createAgent(agentInput(), OWNER_A)
        const session = await store.createSession(agent.id, {
          ownerId: OWNER_A,
          initial_events: [
            { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'hi' }] },
            { type: EVENT_TYPES.userInterrupt },
          ],
        })
        const events = (await store.listEventsUnscoped(session.id)).data
        expect(events.map((event) => [event.type, event.seq])).toEqual([
          [EVENT_TYPES.userMessage, 1],
          [EVENT_TYPES.userInterrupt, 2],
        ])
        for (const event of events) {
          expectExact(StoredEventSchema, event, 'a stored event')
        }
        expect(await store.getPendingUserEvents(session.id)).toEqual(events)
      })

      it('reads a session back, and answers null for one that does not exist', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        expect(await store.getSession(session.id, { ownerId: OWNER_A })).toEqual(session)
        expect(await store.getSession(unknownSessionId(), { ownerId: OWNER_A })).toBeNull()
      })

      it('lists sessions newest first', async () => {
        const { store, clock } = await setup()
        const agent = await store.createAgent(agentInput(), OWNER_A)
        const first = await store.createSession(agent.id, { ownerId: OWNER_A })
        clock.advance(SECOND)
        const second = await store.createSession(agent.id, { ownerId: OWNER_A })
        clock.advance(SECOND)
        const third = await store.createSession(agent.id, { ownerId: OWNER_A })
        const page = await store.listSessions({ ownerId: OWNER_A })
        expect(page.data.map((session) => session.id)).toEqual([third.id, second.id, first.id])
        expect(page.next_page).toBeNull()
      })

      it('pages through sessions with the keyset cursor, without gaps or duplicates', async () => {
        const { store, clock } = await setup()
        const agent = await store.createAgent(agentInput(), OWNER_A)
        const created: Session[] = []
        for (let index = 0; index < 5; index += 1) {
          created.push(await store.createSession(agent.id, { ownerId: OWNER_A }))
          clock.advance(SECOND)
        }
        const page = await store.listSessions({ ownerId: OWNER_A, limit: 2 })
        expect(page.data.map((session) => session.id)).toEqual([created[4]?.id, created[3]?.id])
        expect(decodePageCursor(nextPageOf(page))).toEqual({
          kind: 'key',
          created_at: created[3]?.created_at,
          id: created[3]?.id,
        })
        const all = await readAllPages((cursor) =>
          store.listSessions({ ownerId: OWNER_A, limit: 2, page: cursor }),
        )
        expect(all.map((session) => session.id)).toEqual(
          [...created].reverse().map((session) => session.id),
        )
      })

      it('pages sessions that share a created_at by id, newest first', async () => {
        const { store } = await setup()
        const agent = await store.createAgent(agentInput(), OWNER_A)
        const created: Session[] = []
        for (let index = 0; index < 4; index += 1) {
          created.push(await store.createSession(agent.id, { ownerId: OWNER_A }))
        }
        expect(new Set(created.map((session) => session.created_at)).size).toBe(1)
        const expected = [...created]
          .sort(byKeysAsc)
          .reverse()
          .map((session) => session.id)
        const all = await readAllPages((cursor) =>
          store.listSessions({ ownerId: OWNER_A, limit: 3, page: cursor }),
        )
        expect(all.map((session) => session.id)).toEqual(expected)
      })

      it('filters sessions by agent', async () => {
        const { store, clock } = await setup()
        const wanted = await store.createAgent(agentInput('Wanted'), OWNER_A)
        const other = await store.createAgent(agentInput('Other'), OWNER_A)
        const mine = await store.createSession(wanted.id, { ownerId: OWNER_A })
        clock.advance(SECOND)
        await store.createSession(other.id, { ownerId: OWNER_A })
        clock.advance(SECOND)
        // A model-first session has no agent id, so no agent filter can match it (#93).
        await store.createSession(null, { ownerId: OWNER_A, model: { id: 'openai/gpt-4.1-mini' } })
        const page = await store.listSessions({ ownerId: OWNER_A, agentId: wanted.id })
        expect(page.data.map((session) => session.id)).toEqual([mine.id])
        const all = await store.listSessions({ ownerId: OWNER_A })
        expect(all.data).toHaveLength(3)
      })

      // One test per method, so a failure names the call that misbehaved.
      const sessionCalls: Record<
        string,
        (store: SessionStore, sessionId: SessionId) => Promise<unknown>
      > = {
        appendEvents: (store, sessionId) => store.appendEvents(sessionId, [userMessage('hi')]),
        listEventsUnscoped: (store, sessionId) => store.listEventsUnscoped(sessionId),
        getPendingUserEvents: (store, sessionId) => store.getPendingUserEvents(sessionId),
        getTurnState: (store, sessionId) => store.getTurnState(sessionId),
        subscribe: (store, sessionId) => store.subscribe(sessionId, () => undefined),
      }
      for (const [method, call] of Object.entries(sessionCalls)) {
        it(`rejects ${method} for a session that does not exist`, async () => {
          const { store } = await setup()
          const missing = unknownSessionId()
          const error = await thrownBy(() => call(store, missing))
          expectErrorIdentity(error, 'SessionNotFoundError', SESSION_NOT_FOUND_ERROR_CODE)
          expect(errorFields(error)).toMatchObject({ sessionId: missing })
        })
      }
    })

    // -------------------------------------------------------------- ownership

    describe('ownership', () => {
      it('stamps a created agent and session with the owner they were created for', async () => {
        const { store } = await setup()
        const agent = await store.createAgent(agentInput(), OWNER_A)
        const session = await store.createSession(agent.id, { ownerId: OWNER_A })
        expect(agent.owner_id).toBe(OWNER_A)
        expect(session.owner_id).toBe(OWNER_A)
        expect((await store.getAgent(agent.id, { ownerId: OWNER_A }))?.owner_id).toBe(OWNER_A)
        expect((await store.getSession(session.id, { ownerId: OWNER_A }))?.owner_id).toBe(OWNER_A)
        // The owner is not writable after creation: an update leaves it alone, and it is not
        // a field any request carries.
        const updated = await store.updateAgent(agent.id, { name: 'Renamed' })
        expect(updated?.owner_id).toBe(OWNER_A)
      })

      it('answers null for a scoped read of another owner’s agent', async () => {
        const { store } = await setup()
        const agent = await store.createAgent(agentInput(), OWNER_A)
        expect(await store.getAgent(agent.id, { ownerId: OWNER_A })).toEqual(agent)
        expect(await store.getAgent(agent.id, { ownerId: OWNER_B })).toBeNull()
      })

      it('lists only the owner’s agents, and an empty list for a user with none', async () => {
        const { store, clock } = await setup()
        const mine = await store.createAgent(agentInput('Mine'), OWNER_A)
        clock.advance(SECOND)
        const theirs = await store.createAgent(agentInput('Theirs'), OWNER_B)
        expect((await store.listAgents({ ownerId: OWNER_A })).data).toEqual([mine])
        expect((await store.listAgents({ ownerId: OWNER_B })).data).toEqual([theirs])
        expect((await store.listAgents({ ownerId: 'user_nobody' })).data).toEqual([])
      })

      it('answers null for another owner’s session when scoped, and the internal read sees it', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        expect(await store.getSession(session.id, { ownerId: OWNER_A })).toEqual(session)
        expect(await store.getSession(session.id, { ownerId: OWNER_B })).toBeNull()
        // The unscoped read is the brain's form, under its own name: an explicitly named
        // method rather than an optional owner, so a route cannot reach it by forgetting one.
        expect((await store.getSessionUnscoped(session.id))?.id).toBe(session.id)
      })

      it('lists only the owner’s sessions, and an empty list for a user with none', async () => {
        const { store, clock } = await setup()
        const { agent, session } = await seed(store)
        const theirs = await store.createAgent(agentInput('Theirs'), OWNER_B)
        clock.advance(SECOND)
        const theirSession = await store.createSession(theirs.id, { ownerId: OWNER_B })
        expect((await store.listSessions({ ownerId: OWNER_A })).data).toEqual([session])
        expect((await store.listSessions({ ownerId: OWNER_B })).data).toEqual([theirSession])
        expect((await store.listSessions({ ownerId: 'user_nobody' })).data).toEqual([])
        // The agent filter narrows inside the owner's own sessions, never across owners.
        expect((await store.listSessions({ ownerId: OWNER_B, agentId: agent.id })).data).toEqual([])
      })

      it('rejects a scoped read of another owner’s events like a session that does not exist', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [userMessage('mine')])
        expect((await store.listEvents(session.id, { ownerId: OWNER_A })).data).toHaveLength(1)
        const error = await thrownBy(() => store.listEvents(session.id, { ownerId: OWNER_B }))
        expectErrorIdentity(error, 'SessionNotFoundError', SESSION_NOT_FOUND_ERROR_CODE)
        // Same answer as an id nothing has: the scoped read leaks nothing.
        const missing = await thrownBy(() =>
          store.listEvents(unknownSessionId(), { ownerId: OWNER_B }),
        )
        expectErrorIdentity(missing, 'SessionNotFoundError', SESSION_NOT_FOUND_ERROR_CODE)
        // The unscoped read — the brain's replay — still sees the log.
        expect((await store.listEventsUnscoped(session.id)).data).toHaveLength(1)
      })

      it('reads any owner’s session and log through the explicitly unscoped internal methods', async () => {
        const { store } = await setup()
        const theirs = await store.createAgent(agentInput('Theirs'), OWNER_B)
        const theirSession = await store.createSession(theirs.id, { ownerId: OWNER_B })
        await append(store, theirSession.id, [userMessage('theirs')])
        expect((await store.getSessionUnscoped(theirSession.id))?.owner_id).toBe(OWNER_B)
        expect((await store.listEventsUnscoped(theirSession.id)).data).toHaveLength(1)
        // The unscoped reads still refuse an id nothing has: they are owners of nothing.
        const missingSession = await thrownBy(() => store.listEventsUnscoped(unknownSessionId()))
        expectErrorIdentity(missingSession, 'SessionNotFoundError', SESSION_NOT_FOUND_ERROR_CODE)
        expect(await store.getSessionUnscoped(unknownSessionId())).toBeNull()
      })

      it('refuses to create a session from another owner’s agent, and stores nothing', async () => {
        const { store } = await setup()
        const agent = await store.createAgent(agentInput('Theirs'), OWNER_B)
        const error = await thrownBy(() => store.createSession(agent.id, { ownerId: OWNER_A }))
        expectErrorIdentity(error, 'AgentNotFoundError', AGENT_NOT_FOUND_ERROR_CODE)
        expect(errorFields(error)).toMatchObject({ agentId: agent.id })
        expect((await store.listSessions({ ownerId: OWNER_A })).data).toEqual([])
        expect((await store.listSessions({ ownerId: OWNER_B })).data).toEqual([])
      })

      it('keeps two owners’ logs apart when both sides are scoped', async () => {
        const { store } = await setup()
        const mine = await store.createAgent(agentInput(), OWNER_A)
        const theirs = await store.createAgent(agentInput(), OWNER_B)
        const mineSession = await store.createSession(mine.id, { ownerId: OWNER_A })
        const theirSession = await store.createSession(theirs.id, { ownerId: OWNER_B })
        await append(store, mineSession.id, [userMessage('mine')])
        await append(store, theirSession.id, [userMessage('theirs')])
        const hers = await store.listEvents(mineSession.id, { ownerId: OWNER_A })
        const his = await store.listEvents(theirSession.id, { ownerId: OWNER_B })
        expect(hers.data).toHaveLength(1)
        expect(his.data).toHaveLength(1)
        expect(hers.data[0]?.id).not.toBe(his.data[0]?.id)
      })
    })

    // ------------------------------------------------------------- preferences

    describe('preferences (#111, epic #116 U1)', () => {
      it('reads the protocol defaults for a user who has saved none', async () => {
        const { store } = await setup()
        // No row is the absence of a choice, not an error: one shape for a settings screen.
        expect(await store.getPreferences(OWNER_A)).toEqual({
          default_model: null,
          theme: 'system',
        })
        expect(await store.getPreferences(OWNER_B)).toEqual({
          default_model: null,
          theme: 'system',
        })
      })

      it('round-trips a put through the read, as written', async () => {
        const { store } = await setup()
        const stored = await store.putPreferences(OWNER_A, {
          default_model: 'anthropic/claude-sonnet-5',
          theme: 'dim',
        })
        expect(stored).toEqual({ default_model: 'anthropic/claude-sonnet-5', theme: 'dim' })
        expect(await store.getPreferences(OWNER_A)).toEqual(stored)
      })

      it('replaces the stored value in place on a second put, both fields together', async () => {
        const { store } = await setup()
        await store.putPreferences(OWNER_A, {
          default_model: 'anthropic/claude-sonnet-5',
          theme: 'dim',
        })
        const replaced = await store.putPreferences(OWNER_A, {
          default_model: 'openai/gpt-5-mini',
          theme: 'dark',
        })
        // One value per user, so the second put is the same preferences with new choices —
        // and writing one field never leaves the other at a previous put's value.
        expect(replaced).toEqual({ default_model: 'openai/gpt-5-mini', theme: 'dark' })
        expect(await store.getPreferences(OWNER_A)).toEqual(replaced)
      })

      it('clears the stored default when put null, keeping the theme', async () => {
        const { store } = await setup()
        await store.putPreferences(OWNER_A, {
          default_model: 'anthropic/claude-sonnet-5',
          theme: 'dark',
        })
        expect(await store.putPreferences(OWNER_A, { default_model: null, theme: 'dark' })).toEqual(
          {
            default_model: null,
            theme: 'dark',
          },
        )
        expect(await store.getPreferences(OWNER_A)).toEqual({ default_model: null, theme: 'dark' })
      })

      it('keeps two users’ preferences apart', async () => {
        const { store } = await setup()
        await store.putPreferences(OWNER_A, {
          default_model: 'anthropic/claude-sonnet-5',
          theme: 'light',
        })
        // B has saved nothing while A has — and neither read ever sees the other's value.
        expect(await store.getPreferences(OWNER_B)).toEqual({
          default_model: null,
          theme: 'system',
        })
        await store.putPreferences(OWNER_B, { default_model: 'openai/gpt-5-mini', theme: 'dim' })
        expect(await store.getPreferences(OWNER_A)).toEqual({
          default_model: 'anthropic/claude-sonnet-5',
          theme: 'light',
        })
        expect(await store.getPreferences(OWNER_B)).toEqual({
          default_model: 'openai/gpt-5-mini',
          theme: 'dim',
        })
      })

      it('hands out deep-frozen values, so writing to one throws', async () => {
        const { store } = await setup()
        const stored = await store.putPreferences(OWNER_A, {
          default_model: 'anthropic/claude-sonnet-5',
          theme: 'system',
        })
        const read = await store.getPreferences(OWNER_A)
        expect(Object.isFrozen(stored)).toBe(true)
        expect(Object.isFrozen(read)).toBe(true)
        expect(() => Object.assign(read, { default_model: 'openai/gpt-5-mini' })).toThrow(TypeError)
        // None of it reached the store.
        expect(await store.getPreferences(OWNER_A)).toEqual({
          default_model: 'anthropic/claude-sonnet-5',
          theme: 'system',
        })
      })
    })

    // ----------------------------------------------------------------- events

    describe('appending events', () => {
      it('assigns an id and a seq to every event, in order', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const stored = await append(store, session.id, [
          statusRunning(),
          agentMessage('hello'),
          statusIdle(),
        ])
        expect(stored.map((event) => event.seq)).toEqual([1, 2, 3])
        expect(new Set(stored.map((event) => event.id)).size).toBe(3)
        for (const event of stored) {
          expect(event.id).toMatch(/^sevt_/)
        }
        expect((await store.listEventsUnscoped(session.id)).data).toEqual(stored)
      })

      it('continues the sequence across appends', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [userMessage('one')])
        const second = await append(store, session.id, [userMessage('two'), userMessage('three')])
        expect(second.map((event) => event.seq)).toEqual([2, 3])
        expect(await store.getPendingUserEvents(session.id)).toHaveLength(3)
      })

      it('stores a user event unprocessed and a server event already processed', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        clock.advance(3 * SECOND)
        const [message, running] = await append(store, session.id, [
          userMessage('hi'),
          statusRunning(),
        ])
        expect(message).toMatchObject({ type: EVENT_TYPES.userMessage, processed_at: null })
        expect(running).toMatchObject({
          type: EVENT_TYPES.sessionStatusRunning,
          processed_at: timestampAt(clock.currentMs),
        })
      })

      it('does nothing when handed no events', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        clock.advance(10 * SECOND)
        expect(await store.appendEvents(session.id, [])).toEqual([])
        expect((await store.getSession(session.id, { ownerId: OWNER_A }))?.updated_at).toBe(
          session.updated_at,
        )
        await append(store, session.id, [userMessage('later')])
        expect((await store.getSession(session.id, { ownerId: OWNER_A }))?.updated_at).toBe(
          timestampAt(clock.currentMs),
        )
      })

      it('advances the session updated_at with every append', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        clock.advance(10 * SECOND)
        await append(store, session.id, [userMessage('hi')])
        expect((await store.getSession(session.id, { ownerId: OWNER_A }))?.updated_at).toBe(
          timestampAt(clock.currentMs),
        )
      })

      it('returns events that are exactly stored events', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const stored = await append(store, session.id, [statusRunning(), spanStart()])
        const start = stored[1]
        if (start?.type !== EVENT_TYPES.modelRequestStart) {
          throw new Error('the store did not return the span start it was given')
        }
        await append(store, session.id, [spanEnd(start), sessionError(), statusRescheduled()])
        for (const event of (await store.listEventsUnscoped(session.id)).data) {
          expectExact(StoredEventSchema, event, 'a stored event')
        }
      })
    })

    // ------------------------------------------------------ the model projection

    describe('the model projection (user.message.model, #111)', () => {
      it('switches the session’s model to the one a user.message carries', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [userMessageWith('use this one', 'openai/gpt-5-mini')])
        // The projection lands in the append's transaction, so a read after it sees the new
        // model — scoped, and unscoped, which is the one the brain takes.
        expect((await store.getSession(session.id, { ownerId: OWNER_A }))?.model).toEqual({
          id: 'openai/gpt-5-mini',
        })
        expect((await store.getSessionUnscoped(session.id))?.model).toEqual({
          id: 'openai/gpt-5-mini',
        })
        // The agent snapshot is untouched: it records what the agent was, not what runs.
        expect((await store.getSessionUnscoped(session.id))?.agent?.model).toEqual(
          session.agent?.model,
        )
        // And the message that carried the switch is stored as written, model and all.
        const [message] = (await store.listEventsUnscoped(session.id)).data
        expect(message).toMatchObject({
          type: EVENT_TYPES.userMessage,
          model: { id: 'openai/gpt-5-mini' },
        })
      })

      it('leaves the session’s model alone for a message without one', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [userMessageWith('switch', 'openai/gpt-5-mini')])
        await append(store, session.id, [userMessage('just talking'), statusRunning()])
        expect((await store.getSessionUnscoped(session.id))?.model).toEqual({
          id: 'openai/gpt-5-mini',
        })
      })

      it('lets the last model-carrying message win, within a batch and across appends', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [
          userMessageWith('one', 'openai/gpt-5-mini'),
          userMessageWith('two', 'anthropic/claude-sonnet-5'),
        ])
        expect((await store.getSessionUnscoped(session.id))?.model).toEqual({
          id: 'anthropic/claude-sonnet-5',
        })
        await append(store, session.id, [userMessageWith('three', 'google/gemini-3-pro')])
        expect((await store.getSessionUnscoped(session.id))?.model).toEqual({
          id: 'google/gemini-3-pro',
        })
      })

      it('projects a model carried by a createSession initial_events message', async () => {
        const { store } = await setup()
        const agent = await store.createAgent(agentInput(), OWNER_A)
        const session = await store.createSession(agent.id, {
          ownerId: OWNER_A,
          // Written out as a client writes it: `initial_events` are user event inputs, the
          // shapes a request carries, not the stored events an append returns.
          initial_events: [
            {
              type: EVENT_TYPES.userMessage,
              content: [{ type: 'text', text: 'start here' }],
              model: { id: 'openai/gpt-5-mini' },
            },
          ],
        })
        // The append and the creation are one transaction, so the session is never observable
        // running the agent's model — what comes back already runs the message's.
        expect(session.model).toEqual({ id: 'openai/gpt-5-mini' })
        expect((await store.getSession(session.id, { ownerId: OWNER_A }))?.model).toEqual({
          id: 'openai/gpt-5-mini',
        })
      })
    })

    // ------------------------------------------------- caller-supplied event ids

    describe('caller-supplied event ids', () => {
      it('stores an event under the id it was given, and returns it', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const id = suppliedEventId()
        // Written out rather than spread over a builder: this is the shape a caller — the
        // brain appending the `agent.message` its previews announced — writes by hand.
        const [stored] = await append(store, session.id, [
          { type: EVENT_TYPES.agentMessage, content: [{ type: 'text', text: 'hello' }], id },
        ])
        expect(stored?.id).toBe(id)
      })

      it('reads the event back under that id, at the seq the log has it at', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const id = suppliedEventId()
        const [stored] = await append(store, session.id, [{ ...userMessage('one'), id }])
        const page = await store.listEventsUnscoped(session.id)
        expect(page.data.find((event) => event.id === id)).toEqual(stored)
        expect(page.data.filter((event) => event.id === id)).toHaveLength(1)

        // `seq` is the store's either way: a supplied id changes which event an append
        // writes, not where in the log it lands.
        expect(stored?.seq).toBe(1)
        const [next] = await append(store, session.id, [userMessage('two')])
        expect(next?.seq).toBe(2)
        expect(next?.id).not.toBe(id)
      })

      it('mixes supplied and generated ids in one batch', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const first = suppliedEventId()
        const third = suppliedEventId()
        const stored = await append(store, session.id, [
          { ...userMessage('one'), id: first },
          userMessage('two'),
          { ...statusRunning(), id: third },
        ])
        expect(stored.map((event) => event.seq)).toEqual([1, 2, 3])
        expect(stored[0]?.id).toBe(first)
        expect(stored[2]?.id).toBe(third)
        // The event that brought no id got one from the store, as every event used to.
        expect(stored[1]?.id).toMatch(/^sevt_/)
        expect(new Set(stored.map((event) => event.id)).size).toBe(3)
      })

      it('keeps a reply’s chunks and its message on one id', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const received: StreamEvent[] = []
        await store.subscribe(session.id, (event) => {
          received.push(event)
        })
        // What the brain does for a streaming reply: mint an id, append the chunks under it,
        // and append the finished message with the same id, so a client matches what it
        // accumulated to what was stored.
        const id = suppliedEventId()
        await append(store, session.id, [eventStart(id), eventDelta(id)])
        const [stored] = await append(store, session.id, [{ ...agentMessage('hello'), id }])
        await waitFor(() => received.length === 3, 'the two chunks and the stored message')

        expect(stored?.id).toBe(id)
        // Every chunk names the message it previews from the inside; the message is itself.
        expect(received.filter(isStoredEvent).map((event) => previewedId(event))).toEqual([
          id,
          id,
          id,
        ])
      })

      it('refuses an id the log already holds, and stores nothing of the batch', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const id = suppliedEventId()
        const [first] = await append(store, session.id, [{ ...userMessage('first'), id }])

        const error = await thrownBy(() =>
          store.appendEvents(session.id, [userMessage('second'), { ...agentMessage('hi'), id }]),
        )
        expect(error).toBeInstanceOf(DuplicateEventIdError)
        expectErrorIdentity(error, 'DuplicateEventIdError', DUPLICATE_EVENT_ID_ERROR_CODE)
        expect(errorFields(error)).toMatchObject({ sessionId: session.id, eventId: id })

        // Nothing of the refused batch: not the event with the taken id, and not the valid
        // event in front of it, because an append is one transaction.
        expect((await store.listEventsUnscoped(session.id)).data).toEqual([first])
        expect(await store.getPendingUserEvents(session.id)).toEqual([first])
      })

      it('refuses an id another session already holds', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const id = suppliedEventId()
        await append(store, session.id, [{ ...userMessage('here'), id }])

        // An event id is the identity of one event for the whole store, not one per session.
        const other = await store.createSession(
          (await store.createAgent(agentInput('Other'), OWNER_A)).id,
          { ownerId: OWNER_A },
        )
        const error = await thrownBy(() =>
          store.appendEvents(other.id, [{ ...userMessage('there'), id }]),
        )
        expectErrorIdentity(error, 'DuplicateEventIdError', DUPLICATE_EVENT_ID_ERROR_CODE)
        expect((await store.listEventsUnscoped(other.id)).data).toEqual([])
      })

      it('refuses the same id twice in one batch, and stores nothing', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const id = suppliedEventId()
        const error = await thrownBy(() =>
          store.appendEvents(session.id, [
            { ...userMessage('one'), id },
            { ...statusRunning(), id },
          ]),
        )
        expectErrorIdentity(error, 'DuplicateEventIdError', DUPLICATE_EVENT_ID_ERROR_CODE)
        expect(errorFields(error)).toMatchObject({ eventId: id })
        expect((await store.listEventsUnscoped(session.id)).data).toEqual([])
        expect((await store.getSession(session.id, { ownerId: OWNER_A }))?.status).toBe('idle')
      })

      it('refuses an id that is not a valid event id, and stores nothing', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        // A session id is a valid id of the wrong kind; the other is not an id at all.
        const wrongKind = session.id as unknown as EventId
        const notAnId = 'nope' as EventId
        for (const id of [wrongKind, notAnId]) {
          const error = await thrownBy(() =>
            store.appendEvents(session.id, [{ ...userMessage('hi'), id }]),
          )
          expect(error).toBeInstanceOf(RangeError)
        }
        expect((await store.listEventsUnscoped(session.id)).data).toEqual([])
      })

      it('fences an append that supplies an id like any other', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        const lease = await leaseFor(store, session.id, 30 * SECOND)
        const fence = { partition: lease.partition, epoch: lease.epoch }
        const id = suppliedEventId()
        const [stored] = await append(store, session.id, [{ ...userMessage('hi'), id }], { fence })
        expect(stored?.id).toBe(id)

        clock.advance(30 * SECOND)
        const error = await thrownBy(() =>
          store.appendEvents(session.id, [{ ...userMessage('late'), id: suppliedEventId() }], {
            fence,
          }),
        )
        expect(isFencedError(error)).toBe(true)
        expect((await store.listEventsUnscoped(session.id)).data).toEqual([stored])
      })
    })

    // ------------------------------------------------- processed_at lifecycle

    describe('the processed_at lifecycle', () => {
      it('lists pending user events in seq order, and stops listing them once claimed', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const first = await append(store, session.id, [userMessage('one')])
        await append(store, session.id, [statusRunning(), agentMessage('hi')])
        const second = await append(store, session.id, [userMessage('two')])
        expect((await store.getPendingUserEvents(session.id)).map((event) => event.id)).toEqual([
          first[0]?.id,
          second[0]?.id,
        ])
        await append(store, session.id, [spanStartFor([first[0]?.id ?? unknownEventId()])])
        expect((await store.getPendingUserEvents(session.id)).map((event) => event.id)).toEqual([
          second[0]?.id,
        ])
      })

      it('stamps processed_at from the clock of the claiming append, on every read', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        const stored = await append(store, session.id, [userMessage('one'), userMessage('two')])
        const ids = stored.map((event) => event.id)
        clock.advance(7 * SECOND)
        const [span] = await append(store, session.id, [spanStartFor(ids)])
        expect(span?.processed_at).toBe(timestampAt(clock.currentMs))

        const reread = (await store.listEventsUnscoped(session.id)).data.filter((event) =>
          ids.includes(event.id),
        )
        expect(reread.map((event) => event.processed_at)).toEqual([
          timestampAt(clock.currentMs),
          timestampAt(clock.currentMs),
        ])
        for (const event of reread) {
          expectExact(StoredEventSchema, event, 'a stored event')
        }
        // The log's own rows are untouched: what a read derives is the claim's instant.
        expect(reread).toEqual(
          stored.map((event) => ({ ...event, processed_at: timestampAt(clock.currentMs) })),
        )
      })

      it('refuses claims on ids that are not pending user events, and stores nothing', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const [message] = await append(store, session.id, [userMessage('one')])
        const [running] = await append(store, session.id, [statusRunning()])
        const other = await store.createSession(
          (await store.createAgent(agentInput(), OWNER_A)).id,
          { ownerId: OWNER_A },
        )
        const [elsewhere] = await append(store, other.id, [userMessage('other')])
        const before = (await store.listEventsUnscoped(session.id)).data
        for (const consumed of [
          running?.id ?? unknownEventId(),
          elsewhere?.id ?? unknownEventId(),
          unknownEventId(),
        ]) {
          const error = await thrownBy(() =>
            store.appendEvents(session.id, [spanStartFor([consumed])]),
          )
          expectErrorIdentity(error, 'ClaimConflictError', CLAIM_CONFLICT_ERROR_CODE)
        }
        expect((await store.listEventsUnscoped(session.id)).data).toEqual(before)
        // The message is still queued, and the foreign event is untouched where it lives.
        expect((await store.getPendingUserEvents(session.id)).map((event) => event.id)).toEqual([
          message?.id,
        ])
        expect((await store.getPendingUserEvents(other.id)).map((event) => event.id)).toEqual([
          elsewhere?.id,
        ])
      })

      it('claims an event once when two appends race for it', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const [message] = await append(store, session.id, [userMessage('one')])
        const id = message?.id ?? unknownEventId()
        // Async wrappers, because the in-memory store throws synchronously where Postgres
        // rejects: both spellings have to settle as one fulfilled and one rejected attempt.
        const attempt = async () => store.appendEvents(session.id, [spanStartFor([id])])
        const race = await Promise.allSettled([attempt(), attempt()])
        const fulfilled = race.filter((result) => result.status === 'fulfilled')
        const rejected = race.filter((result) => result.status === 'rejected')
        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expectErrorIdentity(
          rejected[0]?.status === 'rejected' ? rejected[0].reason : null,
          'ClaimConflictError',
          CLAIM_CONFLICT_ERROR_CODE,
        )
        expect(await store.getPendingUserEvents(session.id)).toEqual([])
      })
    })

    // ------------------------------------------------------- claims (D9, #46)

    describe('claims', () => {
      it('claims user events by appending the span that consumes them', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        const [queued] = await append(store, session.id, [userMessage('answer me')])
        const id = queued?.id ?? unknownEventId()
        expect((await store.getPendingUserEvents(session.id)).map((event) => event.id)).toEqual([
          id,
        ])

        clock.advance(4 * SECOND)
        const [span] = await append(store, session.id, [spanStartFor([id])])
        expect(span?.type).toBe(EVENT_TYPES.modelRequestStart)

        // The claim is the fact: no stored event changed, and every read of the consumed event
        // now derives its `processed_at` from the append that consumed it.
        expect(await store.getPendingUserEvents(session.id)).toEqual([])
        const reread = (await store.listEventsUnscoped(session.id)).data.find(
          (event) => event.id === id,
        )
        expect(reread).toMatchObject({
          type: EVENT_TYPES.userMessage,
          processed_at: timestampAt(clock.currentMs),
        })
        expect(reread).toEqual({ ...queued, processed_at: timestampAt(clock.currentMs) })
      })

      it('stops counting a claimed session as one needing work', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const [queued] = await append(store, session.id, [userMessage('hi')])
        expect(await store.findSessionsNeedingWork([partitionOf(session.id)])).toEqual([session.id])
        await append(store, session.id, [spanStartFor([queued?.id ?? unknownEventId()])])
        expect(await store.findSessionsNeedingWork([partitionOf(session.id)])).toEqual([])
      })

      it('refuses a claim on an event another claim already took, and stores nothing', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const [queued] = await append(store, session.id, [userMessage('hi')])
        const id = queued?.id ?? unknownEventId()
        await append(store, session.id, [spanStartFor([id])])
        const before = (await store.listEventsUnscoped(session.id)).data

        const error = await thrownBy(() =>
          store.appendEvents(session.id, [spanStartFor([id]), agentMessage('and stores nothing')]),
        )
        expectErrorIdentity(error, 'ClaimConflictError', CLAIM_CONFLICT_ERROR_CODE)
        expect(errorFields(error)).toMatchObject({ sessionId: session.id, eventIds: [id] })
        // Nothing of the refused batch: not the span, and not the message behind it.
        expect((await store.listEventsUnscoped(session.id)).data).toEqual(before)
      })

      it('refuses to claim a non-user event, a foreign event, or an id nothing names', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const [running] = await append(store, session.id, [statusRunning()])
        const elsewhere = await store
          .createAgent(agentInput('Other'), OWNER_A)
          .then((agent) => store.createSession(agent.id, { ownerId: OWNER_A }))
        const [foreign] = await append(store, elsewhere.id, [userMessage('there')])
        const nothing = unknownEventId()
        const consumed = [running?.id ?? unknownEventId(), foreign?.id ?? unknownEventId(), nothing]

        const error = await thrownBy(() => store.appendEvents(session.id, [spanStartFor(consumed)]))
        expectErrorIdentity(error, 'ClaimConflictError', CLAIM_CONFLICT_ERROR_CODE)
        expect(errorFields(error)).toMatchObject({ eventIds: consumed })
        expect((await store.listEventsUnscoped(session.id)).data).toEqual([running])
        // The foreign event is untouched where it lives, too.
        expect((await store.getPendingUserEvents(elsewhere.id)).map((event) => event.id)).toEqual([
          foreign?.id,
        ])
      })

      it('refuses a batch that names the same event twice, in one span or across two', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const [queued] = await append(store, session.id, [userMessage('hi')])
        const id = queued?.id ?? unknownEventId()

        for (const batch of [[spanStartFor([id, id])], [spanStartFor([id]), spanStartFor([id])]]) {
          const error = await thrownBy(() => store.appendEvents(session.id, batch))
          expectErrorIdentity(error, 'ClaimConflictError', CLAIM_CONFLICT_ERROR_CODE)
          expect(errorFields(error)).toMatchObject({ eventIds: [id] })
        }
        // Neither attempt claimed it, and neither stored anything.
        expect((await store.getPendingUserEvents(session.id)).map((event) => event.id)).toEqual([
          id,
        ])
        expect((await store.listEventsUnscoped(session.id)).data).toEqual([queued])
      })

      it('claims nothing for a span with an empty consumes list', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const [queued] = await append(store, session.id, [userMessage('hi')])
        const [span] = await append(store, session.id, [spanStartFor([])])
        expect(span?.type).toBe(EVENT_TYPES.modelRequestStart)
        expect((await store.getPendingUserEvents(session.id)).map((event) => event.id)).toEqual([
          queued?.id,
        ])
      })

      it('claims an interrupt on the span end that closes the request it stopped (P4)', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        const start = await openSpan(store, session.id)
        const [interrupt] = await append(store, session.id, [userInterrupt()])
        const id = interrupt?.id ?? unknownEventId()

        clock.advance(2 * SECOND)
        const [end] = await append(store, session.id, [spanEndFor(start, [id])])
        expect(end?.type).toBe(EVENT_TYPES.modelRequestEnd)
        expect(await store.getPendingUserEvents(session.id)).toEqual([])
        const reread = (await store.listEventsUnscoped(session.id)).data.find(
          (event) => event.id === id,
        )
        expect(reread).toMatchObject({
          type: EVENT_TYPES.userInterrupt,
          processed_at: timestampAt(clock.currentMs),
        })
        expect(reread).toEqual({ ...interrupt, processed_at: timestampAt(clock.currentMs) })
      })

      it('claims an interrupt on the session.status_idle that ends an idle turn (P4)', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        const [interrupt] = await append(store, session.id, [userInterrupt()])
        const id = interrupt?.id ?? unknownEventId()

        clock.advance(3 * SECOND)
        const [idle] = await append(store, session.id, [statusIdleFor([id])])
        expect(idle?.type).toBe(EVENT_TYPES.sessionStatusIdle)
        expect(idle).toMatchObject({ consumes: [id] })
        expect(await store.getPendingUserEvents(session.id)).toEqual([])
        const reread = (await store.listEventsUnscoped(session.id)).data.find(
          (event) => event.id === id,
        )
        expect(reread).toEqual({ ...interrupt, processed_at: timestampAt(clock.currentMs) })
      })

      it('refuses a span end or an idle that claims what is not pending, and stores nothing', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const [message] = await append(store, session.id, [userMessage('hi')])
        const id = message?.id ?? unknownEventId()
        const started = await append(store, session.id, [statusRunning(), spanStartFor([id])])
        const start = started[1]
        if (start?.type !== EVENT_TYPES.modelRequestStart) {
          throw new Error('the store did not return the span start it was given')
        }
        const before = (await store.listEventsUnscoped(session.id)).data

        // The message is already claimed by the span start above...
        const batches: AppendableEvent[][] = [[spanEndFor(start, [id])], [statusIdleFor([id])]]
        for (const batch of batches) {
          const error = await thrownBy(() => store.appendEvents(session.id, batch))
          expectErrorIdentity(error, 'ClaimConflictError', CLAIM_CONFLICT_ERROR_CODE)
          expect(errorFields(error)).toMatchObject({ eventIds: [id] })
        }
        // ...and neither attempt stored anything of its batch.
        expect((await store.listEventsUnscoped(session.id)).data).toEqual(before)
      })

      it('claims nothing for a span end or an idle with no list', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const start = await openSpan(store, session.id)
        await append(store, session.id, [userInterrupt()])
        await append(store, session.id, [spanEnd(start)])
        await append(store, session.id, [statusIdle()])
        // No `consumes` anywhere on the closing events, so the interrupt is still queued.
        expect((await store.getPendingUserEvents(session.id)).map((event) => event.type)).toEqual([
          EVENT_TYPES.userInterrupt,
        ])
      })
    })

    // -------------------------------------------------------- stored chunks

    describe('stored chunks', () => {
      it('appends stored event_start and event_delta events like any other event', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        clock.advance(SECOND)
        const previewed = suppliedEventId()
        const stored = await append(store, session.id, [
          eventStart(previewed),
          deltaOf(previewed, 'Hel'),
          deltaOf(previewed, 'lo'),
        ])

        expect(stored.map((event) => event.seq)).toEqual([1, 2, 3])
        expect(stored.map((event) => event.type)).toEqual([
          EVENT_TYPES.eventStart,
          EVENT_TYPES.eventDelta,
          EVENT_TYPES.eventDelta,
        ])
        for (const event of stored) {
          // The stored form is the preview plus the envelope: an id, a seq, a processed_at.
          expect(isStoredEvent(event)).toBe(true)
          expect(event.id).toMatch(/^sevt_/)
          expect(event).toMatchObject({ processed_at: timestampAt(clock.currentMs) })
        }
        // The message being previewed is named from the inside, as it always was.
        expect(stored[0]).toMatchObject({
          type: EVENT_TYPES.eventStart,
          event: { type: EVENT_TYPES.agentMessage, id: previewed },
        })
        expect(stored[1]).toMatchObject({ type: EVENT_TYPES.eventDelta, event_id: previewed })

        // Nothing supersedes them yet, so they are the log, chunk by chunk.
        expect((await store.listEventsUnscoped(session.id)).data).toEqual(stored)
      })

      it('delivers stored chunks to subscribers like any other event', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const received: StreamEvent[] = []
        await store.subscribe(session.id, (event) => {
          received.push(event)
        })
        const previewed = suppliedEventId()
        const stored = await append(store, session.id, [
          eventStart(previewed),
          deltaOf(previewed, 'streamed'),
        ])
        await waitFor(() => received.length === 2, 'the two stored chunks')
        expect(received.map((event) => event.type)).toEqual([
          EVENT_TYPES.eventStart,
          EVENT_TYPES.eventDelta,
        ])
        expect(received).toEqual(stored)
      })
    })

    // -------------------------------------------------- supersession and replay

    describe('supersession and replay', () => {
      it('skips superseded chunks on replay, and keeps the ones still in flight', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const replied = suppliedEventId()
        const chunks = await append(store, session.id, [
          eventStart(replied),
          deltaOf(replied, 'Hel'),
          deltaOf(replied, 'lo'),
        ])
        const [message] = await append(store, session.id, [supersedingMessage(1, 3)])
        // A second reply, still streaming: nothing supersedes its chunks yet.
        const streaming = suppliedEventId()
        const inFlight = await append(store, session.id, [
          eventStart(streaming),
          deltaOf(streaming, 'wo'),
        ])

        const replay = (await store.listEventsUnscoped(session.id)).data
        expect(replay.map((event) => event.seq)).toEqual([
          message?.seq,
          ...inFlight.map((event) => event.seq),
        ])
        expect(replay[0]).toEqual(message)

        // The debugging read is the raw log: the superseded chunks are still there.
        const raw = (await store.listEventsUnscoped(session.id, { includeSuperseded: true })).data
        expect(raw.map((event) => event.seq)).toEqual([
          ...chunks.map((event) => event.seq),
          message?.seq,
          ...inFlight.map((event) => event.seq),
        ])
      })

      it('skips the range in both orders, from a cursor, and after a resume', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const replied = suppliedEventId()
        await append(store, session.id, [eventStart(replied), deltaOf(replied, 'Hel')])
        const [message] = await append(store, session.id, [supersedingMessage(1, 2)])
        const [after] = await append(store, session.id, [statusRunning()])

        expect((await store.listEventsUnscoped(session.id, { order: 'desc' })).data).toEqual([
          after,
          message,
        ])
        expect((await store.listEventsUnscoped(session.id, { afterSeq: 1 })).data).toEqual([
          message,
          after,
        ])
        expect(
          (await store.listEventsUnscoped(session.id, { types: [EVENT_TYPES.eventDelta] })).data,
        ).toEqual([])
        expect(
          (
            await store.listEventsUnscoped(session.id, {
              types: [EVENT_TYPES.eventDelta],
              includeSuperseded: true,
            })
          ).data,
        ).toHaveLength(1)
        // A seq cursor past the superseded chunks resumes on what follows them.
        expect(
          (await store.listEventsUnscoped(session.id, { page: encodeSeqCursor(2) })).data,
        ).toEqual([message, after])
      })

      it('pages over a log whose superseded chunks are skipped, without gaps or repeats', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const replied = suppliedEventId()
        await append(store, session.id, [eventStart(replied), deltaOf(replied, 'a')])
        const [message] = await append(store, session.id, [supersedingMessage(1, 2)])
        const [queued] = await append(store, session.id, [userMessage('next')])

        const all = await readAllPages((cursor) =>
          store.listEventsUnscoped(session.id, { limit: 1, page: cursor }),
        )
        expect(all).toEqual([message, queued])
      })

      it('refuses a range that does not lie before the superseding event', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [
          eventStart(suppliedEventId()),
          deltaOf(suppliedEventId(), 'x'),
        ])
        // The message will land at seq 3, so a range that reaches it is a claim about the
        // future, and the append is refused whole. (A range that is malformed on its face —
        // `from_seq` over `to_seq`, a `seq` of zero — is the protocol schema's business, and
        // the schemas the callers run reject those before a store sees them.)
        for (const range of [
          { from_seq: 1, to_seq: 3 },
          { from_seq: 3, to_seq: 3 },
        ]) {
          const error = await thrownBy(() =>
            store.appendEvents(session.id, [
              {
                type: EVENT_TYPES.agentMessage,
                content: [{ type: 'text', text: 'no' }],
                supersedes: range,
              },
            ]),
          )
          expect(error).toBeInstanceOf(RangeError)
        }
        expect((await store.listEventsUnscoped(session.id)).data).toHaveLength(2)
      })

      it('records a supersession only for the events that carry one', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const [first] = await append(store, session.id, [deltaOf(suppliedEventId(), 'a')])
        const [plain] = await append(store, session.id, [agentMessage('answer')])
        // `plain` supersedes nothing, so the delta ahead of it is still replayed.
        expect((await store.listEventsUnscoped(session.id)).data).toEqual([first, plain])
      })
    })

    // -------------------------------------------------------- rewind (#238)

    describe('rewind (#238)', () => {
      it('restarts the session from an edited message, and replay shows just that', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const turn = await completeTurn(store, session.id, 'write a haiku about rain')
        const [rewind, edited] = await append(store, session.id, [
          rewindTo(1),
          userMessage('write a haiku about snow'),
        ])

        // The stored rewind: an ordinary session event, processed when it was written, and
        // carrying the range the store recorded — the edited message through the last event
        // before it.
        expect(rewind).toMatchObject({
          type: EVENT_TYPES.sessionRewind,
          seq: 7,
          supersedes: { from_seq: 1, to_seq: 6 },
        })
        expect(rewind?.processed_at).not.toBeNull()
        expect(edited?.seq).toBe(8)

        // Replay is the conversation the reader would have had. The raw log keeps every event
        // of the turn that was replaced: nothing already stored was modified.
        expect((await store.listEventsUnscoped(session.id)).data).toEqual([rewind, edited])
        // The raw log keeps every event of the turn that was replaced, in place: nothing
        // already stored was modified, the claim on the original message included — it still
        // reads processed, because the request inside the range took it.
        const raw = (await store.listEventsUnscoped(session.id, { includeSuperseded: true })).data
        expect(raw.map((event) => event.id)).toEqual([
          ...turn.events.map((event) => event.id),
          rewind?.id,
          edited?.id,
        ])
        expect(raw[0]?.processed_at).not.toBeNull()

        // The model's view: the original message and its reply are not waiting for anything,
        // and the edit is the only thing that is.
        expect(await store.getPendingUserEvents(session.id)).toEqual([edited])
        expect(await store.findSessionsNeedingWork([partitionOf(session.id)])).toEqual([session.id])

        // The rewind reaches a subscriber like every other stored event.
        const seen: StoredEvent[] = []
        const unsubscribe = await store.subscribe(session.id, (event) => {
          if (isStoredEvent(event)) {
            seen.push(event)
          }
        })
        const [later] = await append(store, session.id, [rewindTo(8)])
        await waitFor(() => seen.length === 1, 'the rewind delivery')
        unsubscribe()
        expect(seen).toEqual([later])
      })

      it('refuses a claim into a rewound range: nothing outside it reaches it', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const turn = await completeTurn(store, session.id, 'first')
        const [, edited] = await append(store, session.id, [rewindTo(1), userMessage('edited')])

        // The message the rewind replaced already had its claim — its request is inside the
        // range too. A fresh span naming it is a claim into a range that is gone, refused
        // whole, exactly like a claim on an event another claim already took.
        const error = await thrownBy(() =>
          store.appendEvents(session.id, [spanStartFor([turn.message.id])]),
        )
        expectErrorIdentity(error, 'ClaimConflictError', CLAIM_CONFLICT_ERROR_CODE)
        expect(await store.getPendingUserEvents(session.id)).toEqual([edited])
        expect((await store.listEventsUnscoped(session.id)).data).toHaveLength(2)
      })

      it('refuses a rewind that starts anywhere but a still-visible user.message', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await completeTurn(store, session.id, 'first')

        // 1 is the message; 2..6 are the turn's other events, and 99 is a seq the log has
        // never had. None of them is something a reader could have edited.
        for (const fromSeq of [0, 2, 4, 6, 99]) {
          const error = await thrownBy(() => store.appendEvents(session.id, [rewindTo(fromSeq)]))
          expect(error, `from_seq ${fromSeq}`).toBeInstanceOf(RangeError)
        }
        // Every refusal left the log exactly as it was.
        expect((await store.listEventsUnscoped(session.id)).data).toHaveLength(6)

        await append(store, session.id, [rewindTo(1), userMessage('edited')])
        // The message is still there in the raw log, but the range that replaced it is not —
        // a second restart from it would begin in a tail that is already gone.
        const again = await thrownBy(() => store.appendEvents(session.id, [rewindTo(1)]))
        expect(again).toBeInstanceOf(RangeError)
      })

      it('refuses a batch whose rewind is not first, or one that carries two', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await completeTurn(store, session.id, 'first')
        const before = (await store.listEventsUnscoped(session.id, { includeSuperseded: true }))
          .data

        // A message ahead of the rewind would be stored and then swallowed by the range the
        // rewind records — the append would answer with it as if a turn were going to answer
        // it — and a second rewind would supersede the first's restart. Neither is a batch the
        // store records, whatever the caller is: both are refused whole, like a bad `from_seq`.
        const batches: AppendableEvent[][] = [
          [userMessage('edited'), rewindTo(1)],
          [rewindTo(1), userMessage('edited'), rewindTo(1)],
        ]
        for (const batch of batches) {
          const error = await thrownBy(() => store.appendEvents(session.id, batch))
          expect(error).toBeInstanceOf(RangeError)
        }
        // Every refusal left the log exactly as it was — the message behind the refused rewind
        // included, since a batch is one append.
        expect(
          (await store.listEventsUnscoped(session.id, { includeSuperseded: true })).data,
        ).toEqual(before)

        // The shape the rule allows is untouched: the rewind first, the edit behind it.
        const [rewind, edited] = await append(store, session.id, [
          rewindTo(1),
          userMessage('edited'),
        ])
        expect(rewind).toMatchObject({ type: EVENT_TYPES.sessionRewind })
        expect(edited).toMatchObject({ type: EVENT_TYPES.userMessage })
      })

      it('leaves a session with nothing to do when the rewind replaced everything', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const turn = await completeTurn(store, session.id, 'first')
        // A rewind with no message behind it: the reader took the edit back. Nothing of the
        // replaced turn is work — the session is idle with a queue that is empty.
        await append(store, session.id, [rewindTo(1)])

        expect(await store.getPendingUserEvents(session.id)).toEqual([])
        expect(await store.findSessionsNeedingWork([partitionOf(session.id)])).toEqual([])
        expect(await store.getTurnState(session.id)).toEqual({ state: 'idle', openSpan: null })
        expect(turn.events).toHaveLength(6)
      })

      it('keeps an earlier rewind when a later one restarts from what followed it', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await completeTurn(store, session.id, 'first')
        // 1..6 is the turn, 7 the rewind, 8 the message that followed it.
        const [before, first] = await append(store, session.id, [
          rewindTo(1),
          userMessage('edited'),
        ])
        const [second, after] = await append(store, session.id, [
          rewindTo(first?.seq ?? 0),
          userMessage('edited again'),
        ])

        // The first rewind is nobody's message, so no later range can start at it: it stays
        // part of what a reader sees, and only the tail after it moves on.
        expect(second).toMatchObject({ supersedes: { from_seq: 8, to_seq: 8 } })
        expect((await store.listEventsUnscoped(session.id)).data).toEqual([before, second, after])
      })

      it('treats a reply’s range inside a rewind’s as one union, in replay and in compaction', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        // A turn whose reply's chunks a chunk range already superseded, then a rewind over the
        // whole log: the chunk range (3..4) lies inside the rewind's (1..6), and both a read
        // and a delete have to treat them as one span — the events go once, not twice.
        const replied = suppliedEventId()
        await append(store, session.id, [userMessage('first')])
        await append(store, session.id, [statusRunning()])
        await append(store, session.id, [eventStart(replied), deltaOf(replied, 'hi')])
        await append(store, session.id, [supersedingMessage(3, 4)])
        await append(store, session.id, [statusIdle()])
        const [rewind, edited] = await append(store, session.id, [
          rewindTo(1),
          userMessage('edited'),
        ])

        const replay = (await store.listEventsUnscoped(session.id)).data
        expect(replay).toEqual([rewind, edited])

        expect(await store.compact({ olderThan: clock.currentMs })).toBe(0)
        expect(await store.compact({ olderThan: clock.currentMs + SECOND })).toBe(6)
        // Idempotent, and invisible: the raw log now reads like the replay read did.
        expect(await store.compact({ olderThan: clock.currentMs + SECOND })).toBe(0)
        expect((await store.listEventsUnscoped(session.id)).data).toEqual(replay)
        expect(
          (await store.listEventsUnscoped(session.id, { includeSuperseded: true })).data,
        ).toEqual(replay)
      })
    })

    // ------------------------------------------------------------- compaction

    describe('compaction', () => {
      it('deletes only superseded chunks, only past the window, and is idempotent', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        const replied = suppliedEventId()
        const [first] = await append(store, session.id, [userMessage('first')])
        const chunks = await append(store, session.id, [
          eventStart(replied),
          deltaOf(replied, 'Hel'),
        ])
        // A range wide enough to cover the user event in front of the chunks: compaction still
        // deletes only the two chunks, because only chunks are ever deleted.
        const [message] = await append(store, session.id, [supersedingMessage(1, 3)])
        const streaming = suppliedEventId()
        const inFlight = await append(store, session.id, [
          eventStart(streaming),
          deltaOf(streaming, 'st'),
        ])

        // The window: the chunks were written before the cutoff that follows them, and not
        // before the cutoff that is now — nothing older than "now" is deleted.
        expect(await store.compact({ olderThan: clock.currentMs })).toBe(0)
        expect(await store.compact({ olderThan: new Date(clock.currentMs + SECOND) })).toBe(2)
        // Idempotent: a second run has nothing left to delete.
        expect(await store.compact({ olderThan: clock.currentMs + SECOND })).toBe(0)

        // What every reader sees did not change — replay already skipped the chunks — and the
        // raw read agrees with the replay read now that the rows are gone.
        expect((await store.listEventsUnscoped(session.id)).data).toEqual([
          first,
          message,
          ...inFlight,
        ])
        expect(
          (await store.listEventsUnscoped(session.id, { includeSuperseded: true })).data,
        ).toEqual([first, message, ...inFlight])
        expect((await store.listEventsUnscoped(session.id)).data).not.toContainEqual(chunks[0])
      })

      it('leaves a chunk inside the window where it is, and deletes it once it is old enough', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        const replied = suppliedEventId()
        await append(store, session.id, [eventStart(replied), deltaOf(replied, 'Hel')])
        await append(store, session.id, [supersedingMessage(1, 2)])

        clock.advance(30 * SECOND)
        // A cutoff before the chunks were written leaves them alone: their window is not over.
        expect(await store.compact({ olderThan: clock.currentMs - 60 * SECOND })).toBe(0)
        expect(
          (await store.listEventsUnscoped(session.id, { includeSuperseded: true })).data,
        ).toHaveLength(3)
        // Once the cutoff has moved past them, they go.
        expect(await store.compact({ olderThan: clock.currentMs })).toBe(2)
        expect((await store.listEventsUnscoped(session.id)).data).toHaveLength(1)
      })

      it('leaves a rewound range inside the window where it is, and deletes it past it', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        await completeTurn(store, session.id, 'first')
        const [rewind, edited] = await append(store, session.id, [
          rewindTo(1),
          userMessage('edited'),
        ])

        clock.advance(30 * SECOND)
        // The turn was written after this cutoff, so its window is not over: nothing goes.
        expect(await store.compact({ olderThan: clock.currentMs - 60 * SECOND })).toBe(0)
        expect(
          (await store.listEventsUnscoped(session.id, { includeSuperseded: true })).data,
        ).toHaveLength(8)
        // Past it, the whole replaced tail goes — and the rewind that replaced it stays.
        expect(await store.compact({ olderThan: clock.currentMs })).toBe(6)
        expect((await store.listEventsUnscoped(session.id)).data).toEqual([rewind, edited])
        expect(
          (await store.listEventsUnscoped(session.id, { includeSuperseded: true })).data,
        ).toEqual([rewind, edited])
      })

      it('rejects a cutoff that is not an instant', async () => {
        const { store } = await setup()
        for (const olderThan of [Number.NaN, new Date(Number.NaN), 'yesterday']) {
          const error = await thrownBy(() => store.compact({ olderThan: olderThan as number }))
          expect(error).toBeInstanceOf(RangeError)
        }
      })
    })

    // ---------------------------------------------- deleteSession (#111, #116 U5)

    describe('deleting a session', () => {
      it('deletes the owner’s session and its whole log, and answers true', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [userMessage('gone soon'), statusRunning()])

        expect(await store.deleteSession(session.id, { ownerId: OWNER_A })).toBe(true)
        // Gone from every read, and refused like an id that never existed, in both forms.
        expect(await store.getSession(session.id, { ownerId: OWNER_A })).toBeNull()
        expect(await store.getSessionUnscoped(session.id)).toBeNull()
        for (const call of [
          () => store.listEvents(session.id, { ownerId: OWNER_A }),
          () => store.listEventsUnscoped(session.id),
          () => store.appendEvents(session.id, [userMessage('too late')]),
          () => store.getPendingUserEvents(session.id),
          () => store.getTurnState(session.id),
        ]) {
          const error = await thrownBy(call)
          expectErrorIdentity(error, 'SessionNotFoundError', SESSION_NOT_FOUND_ERROR_CODE)
        }
        // Deleting it again is nothing to delete, not an error.
        expect(await store.deleteSession(session.id, { ownerId: OWNER_A })).toBe(false)
      })

      it('answers false for another owner’s session, and leaves it readable', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [userMessage('mine')])

        expect(await store.deleteSession(session.id, { ownerId: OWNER_B })).toBe(false)
        // The same answer an unknown id gets, so the refusal leaks nothing (A4) — and the
        // owner's session is exactly as it was.
        expect(await store.deleteSession(unknownSessionId(), { ownerId: OWNER_B })).toBe(false)
        expect((await store.getSession(session.id, { ownerId: OWNER_A }))?.id).toBe(session.id)
        expect((await store.listEvents(session.id, { ownerId: OWNER_A })).data).toHaveLength(1)
      })

      it('frees every event id the deleted session held', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const id = suppliedEventId()
        await append(store, session.id, [{ ...userMessage('old'), id }])
        expect(await store.deleteSession(session.id, { ownerId: OWNER_A })).toBe(true)

        // An id identifies one event for the whole store, and the rows that held this one are
        // gone — so a new event in a brand-new session may take it, which is the proof that
        // nothing of the old log survives.
        const other = await store.createSession(
          (await store.createAgent(agentInput('Other'), OWNER_A)).id,
          { ownerId: OWNER_A },
        )
        const [stored] = await append(store, other.id, [{ ...userMessage('new'), id }])
        expect(stored?.id).toBe(id)
      })

      it('ends a subscription with one final session.deleted event, and nothing after it', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const received: StreamEvent[] = []
        await store.subscribe(session.id, (event) => {
          received.push(event)
        })
        await append(store, session.id, [userMessage('before')])
        await waitFor(() => received.length === 1, 'the event before the delete')

        expect(await store.deleteSession(session.id, { ownerId: OWNER_A })).toBe(true)
        await waitFor(() => received.length === 2, 'the final session.deleted delivery')
        // The deletion is the last delivery, and it is the stream-only event itself — no
        // `seq`, no envelope — not a stored event read out of a log that no longer exists.
        await settle()
        expect(received).toHaveLength(2)
        expect(received[received.length - 1]).toEqual({
          type: EVENT_TYPES.sessionDeleted,
          session_id: session.id,
        })
        expect(received.filter(isStoredEvent)).toHaveLength(1)
      })
    })

    // ------------------------------------------------------------ immutability

    describe('immutability', () => {
      it('freezes the events it returns, so mutating one throws', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const [message, running] = await append(store, session.id, [
          userMessage('hi'),
          statusRunning(),
        ])
        for (const event of [message, running]) {
          if (event === undefined) {
            throw new Error('the store did not return the event it was given')
          }
          expect(Object.isFrozen(event)).toBe(true)
          // `Object.assign` writes by key at runtime; the event types are deep-readonly, so
          // the equivalent direct assignment would already be a compile error (D9).
          expect(() => {
            Object.assign(event, { seq: 99 })
          }).toThrow(TypeError)
          expect(() => {
            Object.assign(event, { processed_at: timestampAt(0) })
          }).toThrow(TypeError)
        }

        // Nested values too: the content array, and the blocks inside it.
        if (message?.type !== EVENT_TYPES.userMessage) {
          throw new Error('the first event is not the user message it was given')
        }
        const [block] = message.content
        expect(() => {
          const blocks = message.content as unknown as { type: string; text: string }[]
          blocks.push({ type: 'text', text: 'more' })
        }).toThrow(TypeError)
        expect(() => {
          Object.assign(block ?? {}, { text: 'changed' })
        }).toThrow(TypeError)

        // None of it reached the log.
        expect((await store.listEventsUnscoped(session.id)).data).toEqual([message, running])
        expect((await store.listEventsUnscoped(session.id)).data[0]?.seq).toBe(1)
      })
    })

    // ---------------------------------------------------------- status updates

    describe('status updates', () => {
      it('mirrors session.status_running and session.status_idle onto the session', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        expect(session.status).toBe('idle')
        await append(store, session.id, [statusRunning()])
        expect((await store.getSession(session.id, { ownerId: OWNER_A }))?.status).toBe('running')
        await append(store, session.id, [statusIdle()])
        expect((await store.getSession(session.id, { ownerId: OWNER_A }))?.status).toBe('idle')
      })

      it('takes the last status event of an append, not the first', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [statusRunning(), statusIdle()])
        expect((await store.getSession(session.id, { ownerId: OWNER_A }))?.status).toBe('idle')
        await append(store, session.id, [statusIdle(), statusRunning()])
        expect((await store.getSession(session.id, { ownerId: OWNER_A }))?.status).toBe('running')
      })

      it('leaves the status running through an error and a reschedule', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [statusRunning()])
        await append(store, session.id, [sessionError(), statusRescheduled()])
        expect((await store.getSession(session.id, { ownerId: OWNER_A }))?.status).toBe('running')
        await append(store, session.id, [statusIdle()])
        expect((await store.getSession(session.id, { ownerId: OWNER_A }))?.status).toBe('idle')
      })
    })

    // -------------------------------------------------------------- turn state

    describe('turn state', () => {
      it('is idle before anything ran, and after a turn closed', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        expect(await store.getTurnState(session.id)).toEqual({ state: 'idle', openSpan: null })
        await append(store, session.id, [statusRunning(), statusIdle()])
        expect(await store.getTurnState(session.id)).toEqual({ state: 'idle', openSpan: null })
      })

      it('is idle when a message is queued but no turn has started', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [userMessage('hi')])
        expect(await store.getTurnState(session.id)).toEqual({ state: 'idle', openSpan: null })
      })

      it('is unfinished when a turn stopped with nothing in flight', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [statusRunning()])
        expect(await store.getTurnState(session.id)).toEqual({
          state: 'unfinished',
          openSpan: null,
        })
      })

      it('is running while a model request is in flight, and reports the open span', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const start = await openSpan(store, session.id)
        expect(await store.getTurnState(session.id)).toEqual({ state: 'running', openSpan: start })
      })

      it('is unfinished again once the open span is closed', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const start = await openSpan(store, session.id)
        await append(store, session.id, [spanEnd(start)])
        expect(await store.getTurnState(session.id)).toEqual({
          state: 'unfinished',
          openSpan: null,
        })
      })

      it('is unfinished after a reschedule, which does not end a turn', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const start = await openSpan(store, session.id)
        await append(store, session.id, [spanEnd(start), sessionError(), statusRescheduled()])
        expect((await store.getTurnState(session.id)).state).toBe('unfinished')
      })

      it('only reports a span that nothing closed', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const first = await openSpan(store, session.id)
        await append(store, session.id, [spanEnd(first)])
        const second = await openSpan(store, session.id)
        expect((await store.getTurnState(session.id)).openSpan).toEqual(second)
      })
    })

    // ----------------------------------------------------------- usage reads

    describe('model requests in a window (#247)', () => {
      it('pairs each request end with the model its span start named', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await recordModelRequest(store, session.id, MODEL_ID)

        expect(
          await store.listModelRequests(usageWindow(OWNER_A, START_MS - SECOND, START_MS + SECOND)),
        ).toEqual([
          {
            model: MODEL_ID,
            usage: REQUEST_USAGE,
            processed_at: timestampAt(START_MS),
          },
        ])
      })

      it('reads the half-open window: `from` is in it and `to` is not', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        await recordModelRequest(store, session.id, MODEL_ID)
        clock.advance(SECOND)
        await recordModelRequest(store, session.id, MODEL_ID)

        expect(
          (await store.listModelRequests(usageWindow(OWNER_A, START_MS, START_MS + SECOND))).map(
            (request) => request.processed_at,
          ),
        ).toEqual([timestampAt(START_MS)])
        expect(
          (
            await store.listModelRequests(usageWindow(OWNER_A, START_MS, START_MS + SECOND + 1))
          ).map((request) => request.processed_at),
        ).toEqual([timestampAt(START_MS), timestampAt(START_MS + SECOND)])
        // Nothing between the two instants: a window that starts after the first request and
        // ends at the second one is empty, because the second is not in it.
        expect(
          await store.listModelRequests(usageWindow(OWNER_A, START_MS + 1, START_MS + SECOND)),
        ).toEqual([])
      })

      it('is owner-scoped: another user’s requests are never in the answer', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await recordModelRequest(store, session.id, MODEL_ID)
        const theirs = await store.createSession(null, {
          ownerId: OWNER_B,
          model: { id: MODEL_ID },
        })
        await recordModelRequest(store, theirs.id, MODEL_ID)
        await recordModelRequest(store, theirs.id, MODEL_ID)

        const mine = await store.listModelRequests(
          usageWindow(OWNER_A, START_MS - SECOND, START_MS + SECOND),
        )
        const other = await store.listModelRequests(
          usageWindow(OWNER_B, START_MS - SECOND, START_MS + SECOND),
        )
        expect(mine).toHaveLength(1)
        expect(other).toHaveLength(2)
      })

      it('reads a request whose model cannot be attributed, with `model: null`', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        // A start stored without a model — the shape a log written before the field existed
        // has — and an end whose `model_request_start_id` names no event this log holds.
        const [start] = await append(store, session.id, [spanStart()])
        await append(store, session.id, [spanEnd(start as ModelRequestStartEvent)])
        await append(store, session.id, [
          {
            type: EVENT_TYPES.modelRequestEnd,
            model_request_start_id: unknownEventId(),
            model_usage: { ...REQUEST_USAGE },
            is_error: null,
          },
        ])

        const requests = await store.listModelRequests(
          usageWindow(OWNER_A, START_MS - SECOND, START_MS + SECOND),
        )
        expect(requests.map((request) => request.model)).toEqual([null, null])
        // The tokens are real either way: an unattributable request is in the totals and in no
        // per-model breakdown.
        expect(requests.map((request) => request.usage)).toEqual([REQUEST_USAGE, REQUEST_USAGE])
      })

      it('reads every session of the owner, session by session and in log order', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const other = await store.createSession(null, {
          ownerId: OWNER_A,
          model: { id: 'openai/gpt-5' },
        })
        await recordModelRequest(store, session.id, MODEL_ID)
        await recordModelRequest(store, session.id, MODEL_ID)
        await recordModelRequest(store, other.id, 'openai/gpt-5')

        // The answer is ordered by `(session_id, seq)`, whichever order the sessions were
        // created in — so the two sessions' requests are grouped, not interleaved by time.
        const expected = [MODEL_ID, MODEL_ID, 'openai/gpt-5']
        if (session.id > other.id) {
          expected.reverse()
        }
        const requests = await store.listModelRequests(
          usageWindow(OWNER_A, START_MS - SECOND, START_MS + SECOND),
        )
        expect(requests.map((request) => request.model)).toEqual(expected)
      })

      it('does not read a request a rewind replaced (#238)', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const { events } = await completeTurn(store, session.id, 'hello')
        expect(
          await store.listModelRequests(usageWindow(OWNER_A, START_MS - SECOND, START_MS + SECOND)),
        ).toHaveLength(1)

        const message = events[0]
        if (message === undefined) {
          throw new Error('the turn stored no message')
        }
        await append(store, session.id, [rewindTo(message.seq)])
        expect(
          await store.listModelRequests(usageWindow(OWNER_A, START_MS - SECOND, START_MS + SECOND)),
        ).toEqual([])
      })

      it('rejects a window it cannot read', async () => {
        const { store } = await setup()
        expect(
          await thrownBy(() =>
            store.listModelRequests(usageWindow(OWNER_A, START_MS + 1, START_MS)),
          ),
        ).toBeInstanceOf(RangeError)
        expect(
          await thrownBy(() =>
            store.listModelRequests({
              ownerId: OWNER_A,
              from: new Date(Number.NaN),
              to: new Date(START_MS),
            }),
          ),
        ).toBeInstanceOf(RangeError)
      })
    })

    // --------------------------------------------------------- reading the log

    describe('reading the log', () => {
      it('reads oldest first by default and newest first with order desc', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const stored = await append(store, session.id, [
          userMessage('one'),
          userMessage('two'),
          userMessage('three'),
        ])
        expect((await store.listEventsUnscoped(session.id)).data).toEqual(stored)
        expect((await store.listEventsUnscoped(session.id, { order: 'desc' })).data).toEqual(
          [...stored].reverse(),
        )
      })

      it('reads only what after_seq points at', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const stored = await append(store, session.id, [
          userMessage('one'),
          userMessage('two'),
          userMessage('three'),
        ])
        expect((await store.listEventsUnscoped(session.id, { afterSeq: 0 })).data).toEqual(stored)
        expect((await store.listEventsUnscoped(session.id, { afterSeq: 1 })).data).toEqual(
          stored.slice(1),
        )
        expect((await store.listEventsUnscoped(session.id, { afterSeq: 3 })).data).toEqual([])
      })

      it('filters by types, and keeps none for an empty filter', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [userMessage('one'), statusRunning(), agentMessage('hi')])
        expect(
          (
            await store.listEventsUnscoped(session.id, { types: [EVENT_TYPES.userMessage] })
          ).data.map((event) => event.type),
        ).toEqual([EVENT_TYPES.userMessage])
        expect(
          (
            await store.listEventsUnscoped(session.id, {
              types: [EVENT_TYPES.userMessage, EVENT_TYPES.agentMessage],
            })
          ).data.map((event) => event.type),
        ).toEqual([EVENT_TYPES.userMessage, EVENT_TYPES.agentMessage])
        expect(await store.listEventsUnscoped(session.id, { types: [] })).toEqual({
          data: [],
          next_page: null,
        })
      })

      it('pages with the seq cursor, in both orders, without gaps or duplicates', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const stored = await append(
          store,
          session.id,
          Array.from({ length: 5 }, (_unused, index) => userMessage(`message ${index}`)),
        )
        const firstPage = await store.listEventsUnscoped(session.id, { limit: 2 })
        expect(firstPage.data.map((event) => event.seq)).toEqual([1, 2])
        expect(decodePageCursor(nextPageOf(firstPage))).toEqual({ kind: 'seq', seq: 2 })
        const ascending = await readAllPages((cursor) =>
          store.listEventsUnscoped(session.id, { limit: 2, page: cursor }),
        )
        expect(ascending).toEqual(stored)
        const descending = await readAllPages((cursor) =>
          store.listEventsUnscoped(session.id, { limit: 2, order: 'desc', page: cursor }),
        )
        expect(descending).toEqual([...stored].reverse())
      })

      it('reads an empty page for a seq position past the end of the log', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [userMessage('one')])
        expect(await store.listEventsUnscoped(session.id, { page: encodeSeqCursor(99) })).toEqual({
          data: [],
          next_page: null,
        })
      })

      it('clamps the page size into the protocol limits', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(
          store,
          session.id,
          Array.from({ length: MAX_PAGE_LIMIT + 1 }, () => userMessage('hi')),
        )
        expect((await store.listEventsUnscoped(session.id, { limit: 0 })).data).toHaveLength(1)
        const huge = await store.listEventsUnscoped(session.id, { limit: MAX_PAGE_LIMIT * 10 })
        expect(huge.data).toHaveLength(MAX_PAGE_LIMIT)
        expect(huge.next_page).not.toBeNull()
      })

      it('rejects a cursor it cannot use', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [userMessage('one')])
        const keyCursor = encodeKeyCursor(session)
        expect(
          await thrownBy(() => store.listEventsUnscoped(session.id, { page: keyCursor })),
        ).toBeInstanceOf(RangeError)
        expect(
          await thrownBy(() => store.listEventsUnscoped(session.id, { page: 'page_nonsense' })),
        ).toBeInstanceOf(RangeError)
        const seqCursor = encodeSeqCursor(1)
        expect(
          await thrownBy(() => store.listAgents({ ownerId: OWNER_A, page: seqCursor })),
        ).toBeInstanceOf(RangeError)
        expect(
          await thrownBy(() => store.listSessions({ ownerId: OWNER_A, page: seqCursor })),
        ).toBeInstanceOf(RangeError)
      })
    })

    // ----------------------------------------------------------- subscriptions

    describe('subscriptions', () => {
      it('delivers appended events in seq order, once each', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const received: StreamEvent[] = []
        await store.subscribe(session.id, (event) => {
          received.push(event)
        })
        await append(store, session.id, [userMessage('one'), statusRunning()])
        await append(store, session.id, [agentMessage('hi')])
        await waitFor(() => received.length === 3, 'three stored events')
        expect(received.map((event) => event.type)).toEqual([
          EVENT_TYPES.userMessage,
          EVENT_TYPES.sessionStatusRunning,
          EVENT_TYPES.agentMessage,
        ])
        expect(received.map((event) => (isStoredEvent(event) ? event.seq : null))).toEqual([
          1, 2, 3,
        ])
        for (const event of received) {
          expectExact(StoredEventSchema, event, 'a stored event')
        }
      })

      it('delivers a reply’s chunks between the events around them, in seq order', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const received: StreamEvent[] = []
        await store.subscribe(session.id, (event) => {
          received.push(event)
        })
        const [message] = await append(store, session.id, [userMessage('hi')])
        const previewId = suppliedEventId()
        await append(store, session.id, [
          eventStart(previewId),
          deltaOf(previewId, 'Hel'),
          deltaOf(previewId, 'lo'),
        ])
        await append(store, session.id, [{ ...agentMessage('hello'), id: previewId }])
        await waitFor(() => received.length === 5, 'the message and the chunks of its reply')
        expect(received.map((event) => event.type)).toEqual([
          EVENT_TYPES.userMessage,
          EVENT_TYPES.eventStart,
          EVENT_TYPES.eventDelta,
          EVENT_TYPES.eventDelta,
          EVENT_TYPES.agentMessage,
        ])
        expect(received.map((event) => (isStoredEvent(event) ? event.seq : null))).toEqual([
          1, 2, 3, 4, 5,
        ])
        expect(message?.seq).toBe(1)
      })

      it('delivers nothing that was already in the log', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [userMessage('before')])
        const received: StreamEvent[] = []
        await store.subscribe(session.id, (event) => {
          received.push(event)
        })
        await settle()
        expect(received).toEqual([])
        await append(store, session.id, [userMessage('after')])
        await waitFor(() => received.length === 1, 'the event appended after subscribing')
      })

      it('stops delivering once unsubscribed', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const received: StreamEvent[] = []
        const unsubscribe = await store.subscribe(session.id, (event) => {
          received.push(event)
        })
        await append(store, session.id, [userMessage('one')])
        await waitFor(() => received.length === 1, 'the first event')
        unsubscribe()
        unsubscribe()
        await append(store, session.id, [userMessage('two')])
        await settle()
        expect(received).toHaveLength(1)
      })

      it('delivers every event to every listener of the session', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const first: StreamEvent[] = []
        const second: StreamEvent[] = []
        await store.subscribe(session.id, (event) => {
          first.push(event)
        })
        await store.subscribe(session.id, (event) => {
          second.push(event)
        })
        await append(store, session.id, [userMessage('one'), userMessage('two')])
        await waitFor(
          () => first.length === 2 && second.length === 2,
          'both listeners to have seen both events',
        )
        expect(second.map((event) => event.type)).toEqual(first.map((event) => event.type))
      })

      it('delivers to the session subscribed to, and to no other', async () => {
        const { store, clock } = await setup()
        const agent = await store.createAgent(agentInput(), OWNER_A)
        const one = await store.createSession(agent.id, { ownerId: OWNER_A })
        clock.advance(SECOND)
        const other = await store.createSession(agent.id, { ownerId: OWNER_A })
        const received: StreamEvent[] = []
        await store.subscribe(one.id, (event) => {
          received.push(event)
        })
        await append(store, other.id, [userMessage('elsewhere')])
        await settle()
        expect(received).toEqual([])
      })
    })

    // -------------------------------------------------------- partition signals

    describe('partition signals', () => {
      it('delivers a signal to the partition listeners, once each', async () => {
        const { store, clock } = await setup()
        const agent = await store.createAgent(agentInput(), OWNER_A)
        const one = await store.createSession(agent.id, { ownerId: OWNER_A })
        clock.advance(SECOND)
        const other = await store.createSession(agent.id, { ownerId: OWNER_A })
        const partition = partitionOf(one.id)
        const elsewhere = partitionOf(other.id)
        const received: string[] = []
        await store.onPartitionSignal(partition, (signal) => {
          received.push(`${signal.partition}/${signal.sessionId}/${signal.kind}`)
        })
        await store.signalPartition(partition, { sessionId: one.id, kind: 'work' })
        await store.signalPartition(partition, { sessionId: one.id, kind: 'interrupt' })
        await waitFor(() => received.length === 2, 'both signals')
        expect(received).toEqual([
          `${partition}/${one.id}/work`,
          `${partition}/${one.id}/interrupt`,
        ])

        if (elsewhere !== partition) {
          await store.signalPartition(elsewhere, { sessionId: other.id, kind: 'work' })
          await settle()
          expect(received).toHaveLength(2)
        }
      })

      it('drops a signal nobody is listening for', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const partition = partitionOf(session.id)
        await store.signalPartition(partition, { sessionId: session.id, kind: 'work' })
        const received: string[] = []
        await store.onPartitionSignal(partition, (signal) => {
          received.push(signal.kind)
        })
        await settle()
        expect(received).toEqual([])
      })

      it('stops delivering once unsubscribed', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const partition = partitionOf(session.id)
        const received: string[] = []
        const unsubscribe = await store.onPartitionSignal(partition, (signal) => {
          received.push(signal.kind)
        })
        await store.signalPartition(partition, { sessionId: session.id, kind: 'work' })
        await waitFor(() => received.length === 1, 'the first signal')
        unsubscribe()
        await store.signalPartition(partition, { sessionId: session.id, kind: 'work' })
        await settle()
        expect(received).toEqual(['work'])
      })
    })

    // ------------------------------------------------ auth-session revocations

    describe('auth-session revocations', () => {
      it('delivers a revocation to every listener, once each, named by session id', async () => {
        const { store } = await setup()
        const first: string[] = []
        const second: string[] = []
        await store.onAuthSessionRevoked((authSessionId) => {
          first.push(authSessionId)
        })
        await store.onAuthSessionRevoked((authSessionId) => {
          second.push(authSessionId)
        })
        await store.notifyAuthSessionRevoked('auth_session_one')
        await store.notifyAuthSessionRevoked('auth_session_two')
        await waitFor(() => first.length === 2 && second.length === 2, 'both revocations')
        expect(first).toEqual(['auth_session_one', 'auth_session_two'])
        expect(second).toEqual(['auth_session_one', 'auth_session_two'])
      })

      it('stops delivering once unsubscribed', async () => {
        const { store } = await setup()
        const received: string[] = []
        const unsubscribe = await store.onAuthSessionRevoked((authSessionId) => {
          received.push(authSessionId)
        })
        await store.notifyAuthSessionRevoked('auth_session_one')
        await waitFor(() => received.length === 1, 'the first revocation')
        unsubscribe()
        await store.notifyAuthSessionRevoked('auth_session_two')
        await settle()
        expect(received).toEqual(['auth_session_one'])
      })

      it('drops a revocation nobody is listening for, and never replays one', async () => {
        const { store } = await setup()
        await store.notifyAuthSessionRevoked('auth_session_one')
        const received: string[] = []
        await store.onAuthSessionRevoked((authSessionId) => {
          received.push(authSessionId)
        })
        await settle()
        expect(received).toEqual([])
      })
    })

    // --------------------------------------------------- findSessionsNeedingWork

    describe('findSessionsNeedingWork', () => {
      it('finds sessions with pending user events', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [userMessage('hi')])
        expect(await store.findSessionsNeedingWork([partitionOf(session.id)])).toEqual([session.id])
      })

      it('finds sessions with an open turn, running or not', async () => {
        const { store, clock } = await setup()
        const agent = await store.createAgent(agentInput(), OWNER_A)
        const running = await store.createSession(agent.id, { ownerId: OWNER_A })
        clock.advance(SECOND)
        const unfinished = await store.createSession(agent.id, { ownerId: OWNER_A })
        await append(store, running.id, [statusRunning(), spanStart()])
        await append(store, unfinished.id, [statusRunning()])
        const partitions = [partitionOf(running.id), partitionOf(unfinished.id)]
        expect(await store.findSessionsNeedingWork(partitions)).toEqual([running.id, unfinished.id])
      })

      it('leaves out sessions with nothing to do', async () => {
        const { store, clock } = await setup()
        const agent = await store.createAgent(agentInput(), OWNER_A)
        const idle = await store.createSession(agent.id, { ownerId: OWNER_A })
        clock.advance(SECOND)
        const handled = await store.createSession(agent.id, { ownerId: OWNER_A })
        const [message] = await append(store, handled.id, [userMessage('hi')])
        await append(store, handled.id, [spanStartFor([message?.id ?? unknownEventId()])])
        const partitions = [partitionOf(idle.id), partitionOf(handled.id)]
        expect(await store.findSessionsNeedingWork(partitions)).toEqual([])
      })

      it('looks only at the partitions it was handed', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [userMessage('hi')])
        expect(await store.findSessionsNeedingWork([])).toEqual([])
        const elsewhere = Array.from({ length: 64 }, (_unused, index) => index).filter(
          (partition) => partition !== partitionOf(session.id),
        )
        expect(await store.findSessionsNeedingWork(elsewhere)).toEqual([])
      })

      it('returns each session once, oldest first', async () => {
        const { store, clock } = await setup()
        const agent = await store.createAgent(agentInput(), OWNER_A)
        const older = await store.createSession(agent.id, { ownerId: OWNER_A })
        clock.advance(SECOND)
        const newer = await store.createSession(agent.id, { ownerId: OWNER_A })
        await append(store, older.id, [statusRunning()])
        await append(store, newer.id, [statusRunning(), userMessage('hi')])
        const partitions = [partitionOf(older.id), partitionOf(newer.id)]
        expect(await store.findSessionsNeedingWork(partitions)).toEqual([older.id, newer.id])
      })
    })

    // --------------------------------------------------------- partition leases

    describe('partition leases', () => {
      it('acquires a free partition with a fresh epoch and a ttl from the clock', async () => {
        const { store, clock } = await setup()
        expect(await store.currentEpoch(3)).toBe(0)
        const lease = await store.acquirePartition(3, 'owner-1', 30 * SECOND)
        expect(lease).toEqual({
          partition: 3,
          owner: 'owner-1',
          epoch: 1,
          expires_at: timestampAt(clock.currentMs + 30 * SECOND),
        })
        expect(await store.currentEpoch(3)).toBe(1)
      })

      it('refuses a lease a live owner holds', async () => {
        const { store } = await setup()
        await leaseOn(store, 3, 'owner-1', 30 * SECOND)
        expect(await store.acquirePartition(3, 'owner-2', 30 * SECOND)).toBeNull()
      })

      it('lets the same owner acquire again, on a new epoch', async () => {
        const { store } = await setup()
        const first = await leaseOn(store, 3, 'owner-1', 30 * SECOND)
        const second = await leaseOn(store, 3, 'owner-1', 30 * SECOND)
        expect(second.epoch).toBeGreaterThan(first.epoch)
        expect(await store.currentEpoch(3)).toBe(second.epoch)
      })

      it('keeps the epochs of different partitions apart', async () => {
        const { store } = await setup()
        expect((await leaseOn(store, 3, 'owner-1', 30 * SECOND)).epoch).toBe(1)
        expect((await leaseOn(store, 4, 'owner-1', 30 * SECOND)).epoch).toBe(1)
      })

      it('renews a lease this owner holds at this epoch', async () => {
        const { store, clock } = await setup()
        const lease = await leaseOn(store, 3, 'owner-1', 30 * SECOND)
        clock.advance(20 * SECOND)
        expect(await store.renewPartition(3, 'owner-1', lease.epoch, 30 * SECOND)).toBe(true)
        clock.advance(20 * SECOND)
        // 40 seconds in, but only 20 since the renewal: the lease still holds.
        expect(await store.acquirePartition(3, 'owner-2', 30 * SECOND)).toBeNull()
      })

      it('refuses to renew for another owner or an old epoch', async () => {
        const { store } = await setup()
        const lease = await leaseOn(store, 3, 'owner-1', 30 * SECOND)
        expect(await store.renewPartition(3, 'owner-2', lease.epoch, 30 * SECOND)).toBe(false)
        expect(await store.renewPartition(3, 'owner-1', lease.epoch + 1, 30 * SECOND)).toBe(false)
      })

      it('renews a lease that lapsed while nobody took it: a lapse is stealable, not lost', async () => {
        // The row still naming this owner at this epoch is the whole test. A heartbeat cycle
        // that ran past the TTL — a stalled process, a slow round trip — costs the owner
        // nothing as long as nobody took the partition over in the meantime, and the epoch is
        // the proof that nobody did. What a lapse *does* allow is a steal (below), which is
        // why a lease that is lapsed and taken over is refused.
        const { store, clock } = await setup()
        const lease = await leaseOn(store, 3, 'owner-1', 30 * SECOND)
        clock.advance(30 * SECOND)
        expect(await store.renewPartition(3, 'owner-1', lease.epoch, 30 * SECOND)).toBe(true)
        expect(await store.currentEpoch(3)).toBe(lease.epoch)
        clock.advance(20 * SECOND)
        // Renewed 20 seconds ago: the partition is live and held, so nobody can take it.
        expect(await store.acquirePartition(3, 'owner-2', 30 * SECOND)).toBeNull()

        clock.advance(30 * SECOND)
        const stolen = await leaseOn(store, 3, 'owner-2', 30 * SECOND)
        expect(stolen.epoch).toBeGreaterThan(lease.epoch)
        expect(await store.renewPartition(3, 'owner-1', lease.epoch, 30 * SECOND)).toBe(false)
      })

      it('expires a lease at the instant expires_at names, and lets another owner steal it', async () => {
        const { store, clock } = await setup()
        const lease = await leaseOn(store, 3, 'owner-1', 30 * SECOND)
        clock.advance(29 * SECOND)
        expect(await store.acquirePartition(3, 'owner-2', 30 * SECOND)).toBeNull()
        clock.advance(SECOND)
        const stolen = await leaseOn(store, 3, 'owner-2', 30 * SECOND)
        expect(stolen.owner).toBe('owner-2')
        expect(stolen.epoch).toBeGreaterThan(lease.epoch)
        expect(await store.currentEpoch(3)).toBe(stolen.epoch)
      })

      it('advances the epoch on release, so the released tenure is gone', async () => {
        const { store } = await setup()
        const lease = await leaseOn(store, 3, 'owner-1', 30 * SECOND)
        await store.releasePartition(3, 'owner-1', lease.epoch)
        expect(await store.currentEpoch(3)).toBeGreaterThan(lease.epoch)
        const next = await leaseOn(store, 3, 'owner-2', 30 * SECOND)
        expect(next.epoch).toBeGreaterThan(lease.epoch)
      })

      it('ignores a release from an owner or epoch that does not hold the lease', async () => {
        const { store, clock } = await setup()
        const lease = await leaseOn(store, 3, 'owner-1', 30 * SECOND)
        await store.releasePartition(3, 'owner-2', lease.epoch)
        await store.releasePartition(3, 'owner-1', lease.epoch + 1)
        expect(await store.currentEpoch(3)).toBe(lease.epoch)
        expect(await store.acquirePartition(3, 'owner-2', 30 * SECOND)).toBeNull()
        clock.advance(30 * SECOND)
        await store.releasePartition(3, 'owner-1', lease.epoch)
        expect(await store.currentEpoch(3)).toBeGreaterThan(lease.epoch)
      })

      it('rejects a ttl that is not a positive number of milliseconds', async () => {
        const { store } = await setup()
        expect(await thrownBy(() => store.acquirePartition(3, 'owner-1', 0))).toBeInstanceOf(
          RangeError,
        )
        expect(await thrownBy(() => store.acquirePartition(3, 'owner-1', -1))).toBeInstanceOf(
          RangeError,
        )
        const lease = await leaseOn(store, 3, 'owner-1', 30 * SECOND)
        expect(
          await thrownBy(() => store.renewPartition(3, 'owner-1', lease.epoch, Number.NaN)),
        ).toBeInstanceOf(RangeError)
      })
    })

    // ------------------------------------------------------ scheduler membership

    describe('scheduler membership', () => {
      it('records a heartbeat and lists the instance as live', async () => {
        const { store } = await setup()
        await store.heartbeatInstance('instance-a')
        expect(await store.listLiveInstances(30 * SECOND)).toEqual(['instance-a'])
      })

      it('lists only the memberships seen within the window, in instance-id order', async () => {
        const { store, clock } = await setup()
        await store.heartbeatInstance('instance-b')
        await store.heartbeatInstance('instance-a')
        await store.heartbeatInstance('instance-c')
        clock.advance(20 * SECOND)
        await store.heartbeatInstance('instance-c')
        // A and b were last seen exactly one window ago: at the edge a membership is gone,
        // the same inclusive expiry a lease has at `expires_at`. C is 10 s fresh, and the
        // answer is ordered by instance id.
        clock.advance(10 * SECOND)
        expect(await store.listLiveInstances(30 * SECOND)).toEqual(['instance-c'])
      })

      it('refreshes the window on a new heartbeat', async () => {
        const { store, clock } = await setup()
        await store.heartbeatInstance('instance-a')
        clock.advance(20 * SECOND)
        expect(await store.listLiveInstances(30 * SECOND)).toEqual(['instance-a'])
        await store.heartbeatInstance('instance-a')
        clock.advance(20 * SECOND)
        // 40 s since the first heartbeat, 20 since the second.
        expect(await store.listLiveInstances(30 * SECOND)).toEqual(['instance-a'])
      })

      it('drops a membership that stops heartbeating, and re-adds it when it does again', async () => {
        const { store, clock } = await setup()
        await store.heartbeatInstance('instance-a')
        clock.advance(30 * SECOND + 1)
        expect(await store.listLiveInstances(30 * SECOND)).toEqual([])
        await store.heartbeatInstance('instance-a')
        expect(await store.listLiveInstances(30 * SECOND)).toEqual(['instance-a'])
      })

      it('removes a membership, and removing one that is not there is a no-op', async () => {
        const { store } = await setup()
        await store.heartbeatInstance('instance-a')
        await store.heartbeatInstance('instance-b')
        await store.removeInstance('instance-a')
        expect(await store.listLiveInstances(30 * SECOND)).toEqual(['instance-b'])
        await store.removeInstance('instance-a')
        await store.removeInstance('never-heartbeated')
        expect(await store.listLiveInstances(30 * SECOND)).toEqual(['instance-b'])
      })

      it('rejects a window that is not a positive number of milliseconds', async () => {
        const { store } = await setup()
        expect(await thrownBy(() => store.listLiveInstances(0))).toBeInstanceOf(RangeError)
        expect(await thrownBy(() => store.listLiveInstances(-1))).toBeInstanceOf(RangeError)
        expect(await thrownBy(() => store.listLiveInstances(Number.NaN))).toBeInstanceOf(RangeError)
      })
    })

    // ------------------------------------------------------------------ fencing

    describe('fencing', () => {
      it('accepts a write at the partition current live epoch', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const lease = await leaseFor(store, session.id, 30 * SECOND)
        const fence = { partition: lease.partition, epoch: lease.epoch }
        const stored = await store.appendEvents(session.id, [userMessage('hi')], { fence })
        expect(stored).toHaveLength(1)
        const claimed = await store.appendEvents(
          session.id,
          [spanStartFor([stored[0]?.id ?? unknownEventId()])],
          { fence },
        )
        expect(claimed).toHaveLength(1)
      })

      it('refuses a write from a tenure that was taken over, and stores nothing', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        const stale = await leaseFor(store, session.id, 30 * SECOND)
        clock.advance(30 * SECOND)
        const current = await leaseOn(store, stale.partition, 'owner-2', 30 * SECOND)
        const error = await thrownBy(() =>
          store.appendEvents(session.id, [userMessage('zombie')], {
            fence: { partition: stale.partition, epoch: stale.epoch },
          }),
        )
        expect(isFencedError(error)).toBe(true)
        expect(errorFields(error)).toMatchObject({
          name: 'FencedError',
          code: FENCED_ERROR_CODE,
          partition: stale.partition,
          epoch: stale.epoch,
          currentEpoch: current.epoch,
          operation: 'appendEvents',
        })
        expect((await store.listEventsUnscoped(session.id)).data).toEqual([])

        const accepted = await store.appendEvents(session.id, [userMessage('owner')], {
          fence: { partition: stale.partition, epoch: current.epoch },
        })
        expect(accepted).toHaveLength(1)
      })

      it('refuses a write once the lease has expired', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        const lease = await leaseFor(store, session.id, 30 * SECOND)
        clock.advance(30 * SECOND)
        const error = await thrownBy(() =>
          store.appendEvents(session.id, [userMessage('late')], {
            fence: { partition: lease.partition, epoch: lease.epoch },
          }),
        )
        expect(isFencedError(error)).toBe(true)
      })

      it('refuses a write for a partition that was never leased', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const partition = partitionOf(session.id)
        expect(await store.currentEpoch(partition)).toBe(0)
        const error = await thrownBy(() =>
          store.appendEvents(session.id, [userMessage('hi')], { fence: { partition, epoch: 1 } }),
        )
        expect(isFencedError(error)).toBe(true)
      })

      it('never refuses a write without a fence', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await store.acquirePartition(partitionOf(session.id), 'owner-1', 30 * SECOND)
        expect(await store.appendEvents(session.id, [userMessage('unfenced')])).toHaveLength(1)
      })

      it('refuses a fenced claiming append, and leaves the events pending', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        const lease = await leaseFor(store, session.id, 30 * SECOND)
        const [message] = await append(store, session.id, [userMessage('hi')])
        clock.advance(30 * SECOND)
        const error = await thrownBy(() =>
          store.appendEvents(session.id, [spanStartFor([message?.id ?? unknownEventId()])], {
            fence: { partition: lease.partition, epoch: lease.epoch },
          }),
        )
        expect(isFencedError(error)).toBe(true)
        expect(errorFields(error)).toMatchObject({ operation: 'appendEvents' })
        expect((await store.getPendingUserEvents(session.id)).map((event) => event.id)).toEqual([
          message?.id,
        ])
      })

      it('refuses a fenced write after the lease was released', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const lease = await leaseFor(store, session.id, 30 * SECOND)
        await store.releasePartition(lease.partition, lease.owner, lease.epoch)
        const error = await thrownBy(() =>
          store.appendEvents(session.id, [userMessage('hi')], {
            fence: { partition: lease.partition, epoch: lease.epoch },
          }),
        )
        expect(isFencedError(error)).toBe(true)
      })
    })
  })
}

/** The factory a store is tested through: it receives the clock the store must use. */
export type MakeSessionStore = (clock: TestClock) => SessionStore | Promise<SessionStore>

/** How to title the suite in a report. */
export interface SessionStoreConformanceOptions {
  /** The implementation's name; the suite's blocks are titled `${name} conformance`. */
  readonly name?: string
  /**
   * Makes sure the given users exist, for a store whose schema references them.
   *
   * The suite creates everything as one of {@link OWNER_A} and {@link OWNER_B} (epic #65, A4),
   * and the Postgres tables reference Better Auth's `"user"` row for both, so a Postgres store
   * needs a way to seed them; the store's factory has already emptied the tables by the time
   * this is called, once per test. A store without users — the in-memory one — leaves it out.
   */
  readonly ensureUsers?: (userIds: readonly UserId[]) => Promise<void>
}

/**
 * The two users everything in the suite belongs to.
 *
 * They are fixed strings rather than generated ones so that an implementation can seed them
 * ({@link SessionStoreConformanceOptions.ensureUsers}) and so that a failure names the same
 * owner twice. Nothing about them is special beyond being valid `UserId`s: a user id is
 * Better Auth's opaque string, whatever a store's user rows happen to hold.
 */
export const OWNER_A: UserId = 'user_conformance_a'

/** The second user; see {@link OWNER_A}. */
export const OWNER_B: UserId = 'user_conformance_b'

/** The instant every test's clock starts at; fixed, so a timestamp in a failure is readable. */
const START_MS = Date.UTC(2026, 2, 15, 10, 0, 0)

/** One second in milliseconds; the suite moves its clock in these. */
const SECOND = 1000

/** How long the suite waits for a delivery that may be asynchronous. */
const DELIVERY_TIMEOUT_MS = 2000

/** How long a `settle()` waits for deliveries that were already scheduled. */
const SETTLE_MS = 20

/** How many pages `readAllPages` walks before it gives up on a list that never ends. */
const MAX_PAGES = 100

/** The model the suite's span starts name, where a test does not say otherwise. */
const MODEL_ID = 'anthropic/claude-sonnet-5'

/** What the suite's `span.model_request_end` events report: fixed, so a total is assertable. */
const REQUEST_USAGE = {
  input_tokens: 512,
  output_tokens: 64,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

/** A `POST /v1/agents` body. */
function agentInput(name = 'Summarizer'): CreateAgentRequest {
  return { name, model: { id: 'anthropic/claude-sonnet-5' }, system: 'You are concise.' }
}

/** An agent and a session for it: what most tests start from. */
async function seed(store: SessionStore): Promise<{ agent: Agent; session: Session }> {
  const agent = await store.createAgent(agentInput(), OWNER_A)
  const session = await store.createSession(agent.id, { ownerId: OWNER_A })
  return { agent, session }
}

/** An `agent_` id no store has an agent for: well-formed, and never handed out. */
function unknownAgentId(): AgentId {
  return 'agent_00000000000000000000000000' as AgentId
}

/** A `sesn_` id no store has a session for. */
function unknownSessionId(): SessionId {
  return 'sesn_00000000000000000000000000' as SessionId
}

/** A `sevt_` id no store has an event for. */
function unknownEventId(): EventId {
  return 'sevt_00000000000000000000000000' as EventId
}

/** A `sevt_` id a test hands the store, so the store is not the one that minted it. */
function suppliedEventId(): EventId {
  return newEventId()
}

/** A `user.message` to append. */
function userMessage(text: string): AppendableEvent {
  return { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }] }
}

/**
 * A `user.message` carrying a model switch, as a client sends one (#111): it is stored like
 * any message and also sets the session's `model` in the append's transaction.
 */
function userMessageWith(text: string, modelId: string): AppendableEvent {
  return {
    type: EVENT_TYPES.userMessage,
    content: [{ type: 'text', text }],
    model: { id: modelId },
  }
}

/** An `agent.message` to append. */
function agentMessage(text: string): AppendableEvent {
  return { type: EVENT_TYPES.agentMessage, content: [{ type: 'text', text }] }
}

/** A `user.interrupt` to append. */
function userInterrupt(): AppendableEvent {
  return { type: EVENT_TYPES.userInterrupt }
}

/** A `session.status_running` to append. */
function statusRunning(): AppendableEvent {
  return { type: EVENT_TYPES.sessionStatusRunning }
}

/** A `session.status_idle` to append; `end_turn` is the only stop reason v1 has. */
function statusIdle(): AppendableEvent {
  return { type: EVENT_TYPES.sessionStatusIdle, stop_reason: { type: 'end_turn' } }
}

/** A `session.status_idle` claiming `consumes`, as the brain ends an idle turn on an interrupt (P4). */
function statusIdleFor(consumes: EventId[]): AppendableEvent {
  return { type: EVENT_TYPES.sessionStatusIdle, stop_reason: { type: 'end_turn' }, consumes }
}

/** A `session.status_rescheduled` to append. */
function statusRescheduled(): AppendableEvent {
  return { type: EVENT_TYPES.sessionStatusRescheduled }
}

/** A `session.error` to append. */
function sessionError(): AppendableEvent {
  return {
    type: EVENT_TYPES.sessionError,
    error: {
      type: 'model_overloaded_error',
      message: 'The model is overloaded. Retrying.',
      retry_status: { type: 'retrying' },
    },
  }
}

/** A `span.model_request_start` to append. */
function spanStart(): AppendableEvent {
  return { type: EVENT_TYPES.modelRequestStart }
}

/** A `span.model_request_start` claiming the user events it is given (D9). */
function spanStartFor(consumes: EventId[]): AppendableEvent {
  return { type: EVENT_TYPES.modelRequestStart, consumes, model: MODEL_ID }
}

/**
 * A `session.rewind` to append (#238): restart the session from the `user.message` at
 * `fromSeq`. The range it records — through the end of the log — is the store's to fill in.
 */
function rewindTo(fromSeq: number): AppendableEvent {
  return { type: EVENT_TYPES.sessionRewind, from_seq: fromSeq }
}

/**
 * One whole turn: the user speaks, the brain claims the message in a request, answers, closes
 * the span and goes idle — the six events of a complete turn, in order.
 *
 * That is what a rewind is aimed at, so the tests that need one start from here rather than
 * spelling the same six appends out again.
 */
async function completeTurn(
  store: SessionStore,
  sessionId: SessionId,
  text: string,
): Promise<{ events: StoredEvent[]; message: { readonly id: EventId } }> {
  const events: StoredEvent[] = []
  const message = await append(store, sessionId, [userMessage(text)])
  const [first] = message
  if (first === undefined) {
    throw new Error('the store did not return the message it was given')
  }
  events.push(first)
  events.push(...(await append(store, sessionId, [statusRunning()])))
  const [start] = await append(store, sessionId, [spanStartFor([first.id])])
  if (start?.type !== EVENT_TYPES.modelRequestStart) {
    throw new Error('the store did not return the span start it was given')
  }
  events.push(start)
  events.push(...(await append(store, sessionId, [agentMessage(`reply to ${text}`)])))
  events.push(...(await append(store, sessionId, [spanEnd(start)])))
  events.push(...(await append(store, sessionId, [statusIdle()])))
  return { events, message: first }
}

/** An `agent.message` that supersedes the chunk range `from`..`to`, inclusive (D9). */
function supersedingMessage(from: number, to: number): AppendableEvent {
  return {
    type: EVENT_TYPES.agentMessage,
    content: [{ type: 'text', text: 'the whole reply' }],
    supersedes: { from_seq: from, to_seq: to },
  }
}

/** A `span.model_request_end` that closes `start`. */
function spanEnd(start: ModelRequestStartEvent): AppendableEvent {
  const end: AppendableEvent = {
    type: EVENT_TYPES.modelRequestEnd,
    model_request_start_id: start.id,
    model_usage: { ...REQUEST_USAGE },
    is_error: null,
  }
  return end
}

/** A `span.model_request_end` closing `start` and claiming `consumes` (P4). */
function spanEndFor(start: ModelRequestStartEvent, consumes: EventId[]): AppendableEvent {
  return {
    type: EVENT_TYPES.modelRequestEnd,
    model_request_start_id: start.id,
    model_usage: { ...REQUEST_USAGE },
    is_error: true,
    error: { type: 'interrupted' },
    consumes,
  }
}

/**
 * One model request: a `span.model_request_start` — naming `model`, or naming none when it is
 * `null` — and the `span.model_request_end` that reports {@link REQUEST_USAGE} for it.
 *
 * That pair is what {@link SessionStore.listModelRequests} reads, so the tests that need a
 * request in a log rather than a whole turn start from here.
 */
async function recordModelRequest(
  store: SessionStore,
  sessionId: SessionId,
  model: string | null,
): Promise<void> {
  const [start] = await append(store, sessionId, [
    model === null ? spanStart() : { type: EVENT_TYPES.modelRequestStart, model },
  ])
  if (start?.type !== EVENT_TYPES.modelRequestStart) {
    throw new Error('the store did not return the span start it was given')
  }
  await append(store, sessionId, [spanEnd(start)])
}

/** A `listModelRequests` query for `ownerId`, over the half-open window `[fromMs, toMs)`. */
function usageWindow(ownerId: UserId, fromMs: number, toMs: number): ListModelRequestsOptions {
  return { ownerId, from: new Date(fromMs), to: new Date(toMs) }
}

/** An `event_start` chunk previewing `id`. */
function eventStart(id: EventId): AppendableEvent {
  return { type: EVENT_TYPES.eventStart, event: { type: EVENT_TYPES.agentMessage, id } }
}

/**
 * The id of the event a reply event carries from the inside: an `event_start` names it, an
 * `event_delta` points at it, and the finished message is its own.
 */
function previewedId(event: StoredEvent): EventId {
  if (event.type === EVENT_TYPES.eventStart) {
    return event.event.id
  }
  if (event.type === EVENT_TYPES.eventDelta) {
    return event.event_id
  }
  return event.id
}

/** An `event_delta` chunk extending the reply of `id`. */
function eventDelta(id: EventId): AppendableEvent {
  return deltaOf(id, 'hel')
}

/** An `event_delta` carrying `text` for the reply of `id`. */
function deltaOf(id: EventId, text: string): AppendableEvent {
  return {
    type: EVENT_TYPES.eventDelta,
    event_id: id,
    delta: { type: 'content_delta', index: 0, content: { type: 'text', text } },
  }
}

/**
 * Append events, checking that the store returned them in the order they were given and that
 * each is exactly a stored event.
 */
async function append(
  store: SessionStore,
  sessionId: SessionId,
  events: AppendableEvent[],
  options?: AppendEventsOptions,
): Promise<StoredEvent[]> {
  const stored = await store.appendEvents(sessionId, events, options)
  expect(stored.map((event) => event.type)).toEqual(events.map((event) => event.type))
  for (const event of stored) {
    expectExact(StoredEventSchema, event, 'a stored event')
  }
  return stored
}

/** Append `session.status_running` and `span.model_request_start`, and return the span. */
async function openSpan(
  store: SessionStore,
  sessionId: SessionId,
): Promise<ModelRequestStartEvent> {
  const stored = await append(store, sessionId, [statusRunning(), spanStart()])
  const start = stored[1]
  if (start?.type !== EVENT_TYPES.modelRequestStart) {
    throw new Error('the store did not return the span start it was given')
  }
  return start
}

/** Acquire a partition for `owner`, failing the test when it is not free. */
async function leaseOn(
  store: SessionStore,
  partition: number,
  owner: string,
  ttlMs: number,
): Promise<PartitionLease> {
  const lease = await store.acquirePartition(partition, owner, ttlMs)
  if (lease === null) {
    throw new Error(`partition ${partition} was not free for ${owner}`)
  }
  return lease
}

/** Acquire the partition a session lives in, as a server does before running its turn. */
async function leaseFor(
  store: SessionStore,
  sessionId: SessionId,
  ttlMs: number,
): Promise<PartitionLease> {
  return leaseOn(store, partitionOf(sessionId), 'owner-1', ttlMs)
}

/** Walk every page of a list, and return the items in the order the store returned them. */
async function readAllPages<T>(
  fetchPage: (page: string | undefined) => Promise<{ data: T[]; next_page: NextPage }>,
): Promise<T[]> {
  const all: T[] = []
  let page: string | undefined
  for (let visited = 0; visited < MAX_PAGES; visited += 1) {
    const response = await fetchPage(page)
    all.push(...response.data)
    if (response.next_page === null) {
      return all
    }
    page = response.next_page
  }
  throw new Error(`the list did not end after ${MAX_PAGES} pages`)
}

/** The `next_page` of a response the test expects to be continued. */
function nextPageOf(response: { next_page: NextPage }): string {
  if (response.next_page === null) {
    throw new Error('expected another page, but next_page was null')
  }
  return response.next_page
}

/** Assert that `value` parses as `schema` and carries nothing the protocol does not define. */
function expectExact<T>(schema: { parse(value: unknown): T }, value: unknown, what: string): void {
  const parsed = schema.parse(value)
  expect(parsed, `${what} is exactly its protocol shape`).toEqual(value)
}

/** Assert the stable identity of a thrown error: what a caller from another bundle can see. */
function expectErrorIdentity(error: unknown, name: string, code: string): void {
  expect(error).toBeInstanceOf(Error)
  expect(errorFields(error)).toMatchObject({ name, code })
}

/** Read a thrown value as a record, so a test can assert on the fields it carries. */
function errorFields(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) {
    throw new Error(`expected an error object, got ${JSON.stringify(error)}`)
  }
  return error as Record<string, unknown>
}

/** Await `work` and return what it threw; fails the test when it does not throw. */
async function thrownBy(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw, but it resolved')
}

/** Wait for a condition that may only become true once a store has delivered something. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + DELIVERY_TIMEOUT_MS
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${DELIVERY_TIMEOUT_MS}ms waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Let deliveries that were already scheduled happen: the suite's "nothing more arrived" wait. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

/** The `(created_at, id)` order both resource lists use, ascending. */
function byKeysAsc(left: KeyCursorPosition, right: KeyCursorPosition): number {
  if (left.created_at !== right.created_at) {
    return left.created_at < right.created_at ? -1 : 1
  }
  if (left.id === right.id) {
    return 0
  }
  return left.id < right.id ? -1 : 1
}
