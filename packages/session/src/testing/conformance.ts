import {
  AgentSchema,
  EVENT_TYPES,
  MAX_PAGE_LIMIT,
  SessionSchema,
  StoredEventSchema,
  decodePageCursor,
  encodeKeyCursor,
  encodeSeqCursor,
  isStoredEvent,
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
  type StreamOnlyEvent,
} from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { timestampAt } from '../clock'
import {
  AGENT_NOT_FOUND_ERROR_CODE,
  FENCED_ERROR_CODE,
  SESSION_NOT_FOUND_ERROR_CODE,
  isFencedError,
} from '../errors'
import type { AppendableEvent, AppendEventsOptions, PartitionLease, SessionStore } from '../store'
import { type TestClock, createTestClock } from './clock'

/**
 * The conformance suite every `SessionStore` implementation has to pass.
 *
 * It is the contract's executable form: `InMemorySessionStore` passes it today, and the
 * Postgres store must pass the same suite unchanged. That is why it only asks for what the
 * contract promises — ordering by `seq`, atomically assigned fields, the `processed_at`
 * lifecycle, turn state, pagination cursors, fencing, at-most-once signals, and leases that
 * acquire, renew, expire and are stolen after expiry. It never reaches into an implementation,
 * and it never assumes synchronous delivery: a store may notify subscriptions a tick later, or
 * over a connection, so the tests wait for a delivery instead of requiring one to have
 * happened already.
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
 * - **sessions** — the agent snapshot, creation options, `initial_events`, newest-first
 *   pagination, the agent filter, and not-found behaviour.
 * - **appending events** — `id`/`seq` assignment, `processed_at` per event kind, and the shape
 *   of what comes back.
 * - **the `processed_at` lifecycle** — pending events, marking, marking twice, and ids that are
 *   not pending user events.
 * - **status updates** — the session `status` mirroring the log, and a reschedule not ending a
 *   turn.
 * - **turn state** — `idle`, `running` (with the open span) and `unfinished`, from the log.
 * - **reading the log** — order, `after_seq`, `types`, `seq` pagination and bad cursors.
 * - **subscriptions** — stored events in `seq` order, ephemeral events interleaved, isolation,
 *   unsubscribe.
 * - **partition signals** — delivery, fan-out to a partition's listeners, and dropping.
 * - **findSessionsNeedingWork** — pending events and open turns, scoped to partitions.
 * - **partition leases** — acquire, renew, expiry at `expires_at`, steal after expiry, release.
 * - **fencing** — a stale, expired, released or never-leased epoch is refused, and an unfenced
 *   write never is.
 */
