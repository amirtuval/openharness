import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import {
  EVENT_TYPES,
  partitionOf,
  type ModelRequestEndEvent,
  type Session,
  type SessionId,
  type StoredEvent,
  type UserEvent,
} from '@openharness/protocol'
import { isFencedError, type SessionStore } from '@openharness/session'
import { PostgresSessionStore } from '@openharness/session/postgres'

import { TEST_OWNER_ID } from './test-support'
import { PostgresPartitionScheduler } from './partition-scheduler'
import {
  POSTGRES_STARTUP_TIMEOUT_MS,
  RecordingStore,
  createScriptedModel,
  historyTypes,
  postgresSource,
  readHistory,
  resolveTestSessionCredential,
  startPostgres,
  waitFor,
  waitForIdle,
  type PostgresFixture,
  type ScriptedModel,
  type ScriptedReply,
} from './test-support'

/**
 * The multi-instance scheduler, against a real Postgres: several schedulers in one process,
 * each with its own store connection, sharing one database — which is what several servers
 * sharing sessions look like from the inside.
 *
 * What only this suite can ask: that partitions end up spread over the instances, that a
 * signal reaches the owner across instances, that a partition whose owner died is taken over
 * and its turn finished, that an instance which lost its lease cannot write any more, and that
 * a shutdown hands its leases back rather than making the next instance wait out the TTL.
 *
 * ## Where the database comes from
 *
 * `DATABASE_URL` when it is set (CI sets it, against the workflow's service container),
 * otherwise Postgres in a container when a Docker daemon is around, otherwise the suite is
 * **skipped with a note** — a skipped scheduler test is not a passing one.
 *
 * ## Why the timings are what they are
 *
 * Every wait is a `waitFor` with a bounded timeout, never a fixed sleep, and the leases are
 * short (a few hundred milliseconds) with heartbeats a tenth of that, so a takeover happens in
 * the time a test is willing to wait. The one place time is asserted at all is the shutdown
 * test, and it asserts the opposite: that the handover is quick because the lease was
 * released, not slow because the TTL ran out.
 */

/** The partition space the tests use; small, so a session can be aimed at a partition. */
const PARTITIONS = 8

/** A lease that lapses quickly, so a dead instance's partitions move on in a test's lifetime. */
const TTL_MS = 300

/**
 * The lease timings for tests that are *not* about lease loss.
 *
 * `TTL_MS` is deliberately short, so a test that pauses an instance sees its partitions move
 * within its own patience. That also makes those leases fragile: a loaded runner — the CI
 * boxes these tests flake on — can stall a process past 300 ms between two 30 ms heartbeats,
 * and the scheduler then does exactly what it promises: treats the instance as dead, takes
 * its partitions, and the recovered turns run again. Tests that assert *one* turn, *stable*
 * ownership or an untouched log are about routing and balancing, not about crash recovery, so
 * they run with leases long enough that no plausible stall expires one. Only the tests that
 * want a takeover (a pause, a death, a lease that cannot be renewed) keep `TTL_MS`.
 */
const LONG_TTL_MS = 30_000

/** A heartbeat well inside the TTL, so nothing lapses while an instance is healthy. */
const HEARTBEAT_MS = 30

/** The sweep is off unless a test asks for it; `*UnclaimedWork` has the test that turns it on. */
const NO_SWEEP_MS = 3_600_000

/** How long a test waits for something that should happen in a heartbeat or two. */
const WAIT_MS = 5_000

const SOURCE = postgresSource()

