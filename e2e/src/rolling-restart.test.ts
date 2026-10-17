import { type Client } from '@openharness/client'
import {
  DEFAULT_PARTITION_COUNT,
  EVENT_TYPES,
  partitionOf,
  type EventId,
  type Session,
  type StoredEvent,
} from '@openharness/protocol'
import { MOCK_SLOW_MARKER, MOCK_SLOW_TOOL_MARKER, TEST_TOOL_NAME } from '@openharness/server'
import { describe, expect, it } from 'vitest'

import {
  agentMessages,
  clientFor,
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
  waitForModelRequestStart,
  waitForTurnEnd,
  withDatabaseClient,
  type SignedIn,
} from './harness'

/**
 * A rolling restart of a real deployment, while turns are streaming (#378, P1/P3).
 *
 * Three servers run against one database with the partition scheduler. Sessions stream replies
 * long enough to be in flight for the whole restart (ten seconds each, and every handoff makes
 * the next owner start its request again). Then, one original at a time — the order a
 * `maxSurge: 1, maxUnavailable: 0` rollout uses — a fresh replacement process is **started
 * while the turns are still streaming**; it boots, migrates and joins the membership, and once
 * it holds partitions the original it replaces is `SIGTERM`ed. The old process hands its turns
 * **off**; the partitions' next owners close the inherited spans as `brain_lost` and re-issue
 * the requests.
 *
 * The replacement booting mid-turn is deliberate: a pod boots on every rollout, scale-up and
 * crash restart, and it must be harmless to the servers still appending. Before the migration
 * ledger (#378, PR 3/6) this test had to start the surge replicas before the turns, because a
 * boot re-ran every idempotent migration and its DDL (`create index if not exists` on `events`,
 * `alter table … add column if not exists` on `sessions`) deadlocked with a live
 * `insert into events`; Postgres aborted either the boot or the turn. With the ledger a boot
 * with nothing to apply takes no lock on any application table, which is what lets this test
 * run the rollout in the order Kubernetes does.
 *
 * What this asserts is the product goal: every turn ends with a complete final reply and an
 * idle session, no span ended `interrupted`, no session ever had two brains' requests open at
 * once, and the user never had to send anything after the first message. On the base branch
 * (`deploys/p0-scheduler`) a shutdown aborts the turn the way a user's Stop does, so the reply
 * is cut off, the span ends `interrupted` and the session goes idle with no more work: this
 * file fails there on the first of those assertions.
 */

const harness = e2eHarness('rolling-restart')

/** How many of the two kinds of session the restart runs turns for. */
const SLOW_SESSIONS = 8
const TOOL_SESSIONS = 4

/**
 * The scheduler's timings: a lease well inside the test, a heartbeat well inside the lease.
 *
 * The TTL has to outlast the surplus release's drain (OPENHARNESS_DRAIN_TIMEOUT_MS, 5 s):
 * a replacement joining mid-turn makes the originals give surplus partitions up, and that
 * release lets the turns there finish for up to the drain timeout inside one heartbeat cycle.
 * A TTL shorter than the drain would expire the leases this instance is still nursing, a peer
 * would take them, and the release would fence its own in-flight appends — a test-only shape,
 * because a deployment's lease is 30 s.
 */
const PARTITION_ENV = {
  SCHEDULER: 'postgres',
  OPENHARNESS_LEASE_TTL_MS: '15000',
  OPENHARNESS_HEARTBEAT_MS: '300',
  // The sweep is a safety net, not a way to find work: with it out of the way, a turn that is
  // finished after a handoff can only have been found by the acquire scan.
  OPENHARNESS_SWEEP_MS: '600000',
}

/** How long a wait for something that needs a restart's worth of time may take. */
const RESTART_WAIT_MS = 30_000

/** How long the turns may take, with a handoff or two: each re-runs a ten-second reply. */
const TURN_WAIT_MS = 90_000

/** One server in the rollout. */
interface Instance {
  readonly id: string
  readonly server: Awaited<ReturnType<typeof harness.server>>
}

/** Start one real server with a unique instance id. */
async function startInstance(id: string): Promise<Instance> {
  return {
    id,
    server: await harness.server({
      env: { ...PARTITION_ENV, OPENHARNESS_INSTANCE_ID: id },
    }),
  }
}

/** How many partitions an instance holds, read from the lease table. */
async function heldPartitions(id: string): Promise<number> {
  const database = await harness.database()
  return await withDatabaseClient(
    async (client) => {
      const result = await client.query<{ held: string }>(
        'select count(*) as held from partition_leases where owner = $1',
        [id],
      )
      return Number(result.rows[0]?.held ?? '0')
    },
    { database: database.name },
  )
}

