import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Client } from '@openharness/client'
import {
  DEFAULT_PARTITION_COUNT,
  EVENT_TYPES,
  partitionOf,
  type AgentToolResultEvent,
  type Session,
} from '@openharness/protocol'
import { MOCK_CRASH_MARKER, MOCK_DELAYED_TOOL_MARKER, MOCK_SLOW_MARKER } from '@openharness/server'
import { afterEach, describe, expect, it } from 'vitest'

import {
  agentMessages,
  collectStream,
  e2eHarness,
  expectedSlowReply,
  hasOpenTurn,
  isPreviewDelta,
  modelRequestEnds,
  readLog,
  textOf,
  typesOf,
  waitFor,
  waitForTurnEnd,
  withDatabaseClient,
} from './harness'

/**
 * Crash handling (#378, P4): `kill -9` among several instances on one database.
 *
 * The goals are modest — a rare crash may be visible, but nothing may freeze for ever — and
 * these are the facts that make "may be visible" mean something:
 *
 * 1. a streaming turn whose owner is killed is finished by a peer, with no user action, inside
 *    a lease TTL plus a heartbeat plus the margin a re-run needs; the partial reply is
 *    superseded and exactly one final reply remains;
 * 2. a tool call in flight when its owner dies is answered `execution lost` with a sentence
 *    the model can act on, and is **never run again** (the slow test tool counts executions);
 * 3. a turn that kills every owner that runs it — a poison input — is stopped by the recovery
 *    cap with a terminal `recovery_exhausted_error`, rather than looping through processes.
 */

const harness = e2eHarness('crash')

/**
 * What every instance runs with: the partitioned scheduler, a lease short enough that a
 * takeover happens in the test's lifetime, and no balancing window so the partitions settle
 * among the instances immediately after boot.
 */
const PARTITION_ENV = {
  SCHEDULER: 'postgres',
  OPENHARNESS_LEASE_TTL_MS: '2000',
  OPENHARNESS_HEARTBEAT_MS: '500',
  OPENHARNESS_BALANCE_STABILITY_MS: '0',
}

/** The takeover budget: one TTL, one heartbeat, a whole slow reply, and room to spare. */
const TAKEOVER_BUDGET_MS = 2_000 + 500 + 15_000

/** How long a test waits for a partition to be claimed at boot. */
const LEASE_PROBE_TIMEOUT_MS = 10_000

/**
 * Each scenario owns the database, so a server from the previous test must not still hold
 * partitions when the next one starts: it would run that test's turn without that test's
 * environment (the tool-execution log, the recovery cap). Kill them all between tests; the
 * harness drops the database itself in `afterAll`.
 */
afterEach(async () => {
  await Promise.all(harness.servers.map(async (server) => server.kill()))
})

/** Start `count` instances of the partitioned server, ids `<prefix>-0..n-1`. */
async function startServers(
  count: number,
  prefix: string,
  env: Readonly<Record<string, string>> = {},
): Promise<Awaited<ReturnType<typeof harness.server>>[]> {
  const servers = []
  for (let index = 0; index < count; index += 1) {
    servers.push(
      await harness.server({
        env: { ...PARTITION_ENV, OPENHARNESS_INSTANCE_ID: `${prefix}-${index}`, ...env },
      }),
    )
  }
  return servers
}

/** The session a test drives: model-first, so no agent setup is in the way. */
async function newSession(client: Client): Promise<Session> {
  return await client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })
}

/** The instance holding the lease on the session's partition. */
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

/** Wait until some instance owns the session's partition. */
async function waitForOwner(sessionId: string): Promise<string> {
  return await waitFor(
    'the session partition to be leased',
    async () => await partitionOwner(sessionId),
    { timeoutMs: LEASE_PROBE_TIMEOUT_MS },
  )
}

/** The server whose instance id the lease names, or a failure naming what was seen. */
function ownerServer(
  servers: readonly Awaited<ReturnType<typeof harness.server>>[],
  owner: string,
): Awaited<ReturnType<typeof harness.server>> {
  const server = servers.find((candidate, index) => owner.endsWith(`-${String(index)}`))
  if (server === undefined) {
    throw new Error(`no started server matches the partition owner ${owner}`)
  }
  return server
}