if (SOURCE === null) {
  describe.skip('PostgresPartitionScheduler (skipped: no DATABASE_URL and no Docker daemon)', () => {
    it('would run the multi-instance scheduler tests against Postgres', () => {
      expect.unreachable('unreachable: the suite is skipped')
    })
  })
} else {
  let db: PostgresFixture

  /** Every scheduler a test made, stopped again afterwards. */
  const schedulers: PostgresPartitionScheduler[] = []

  beforeAll(async () => {
    db = await startPostgres({ partitions: PARTITIONS })
  }, POSTGRES_STARTUP_TIMEOUT_MS)

  afterEach(async () => {
    // Stopping releases the leases, so the next test starts from a partition space nobody
    // owns — on top of the truncate, which is what removes the sessions themselves.
    await Promise.all(schedulers.splice(0).map(async (scheduler) => scheduler.stop()))
    await db.truncate()
  })

  afterAll(async () => {
    await db.close()
  })

  // ------------------------------------------------------------------ the harness

  /** One server instance: its own store connection, its own model, its own scheduler. */
  interface Instance {
    readonly name: string
    readonly store: SessionStore
    readonly model: ScriptedModel
    readonly scheduler: PostgresPartitionScheduler
    readonly errors: { error: unknown; sessionId: SessionId | undefined }[]
    readonly notices: string[]
  }

  function instance(
    name: string,
    options: {
      readonly replies?: readonly ScriptedReply[]
      readonly ttlMs?: number
      readonly heartbeatMs?: number
      readonly sweepMs?: number
      readonly store?: SessionStore
      readonly model?: ScriptedModel
    } = {},
  ): Instance {
    const store = options.store ?? db.store()
    const model = options.model ?? createScriptedModel(...(options.replies ?? []))
    const errors: Instance['errors'] = []
    const notices: string[] = []
    const scheduler = new PostgresPartitionScheduler({
      store,
      model: model.factory,
      resolveCredential: resolveTestSessionCredential,
      instanceId: name,
      partitions: PARTITIONS,
      ttlMs: options.ttlMs ?? TTL_MS,
      heartbeatMs: options.heartbeatMs ?? HEARTBEAT_MS,
      sweepMs: options.sweepMs ?? NO_SWEEP_MS,
      drainTimeoutMs: 500,
      onError: (error, sessionId) => {
        errors.push({ error, sessionId })
      },
      onNotice: (message) => {
        notices.push(message)
      },
    })
    schedulers.push(scheduler)
    return { name, store, model, scheduler, errors, notices }
  }

  /** A session whose `sessionId` hashes to `partition`, created directly in the store. */
  async function sessionIn(store: SessionStore, partition: number): Promise<Session> {
    const agent = await store.createAgent(
      { name: 'Agent', model: { id: 'openharness-test/x' } },
      TEST_OWNER_ID,
    )
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const session = await store.createSession(agent.id, { ownerId: TEST_OWNER_ID })
      if (partitionOf(session.id, PARTITIONS) === partition) {
        return session
      }
    }
    throw new Error(`no session landed in partition ${partition} after 200 tries`)
  }

  /** Append a `user.message`, as the events route does. */
  async function appendMessage(
    store: SessionStore,
    sessionId: SessionId,
    text: string,
  ): Promise<StoredEvent[]> {
    return store.appendEvents(sessionId, [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }] },
    ])
  }

  /** Which instance holds the lease of a session's partition — there is exactly one. */
  function ownerOf(instances: readonly Instance[], sessionId: SessionId): Instance {
    const partition = partitionOf(sessionId, PARTITIONS)
    const owners = instances.filter((instance) =>
      instance.scheduler.heldPartitions().includes(partition),
    )
    if (owners.length !== 1) {
      throw new Error(
        `expected exactly one owner of partition ${partition}, found ` +
          `${owners.map((owner) => owner.name).join(', ') || 'none'}`,
      )
    }
    return owners[0] as Instance
  }

  /** Wait until somebody owns a session's partition, and answer who. */
  async function waitForOwner(
    instances: readonly Instance[],
    sessionId: SessionId,
  ): Promise<Instance> {
    const partition = partitionOf(sessionId, PARTITIONS)
    await waitFor(
      () =>
        instances.filter((instance) => instance.scheduler.heldPartitions().includes(partition))
          .length === 1,
      { timeoutMs: WAIT_MS, message: `nobody took partition ${partition} over` },
    )
    return ownerOf(instances, sessionId)
  }

  /** The other instance, for a test that needs one that is not the owner. */
  function otherThan(instances: readonly Instance[], owner: Instance): Instance {
    return instances.find((instance) => instance !== owner) as Instance
  }

  /** The `error.type` of every span end in a log, `null` where there is none. */
  function spanErrors(events: readonly StoredEvent[]): (string | null)[] {
    return events.flatMap((event) =>
      event.type === EVENT_TYPES.modelRequestEnd ? [event.error?.type ?? null] : [],
    )
  }

  /** The text of the agent messages in a log, joined per message. */
  function repliesIn(events: readonly StoredEvent[]): string[] {
    return events.flatMap((event) =>
      event.type === EVENT_TYPES.agentMessage
        ? [event.content.map((block) => block.text).join('')]
        : [],
    )
  }

  /** A gate a test opens by hand, which is how a turn is held in the middle of a stream. */
  function gate(): { wait: () => Promise<void>; open: () => void } {
    let open: () => void = () => {}
    const waited = new Promise<void>((resolve) => {
      open = resolve
    })
    return { wait: () => waited, open: () => open() }
  }

  // ------------------------------------------------------------------ the tests

  describe('sharing the partition space', () => {
    it('spreads the partitions over the instances that boot together, and steals nothing', async () => {
      const first = instance('first', { ttlMs: LONG_TTL_MS })
      const second = instance('second', { ttlMs: LONG_TTL_MS })

      await Promise.all([first.scheduler.start(), second.scheduler.start()])
      // Each instance stops at half the space on its first scan, so two that boot together
      // each end up with a set rather than whichever one won the race having all of them. The
      // first scans can race for the same partition and land 5/3 for a moment; the instance
      // above its share then gives the surplus back, so wait for the balance, not the first claim.
      await waitFor(
        () =>
          first.scheduler.heldPartitions().length === PARTITIONS / 2 &&
          second.scheduler.heldPartitions().length === PARTITIONS / 2,
        { timeoutMs: WAIT_MS, message: 'the partition space never settled at half each' },
      )

      const heldByFirst = first.scheduler.heldPartitions()
      const heldBySecond = second.scheduler.heldPartitions()
      expect(heldByFirst.filter((partition) => heldBySecond.includes(partition))).toEqual([])

      // A few heartbeats later nothing has changed hands: a live lease is never taken over.
      await sleep(4 * HEARTBEAT_MS)
      expect(sorted(first.scheduler.heldPartitions())).toEqual(sorted(heldByFirst))
      expect(sorted(second.scheduler.heldPartitions())).toEqual(sorted(heldBySecond))
    })

    it('offers the space to a peer whose first scan lost the race, instead of starving it', async () => {
      // The slow store stands in for a loaded runner: the slow instance's first acquire holds
      // its first scan up past the fast instance's next heartbeat, so the fast one finds the
      // rest of the space free and takes the whole thing. Nothing on either side could break
      // the stand-off that leaves: the fast one has no visible peer (the slow one holds no
      // lease to be blocked on) and the slow one has nothing to release and can never take a
      // live lease. The offer is the door out: the fast instance, holding everything with
      // nothing running, releases its newest half for a heartbeat, the slow one takes its half
      // out of it — and from then on it is visible and the share-based balancing applies.
      const fast = instance('fast', { ttlMs: LONG_TTL_MS })
      const slow = instance('slow', {
        store: db.track(
          new SlowFirstAcquireStore(
            { pool: db.pool, partitionCount: PARTITIONS },
            SLOW_FIRST_ACQUIRE_MS,
          ),
        ),
        ttlMs: LONG_TTL_MS,
      })

      await Promise.all([fast.scheduler.start(), slow.scheduler.start()])

      await waitFor(
        () =>
          fast.scheduler.heldPartitions().length > 0 && slow.scheduler.heldPartitions().length > 0,
        {
          timeoutMs: WAIT_MS,
          message: 'the instance that lost the first-scan race was never offered a partition',
        },
      )
      // And the space is whole: every partition is somebody's again once the offer windows
      // close, with no partition held by both.
      await waitFor(
        () =>
          fast.scheduler.heldPartitions().length + slow.scheduler.heldPartitions().length ===
          PARTITIONS,
        { timeoutMs: WAIT_MS },
      )
      const heldByFast = new Set(fast.scheduler.heldPartitions())
      expect(
        slow.scheduler.heldPartitions().filter((partition) => heldByFast.has(partition)),
      ).toEqual([])
    })

    it('releases a lease it was acquiring when it stopped, instead of leaving it live for the TTL', async () => {
      // `stop()` cannot cancel an acquire already in flight: the row commits after the stop's
      // snapshot of held leases was taken, and the scan's next look at `#stopped` drops it.
      // Dropping it without releasing it would strand a partition — leased, live, and run by
      // nobody — for the whole TTL, which is exactly what `stop()` promises not to do.
      const store = db.track(
        new SlowFirstAcquireStore({ pool: db.pool, partitionCount: PARTITIONS }, 200),
      )
      const stopping = instance('stopping', { store, ttlMs: LONG_TTL_MS })

      const starting = stopping.scheduler.start()
      await sleep(50) // inside the first acquire, before the lease is even in hand
      await stopping.scheduler.stop()
      await starting // the scan finishes; the lease it just took goes back

      const other = db.store()
      for (let partition = 0; partition < PARTITIONS; partition += 1) {
        expect(await other.acquirePartition(partition, 'other', 1_000)).not.toBeNull()
      }
    })

    it('never takes a live lease: the holder keeps what it renews, and a released lease is taken', async () => {
      const first = instance('first', { ttlMs: LONG_TTL_MS })
      await first.scheduler.start()
      // give the instance the whole space, so nothing is free for the second one to take
      await waitFor(() => first.scheduler.heldPartitions().length === PARTITIONS, {
        timeoutMs: WAIT_MS,
        message: 'the single instance never claimed the whole space',
      })
      const second = instance('second', { ttlMs: LONG_TTL_MS })

      await second.scheduler.start()

      // What the second instance comes to hold, it holds only over partitions the first
      // released first — never one the first still holds, and never one taken from it: a
      // refused renewal would say "lost partition", and none may. (The first, idle and alone
      // in the space, *offers* its newest half back for a heartbeat; that offer is the only
      // door into a fully-held space, and it is a release, not a steal.)
      for (let sample = 0; sample < 4; sample += 1) {
        await sleep(HEARTBEAT_MS)
        const heldByFirst = new Set(first.scheduler.heldPartitions())
        expect(
          second.scheduler.heldPartitions().filter((partition) => heldByFirst.has(partition)),
        ).toEqual([])
      }
      expect(first.notices.filter((line) => line.includes('lost partition'))).toEqual([])
      expect(second.notices.filter((line) => line.includes('lost partition'))).toEqual([])

      // The moment the first instance stops, the second takes the space over.
      await first.scheduler.stop()
      await waitFor(() => second.scheduler.heldPartitions().length === PARTITIONS, {
        timeoutMs: WAIT_MS,
        message: 'the released partitions were not taken over',
      })
    })

    it('hands its leases back on shutdown instead of making the next instance wait for the TTL', async () => {
      // Long leases, so only a release can move a partition within the test's patience.
      const first = instance('first', { ttlMs: 30_000, heartbeatMs: 1_000 })
      const second = instance('second', { ttlMs: 30_000, heartbeatMs: 20 })
      await Promise.all([first.scheduler.start(), second.scheduler.start()])
      await waitFor(
        () =>
          first.scheduler.heldPartitions().length + second.scheduler.heldPartitions().length ===
          PARTITIONS,
        { timeoutMs: WAIT_MS },
      )
      const released = first.scheduler.heldPartitions()

      const before = Date.now()
      await first.scheduler.stop()
      await waitFor(() => released.every((p) => second.scheduler.heldPartitions().includes(p)), {
        timeoutMs: WAIT_MS,
        message: 'the shutdown leases were not taken over',
      })

      // Long before the 30-second TTL: the partitions came back, they did not expire.
      expect(Date.now() - before).toBeLessThan(5_000)
    })
  })

  describe('running a session', () => {
    it('runs one turn, in the instance that owns the session', async () => {
      const first = instance('first', {
        replies: [{ text: ['answered once'] }],
        ttlMs: LONG_TTL_MS,
      })
      const second = instance('second', { replies: [{ text: ['never'] }], ttlMs: LONG_TTL_MS })
      await Promise.all([first.scheduler.start(), second.scheduler.start()])

      const store = db.store()
      const session = await sessionIn(store, 0)
      const owner = await waitForOwner([first, second], session.id)
      const other = otherThan([first, second], owner)

      await appendMessage(store, session.id, 'hello')
      // The signal goes through the other instance, which does not own the partition: it is
      // routed to the owner over the partition's channel, not handled where it was raised.
      other.scheduler.signal(session.id, 'work')

      await waitForIdle(store, session.id)
      expect(owner.model.requests).toBe(1)
      expect(other.model.requests).toBe(0)
      expect(await historyTypes(store, session.id)).toEqual([
        EVENT_TYPES.userMessage,
        EVENT_TYPES.sessionStatusRunning,
        EVENT_TYPES.modelRequestStart,
        EVENT_TYPES.agentMessage,
        EVENT_TYPES.modelRequestEnd,
        EVENT_TYPES.sessionStatusIdle,
      ])
      expect(repliesIn(await readHistory(store, session.id))).toEqual(['answered once'])
    })

    it('fences every write with the lease the owner holds', async () => {
      // The recording store is the instance's: everything it sees is a write the *scheduler*
      // made, so the unfenced append the test itself makes goes through a second store.
      const store = db.track(new RecordingStore({ pool: db.pool, partitionCount: PARTITIONS }))
      const owner = instance('owner', {
        replies: [{ text: ['under a lease'] }],
        store,
        ttlMs: LONG_TTL_MS,
      })
      await owner.scheduler.start()

      const session = await sessionIn(store, 0)
      const partition = partitionOf(session.id, PARTITIONS)
      await waitFor(() => owner.scheduler.heldPartitions().includes(partition))
      await appendMessage(db.store(), session.id, 'hello')
      owner.scheduler.signal(session.id, 'work')

      await waitForIdle(store, session.id)
      expect(store.writes.length).toBeGreaterThan(0)
      for (const write of store.writes) {
        // Every write carried this partition — which is what a zombie's write, made under an
        // epoch this instance no longer holds, fails against.
        expect(write.fence).toMatchObject({ partition })
        expect(write.fence?.epoch).toBeGreaterThan(0)
      }
    })

    it('recovers a partition it takes over, even when the signal for its work was dropped', async () => {
      const first = instance('first', {
        replies: [{ text: ['found by the scan'] }],
        ttlMs: LONG_TTL_MS,
      })
      const second = instance('second', {
        replies: [{ text: ['found by the scan'] }],
        ttlMs: LONG_TTL_MS,
      })
      const store = db.store()
      const session = await sessionIn(store, 0)
      await appendMessage(store, session.id, 'written while nobody was listening')

      // The signal is sent with no instance running at all: it reaches nobody and is dropped,
      // exactly as the contract allows. The work is in the log, not in the signal.
      first.scheduler.signal(session.id, 'work')

      await Promise.all([first.scheduler.start(), second.scheduler.start()])

      await waitForIdle(store, session.id)
      expect(repliesIn(await readHistory(store, session.id))).toEqual(['found by the scan'])
      expect(first.model.requests + second.model.requests).toBe(1)
    })

    it('sweeps the partitions it owns, for the work a signal never mentioned', async () => {
      // The sweep is the safety net, so it is turned on here and the heartbeat is slowed
      // down: nothing but the sweep can find this message.
      const owner = instance('owner', {
        replies: [{ text: ['found by the sweep'] }],
        heartbeatMs: 100,
        sweepMs: 200,
        ttlMs: LONG_TTL_MS,
      })
      await owner.scheduler.start()
      const store = db.store()
      const session = await sessionIn(store, 0)
      await waitFor(() =>
        owner.scheduler.heldPartitions().includes(partitionOf(session.id, PARTITIONS)),
      )

      await appendMessage(store, session.id, 'no signal was sent for this')

      await waitForIdle(store, session.id, WAIT_MS)
      expect(repliesIn(await readHistory(store, session.id))).toEqual(['found by the sweep'])
    })
  })

  describe('an instance that dies mid-turn', () => {
    it('is taken over, and the turn is finished on the surviving instance', async () => {
      const victim = instance('victim')
      const survivor = instance('survivor')
      await Promise.all([victim.scheduler.start(), survivor.scheduler.start()])

      const store = db.store()
      const session = await sessionIn(store, 0)
      const owner = await waitForOwner([victim, survivor], session.id)
      const other = otherThan([victim, survivor], owner)
      const held = gate()
      owner.model.push({ onChunk: () => held.wait() })
      other.model.push({ text: ['finished by the survivor'] })

      await appendMessage(store, session.id, 'a long one')
      owner.scheduler.signal(session.id, 'work')
      await owner.model.waitForRequests(1)

      // The crash: the heartbeats stop, and the turn is held in the middle of its stream. The
      // lease is never renewed again, so it lapses and the survivor takes the partition over.
      owner.scheduler.pause()
      await waitFor(
        () => other.scheduler.heldPartitions().includes(partitionOf(session.id, PARTITIONS)),
        {
          timeoutMs: WAIT_MS,
          message: 'the dead instance’s partition was never taken over',
        },
      )

      await waitForIdle(store, session.id, WAIT_MS)
      const history = await readHistory(store, session.id)
      // The inherited span is closed before the re-run: brain_lost says the brain that opened
      // it is gone, and the turn that follows is the one that finishes the work.
      expect(history.map((event) => event.type)).toEqual([
        EVENT_TYPES.userMessage,
        EVENT_TYPES.sessionStatusRunning,
        EVENT_TYPES.modelRequestStart,
        EVENT_TYPES.modelRequestEnd,
        EVENT_TYPES.modelRequestStart,
        EVENT_TYPES.agentMessage,
        EVENT_TYPES.modelRequestEnd,
        EVENT_TYPES.sessionStatusIdle,
      ])
      expect(spanErrors(history)).toEqual(['brain_lost', null])
      expect(repliesIn(history)).toEqual(['finished by the survivor'])
      // Every span is closed: nothing was left open for the next recovery to find.
      expect(await store.getTurnState(session.id)).toEqual({ state: 'idle', openSpan: null })

      held.open()
    })

    it('cannot write when it wakes up: the write is fenced, and nothing is stored', async () => {
      const victim = instance('victim')
      const survivor = instance('survivor')
      await Promise.all([victim.scheduler.start(), survivor.scheduler.start()])

      const store = db.store()
      const session = await sessionIn(store, 0)
      const owner = await waitForOwner([victim, survivor], session.id)
      const other = otherThan([victim, survivor], owner)
      const held = gate()
      // The zombie streams, but the reply it is building is only finished after it has lost
      // the lease — which is exactly the write that must be refused. The gate opens on the
      // second chunk, so the turn is held with the reply already half-written.
      owner.model.push({
        text: ['from ', 'the ', 'zombie'],
        onChunk: (_chunk, index) => (index === 1 ? held.wait() : Promise.resolve()),
      })
      other.model.push({ text: ['from the survivor'] })

      await appendMessage(store, session.id, 'a long one')
      owner.scheduler.signal(session.id, 'work')
      await owner.model.waitForRequests(1)
      owner.scheduler.pause()
      await waitFor(
        () => other.scheduler.heldPartitions().includes(partitionOf(session.id, PARTITIONS)),
        {
          timeoutMs: WAIT_MS,
        },
      )
      await waitForIdle(store, session.id, WAIT_MS)
      const before = await readHistory(store, session.id)

      // The paused instance comes back to life and tries to write what it streamed.
      held.open()

      await waitFor(() => owner.errors.some((reported) => isFencedError(reported.error)), {
        timeoutMs: WAIT_MS,
        message: 'the zombie was never fenced',
      })
      // The process is alive — a FencedError is news, not a crash — and the zombie's partition
      // is not its work any more.
      expect(owner.scheduler.heldPartitions()).not.toContain(partitionOf(session.id, PARTITIONS))
      // Nothing the zombie wrote is in the log: it is exactly what the survivor left.
      const after = await readHistory(store, session.id)
      expect(after.map((event) => event.id)).toEqual(before.map((event) => event.id))
      expect(repliesIn(after)).toEqual(['from the survivor'])
    })

    it('drops the lease of a partition it can no longer renew, and stops running it', async () => {
      const victim = instance('victim')
      const survivor = instance('survivor')
      await Promise.all([victim.scheduler.start(), survivor.scheduler.start()])

      const store = db.store()
      const session = await sessionIn(store, 0)
      const owner = await waitForOwner([victim, survivor], session.id)
      const other = otherThan([victim, survivor], owner)
      const partition = partitionOf(session.id, PARTITIONS)
      const held = gate()
      owner.model.push({ onChunk: () => held.wait() })
      // Scripted up front: the instance that takes the partition over answers with this for
      // the turn it recovers and for the one that arrives afterwards, and the test must not
      // race the signal that starts the second one.
      other.model.push({ text: ['the survivor answers'] })

      await appendMessage(store, session.id, 'a long one')
      owner.scheduler.signal(session.id, 'work')
      await owner.model.waitForRequests(1)
      owner.scheduler.pause()
      await waitFor(() => other.scheduler.heldPartitions().includes(partition), {
        timeoutMs: WAIT_MS,
      })

      // The instance wakes up with its lease gone: the renewal is refused, and that aborts the
      // turn it was still running and stops it running anything more for that partition.
      owner.scheduler.resume()
      await waitFor(() => !owner.scheduler.heldPartitions().includes(partition), {
        timeoutMs: WAIT_MS,
        message: 'the instance kept a lease it could not renew',
      })
      // The aborted turn ends where a gated model lets it: the stream is released, and the
      // writes it then tries to make are refused — the lease it would write under is gone.
      held.open()
      await waitFor(() => owner.scheduler.activeSessions().length === 0, {
        timeoutMs: WAIT_MS,
        message: 'the aborted turn was still running',
      })

      // And the work moved with the lease: the next message is answered by the survivor.
      await appendMessage(store, session.id, 'after the handover')
      other.scheduler.signal(session.id, 'work')
      await waitForIdle(store, session.id, WAIT_MS)
      expect(repliesIn(await readHistory(store, session.id))).toContain('the survivor answers')
    })
  })

  describe('interrupts across instances', () => {
    it('stops a turn through an interrupt raised at the instance that does not own it', async () => {
      const first = instance('first', { ttlMs: LONG_TTL_MS })
      const second = instance('second', { ttlMs: LONG_TTL_MS })
      await Promise.all([first.scheduler.start(), second.scheduler.start()])

      const store = db.store()
      const session = await sessionIn(store, 0)
      const owner = await waitForOwner([first, second], session.id)
      const other = otherThan([first, second], owner)
      // The previews the brain publishes are the only way to know the turn is really under way
      // — and they are what a client sees first, so waiting for one is waiting for the turn.
      const deltas: string[] = []
      const unsubscribe = await store.subscribe(session.id, (event) => {
        if (event.type === EVENT_TYPES.eventDelta) {
          deltas.push(event.delta.content.text)
        }
      })
      owner.model.push({ text: ['one ', 'two ', 'three'], delayMs: 40 })

      await appendMessage(store, session.id, 'stream something long')
      owner.scheduler.signal(session.id, 'work')
      await waitFor(() => deltas.length > 0, {
        timeoutMs: WAIT_MS,
        message: 'the model never started streaming',
      })
      await store.appendEvents(session.id, [{ type: EVENT_TYPES.userInterrupt }])

      // The user interrupts through the wrong instance on purpose: the signal is routed to the
      // owner's partition channel and the owner stops the turn.
      other.scheduler.signal(session.id, 'interrupt')

      await waitForIdle(store, session.id, WAIT_MS)
      unsubscribe()
      const history = await readHistory(store, session.id)
      // One span, closed interrupted: an interrupt is not a model request, so the request
      // that was streaming is the only span, and its end is what claims the interrupt (P4).
      expect(spanErrors(history)).toEqual(['interrupted'])
      const interrupt = history.find(
        (event): event is ModelRequestEndEvent => event.type === EVENT_TYPES.modelRequestEnd,
      )
      const interruptEvent = history.find((event) => event.type === EVENT_TYPES.userInterrupt)
      expect(interrupt?.consumes).toEqual([interruptEvent?.id])
      expect(history.at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
      // The partial reply is stored — an interrupt keeps what was already said, up to the
      // chunk the brain had when the signal reached it — and the interrupt itself is claimed,
      // so nothing is left queued.
      const partial = repliesIn(history)
      expect(partial).toHaveLength(1)
      expect('one two three'.startsWith(partial[0] ?? 'x')).toBe(true)
      const pending: UserEvent[] = await store.getPendingUserEvents(session.id)
      expect(pending).toEqual([])
    })

    it('claims a queued interrupt for a session that was not running', async () => {
      const first = instance('first', { ttlMs: LONG_TTL_MS })
      const second = instance('second', { ttlMs: LONG_TTL_MS })
      await Promise.all([first.scheduler.start(), second.scheduler.start()])

      const store = db.store()
      const session = await sessionIn(store, 0)
      const owner = await waitForOwner([first, second], session.id)
      const other = otherThan([first, second], owner)
      await store.appendEvents(session.id, [{ type: EVENT_TYPES.userInterrupt }])

      other.scheduler.signal(session.id, 'interrupt')

      // Nothing was running, but a `user.interrupt` is still queued work: a turn is started for
      // the owner to claim it.
      await waitForIdle(store, session.id, WAIT_MS)
      expect(await store.getPendingUserEvents(session.id)).toEqual([])
      expect(owner.model.requests).toBe(0)
    })
  })

  describe('its options', () => {
    it('refuses a heartbeat slower than the lease it has to renew', () => {
      expect(
        () =>
          new PostgresPartitionScheduler({
            store: db.store(),
            model: createScriptedModel().factory,
            resolveCredential: resolveTestSessionCredential,
            instanceId: 'bad',
            ttlMs: 100,
            heartbeatMs: 100,
          }),
      ).toThrow(/heartbeatMs .* must be smaller than ttlMs/)
    })
  })
}