/** Which instance owns each session's partition, right now. */
async function ownersOf(sessions: readonly Session[]): Promise<Map<string, number>> {
  const database = await harness.database()
  const counts = new Map<string, number>()
  await withDatabaseClient(
    async (client) => {
      for (const session of sessions) {
        const partition = partitionOf(session.id, DEFAULT_PARTITION_COUNT)
        const result = await client.query<{ owner: string | null }>(
          'select owner from partition_leases where partition = $1',
          [partition],
        )
        const owner = result.rows[0]?.owner
        if (typeof owner === 'string' && owner.length > 0) {
          counts.set(owner, (counts.get(owner) ?? 0) + 1)
        }
      }
    },
    { database: database.name },
  )
  return counts
}

/** Wait until every partition of the space has an owner. */
async function waitForTheWholeSpace(): Promise<void> {
  const database = await harness.database()
  await waitFor(
    'every partition to have an owner',
    async () => {
      const owned = await withDatabaseClient(
        async (client) => {
          const result = await client.query<{ owned: string }>(
            'select count(*) as owned from partition_leases where owner is not null',
          )
          return Number(result.rows[0]?.owned ?? '0')
        },
        { database: database.name },
      )
      return owned === DEFAULT_PARTITION_COUNT ? true : undefined
    },
    { timeoutMs: RESTART_WAIT_MS },
  )
}

/** One span at a time, and every span closed: what "no two brains wrote at once" means. */
function expectSequentialSpans(log: readonly StoredEvent[], label: string): void {
  // The compaction engine's requests are their own spans and are not part of the turn's
  // sequence; this test's histories are far too small to have one, but the reader should not
  // depend on that.
  const summaryStarts = new Set(
    log.flatMap((event) =>
      event.type === EVENT_TYPES.modelRequestStart && event.purpose === 'summary' ? [event.id] : [],
    ),
  )
  let open: EventId | null = null
  for (const event of log) {
    if (event.type === EVENT_TYPES.modelRequestStart) {
      if (summaryStarts.has(event.id)) {
        continue
      }
      expect(
        open,
        `${label}: a chat request opened while ${String(open)} was still open`,
      ).toBeNull()
      open = event.id
    } else if (event.type === EVENT_TYPES.modelRequestEnd) {
      if (summaryStarts.has(event.model_request_start_id)) {
        continue
      }
      expect(event.model_request_start_id, `${label}: a span end with no open start`).toBe(open)
      open = null
    }
  }
  expect(open, `${label}: a request was left open`).toBeNull()
}

/** The one reply a `__slow__` session ends with, and the final answer a tool session does. */
function expectCompleteReplies(log: readonly StoredEvent[], label: string): void {
  const messages = agentMessages(log)
  expect(messages.length, `${label}: no reply at all`).toBeGreaterThan(0)
  const last = messages[messages.length - 1]
  expect(last, `${label}: no final reply`).toBeDefined()
  const text = textOf(last as (typeof messages)[number])
  expect(text.length, `${label}: the final reply is empty`).toBeGreaterThan(0)
  // A partial reply is never stored by the handoff path, so a `__slow__` turn's only message
  // is the whole ten-second reply. A tool turn's last message answers what the tool said —
  // the echo, or (if the deploy cut the call off) the crash rule's `execution lost`.
  if (label.includes('slow-tool')) {
    expect(text).toMatch(/^the tool said: /u)
    expect(
      log.some((event) => event.type === EVENT_TYPES.agentToolUse && event.name === TEST_TOOL_NAME),
      `${label}: the tool was never called`,
    ).toBe(true)
    expect(
      log.some((event) => event.type === EVENT_TYPES.agentToolResult),
      `${label}: the tool call was never answered`,
    ).toBe(true)
  } else {
    expect(text).toBe(expectedSlowReply())
  }
}

