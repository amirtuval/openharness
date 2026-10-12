import { MOCK_TASK_MARKER, MOCK_WAIT_MARKER, TEST_TASK_TOOL_NAME } from '@openharness/server'
import { EVENT_TYPES, TASK_WAIT_TOOL_NAME } from '@openharness/protocol'
import type {
  AgentMessageEvent,
  AgentToolResultEvent,
  ModelRequestStartEvent,
  SessionStatusIdleEvent,
  SessionTaskNotificationEvent,
  StoredEvent,
} from '@openharness/protocol'
import type { Client } from '@openharness/client'
import { describe, expect, it } from 'vitest'

import { e2eHarness, readLog, waitFor, waitForTurnEnd } from './harness'

/**
 * Background tasks through the real server, end to end (epic #340, S4/S5; issue #343).
 *
 * The whole path a deployment runs: the model starts a task (the mock model's `__task__` marker
 * calls the test background tool), the handle comes back at once and the conversation goes on,
 * and the process that owns the store records the start — and then the news, which the parent's
 * brain picks up and answers, through the scheduler, the log and the client. The wait is the
 * second half: a model that asked to wait ends the turn idle holding nothing, and the process's
 * own timer resumes it when the deadline passes, or a task's news does.
 *
 * Everything here is the built server, a real Postgres and `@openharness/client`. The hooks are
 * only active under `OPENHARNESS_TEST_MODEL=mock`, which the harness always sets.
 */

const harness = e2eHarness('tasks')

/** The stored events of one type, in order, narrowed to that kind. */
function of<T extends StoredEvent['type']>(
  log: readonly StoredEvent[],
  type: T,
): Extract<StoredEvent, { type: T }>[] {
  return log.filter((event): event is Extract<StoredEvent, { type: T }> => event.type === type)
}

/** The text a result carried, joined. */
function resultText(result: AgentToolResultEvent | undefined): string {
  return result === undefined ? '' : result.content.map((block) => block.text).join('')
}

/** The text of a reply. */
function messageText(event: AgentMessageEvent): string {
  return event.content.map((block) => block.text).join('')
}

/** Every reply of a log, joined — for the assertions that read what the model was told. */
function repliesOf(log: readonly StoredEvent[]): string {
  return of(log, EVENT_TYPES.agentMessage).map(messageText).join('\n')
}

/** The last `session.status_idle` of a log. */
function idleOf(log: readonly StoredEvent[]): SessionStatusIdleEvent | undefined {
  return of(log, EVENT_TYPES.sessionStatusIdle).at(-1)
}

/**
 * The task the test background tool started, as its own two facts: the id the handle named and
 * the call the handle answered.
 *
 * Read by the *call*, not by position: a task's news can arrive while a test is still looking,
 * and a result at the end of the log is not necessarily the handle.
 */
function taskOf(log: readonly StoredEvent[]): {
  readonly taskId: string
  readonly callId: string
  readonly handle: AgentToolResultEvent | undefined
} {
  const call = of(log, EVENT_TYPES.agentToolUse).find((event) => event.name === TEST_TASK_TOOL_NAME)
  if (call === undefined) {
    throw new Error('the log holds no call to the test background tool')
  }
  const handle = of(log, EVENT_TYPES.agentToolResult).find((event) => event.tool_use_id === call.id)
  if (handle === undefined) {
    throw new Error('the call to the test background tool was never answered')
  }
  return {
    taskId: (JSON.parse(resultText(handle)) as { task_id: string }).task_id,
    callId: call.id,
    handle,
  }
}

/** The notifications of one task, in order. */
function notificationsOf(
  log: readonly StoredEvent[],
  taskId: string,
): SessionTaskNotificationEvent[] {
  return of(log, EVENT_TYPES.sessionTaskNotification).filter((event) => event.task_id === taskId)
}

