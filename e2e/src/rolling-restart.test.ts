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
  sleep,
  textOf,
  typesOf,
  waitFor,
  waitForModelRequestStart,
  waitForTurnEnd,
  withDatabaseClient,
  type SignedIn,
} from './harness'

/**
 * A rolling restart of a real deployment, while turns are streaming (#378, P1/P2/P4).
 *
 * Three servers run against one database with the partition scheduler. Sessions stream replies
 * long enough to be in flight for the whole restart (ten seconds each). Then, one original at
 * a time — the order a `maxSurge: 1, maxUnavailable: 0` rollout uses — a fresh replacement
 * process is **started while the turns are still streaming**; it boots, migrates and joins the
 * membership, and once it holds partitions the original it replaces is `SIGTERM`ed.
 *
 * What P3 (#378) changes is how many times a partition moves. A rolling update is a join (the
 * surge pod, which shrinks every share) followed a moment later by a leave (the pod it
 * replaces, which grows the share back). The scheduler waits for the membership to be stable
 * before an instance gives up surplus, so the join moves nothing; each partition moves once,
 * when its original owner terminates, and at most two of them move twice (a surviving original
 * had a free slot for one, and is replaced later). The audit below counts those moves off
 * `partition_leases`.
 *
 * What changed with P2 (#378, P4) is what "handed off" means. A shutdown now **drains** first:
 * every turn in flight finishes its model request or tool step — storing the reply and the
 * tool results — and only a step that outlives `OPENHARNESS_DRAIN_TIMEOUT_MS` is hard-handed
 * off. The replacement booting mid-turn is deliberate: a pod boots on every rollout, scale-up
 * and crash restart, and it must be harmless to the servers still appending. Before the
 * migration ledger (#378, PR 3/6) this test had to start the surge replicas before the turns,
 * because a boot re-ran every idempotent migration and its DDL deadlocked with a live
 * `insert into events`; the ledger is what lets this run the rollout in the order Kubernetes
 * does.
 *
 * Two scenarios, because the drain has two outcomes:
 *
 * 1. **Steps shorter than the drain** — the normal case, and the goal of the issue. No model
 *    request is cut off: the request in flight finishes and is not re-issued, so no span ends
 *    `brain_lost` and every turn's requests each ran exactly once. The lease TTL is kept at
 *    three seconds — shorter than the twenty-second drain — because the release of a surplus
 *    partition must no longer delay renewal of the leases the instance keeps (they used to be
 *    one heartbeat cycle, which is the constraint P2 removes).
 * 2. **A turn longer than the drain** — the safety net. The drain deadline passes, the turn is
 *    handed off with its `TurnHandoff('shutdown')` reason, and the replacement closes the open
 *    span as `brain_lost` and re-issues the request. The user still sees one complete reply.
 *
 * Every assertion is read off the log: the user sent exactly one message, the turn ended idle,
 * no span ended `interrupted`, no session error was written, and requests never overlapped.
 */

const harness = e2eHarness('rolling-restart')

/** How many of the two kinds of session the first rollout runs turns for. */
const SLOW_SESSIONS = 8
const TOOL_SESSIONS = 4

/**
 * The scheduler's timings.
 *
 * The TTL is deliberately **shorter than the drain timeout**: a surplus partition is released
 * in the background now, and the leases this instance keeps are renewed on every heartbeat
 * while that happens. Before P2 the release drained inside the heartbeat cycle, so a TTL
 * below the drain timed the instance out mid-release and its own appends were fenced. If that
 * regresses, this rollout fails with `FencedError` (and usually a second `brain_lost`).
 */
const PARTITION_ENV = {
  SCHEDULER: 'postgres',
  OPENHARNESS_LEASE_TTL_MS: '3000',
  OPENHARNESS_HEARTBEAT_MS: '300',
  // The sweep is a safety net, not a way to find work: with it out of the way, a turn that is
  // finished after a handoff can only have been found by the acquire scan.
  OPENHARNESS_SWEEP_MS: '600000',
  // A rolling update is a join followed a moment later by a leave (#378, P3). Ten heartbeats
  // of stability are far more than the gap between the surrogate pod joining and the original
  // it replaces receiving SIGTERM below, so no member gives up surplus for the join.
  OPENHARNESS_BALANCE_STABILITY_MS: '3000',
}