describe('a rolling restart while turns are streaming', () => {
  it('hands every turn off: complete replies, no interrupt, no two brains at once', async () => {
    // The deployment before the rollout. Nothing else is running: the replacements are started
    // later, one at a time, while the turns below are streaming. The first boots are serial
    // because the dev-login seed is a check-then-insert Better Auth runs on boot, and three
    // *first* boots against an empty database would race it — a test-harness property (the dev
    // login is off in a deployment) and not what this test is about.
    const originals: Instance[] = []
    for (const id of ['roll-a', 'roll-b', 'roll-c']) {
      originals.push(await startInstance(id))
    }
    await waitForTheWholeSpace()

    const first = originals[0]
    if (first === undefined) {
      throw new Error('the deployment had no server to create the sessions on')
    }
    const signedIn: SignedIn = await harness.user(first.server)
    const client = clientFor(first.server, signedIn)
    const agent = await client.agents.create({
      name: 'Rolling restart agent',
      model: { id: 'anthropic/claude-sonnet-5' },
    })

    // The sessions, and the seq of the one user message each will ever be sent.
    const sessions: { session: Session; afterSeq: number; label: string }[] = []
    for (let index = 0; index < SLOW_SESSIONS + TOOL_SESSIONS; index += 1) {
      const session = await client.sessions.create({ agent: agent.id })
      const slowTool = index >= SLOW_SESSIONS
      const label = slowTool ? `slow-tool ${index}` : `slow ${index}`
      const prompt = slowTool
        ? `${MOCK_SLOW_TOOL_MARKER} tool input ${index}`
        : `${MOCK_SLOW_MARKER} outlive a rolling restart ${index}`
      const message = await client.sendMessage(session.id, prompt)
      sessions.push({ session, afterSeq: message.seq, label })
    }

    // Every turn is really in flight before the rollout starts: a request opened after the
    // message the test sent, and the reply is streaming. (The span start is the brain's
    // record that the request was opened; the delta is what a client sees first.)
    await Promise.all(
      sessions.map(async ({ session, afterSeq }) => {
        await waitForModelRequestStart(client, session.id, {
          afterSeq,
          timeoutMs: RESTART_WAIT_MS,
        })
        const watcher = collectStream(client, session.id, { deltas: true, afterSeq })
        try {
          await watcher.waitFor(
            (events) => events.some(isPreviewDelta),
            'a preview delta before the restart',
            { timeoutMs: RESTART_WAIT_MS },
          )
        } finally {
          await watcher.stop()
        }
      }),
    )

    // The rollout, in the order Kubernetes uses (`maxSurge: 1`, `maxUnavailable: 0`): start
    // one replacement, wait until it holds partitions, and only then take out the original it
    // replaces. Each replacement boots while the turns are still streaming — the property the
    // migration ledger is for. The first original to go is the one running most of the test's
    // turns, so the handoff path is certainly exercised.
    const counts = await ownersOf(sessions.map((entry) => entry.session))
    const order = [...originals].sort(
      (left, right) => (counts.get(right.id) ?? 0) - (counts.get(left.id) ?? 0),
    )
    const busiest = order[0]
    if (busiest === undefined) {
      throw new Error('the rollout had no servers to stop')
    }
    expect(counts.get(busiest.id) ?? 0, 'no in-flight turn ran on an original').toBeGreaterThan(0)
    const replacements: Instance[] = []
    for (const [index, old] of order.entries()) {
      // This boot runs the migrations, while the turns above are streaming.
      const replacement = await startInstance(`roll-replacement-${index}`)
      replacements.push(replacement)
      await waitFor(
        'the replacement to hold partitions',
        async () => ((await heldPartitions(replacement.id)) > 0 ? true : undefined),
        { timeoutMs: RESTART_WAIT_MS },
      )
      await old.server.kill('SIGTERM')
    }
    const last = replacements[replacements.length - 1]
    if (last === undefined) {
      throw new Error('the rollout had no replacement to end on')
    }

    // Every turn ends on the surviving instances, from the log's own record.
    const finalClient: Client = clientFor(last.server, signedIn)
    await Promise.all(
      sessions.map(async ({ session, afterSeq }) =>
        waitForTurnEnd(finalClient, session.id, { afterSeq, timeoutMs: TURN_WAIT_MS }),
      ),
    )

    let handoffs = 0
    for (const { session, label } of sessions) {
      const log = await readLog(finalClient, session.id)

      // The user sent exactly one message and never anything else — no resend, no nudge.
      expect(
        log.filter((event) => event.type.startsWith('user.')).map((event) => event.type),
        `${label}: the user sent something after the first message`,
      ).toEqual([EVENT_TYPES.userMessage])

      expect(hasOpenTurn(log), `${label}: the turn never ended`).toBe(false)
      expect(typesOf(log).at(-1), `${label}: the turn did not end idle`).toBe(
        EVENT_TYPES.sessionStatusIdle,
      )
      // A deploy is not an interruption and not a turn error.
      expect(
        modelRequestEnds(log).map((event) => event.error?.type ?? null),
        `${label}: a span ended interrupted`,
      ).not.toContain('interrupted')
      const sessionErrors = log.filter((event) => event.type === EVENT_TYPES.sessionError)
      expect(
        sessionErrors.length,
        `${label}: the turn ended with a session error: ${JSON.stringify(sessionErrors)}`,
      ).toBe(0)

      expectSequentialSpans(log, label)
      expectCompleteReplies(log, label)
      handoffs += modelRequestEnds(log).filter((event) => event.error?.type === 'brain_lost').length
    }

    // The path this file exists for ran: at least one server handed a request off and another
    // one closed it as `brain_lost`.
    expect(handoffs, 'no request was handed off during the rollout').toBeGreaterThan(0)

    // A graceful release is not a race with the lease: no pass was ever refused a write.
    for (const instance of [...originals, ...replacements]) {
      expect(instance.server.output(), `${instance.id} logged a fenced write`).not.toContain(
        'FencedError',
      )
    }
  }, 180_000)
})