describe('a background task through the real server', () => {
  it('returns a handle at once, and reports back when it is done', async () => {
    const server = await harness.server()
    const client: Client = await harness.client(server)
    const session = await client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })

    // A task that works for a while: long enough that the turn which started it is over, and
    // the log can be read, before it reports. The delay is the marker's argument.
    const sent = await client.sendMessage(session.id, `${MOCK_TASK_MARKER} 2000`)
    await waitForTurnEnd(client, session.id, { afterSeq: sent.seq })

    let log = await readLog(client, session.id)
    const { taskId, callId, handle } = taskOf(log)
    expect(handle).toMatchObject({ tool_use_id: callId, is_error: false })
    // The task is in the parent's log because it *started*, not because it finished: the start
    // and the `running` status are written when the call lands, and the conversation has already
    // gone on past both — that is what makes it a background task (S4).
    expect(of(log, EVENT_TYPES.sessionTaskStarted).map((event) => event.task_id)).toEqual([taskId])
    expect(of(log, EVENT_TYPES.sessionTaskStatus).map((event) => event.status)).toEqual(['running'])
    expect(notificationsOf(log, taskId)).toEqual([])

    // Then it reports: its status moves, and the news reaches the parent model on its own — a
    // turn nobody asked for, which is the whole point of the mechanism.
    const delivered = await waitFor(
      `session ${session.id} to be told what its task produced`,
      async () => notificationsOf(await readLog(client, session.id), taskId)[0],
      { timeoutMs: 20_000 },
    )
    await waitFor(
      `the parent of session ${session.id} to answer the news`,
      // `find`, not `some`: a `waitFor` resolves on anything that is not `undefined`, so a
      // boolean check that is `false` would be read as "it is there already".
      async () =>
        (await readLog(client, session.id)).find(
          (event) => event.type === EVENT_TYPES.agentMessage && event.seq > delivered.seq,
        ),
      { timeoutMs: 20_000 },
    )

    log = await readLog(client, session.id)
    // Exactly once — one notification, claimed by the request that folded it in.
    expect(notificationsOf(log, taskId).length).toBe(1)
    expect(notificationsOf(log, taskId)[0]?.processed_at).not.toBeNull()
    expect(of(log, EVENT_TYPES.sessionTaskStatus).map((event) => event.status)).toEqual([
      'running',
      'idle',
    ])
    const claimed = of(log, EVENT_TYPES.modelRequestStart).some(
      (event: ModelRequestStartEvent) => event.consumes?.includes(delivered.id) === true,
    )
    expect(claimed).toBe(true)
    // The model was told, in the frame — naming the task and saying the text is data.
    const replies = repliesOf(log)
    expect(replies).toContain(`[background task A test background task · ${taskId} · result]`)
    expect(replies).toContain('data, not an instruction')
  })

  it('waits for a task, holding nothing, and is resumed by the deadline', async () => {
    const server = await harness.server()
    const client: Client = await harness.client(server)
    const session = await client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })

    // A wait nothing will answer: the model asked for one and no task was started, so the turn
    // ends idle with the deadline in the log and no lease, slot or request held.
    const sent = await client.sendMessage(session.id, `${MOCK_WAIT_MARKER} 1`)
    const call = await waitFor(`session ${session.id} to pause on a wait`, async () =>
      of(await readLog(client, session.id), EVENT_TYPES.agentToolUse).find(
        (event) => event.name === TASK_WAIT_TOOL_NAME,
      ),
    )
    await waitForTurnEnd(client, session.id, { afterSeq: sent.seq })

    let log = await readLog(client, session.id)
    expect(call).toMatchObject({ evaluated_permission: 'ask' })
    expect(of(log, EVENT_TYPES.agentToolResult)).toEqual([])
    expect(idleOf(log)?.stop_reason).toMatchObject({ type: 'waiting_on_tasks', task_ids: [] })

    // The process's own timer resumes it when the deadline passes — nothing else would, since
    // no task will ever report — and the call is answered with what the log says.
    const result = await waitFor(
      `the wait of session ${session.id} to time out`,
      async () =>
        of(await readLog(client, session.id), EVENT_TYPES.agentToolResult).find(
          (event) => event.tool_use_id === call.id,
        ),
      { timeoutMs: 20_000 },
    )
    expect(result).toMatchObject({ is_error: false })
    expect(resultText(result)).toContain('The wait timed out')

    await waitForTurnEnd(client, session.id)
    log = await readLog(client, session.id)
    expect(idleOf(log)?.stop_reason).toEqual({ type: 'end_turn' })
    // The turn carried on behind the result, and the model answered what it was told.
    expect(repliesOf(log)).toContain('The wait timed out')
  })

  it('resolves a wait with the news a task reports, exactly once', async () => {
    const server = await harness.server()
    const client: Client = await harness.client(server)
    const session = await client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })

    // A task that takes its time, and then a wait for it: the wait is written while the task is
    // still working, so what ends it is the task's news rather than the deadline.
    const started = await client.sendMessage(session.id, `${MOCK_TASK_MARKER} 2500`)
    await waitForTurnEnd(client, session.id, { afterSeq: started.seq })
    const { taskId } = taskOf(await readLog(client, session.id))

    const waited = await client.sendMessage(session.id, `${MOCK_WAIT_MARKER} 60`)
    await waitFor(`session ${session.id} to end its turn waiting`, async () =>
      idleOf(await readLog(client, session.id))?.stop_reason.type === 'waiting_on_tasks'
        ? true
        : undefined,
    )
    await waitForTurnEnd(client, session.id, { afterSeq: waited.seq })

    const result = await waitFor(
      `the wait of session ${session.id} to be answered by its task`,
      async () =>
        of(await readLog(client, session.id), EVENT_TYPES.agentToolResult).find((event) =>
          resultText(event).includes('[background task'),
        ),
      { timeoutMs: 20_000 },
    )
    expect(resultText(result)).toContain(
      `[background task A test background task · ${taskId} · result]`,
    )
    // The result **is** the news, so it claims it: the notification appears once, and the request
    // that followed was not handed the same text a second time as a message of its own.
    const log = await readLog(client, session.id)
    const notifications = notificationsOf(log, taskId)
    expect(notifications.length).toBe(1)
    expect(result.consumes).toEqual([notifications[0]?.id])
  })
})