export function runSessionStoreConformance(
  makeStore: MakeSessionStore,
  options: SessionStoreConformanceOptions = {},
): void {
  const name = options.name ?? 'SessionStore'

  /** A store for one test, built on a clock that test can move. */
  async function setup(): Promise<{ store: SessionStore; clock: TestClock }> {
    const clock = createTestClock(START_MS)
    return { store: await makeStore(clock), clock }
  }

  describe(`${name} conformance`, () => {
    // ------------------------------------------------------------------ agents

    describe('agents', () => {
      it('creates an agent stamped with the clock instant', async () => {
        const { store, clock } = await setup()
        const agent = await store.createAgent(agentInput())
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
        const agent = await store.createAgent(agentInput())
        expect(await store.getAgent(agent.id)).toEqual(agent)
        expect(await store.getAgent(unknownAgentId())).toBeNull()
      })

      it('lists agents oldest first, and ends the list with next_page: null', async () => {
        const { store, clock } = await setup()
        const first = await store.createAgent(agentInput('First'))
        clock.advance(SECOND)
        const second = await store.createAgent(agentInput('Second'))
        clock.advance(SECOND)
        const third = await store.createAgent(agentInput('Third'))
        const page = await store.listAgents()
        expect(page.data.map((agent) => agent.id)).toEqual([first.id, second.id, third.id])
        expect(page.next_page).toBeNull()
      })

      it('pages through agents with the keyset cursor, without gaps or duplicates', async () => {
        const { store, clock } = await setup()
        const created: Agent[] = []
        for (let index = 0; index < 5; index += 1) {
          created.push(await store.createAgent(agentInput(`Agent ${index}`)))
          clock.advance(SECOND)
        }
        const page = await store.listAgents({ limit: 2 })
        expect(page.data.map((agent) => agent.id)).toEqual([created[0]?.id, created[1]?.id])
        expect(decodePageCursor(nextPageOf(page))).toEqual({
          kind: 'key',
          created_at: created[1]?.created_at,
          id: created[1]?.id,
        })
        const all = await readAllPages((cursor) => store.listAgents({ limit: 2, page: cursor }))
        expect(all.map((agent) => agent.id)).toEqual(created.map((agent) => agent.id))
      })

      it('pages agents that share a created_at by id', async () => {
        const { store } = await setup()
        const created: Agent[] = []
        for (let index = 0; index < 4; index += 1) {
          created.push(await store.createAgent(agentInput(`Agent ${index}`)))
        }
        // All four share an instant, so the tie is broken by id: that is what makes the cursor
        // a position in a total order rather than in a list that shifts under a paging client.
        expect(new Set(created.map((agent) => agent.created_at)).size).toBe(1)
        const expected = [...created].sort(byKeysAsc).map((agent) => agent.id)
        const all = await readAllPages((cursor) => store.listAgents({ limit: 2, page: cursor }))
        expect(all.map((agent) => agent.id)).toEqual(expected)
      })

      it('updates an agent, keeping what it omits and clearing what it nulls', async () => {
        const { store, clock } = await setup()
        const agent = await store.createAgent(agentInput())
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
        expect(await store.getAgent(agent.id)).toEqual(updated)
      })

      it('answers null when updating an agent that does not exist', async () => {
        const { store } = await setup()
        expect(await store.updateAgent(unknownAgentId(), { name: 'Nobody' })).toBeNull()
      })

      it('rejects a session for an agent that does not exist', async () => {
        const { store } = await setup()
        const error = await thrownBy(() => store.createSession(unknownAgentId()))
        expectErrorIdentity(error, 'AgentNotFoundError', AGENT_NOT_FOUND_ERROR_CODE)
      })
    })

    // ---------------------------------------------------------------- sessions

    describe('sessions', () => {
      it('snapshots the agent onto the session, and stops tracking it afterwards', async () => {
        const { store, clock } = await setup()
        const agent = await store.createAgent(agentInput())
        const session = await store.createSession(agent.id)
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
        expect(session.id).toMatch(/^sesn_/)
        expectExact(SessionSchema, session, 'a session')

        await store.updateAgent(agent.id, { name: 'Renamed', model: { id: 'other/model' } })
        const reread = await store.getSession(session.id)
        expect(reread?.agent.name).toBe(agent.name)
        expect(reread?.agent.model.id).toBe(agent.model.id)
      })

      it('stores the title and metadata it was created with', async () => {
        const { store } = await setup()
        const { agent } = await seed(store)
        const session = await store.createSession(agent.id, {
          title: 'A chat',
          metadata: { ticket: 'OH-4' },
        })
        expect(session.title).toBe('A chat')
        expect(session.metadata).toEqual({ ticket: 'OH-4' })
        expect(await store.getSession(session.id)).toEqual(session)
      })

      it('appends initial_events in the creation transaction, unprocessed and numbered from 1', async () => {
        const { store } = await setup()
        const agent = await store.createAgent(agentInput())
        const session = await store.createSession(agent.id, {
          initial_events: [
            { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'hi' }] },
            { type: EVENT_TYPES.userInterrupt },
          ],
        })
        const events = (await store.listEvents(session.id)).data
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
        expect(await store.getSession(session.id)).toEqual(session)
        expect(await store.getSession(unknownSessionId())).toBeNull()
      })

      it('lists sessions newest first', async () => {
        const { store, clock } = await setup()
        const agent = await store.createAgent(agentInput())
        const first = await store.createSession(agent.id)
        clock.advance(SECOND)
        const second = await store.createSession(agent.id)
        clock.advance(SECOND)
        const third = await store.createSession(agent.id)
        const page = await store.listSessions()
        expect(page.data.map((session) => session.id)).toEqual([third.id, second.id, first.id])
        expect(page.next_page).toBeNull()
      })

      it('pages through sessions with the keyset cursor, without gaps or duplicates', async () => {
        const { store, clock } = await setup()
        const agent = await store.createAgent(agentInput())
        const created: Session[] = []
        for (let index = 0; index < 5; index += 1) {
          created.push(await store.createSession(agent.id))
          clock.advance(SECOND)
        }
        const page = await store.listSessions({ limit: 2 })
        expect(page.data.map((session) => session.id)).toEqual([created[4]?.id, created[3]?.id])
        expect(decodePageCursor(nextPageOf(page))).toEqual({
          kind: 'key',
          created_at: created[3]?.created_at,
          id: created[3]?.id,
        })
        const all = await readAllPages((cursor) => store.listSessions({ limit: 2, page: cursor }))
        expect(all.map((session) => session.id)).toEqual(
          [...created].reverse().map((session) => session.id),
        )
      })

      it('pages sessions that share a created_at by id, newest first', async () => {
        const { store } = await setup()
        const agent = await store.createAgent(agentInput())
        const created: Session[] = []
        for (let index = 0; index < 4; index += 1) {
          created.push(await store.createSession(agent.id))
        }
        expect(new Set(created.map((session) => session.created_at)).size).toBe(1)
        const expected = [...created]
          .sort(byKeysAsc)
          .reverse()
          .map((session) => session.id)
        const all = await readAllPages((cursor) => store.listSessions({ limit: 3, page: cursor }))
        expect(all.map((session) => session.id)).toEqual(expected)
      })

      it('filters sessions by agent', async () => {
        const { store, clock } = await setup()
        const wanted = await store.createAgent(agentInput('Wanted'))
        const other = await store.createAgent(agentInput('Other'))
        const mine = await store.createSession(wanted.id)
        clock.advance(SECOND)
        await store.createSession(other.id)
        const page = await store.listSessions({ agentId: wanted.id })
        expect(page.data.map((session) => session.id)).toEqual([mine.id])
      })

      // One test per method, so a failure names the call that misbehaved.
      const sessionCalls: Record<
        string,
        (store: SessionStore, sessionId: SessionId) => Promise<unknown>
      > = {
        appendEvents: (store, sessionId) => store.appendEvents(sessionId, [userMessage('hi')]),
        markProcessed: (store, sessionId) => store.markProcessed(sessionId, [unknownEventId()]),
        listEvents: (store, sessionId) => store.listEvents(sessionId),
        getPendingUserEvents: (store, sessionId) => store.getPendingUserEvents(sessionId),
        getTurnState: (store, sessionId) => store.getTurnState(sessionId),
        subscribe: (store, sessionId) => store.subscribe(sessionId, () => undefined),
        publishEphemeral: (store, sessionId) =>
          store.publishEphemeral(sessionId, eventStart(unknownEventId())),
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
        expect((await store.listEvents(session.id)).data).toEqual(stored)
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
        expect((await store.getSession(session.id))?.updated_at).toBe(session.updated_at)
        await append(store, session.id, [userMessage('later')])
        expect((await store.getSession(session.id))?.updated_at).toBe(timestampAt(clock.currentMs))
      })

      it('advances the session updated_at with every append', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        clock.advance(10 * SECOND)
        await append(store, session.id, [userMessage('hi')])
        expect((await store.getSession(session.id))?.updated_at).toBe(timestampAt(clock.currentMs))
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
        for (const event of (await store.listEvents(session.id)).data) {
          expectExact(StoredEventSchema, event, 'a stored event')
        }
      })
    })

    // ------------------------------------------------- processed_at lifecycle

    describe('the processed_at lifecycle', () => {
      it('lists pending user events in seq order, and stops listing them once processed', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const first = await append(store, session.id, [userMessage('one')])
        await append(store, session.id, [statusRunning(), agentMessage('hi')])
        const second = await append(store, session.id, [userMessage('two')])
        expect((await store.getPendingUserEvents(session.id)).map((event) => event.id)).toEqual([
          first[0]?.id,
          second[0]?.id,
        ])
        await store.markProcessed(session.id, [first[0]?.id ?? unknownEventId()])
        expect((await store.getPendingUserEvents(session.id)).map((event) => event.id)).toEqual([
          second[0]?.id,
        ])
      })

      it('stamps processed_at from the clock, and only claims what was still pending', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        const stored = await append(store, session.id, [userMessage('one'), userMessage('two')])
        const ids = stored.map((event) => event.id)
        clock.advance(7 * SECOND)
        const marked = await store.markProcessed(session.id, ids)
        expect(marked.map((event) => event.id)).toEqual(ids)
        for (const event of marked) {
          expect(event.processed_at).toBe(timestampAt(clock.currentMs))
          expectExact(StoredEventSchema, event, 'a stored event')
        }
        clock.advance(SECOND)
        expect(await store.markProcessed(session.id, ids)).toEqual([])
        expect((await store.listEvents(session.id)).data).toEqual(marked)
      })

      it('ignores ids that are not pending user events', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const [message] = await append(store, session.id, [userMessage('one')])
        const [running] = await append(store, session.id, [statusRunning()])
        const other = await store.createSession((await store.createAgent(agentInput())).id)
        const [elsewhere] = await append(store, other.id, [userMessage('other')])
        const marked = await store.markProcessed(session.id, [
          running?.id ?? unknownEventId(),
          elsewhere?.id ?? unknownEventId(),
          unknownEventId(),
        ])
        expect(marked).toEqual([])
        expect(await store.markProcessed(session.id, [])).toEqual([])
        expect(message?.processed_at).toBeNull()
      })

      it('claims an event once when two callers race for it', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const [message] = await append(store, session.id, [userMessage('one')])
        const id = message?.id ?? unknownEventId()
        const [firstCall, secondCall] = await Promise.all([
          store.markProcessed(session.id, [id]),
          store.markProcessed(session.id, [id]),
        ])
        expect([...firstCall, ...secondCall].map((event) => event.id)).toEqual([id])
      })
    })

    // ---------------------------------------------------------- status updates

    describe('status updates', () => {
      it('mirrors session.status_running and session.status_idle onto the session', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        expect(session.status).toBe('idle')
        await append(store, session.id, [statusRunning()])
        expect((await store.getSession(session.id))?.status).toBe('running')
        await append(store, session.id, [statusIdle()])
        expect((await store.getSession(session.id))?.status).toBe('idle')
      })

      it('takes the last status event of an append, not the first', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [statusRunning(), statusIdle()])
        expect((await store.getSession(session.id))?.status).toBe('idle')
        await append(store, session.id, [statusIdle(), statusRunning()])
        expect((await store.getSession(session.id))?.status).toBe('running')
      })

      it('leaves the status running through an error and a reschedule', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [statusRunning()])
        await append(store, session.id, [sessionError(), statusRescheduled()])
        expect((await store.getSession(session.id))?.status).toBe('running')
        await append(store, session.id, [statusIdle()])
        expect((await store.getSession(session.id))?.status).toBe('idle')
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
        expect((await store.listEvents(session.id)).data).toEqual(stored)
        expect((await store.listEvents(session.id, { order: 'desc' })).data).toEqual(
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
        expect((await store.listEvents(session.id, { afterSeq: 0 })).data).toEqual(stored)
        expect((await store.listEvents(session.id, { afterSeq: 1 })).data).toEqual(stored.slice(1))
        expect((await store.listEvents(session.id, { afterSeq: 3 })).data).toEqual([])
      })

      it('filters by types, and keeps none for an empty filter', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [userMessage('one'), statusRunning(), agentMessage('hi')])
        expect(
          (await store.listEvents(session.id, { types: [EVENT_TYPES.userMessage] })).data.map(
            (event) => event.type,
          ),
        ).toEqual([EVENT_TYPES.userMessage])
        expect(
          (
            await store.listEvents(session.id, {
              types: [EVENT_TYPES.userMessage, EVENT_TYPES.agentMessage],
            })
          ).data.map((event) => event.type),
        ).toEqual([EVENT_TYPES.userMessage, EVENT_TYPES.agentMessage])
        expect(await store.listEvents(session.id, { types: [] })).toEqual({
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
        const firstPage = await store.listEvents(session.id, { limit: 2 })
        expect(firstPage.data.map((event) => event.seq)).toEqual([1, 2])
        expect(decodePageCursor(nextPageOf(firstPage))).toEqual({ kind: 'seq', seq: 2 })
        const ascending = await readAllPages((cursor) =>
          store.listEvents(session.id, { limit: 2, page: cursor }),
        )
        expect(ascending).toEqual(stored)
        const descending = await readAllPages((cursor) =>
          store.listEvents(session.id, { limit: 2, order: 'desc', page: cursor }),
        )
        expect(descending).toEqual([...stored].reverse())
      })

      it('reads an empty page for a seq position past the end of the log', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [userMessage('one')])
        expect(await store.listEvents(session.id, { page: encodeSeqCursor(99) })).toEqual({
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
        expect((await store.listEvents(session.id, { limit: 0 })).data).toHaveLength(1)
        const huge = await store.listEvents(session.id, { limit: MAX_PAGE_LIMIT * 10 })
        expect(huge.data).toHaveLength(MAX_PAGE_LIMIT)
        expect(huge.next_page).not.toBeNull()
      })

      it('rejects a cursor it cannot use', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        await append(store, session.id, [userMessage('one')])
        const keyCursor = encodeKeyCursor(session)
        expect(
          await thrownBy(() => store.listEvents(session.id, { page: keyCursor })),
        ).toBeInstanceOf(RangeError)
        expect(
          await thrownBy(() => store.listEvents(session.id, { page: 'page_nonsense' })),
        ).toBeInstanceOf(RangeError)
        const seqCursor = encodeSeqCursor(1)
        expect(await thrownBy(() => store.listAgents({ page: seqCursor }))).toBeInstanceOf(
          RangeError,
        )
        expect(await thrownBy(() => store.listSessions({ page: seqCursor }))).toBeInstanceOf(
          RangeError,
        )
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

      it('interleaves ephemeral events at the point they were published', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const received: StreamEvent[] = []
        await store.subscribe(session.id, (event) => {
          received.push(event)
        })
        const [message] = await append(store, session.id, [userMessage('hi')])
        const previewId = message?.id ?? unknownEventId()
        await store.publishEphemeral(session.id, eventStart(previewId))
        await store.publishEphemeral(session.id, eventDelta(previewId))
        await store.publishEphemeral(session.id, eventDelta(previewId))
        await append(store, session.id, [agentMessage('hello')])
        await waitFor(() => received.length === 5, 'the stored events and the previews')
        expect(received.map((event) => event.type)).toEqual([
          EVENT_TYPES.userMessage,
          EVENT_TYPES.eventStart,
          EVENT_TYPES.eventDelta,
          EVENT_TYPES.eventDelta,
          EVENT_TYPES.agentMessage,
        ])
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
        const agent = await store.createAgent(agentInput())
        const one = await store.createSession(agent.id)
        clock.advance(SECOND)
        const other = await store.createSession(agent.id)
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
        const agent = await store.createAgent(agentInput())
        const one = await store.createSession(agent.id)
        clock.advance(SECOND)
        const other = await store.createSession(agent.id)
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
        const agent = await store.createAgent(agentInput())
        const running = await store.createSession(agent.id)
        clock.advance(SECOND)
        const unfinished = await store.createSession(agent.id)
        await append(store, running.id, [statusRunning(), spanStart()])
        await append(store, unfinished.id, [statusRunning()])
        const partitions = [partitionOf(running.id), partitionOf(unfinished.id)]
        expect(await store.findSessionsNeedingWork(partitions)).toEqual([running.id, unfinished.id])
      })

      it('leaves out sessions with nothing to do', async () => {
        const { store, clock } = await setup()
        const agent = await store.createAgent(agentInput())
        const idle = await store.createSession(agent.id)
        clock.advance(SECOND)
        const handled = await store.createSession(agent.id)
        const [message] = await append(store, handled.id, [userMessage('hi')])
        await store.markProcessed(handled.id, [message?.id ?? unknownEventId()])
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
        const agent = await store.createAgent(agentInput())
        const older = await store.createSession(agent.id)
        clock.advance(SECOND)
        const newer = await store.createSession(agent.id)
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

      it('refuses to renew for another owner, an old epoch, or an expired lease', async () => {
        const { store, clock } = await setup()
        const lease = await leaseOn(store, 3, 'owner-1', 30 * SECOND)
        expect(await store.renewPartition(3, 'owner-2', lease.epoch, 30 * SECOND)).toBe(false)
        expect(await store.renewPartition(3, 'owner-1', lease.epoch + 1, 30 * SECOND)).toBe(false)
        clock.advance(30 * SECOND)
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

    // ------------------------------------------------------------------ fencing

    describe('fencing', () => {
      it('accepts a write at the partition current live epoch', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const lease = await leaseFor(store, session.id, 30 * SECOND)
        const fence = { partition: lease.partition, epoch: lease.epoch }
        const stored = await store.appendEvents(session.id, [userMessage('hi')], { fence })
        expect(stored).toHaveLength(1)
        const marked = await store.markProcessed(session.id, [stored[0]?.id ?? unknownEventId()], {
          fence,
        })
        expect(marked).toHaveLength(1)
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
        expect((await store.listEvents(session.id)).data).toEqual([])

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

      it('refuses a fenced markProcessed, and leaves the events pending', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        const lease = await leaseFor(store, session.id, 30 * SECOND)
        const [message] = await append(store, session.id, [userMessage('hi')])
        clock.advance(30 * SECOND)
        const error = await thrownBy(() =>
          store.markProcessed(session.id, [message?.id ?? unknownEventId()], {
            fence: { partition: lease.partition, epoch: lease.epoch },
          }),
        )
        expect(isFencedError(error)).toBe(true)
        expect(errorFields(error)).toMatchObject({ operation: 'markProcessed' })
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
}

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

/** A `POST /v1/agents` body. */
function agentInput(name = 'Summarizer'): CreateAgentRequest {
  return { name, model: { id: 'anthropic/claude-sonnet-5' }, system: 'You are concise.' }
}

/** An agent and a session for it: what most tests start from. */
async function seed(store: SessionStore): Promise<{ agent: Agent; session: Session }> {
  const agent = await store.createAgent(agentInput())
  const session = await store.createSession(agent.id)
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

/** A `user.message` to append. */
function userMessage(text: string): AppendableEvent {
  return { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }] }
}

/** An `agent.message` to append. */
function agentMessage(text: string): AppendableEvent {
  return { type: EVENT_TYPES.agentMessage, content: [{ type: 'text', text }] }
}

/** A `session.status_running` to append. */
function statusRunning(): AppendableEvent {
  return { type: EVENT_TYPES.sessionStatusRunning }
}

/** A `session.status_idle` to append; `end_turn` is the only stop reason v1 has. */
function statusIdle(): AppendableEvent {
  return { type: EVENT_TYPES.sessionStatusIdle, stop_reason: { type: 'end_turn' } }
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

/** A `span.model_request_end` that closes `start`. */
function spanEnd(start: ModelRequestStartEvent): AppendableEvent {
  return {
    type: EVENT_TYPES.modelRequestEnd,
    model_request_start_id: start.id,
    model_usage: {
      input_tokens: 512,
      output_tokens: 64,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    is_error: null,
  }
}

/** An `event_start` previewing `id`. */
function eventStart(id: EventId): StreamOnlyEvent {
  return { type: EVENT_TYPES.eventStart, event: { type: EVENT_TYPES.agentMessage, id } }
}

/** An `event_delta` extending the preview of `id`. */
function eventDelta(id: EventId): StreamOnlyEvent {
  return {
    type: EVENT_TYPES.eventDelta,
    event_id: id,
    delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'hel' } },
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