/** Sleep for real milliseconds; the suite's only fixed wait, and only to let timers run. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * How long the losing instance's first acquire takes in the offer test: long past the
 * winner's next heartbeat, so the winner's second scan takes the whole space while the
 * loser's first scan is still waiting on its first round trip — the interleaving a loaded
 * runner produces, and the one that used to leave the loser starved forever. Only the first
 * acquire is slowed: the point is the *first* one, and the rest of the loser's attempts at
 * normal speed are what lets it pick up an offered partition once the offer exists.
 */
const SLOW_FIRST_ACQUIRE_MS = 150

/** A store whose first acquire waits, then behaves normally — a scan behind one slow query. */
class SlowFirstAcquireStore extends PostgresSessionStore {
  readonly #delayMs: number

  #delaysLeft = 1

  constructor(options: { pool: Pool; partitionCount: number }, delayMs: number) {
    super(options)
    this.#delayMs = delayMs
  }

  override async acquirePartition(
    ...args: Parameters<PostgresSessionStore['acquirePartition']>
  ): ReturnType<PostgresSessionStore['acquirePartition']> {
    if (this.#delaysLeft > 0) {
      this.#delaysLeft -= 1
      await sleep(this.#delayMs)
    }
    return super.acquirePartition(...args)
  }
}

function sorted(partitions: readonly number[]): number[] {
  return [...partitions].sort((left, right) => left - right)
}