/** Longer than a slow reply (about ten seconds) plus its follow-up: the step finishes. */
const GRACEFUL_DRAIN_MS = '20000'

/** Shorter than a slow reply: the deadline passes and the turn is hard-handed off. */
const HARD_HANDOFF_DRAIN_MS = '2000'

/** How long a wait for something that needs a restart's worth of time may take. */
const RESTART_WAIT_MS = 30_000

/** How long the turns may take, with a handoff or two: each re-runs a ten-second reply. */
const TURN_WAIT_MS = 90_000

/** One server in the rollout. */
interface Instance {
  readonly id: string
  readonly server: Awaited<ReturnType<typeof harness.server>>
}

/** Start one real server with a unique instance id and the rollout's environment. */
async function startInstance(id: string, env: Record<string, string>): Promise<Instance> {
  return {
    id,
    server: await harness.server({
      env: { ...PARTITION_ENV, ...env, OPENHARNESS_INSTANCE_ID: id },
    }),
  }
}

/** Whether an instance has joined the live membership — the rollout's readiness signal. */
async function isLiveMember(id: string): Promise<boolean> {
  const database = await harness.database()
  return await withDatabaseClient(
    async (client) => {
      const result = await client.query(
        'select 1 from scheduler_instances where instance_id = $1',
        [id],
      )
      return result.rowCount === 1
    },
    { database: database.name },
  )
}

/**
 * Make "how many times did a partition move" a read.
 *
 * A move is an acquisition by a **different owner than the tenure before it**: the lease row's
 * owner changing from one instance to another, or from free to owned. A renewal (owner
 * unchanged) and a release (owner becomes `null`) are not moves. `partition_leases` keeps only
 * the current tenure, so the test installs this audit for the rollout and reads it afterwards;
 * the server has no such table, and nothing in it reads one.
 */
async function countMovesFromNow(): Promise<void> {
  const database = await harness.database()
  await withDatabaseClient(
    async (client) => {
      await client.query(
        `create table if not exists partition_moves (
           partition integer not null,
           owner text not null,
           epoch integer not null,
           moved_at timestamptz not null default clock_timestamp()
         )`,
      )
      await client.query('truncate partition_moves')
      await client.query(
        `create or replace function record_partition_move() returns trigger language plpgsql as $$
         begin
           if new.owner is not null and new.owner is distinct from old.owner then
             insert into partition_moves (partition, owner, epoch)
             values (new.partition, new.owner, new.epoch);
           end if;
           return new;
         end
         $$`,
      )
      await client.query('drop trigger if exists partition_moves_after_update on partition_leases')
      await client.query(
        `create trigger partition_moves_after_update after update on partition_leases
         for each row execute function record_partition_move()`,
      )
    },
    { database: database.name },
  )
}

/** The moves recorded since {@link countMovesFromNow}, per partition. */
async function movesPerPartition(): Promise<Map<number, number>> {
  const database = await harness.database()
  const moves = new Map<number, number>()
  await withDatabaseClient(
    async (client) => {
      const result = await client.query<{ partition: number; moves: string }>(
        'select partition, count(*) as moves from partition_moves group by partition',
      )
      for (const row of result.rows) {
        moves.set(row.partition, Number(row.moves))
      }
    },
    { database: database.name },
  )
  return moves
}

