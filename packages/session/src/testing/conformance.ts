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
  type StreamOnlyEvent,
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
 *   pagination, the agent filter, not-found behaviour, and the title an `updateSession` sets,
 *   keeps or clears.
 * - **appending events** — `id`/`seq` assignment, `processed_at` per event kind, and the shape
 *   of what comes back.
 * - **caller-supplied event ids** — an id the caller brings is the stored event's id and stays
 *   the identity its previews carried, `seq` is still the store's, and a batch is refused whole
 *   when an id is taken, repeated in it, or not a valid event id.
 * - **the `processed_at` lifecycle** — pending events, marking, marking twice, and ids that are
 *   not pending user events.
 * - **claims** (D9, issue #46) — `processed_at` derived from the claim on every read, claiming
 *   through a `span.model_request_start`'s `consumes`, the `ClaimConflictError` a claim that
 *   cannot be made raises, and one event never being claimed twice.
 * - **stored chunks** — `event_start` / `event_delta` appended as stored events, with a `seq`,
 *   a `processed_at` and a delivery like any other event.
 * - **supersession and replay** — a recorded `supersedes` range skipped by reads but included
 *   still in flight, `includeSuperseded` as the debugging read, and the `RangeError` a range
 *   that does not fit raises.
 * - **compaction** — the retention window, only superseded chunks deleted, idempotence, and
 *   readers seeing the same log before and after.
 * - **immutability** — a returned event is deep-frozen, so writing to it throws.
 * - **status updates** — the session `status` mirroring the log, and a reschedule not ending a
 *   turn.
 * - **turn state** — `idle`, `running` (with the open span) and `unfinished`, from the log.
 * - **reading the log** — order, `after_seq`, `types`, `seq` pagination and bad cursors.
 * - **subscriptions** — stored events in `seq` order, ephemeral events interleaved, isolation,
 *   unsubscribe.
 * - **the in-flight preview** — the `getPreview` read: start, accumulating deltas, what clears
 *   it (the stored event, a `span.model_request_end`), replacement, and per-session isolation.
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
        expect(await store.getSession(session.id)).toEqual(updated)
        expectExact(SessionSchema, updated, 'a session')
        // A title is metadata, not an event: the log is untouched.
        expect(await store.listEvents(session.id)).toEqual({ data: [], next_page: null })
      })

      it('keeps the title it omits, clears the one it nulls, and answers null for an unknown session', async () => {
        const { store, clock } = await setup()
        const { session } = await seed(store)
        await store.updateSession(session.id, { title: 'First' })
        clock.advance(SECOND)
        expect((await store.updateSession(session.id, {}))?.title).toBe('First')
        clock.advance(SECOND)
        expect((await store.updateSession(session.id, { title: null }))?.title).toBeNull()
        expect((await store.getSession(session.id))?.title).toBeNull()
        expect(await store.updateSession(unknownSessionId(), { title: 'Nobody' })).toBeNull()
      })

      it('stores a title of exactly the protocol maximum, as it was given', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const title = 'x'.repeat(SESSION_TITLE_MAX_LENGTH)
        const updated = await store.updateSession(session.id, { title })
        expect(updated?.title).toBe(title)
        const reread = await store.getSession(session.id)
        expect(reread?.title).toBe(title)
        expect(reread?.updated_at).toBe(updated?.updated_at)
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
        const page = await store.listEvents(session.id)
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

      it('keeps a stored event on the id its previews were published under', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const received: StreamEvent[] = []
        await store.subscribe(session.id, (event) => {
          received.push(event)
        })
        // What the brain does for a streaming reply: mint an id, publish the previews under
        // it, and append the final message with the same id, so a client can replace the
        // preview with the stored event.
        const id = suppliedEventId()
        await store.publishEphemeral(session.id, eventStart(id))
        await store.publishEphemeral(session.id, eventDelta(id))
        const [stored] = await append(store, session.id, [{ ...agentMessage('hello'), id }])
        await waitFor(() => received.length === 3, 'the two previews and the stored event')

        const previewed: EventId[] = []
        const storedIds: EventId[] = []
        for (const event of received) {
          if (isStoredEvent(event)) {
            storedIds.push(event.id)
          } else {
            previewed.push(previewedId(event))
          }
        }
        expect(stored?.id).toBe(id)
        expect(storedIds).toEqual([id])
        expect(previewed).toEqual([id, id])
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
        expect((await store.listEvents(session.id)).data).toEqual([first])
        expect(await store.getPendingUserEvents(session.id)).toEqual([first])
      })

      it('refuses an id another session already holds', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const id = suppliedEventId()
        await append(store, session.id, [{ ...userMessage('here'), id }])

        // An event id is the identity of one event for the whole store, not one per session.
        const other = await store.createSession((await store.createAgent(agentInput('Other'))).id)
        const error = await thrownBy(() =>
          store.appendEvents(other.id, [{ ...userMessage('there'), id }]),
        )
        expectErrorIdentity(error, 'DuplicateEventIdError', DUPLICATE_EVENT_ID_ERROR_CODE)
        expect((await store.listEvents(other.id)).data).toEqual([])
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
        expect((await store.listEvents(session.id)).data).toEqual([])
        expect((await store.getSession(session.id))?.status).toBe('idle')
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
        expect((await store.listEvents(session.id)).data).toEqual([])
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
        expect((await store.listEvents(session.id)).data).toEqual([stored])
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
        const reread = (await store.listEvents(session.id)).data.find((event) => event.id === id)
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
        const before = (await store.listEvents(session.id)).data

        const error = await thrownBy(() =>
          store.appendEvents(session.id, [spanStartFor([id]), agentMessage('and stores nothing')]),
        )
        expectErrorIdentity(error, 'ClaimConflictError', CLAIM_CONFLICT_ERROR_CODE)
        expect(errorFields(error)).toMatchObject({ sessionId: session.id, eventIds: [id] })
        // Nothing of the refused batch: not the span, and not the message behind it.
        expect((await store.listEvents(session.id)).data).toEqual(before)
      })

      it('refuses to claim a non-user event, a foreign event, or an id nothing names', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const [running] = await append(store, session.id, [statusRunning()])
        const elsewhere = await store
          .createAgent(agentInput('Other'))
          .then((agent) => store.createSession(agent.id))
        const [foreign] = await append(store, elsewhere.id, [userMessage('there')])
        const nothing = unknownEventId()
        const consumed = [running?.id ?? unknownEventId(), foreign?.id ?? unknownEventId(), nothing]

        const error = await thrownBy(() => store.appendEvents(session.id, [spanStartFor(consumed)]))
        expectErrorIdentity(error, 'ClaimConflictError', CLAIM_CONFLICT_ERROR_CODE)
        expect(errorFields(error)).toMatchObject({ eventIds: consumed })
        expect((await store.listEvents(session.id)).data).toEqual([running])
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
        expect((await store.listEvents(session.id)).data).toEqual([queued])
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

      it('lets markProcessed and consumes race for an event, but never both win', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const [first] = await append(store, session.id, [userMessage('one')])
        const [second] = await append(store, session.id, [userMessage('two')])
        const firstId = first?.id ?? unknownEventId()
        const secondId = second?.id ?? unknownEventId()

        // `consumes` took the first, so `markProcessed` claims nothing of it...
        await append(store, session.id, [spanStartFor([firstId])])
        expect(await store.markProcessed(session.id, [firstId])).toEqual([])

        // ...and `markProcessed` took the second, so a span may not consume it.
        await store.markProcessed(session.id, [secondId])
        const error = await thrownBy(() =>
          store.appendEvents(session.id, [spanStartFor([secondId])]),
        )
        expectErrorIdentity(error, 'ClaimConflictError', CLAIM_CONFLICT_ERROR_CODE)
        expect(await store.getPendingUserEvents(session.id)).toEqual([])
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
        expect((await store.listEvents(session.id)).data).toEqual(stored)
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

        const replay = (await store.listEvents(session.id)).data
        expect(replay.map((event) => event.seq)).toEqual([
          message?.seq,
          ...inFlight.map((event) => event.seq),
        ])
        expect(replay[0]).toEqual(message)

        // The debugging read is the raw log: the superseded chunks are still there.
        const raw = (await store.listEvents(session.id, { includeSuperseded: true })).data
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

        expect((await store.listEvents(session.id, { order: 'desc' })).data).toEqual([
          after,
          message,
        ])
        expect((await store.listEvents(session.id, { afterSeq: 1 })).data).toEqual([message, after])
        expect(
          (await store.listEvents(session.id, { types: [EVENT_TYPES.eventDelta] })).data,
        ).toEqual([])
        expect(
          (
            await store.listEvents(session.id, {
              types: [EVENT_TYPES.eventDelta],
              includeSuperseded: true,
            })
          ).data,
        ).toHaveLength(1)
        // A seq cursor past the superseded chunks resumes on what follows them.
        expect((await store.listEvents(session.id, { page: encodeSeqCursor(2) })).data).toEqual([
          message,
          after,
        ])
      })

      it('pages over a log whose superseded chunks are skipped, without gaps or repeats', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const replied = suppliedEventId()
        await append(store, session.id, [eventStart(replied), deltaOf(replied, 'a')])
        const [message] = await append(store, session.id, [supersedingMessage(1, 2)])
        const [queued] = await append(store, session.id, [userMessage('next')])

        const all = await readAllPages((cursor) =>
          store.listEvents(session.id, { limit: 1, page: cursor }),
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
        expect((await store.listEvents(session.id)).data).toHaveLength(2)
      })

      it('records a supersession only for the events that carry one', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const [first] = await append(store, session.id, [deltaOf(suppliedEventId(), 'a')])
        const [plain] = await append(store, session.id, [agentMessage('answer')])
        // `plain` supersedes nothing, so the delta ahead of it is still replayed.
        expect((await store.listEvents(session.id)).data).toEqual([first, plain])
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
        expect((await store.listEvents(session.id)).data).toEqual([first, message, ...inFlight])
        expect((await store.listEvents(session.id, { includeSuperseded: true })).data).toEqual([
          first,
          message,
          ...inFlight,
        ])
        expect((await store.listEvents(session.id)).data).not.toContainEqual(chunks[0])
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
        expect((await store.listEvents(session.id, { includeSuperseded: true })).data).toHaveLength(
          3,
        )
        // Once the cutoff has moved past them, they go.
        expect(await store.compact({ olderThan: clock.currentMs })).toBe(2)
        expect((await store.listEvents(session.id)).data).toHaveLength(1)
      })

      it('rejects a cutoff that is not an instant', async () => {
        const { store } = await setup()
        for (const olderThan of [Number.NaN, new Date(Number.NaN), 'yesterday']) {
          const error = await thrownBy(() => store.compact({ olderThan: olderThan as number }))
          expect(error).toBeInstanceOf(RangeError)
        }
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
          expect(() => {
            event.seq = 99
          }).toThrow(TypeError)
          expect(() => {
            event.processed_at = timestampAt(0)
          }).toThrow(TypeError)
        }

        // Nested values too: the content array, and the blocks inside it.
        if (message?.type !== EVENT_TYPES.userMessage) {
          throw new Error('the first event is not the user message it was given')
        }
        const [block] = message.content
        expect(() => {
          message.content.push({ type: 'text', text: 'more' })
        }).toThrow(TypeError)
        expect(() => {
          if (block?.type === 'text') {
            block.text = 'changed'
          }
        }).toThrow(TypeError)

        // None of it reached the log.
        expect((await store.listEvents(session.id)).data).toEqual([message, running])
        expect((await store.listEvents(session.id)).data[0]?.seq).toBe(1)
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

    // -------------------------------------------------------- in-flight preview

    describe('the in-flight preview', () => {
      it('is null until an event_start, and accumulates the deltas that follow it', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        expect(await store.getPreview(session.id)).toBeNull()

        const id = suppliedEventId()
        await store.publishEphemeral(session.id, eventStart(id))
        expect(await store.getPreview(session.id)).toEqual({ eventId: id, text: '' })

        await store.publishEphemeral(session.id, deltaOf(id, 'Hel'))
        await store.publishEphemeral(session.id, deltaOf(id, 'lo'))
        expect(await store.getPreview(session.id)).toEqual({ eventId: id, text: 'Hello' })
        // A delta extends the preview, not the log: the text is nowhere else yet.
        expect(await store.listEvents(session.id)).toEqual({ data: [], next_page: null })
      })

      it('is cleared when the event it previews is stored', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const id = suppliedEventId()
        await store.publishEphemeral(session.id, eventStart(id))
        await store.publishEphemeral(session.id, deltaOf(id, 'Hello'))
        const [stored] = await store.appendEvents(session.id, [agentMessageUnder(id, 'Hello')])
        expect(stored?.id).toBe(id)
        expect(await store.getPreview(session.id)).toBeNull()

        // A delta that arrives afterwards does not resurrect it: the preview is over, and the
        // log is what a reader sees now.
        await store.publishEphemeral(session.id, deltaOf(id, ' and more'))
        expect(await store.getPreview(session.id)).toBeNull()
      })

      it('is cleared by a span.model_request_end, and by nothing else', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const start = await openSpan(store, session.id)
        const id = suppliedEventId()
        await store.publishEphemeral(session.id, eventStart(id))
        await store.publishEphemeral(session.id, deltaOf(id, 'Hello'))

        // An unrelated append leaves the preview alone...
        await append(store, session.id, [userMessage('another message')])
        expect(await store.getPreview(session.id)).toEqual({ eventId: id, text: 'Hello' })

        // ...and the end of the model request the preview belonged to ends it, whether or not
        // that request produced a message.
        await append(store, session.id, [spanEnd(start)])
        expect(await store.getPreview(session.id)).toBeNull()
      })

      it('is replaced by a new event_start, which the old preview stops extending', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        const first = suppliedEventId()
        const second = suppliedEventId()
        await store.publishEphemeral(session.id, eventStart(first))
        await store.publishEphemeral(session.id, deltaOf(first, 'one'))
        await store.publishEphemeral(session.id, eventStart(second))
        expect(await store.getPreview(session.id)).toEqual({ eventId: second, text: '' })

        // A delta for the preview that was replaced is delivered as always, and changes nothing:
        // there is at most one preview per session.
        await store.publishEphemeral(session.id, deltaOf(first, 'two'))
        expect(await store.getPreview(session.id)).toEqual({ eventId: second, text: '' })
        await store.publishEphemeral(session.id, deltaOf(second, 'three'))
        expect(await store.getPreview(session.id)).toEqual({ eventId: second, text: 'three' })
      })

      it('is kept per session', async () => {
        const { store } = await setup()
        const agent = await store.createAgent(agentInput())
        const one = await store.createSession(agent.id)
        const other = await store.createSession(agent.id)
        const oneId = suppliedEventId()
        const otherId = suppliedEventId()
        await store.publishEphemeral(one.id, eventStart(oneId))
        await store.publishEphemeral(other.id, eventStart(otherId))
        await store.publishEphemeral(one.id, deltaOf(oneId, 'mine'))
        await store.publishEphemeral(other.id, deltaOf(otherId, 'theirs'))

        expect(await store.getPreview(one.id)).toEqual({ eventId: oneId, text: 'mine' })
        expect(await store.getPreview(other.id)).toEqual({ eventId: otherId, text: 'theirs' })
        // Storing one session's message clears that session's preview, and no other's.
        await store.appendEvents(one.id, [agentMessageUnder(oneId, 'mine')])
        expect(await store.getPreview(one.id)).toBeNull()
        expect(await store.getPreview(other.id)).toEqual({ eventId: otherId, text: 'theirs' })
      })

      it('ignores a delta nothing started, and answers for a session that does not exist', async () => {
        const { store } = await setup()
        const { session } = await seed(store)
        // A delta whose `event_start` this store never saw cannot start a preview: a preview
        // begins with an `event_start` and with nothing else.
        await store.publishEphemeral(session.id, deltaOf(suppliedEventId(), 'nowhere'))
        expect(await store.getPreview(session.id)).toBeNull()

        const error = await thrownBy(() => store.getPreview(unknownSessionId()))
        expectErrorIdentity(error, 'SessionNotFoundError', SESSION_NOT_FOUND_ERROR_CODE)
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

/** A `sevt_` id a test hands the store, so the store is not the one that minted it. */
function suppliedEventId(): EventId {
  return newEventId()
}

/** A `user.message` to append. */
function userMessage(text: string): AppendableEvent {
  return { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }] }
}

/** An `agent.message` to append. */
function agentMessage(text: string): AppendableEvent {
  return { type: EVENT_TYPES.agentMessage, content: [{ type: 'text', text }] }
}

/** An `agent.message` to append under the id `id`, as the brain appends one its previews announced. */
function agentMessageUnder(id: EventId, text: string): AppendableEvent {
  return { ...agentMessage(text), id }
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

/** A `span.model_request_start` claiming the user events it is given (D9). */
function spanStartFor(consumes: EventId[]): AppendableEvent {
  return { type: EVENT_TYPES.modelRequestStart, consumes, model: 'anthropic/claude-sonnet-5' }
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

/** The id a stream-only event previews: an `event_start` names it, an `event_delta` points at it. */
function previewedId(event: StreamOnlyEvent): EventId {
  return event.type === EVENT_TYPES.eventStart ? event.event.id : event.event_id
}

/** An `event_delta` extending the preview of `id`. */
function eventDelta(id: EventId): StreamOnlyEvent {
  return deltaOf(id, 'hel')
}

/** An `event_delta` carrying `text` for the preview of `id`. */
function deltaOf(id: EventId, text: string): StreamOnlyEvent {
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