/** A client for any instance that is still running; session tokens live in Postgres. */
async function liveClient(
  servers: readonly Awaited<ReturnType<typeof harness.server>>[],
): Promise<Client> {
  const live = servers.find((server) => server.isRunning())
  if (live === undefined) {
    throw new Error('every server in the crash test has exited')
  }
  return await harness.client(live)
}

/** The tool executions the slow test tool recorded, from its append-only file. */
async function executionCount(path: string): Promise<number> {
  try {
    const text = await readFile(path, 'utf8')
    return text.split('\n').filter((line) => line !== '').length
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0
    }
    throw error
  }
}

describe('a crashed owner', () => {
  it('is finished by a peer, with the partial reply superseded (#378, P4)', async () => {
    const servers = await startServers(3, 'crash-stream')
    const client = await harness.client(servers[0]!)
    const session = await newSession(client)

    const watcher = collectStream(client, session.id, { deltas: true, afterSeq: 0 })
    await client.sendMessage(session.id, `${MOCK_SLOW_MARKER} survive a kill -9`)
    await watcher.waitFor((events) => events.some(isPreviewDelta), 'the first preview delta')
    await watcher.stop()

    // The owner of the session's partition is the one running the turn; which instance that
    // is depends on how the three split the space, so read it rather than assume.
    const owner = await waitForOwner(session.id)
    const doomed = ownerServer(servers, owner)
    const killedAt = Date.now()
    await doomed.kill('SIGKILL')

    const survivor = await liveClient(servers)
    await waitForTurnEnd(survivor, session.id, { timeoutMs: TAKEOVER_BUDGET_MS + 15_000 })
    const elapsed = Date.now() - killedAt

    // The user did nothing: a lease lapsed, a peer took the partition, and the turn finished.
    expect(elapsed).toBeLessThanOrEqual(TAKEOVER_BUDGET_MS)

    const log = await readLog(survivor, session.id)
    // The dead owner's span was closed as `brain_lost`, and its streamed chunks were
    // superseded: replay holds not one delta, and exactly one complete reply remains.
    const lost = modelRequestEnds(log).filter((event) => event.error?.type === 'brain_lost')
    expect(lost).toHaveLength(1)
    expect(lost[0]?.supersedes).toBeDefined()
    expect(log.filter((event) => event.type === EVENT_TYPES.eventDelta)).toEqual([])
    expect(agentMessages(log).map(textOf)).toEqual([expectedSlowReply()])
    expect(typesOf(log).at(-1)).toBe(EVENT_TYPES.sessionStatusIdle)
    expect(hasOpenTurn(log)).toBe(false)
    // One message, one re-run — no second user message, no second reply.
    expect(log.filter((event) => event.type === EVENT_TYPES.userMessage)).toHaveLength(1)
    expect(log.filter((event) => event.type === EVENT_TYPES.modelRequestStart)).toHaveLength(2)
  }, 90_000)

  it('answers an inherited tool call execution lost and never runs it (#378, P4)', async () => {
    // A real execution counter, shared by every instance: the tool appends one line when it
    // starts. The recovering brain must not add a second.
    const directory = await mkdtemp(join(tmpdir(), 'openharness-crash-'))
    const executionLog = join(directory, 'executions.log')
    try {
      const servers = await startServers(3, 'crash-tool', {
        OPENHARNESS_TEST_TOOL_EXECUTION_LOG: executionLog,
      })
      const client = await harness.client(servers[0]!)
      const session = await newSession(client)

      // The call is stored at once and the slow tool starts; kill the owner while it waits.
      await client.sendMessage(session.id, `${MOCK_DELAYED_TOOL_MARKER} 60000 keep me`)
      await waitFor(
        'the slow tool call to be stored',
        async () =>
          (await readLog(client, session.id)).some(
            (event) => event.type === EVENT_TYPES.agentToolUse,
          )
            ? true
            : undefined,
        { timeoutMs: 15_000 },
      )
      await waitFor(
        'the slow tool to start',
        async () => ((await executionCount(executionLog)) > 0 ? true : undefined),
        {
          timeoutMs: 15_000,
        },
      )

      const owner = await waitForOwner(session.id)
      await ownerServer(servers, owner).kill('SIGKILL')

      const survivor = await liveClient(servers)
      await waitForTurnEnd(survivor, session.id, { timeoutMs: 60_000 })

      const log = await readLog(survivor, session.id)
      const results = log.filter(
        (event): event is AgentToolResultEvent => event.type === EVENT_TYPES.agentToolResult,
      )
      expect(results).toHaveLength(1)
      expect(results[0]?.is_error).toBe(true)
      const resultText = JSON.stringify(results[0]?.content ?? [])
      expect(resultText).toContain('execution lost')
      expect(resultText).toContain('The server running this tool stopped before it returned')
      expect(resultText).toContain('You may retry it if that is safe.')

      // The model was told, and answered: the mock echoes the result it was handed.
      const reply = agentMessages(log).at(-1)
      expect(reply === undefined ? '' : textOf(reply)).toContain(
        'You may retry it if that is safe.',
      )

      // One call, one execution. The recovering brain never ran the tool again.
      expect(log.filter((event) => event.type === EVENT_TYPES.agentToolUse)).toHaveLength(1)
      const executions = await executionCount(executionLog)
      expect(executions).toBe(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 90_000)

  it('stops a poison turn at the recovery cap instead of looping (#378, P4)', async () => {
    // Four owners die on the poison request; the fifth finds three recoveries already recorded
    // and ends the turn instead of starting a fourth. Five instances are therefore one more
    // than the cap needs.
    const maxRecoveries = 3
    const servers = await startServers(5, 'crash-poison', {
      OPENHARNESS_MAX_RECOVERY_ATTEMPTS: String(maxRecoveries),
    })
    const client = await harness.client(servers[0]!)
    const session = await newSession(client)

    const startedAt = Date.now()
    await client.sendMessage(session.id, `${MOCK_CRASH_MARKER} kill every owner`)

    // Each recovery takes a lease TTL plus a heartbeat, so four deaths fit comfortably here.
    await waitFor(
      'four instances to die on the poison turn',
      () =>
        servers.filter((server) => !server.isRunning()).length >= maxRecoveries + 1
          ? true
          : undefined,
      { timeoutMs: 90_000 },
    )

    const survivor = await liveClient(servers)
    await waitForTurnEnd(survivor, session.id, { timeoutMs: 60_000 })
    const log = await readLog(survivor, session.id)

    const error = log.find((event) => event.type === EVENT_TYPES.sessionError)
    expect(error?.type).toBe(EVENT_TYPES.sessionError)
    if (error?.type === EVENT_TYPES.sessionError) {
      expect(error.error.type).toBe('recovery_exhausted_error')
      expect(error.error.retry_status.type).toBe('terminal')
      expect(error.error.message).toContain(
        `recovered ${String(maxRecoveries)} times without completing a step`,
      )
    }
    // The turn ended, and the poison never reached a fifth request.
    expect(log.filter((event) => event.type === EVENT_TYPES.modelRequestStart)).toHaveLength(
      maxRecoveries + 1,
    )
    expect(
      modelRequestEnds(log).filter((event) => event.error?.type === 'brain_lost'),
    ).toHaveLength(maxRecoveries + 1)
    expect(agentMessages(log)).toEqual([])
    expect(log.filter((event) => event.type === EVENT_TYPES.eventDelta)).toEqual([])
    expect(typesOf(log).at(-1)).toBe(EVENT_TYPES.sessionStatusIdle)
    expect(hasOpenTurn(log)).toBe(false)

    // Four takeovers, each bounded by a TTL plus a heartbeat, plus room for the test's polls.
    expect(Date.now() - startedAt).toBeLessThanOrEqual((maxRecoveries + 1) * (2_000 + 500) + 30_000)
  }, 120_000)
})
