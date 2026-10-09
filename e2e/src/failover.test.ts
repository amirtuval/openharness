import { readFile } from 'node:fs/promises'

import { type Client } from '@openharness/client'
import {
  DEFAULT_PARTITION_COUNT,
  EVENT_TYPES,
  partitionOf,
  type Session,
} from '@openharness/protocol'
import { MOCK_SLOW_MARKER } from '@openharness/server'
import { describe, expect, it } from 'vitest'

import {
  agentMessages,
  collectStream,
  e2eHarness,
  expectedSlowReply,
  hasOpenTurn,
  isPreviewDelta,
  modelRequestEnds,
  readLog,
  serverEntryPath,
  textOf,
  typesOf,
  waitFor,
  waitForTurnEnd,
  withDatabaseClient,
} from './harness'

/**
 * Two server instances sharing one database, and a partition scheduler (#11).
 *
 * This is the scenario #11 exists for: instances own *partitions* of the session space, a
 * signal travels to whichever instance holds the partition, and a turn whose owner dies is
 * picked up by another instance once the lease expires. The kill is the interesting part of
 * it — the surviving instance is told nothing; it has to notice on its own.
 *
 * ## Why this is not an ordinary test
 *
 * `SCHEDULER=postgres` is added by #11, which is a separate branch, so on a tree without it
 * the variable does nothing at all — the server comes up on `LocalScheduler` and every
 * instance believes it owns everything. That is not an error the server can report, so this
 * file **detects** the capability instead of assuming it, and skips with an explanation when
 * it is missing rather than asserting against a guess. Two checks, in order:
 *
 * 1. the built server does not mention `SCHEDULER` anywhere — a variable the code never reads
 *    cannot change what it does, so there is nothing to test;
 * 2. an instance started with `SCHEDULER=postgres` and short lease timings holds no partition
 *    lease in the database, which is what a running partition scheduler looks like from
 *    outside (`partition_leases.owner` is set for the partitions it owns).
 */

const harness = e2eHarness('failover')

/**
 * What the two instances run with: the multi-instance scheduler, a lease that expires
 * quickly, and a heartbeat well inside it, so a takeover happens in seconds rather than
 * minutes.
 */
const PARTITION_ENV = {
  SCHEDULER: 'postgres',
  OPENHARNESS_LEASE_TTL_MS: '2000',
  OPENHARNESS_HEARTBEAT_MS: '500',
}

/** How long the lease probe waits for a partition to be claimed. */
const LEASE_PROBE_TIMEOUT_MS = 5_000

/** Why the failover scenario cannot run here, or `undefined` when it can. */
async function unavailableReason(): Promise<string | undefined> {
  const entry = serverEntryPath()
  const built = await readFile(entry, 'utf8')
  if (!built.includes('SCHEDULER')) {
    return (
      'the multi-instance scheduler (#11) is not in this tree: the built server ' +
      `(${entry}) does not read SCHEDULER at all, so starting two instances with ` +
      'SCHEDULER=postgres would give two ordinary single-process schedulers that cannot ' +
      'take a turn over from each other. The scenario below is written against the #11 ' +
      'interface and runs unchanged once it is merged.'
    )
  }
  if (!(await leasesAreHeld())) {
    return (
      'the server accepts SCHEDULER=postgres but no instance holds a partition lease: ' +
      'either #11 records ownership somewhere other than partition_leases.owner, or the ' +
      'scheduler did not start. Skipping rather than asserting against an assumption about ' +
      'how ownership is stored.'
    )
  }
  return undefined
}

/** Whether an instance started with {@link PARTITION_ENV} claims partitions in the database. */
async function leasesAreHeld(): Promise<boolean> {
  const database = await harness.database()
  const server = await harness.server({ env: PARTITION_ENV })
  try {
    await waitFor(
      'a partition with an owner',
      async () =>
        await withDatabaseClient(
          async (client) => {
            const result = await client.query<{ owned: string }>(
              'select count(*) as owned from partition_leases where owner is not null',
            )
            return Number(result.rows[0]?.owned ?? '0') > 0 ? true : undefined
          },
          { database: database.name },
        ),
      { timeoutMs: LEASE_PROBE_TIMEOUT_MS },
    )
    return true
  } catch {
    return false
  } finally {
    await server.kill()
  }
}

/** An agent and a session, the pair the test drives. */
/** The instance holding the lease on the session's partition, per `partition_leases`. */
async function partitionOwner(sessionId: string): Promise<string | undefined> {
  const database = await harness.database()
  const partition = partitionOf(sessionId, DEFAULT_PARTITION_COUNT)
  return await withDatabaseClient(
    async (client) => {
      const result = await client.query<{ owner: string | null }>(
        'select owner from partition_leases where partition = $1',
        [partition],
      )
      return result.rows[0]?.owner ?? undefined
    },
    { database: database.name },
  )
}

async function newSession(client: Client): Promise<Session> {
  const agent = await client.agents.create({
    name: 'Echo agent',
    model: { id: 'anthropic/claude-sonnet-5' },
  })
  return await client.sessions.create({ agent: agent.id })
}

describe('two instances sharing a database', () => {
  it('finishes the turn of the instance that was killed', async (context) => {
    const reason = await unavailableReason()
    if (reason !== undefined) {
      context.skip(reason)
      return
    }

    const first = await harness.server({
      env: { ...PARTITION_ENV, OPENHARNESS_INSTANCE_ID: 'failover-first' },
    })
    const second = await harness.server({
      env: { ...PARTITION_ENV, OPENHARNESS_INSTANCE_ID: 'failover-second' },
    })
    const client = await harness.client(first)
    const session = await newSession(client)
    const prompt = `${MOCK_SLOW_MARKER} outlive the instance that started me`

    const watcher = collectStream(client, session.id, { deltas: true, afterSeq: 0 })
    await client.sendMessage(session.id, prompt)
    await watcher.waitFor((events) => events.some(isPreviewDelta), 'the first preview delta')
    await watcher.stop()

    // Kill the instance that *owns* the session's partition, which is the one running the
    // turn. Which instance that is depends on how the two split the partitions at boot, so
    // look it up rather than assuming the one that took the message.
    const owner = await partitionOwner(session.id)
    const [doomed, survivorServer] = owner === 'failover-first' ? [first, second] : [second, first]
    expect(['failover-first', 'failover-second']).toContain(owner)
    await doomed.kill('SIGKILL')

    // The survivor has to notice on its own: a lease TTL plus a whole `__slow__` reply.
    const survivor = await harness.client(survivorServer)
    await waitForTurnEnd(survivor, session.id, { timeoutMs: 45_000 })

    const log = await readLog(survivor, session.id)
    expect(modelRequestEnds(log).map((event) => event.error?.type)).toContain('brain_lost')
    expect(agentMessages(log).map(textOf)).toEqual([expectedSlowReply()])
    expect(typesOf(log).at(-1)).toBe(EVENT_TYPES.sessionStatusIdle)
    expect(hasOpenTurn(log)).toBe(false)
  }, 90_000) // A lease expiry, a takeover and a whole `__slow__` reply, on two extra processes.
})