/** The per-partition counts as `3×2, 5×1`, for an assertion message. */
function describeMoves(moves: ReadonlyMap<number, number>): string {
  return [...moves.entries()]
    .sort(([left], [right]) => left - right)
    .map(([partition, count]) => `${partition}×${count}`)
    .join(', ')
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

/**
 * Wait until the named instances own the whole space at their fair shares, and it has stopped
 * changing hands.
 *
 * Coverage alone is not enough, and neither is a count at the share. The instances boot one at
 * a time here (the first claims the whole space, the second makes it rebalance, the third makes
 * it rebalance again), and a surplus release runs in the background after the membership has
 * been stable for `OPENHARNESS_BALANCE_STABILITY_MS`. Starting the rollout while that is still
 * happening would count the boot's own moves as the rollout's. So this waits for the shares,
 * then for a whole heartbeat in which no partition's owner or epoch moved.
 */
async function waitForSettledSpace(ids: readonly string[]): Promise<void> {
  const share = Math.ceil(DEFAULT_PARTITION_COUNT / ids.length)
  const database = await harness.database()
  await waitFor(
    'the instances to settle at their fair shares',
    async () => {
      const counts = await withDatabaseClient(
        async (client) => {
          const result = await client.query<{ owner: string; held: string }>(
            'select owner, count(*) as held from partition_leases where owner = any($1) group by owner',
            [ids],
          )
          return new Map(result.rows.map((row) => [row.owner, Number(row.held)]))
        },
        { database: database.name },
      )
      const owned = [...counts.values()].reduce((total, count) => total + count, 0)
      const fair = ids.every((id) => (counts.get(id) ?? 0) <= share)
      return owned === DEFAULT_PARTITION_COUNT && fair ? true : undefined
    },
    { timeoutMs: RESTART_WAIT_MS },
  )
  const snapshot = async (): Promise<string> =>
    await withDatabaseClient(
      async (client) => {
        const result = await client.query<{
          partition: number
          owner: string | null
          epoch: number
        }>('select partition, owner, epoch from partition_leases order by partition')
        return result.rows
          .map((row) => `${row.partition}:${row.owner ?? '-'}:${row.epoch}`)
          .join(',')
      },
      { database: database.name },
    )
  let previous = await snapshot()
  await waitFor(
    'the partition space to stop changing hands',
    async () => {
      // Longer than the 300 ms heartbeat: a release in flight, or a scan about to run, would
      // show up as an owner or epoch change inside this window.
      await sleep(500)
      const current = await snapshot()
      const stable = current === previous
      previous = current
      return stable ? true : undefined
    },
    { timeoutMs: RESTART_WAIT_MS },
  )
}

/**
 * Run the rollout in Kubernetes' order: one replacement, wait for it to be ready and part of
 * the membership, then take out the original it replaces.
 *
 * Readiness is the membership row, not "it holds partitions". A pod is Ready (and Kubernetes
 * replaces the old one) once it can serve and has joined; it may legitimately hold no
 * partition yet, because since P3 a newcomer does not take a share from a live member — the
 * pod being replaced is the one that releases its own. Waiting for partitions would deadlock
 * the rollout: nobody releases until somebody leaves.
 */
async function replaceOneByOne(
  order: readonly Instance[],
  env: Record<string, string>,
  prefix: string,
): Promise<Instance[]> {
  const replacements: Instance[] = []
  for (const [index, old] of order.entries()) {
    // This boot runs the migrations, while the turns above are streaming.
    const replacement = await startInstance(`${prefix}-replacement-${index}`, env)
    replacements.push(replacement)
    await waitFor(
      'the replacement to join the membership',
      async () => ((await isLiveMember(replacement.id)) ? true : undefined),
      { timeoutMs: RESTART_WAIT_MS },
    )
    await old.server.kill('SIGTERM')
  }
  return replacements
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

/** The chat model requests a log holds, in order — summary requests are not the turn's. */
function chatRequestStarts(log: readonly StoredEvent[]): StoredEvent[] {
  return log.filter(
    (event) => event.type === EVENT_TYPES.modelRequestStart && event.purpose !== 'summary',
  )
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

/** The assertions every rollout makes about a session's log. */
function expectFinishedTurn(log: readonly StoredEvent[], label: string): void {
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
}

describe('a rolling restart while turns are streaming', () => {
  it('finishes every step inside the drain: no request is cut off or re-run', async () => {
    const env = { OPENHARNESS_DRAIN_TIMEOUT_MS: GRACEFUL_DRAIN_MS }
    // The deployment before the rollout. Nothing else is running: the replacements are started
    // later, one at a time, while the turns below are streaming. The first boots are serial
    // because the dev-login seed is a check-then-insert Better Auth runs on boot, and three
    // *first* boots against an empty database would race it — a test-harness property (the dev
    // login is off in a deployment) and not what this test is about.
    const originals: Instance[] = []
    for (const id of ['graceful-a', 'graceful-b', 'graceful-c']) {
      originals.push(await startInstance(id, env))
    }
    await waitForSettledSpace(originals.map((instance) => instance.id))

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
    // replaces. The first original to go is the one running most of the test's turns, so the
    // drain path is certainly exercised.
    const counts = await ownersOf(sessions.map((entry) => entry.session))
    const order = [...originals].sort(
      (left, right) => (counts.get(right.id) ?? 0) - (counts.get(left.id) ?? 0),
    )
    const busiest = order[0]
    if (busiest === undefined) {
      throw new Error('the rollout had no servers to stop')
    }
    expect(counts.get(busiest.id) ?? 0, 'no in-flight turn ran on an original').toBeGreaterThan(0)

    // From here on, every acquisition that changes a partition's owner is recorded. The
    // originals have already settled into their shares, so this counts the rollout's moves and
    // nothing else.
    await countMovesFromNow()
    const replacements = await replaceOneByOne(order, env, 'graceful')
    const last = replacements[replacements.length - 1]
    if (last === undefined) {
      throw new Error('the rollout had no replacement to end on')
    }
    // The last original's released partitions are taken over as the replacements' scans
    // reach them, which can be after the turns the test waits on have finished. Give the new
    // membership the same fair-share-and-quiet check the originals got, so the move count is
    // the whole rollout's and not a snapshot in the middle of its last handover.
    await waitForSettledSpace(replacements.map((instance) => instance.id))

    // Every turn ends on the surviving instances, from the log's own record.
    const finalClient: Client = clientFor(last.server, signedIn)
    await Promise.all(
      sessions.map(async ({ session, afterSeq }) =>
        waitForTurnEnd(finalClient, session.id, { afterSeq, timeoutMs: TURN_WAIT_MS }),
      ),
    )

    let requests = 0
    let reRuns = 0
    for (const { session, label } of sessions) {
      const log = await readLog(finalClient, session.id)

      expectFinishedTurn(log, label)
      expectSequentialSpans(log, label)
      expectCompleteReplies(log, label)

      // The step in flight was shorter than the drain, so it finished where it started: each
      // of the turn's requests ran exactly once. A slow turn has one; a slow-tool turn has the
      // slow request and the follow-up that answers the tool. A `brain_lost` span end is
      // exactly a re-run — the old owner's request was abandoned and issued again.
      const starts = chatRequestStarts(log)
      const expected = label.includes('slow-tool') ? 2 : 1
      expect(starts.length, `${label}: a model request was re-issued`).toBe(expected)
      expect(
        modelRequestEnds(log).filter((event) => event.error?.type === 'brain_lost'),
        `${label}: a request was cut off instead of finishing inside the drain`,
      ).toEqual([])
      requests += starts.length
      reRuns += modelRequestEnds(log).filter((event) => event.error?.type === 'brain_lost').length
    }

    // The counts this scenario exists to report.
    expect(requests).toBe(SLOW_SESSIONS * 1 + TOOL_SESSIONS * 2)
    expect(reRuns, 'a request was re-run during a drain that should have been invisible').toBe(0)

    // How far the partitioning moved while the versions changed (#378, P3). On the P2 base
    // every join made the old members give up surplus that the leave a moment later gave back,
    // so a partition moved as many as three times (92-94 moves over the rollout). Waiting for
    // membership stability means the join moves nothing: each partition moves once, when its
    // original owner is terminated, and a replacement takes it.
    //
    // The residual bound is two, and the second move is capacity, not churn: when the first
    // original leaves, a *surviving* original that is one partition under its share can take
    // one of the released partitions. That survivor is itself replaced later, so that one
    // partition moves again. At 64 partitions and three members the slack is 44 − (64 − 22) = 2,
    // so at most two partitions can do this. (Preferring the newcomer for released leases would
    // remove it, but every way to do that either delays crash/scale-down takeover or needs a
    // lease-transfer API; it is a follow-up, not worth that risk for two partitions.)
    const moves = await movesPerPartition()
    const moved = [...moves.values()]
    const mostMoved = Math.max(0, ...moved)
    const totalMoved = moved.reduce((total, count) => total + count, 0)
    const slack = order.length - 1
    expect(
      mostMoved,
      `a partition moved more than once during the rollout: ${describeMoves(moves)}`,
    ).toBeLessThanOrEqual(slack)
    expect(
      totalMoved,
      `partition moves during the rollout: ${describeMoves(moves)}`,
    ).toBeGreaterThanOrEqual(DEFAULT_PARTITION_COUNT)
    expect(
      totalMoved,
      `partition moves during the rollout: ${describeMoves(moves)}`,
    ).toBeLessThanOrEqual(DEFAULT_PARTITION_COUNT + slack)

    // A graceful release is not a race with the lease: no pass was ever refused a write —
    // including while a surplus partition was draining across several three-second TTLs.
    for (const instance of [...originals, ...replacements]) {
      expect(instance.server.output(), `${instance.id} logged a fenced write`).not.toContain(
        'FencedError',
      )
    }

    // Leave the partition space to the next scenario.
    await Promise.all(replacements.map(async (instance) => instance.server.kill('SIGTERM')))
  }, 300_000)

  it('hard-hands-off a turn longer than the drain, and the replacement finishes it', async () => {
    const env = { OPENHARNESS_DRAIN_TIMEOUT_MS: HARD_HANDOFF_DRAIN_MS }
    const originals: Instance[] = []
    for (const id of ['hard-a', 'hard-b']) {
      originals.push(await startInstance(id, env))
    }
    await waitForSettledSpace(originals.map((instance) => instance.id))

    const first = originals[0]
    if (first === undefined) {
      throw new Error('the deployment had no server to create the session on')
    }
    const signedIn: SignedIn = await harness.user(first.server)
    const client = clientFor(first.server, signedIn)
    const agent = await client.agents.create({
      name: 'Long turn agent',
      model: { id: 'anthropic/claude-sonnet-5' },
    })
    const session = await client.sessions.create({ agent: agent.id })
    const message = await client.sendMessage(
      session.id,
      `${MOCK_SLOW_MARKER} outlive a drain that is too short`,
    )

    await waitForModelRequestStart(client, session.id, {
      afterSeq: message.seq,
      timeoutMs: RESTART_WAIT_MS,
    })
    const watcher = collectStream(client, session.id, { deltas: true, afterSeq: message.seq })
    try {
      await watcher.waitFor(
        (events) => events.some(isPreviewDelta),
        'the slow reply to start before the restart',
        { timeoutMs: RESTART_WAIT_MS },
      )
    } finally {
      await watcher.stop()
    }

    // Kill the instance that owns the session, so the handoff is its shutdown's. The
    // replacement is already up (a real rollout), and the two-second drain expires long before
    // the ten-second reply finishes. The *other* original is left alone: a second handoff of
    // the re-issued request would make the count below meaningless.
    const counts = await ownersOf([session])
    const ownerId = [...counts.keys()][0]
    const owner = originals.find((instance) => instance.id === ownerId)
    if (owner === undefined) {
      throw new Error(`the session's owner ${String(ownerId)} was not an original`)
    }
    const replacement = await startInstance('hard-replacement-0', env)
    await waitFor(
      'the replacement to join the membership',
      async () => ((await isLiveMember(replacement.id)) ? true : undefined),
      { timeoutMs: RESTART_WAIT_MS },
    )
    await owner.server.kill('SIGTERM')
    const replacements = [replacement]

    const finalClient: Client = clientFor(replacement.server, signedIn)
    await waitForTurnEnd(finalClient, session.id, {
      afterSeq: message.seq,
      timeoutMs: TURN_WAIT_MS,
    })
    const log = await readLog(finalClient, session.id)

    expectFinishedTurn(log, 'hard handoff')
    expectSequentialSpans(log, 'hard handoff')
    expectCompleteReplies(log, 'hard handoff')

    // The drain deadline passed, so the old process aborted the request and the next owner
    // closed its span as `brain_lost` and issued it again. That re-run is the safety net, and
    // it is exactly one: the replacement's own request completed inside its turn.
    const brainLost = modelRequestEnds(log).filter((event) => event.error?.type === 'brain_lost')
    expect(brainLost, 'the long turn was not hard-handed off').toHaveLength(1)
    expect(chatRequestStarts(log), 'the re-issued request did not run').toHaveLength(2)

    for (const instance of [...originals, ...replacements]) {
      expect(instance.server.output(), `${instance.id} logged a fenced write`).not.toContain(
        'FencedError',
      )
    }

    await Promise.all(replacements.map(async (instance) => instance.server.kill('SIGTERM')))
  }, 300_000)
})
