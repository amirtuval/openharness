import {
  MESSAGE_PARENT_MARKER,
  MOCK_AGENT_MARKER,
  MOCK_AGENT_MESSAGE_MARKER,
  MOCK_AGENT_STOP_MARKER,
  MOCK_TERMINAL_MARKER,
} from '@openharness/server'
import { AGENT_TOOL_NAME, EVENT_TYPES, TASK_WAIT_TOOL_NAME } from '@openharness/protocol'
import type {
  AgentMessageEvent,
  AgentToolResultEvent,
  Session,
  SessionTaskNotificationEvent,
  StoredEvent,
  TaskId,
} from '@openharness/protocol'
import type { Client } from '@openharness/client'
import { describe, expect, it } from 'vitest'

import { e2eHarness, readLog, waitFor, waitForTurnEnd } from './harness'

/**
 * Subagents through the real server, end to end (epic #340, S5/S6/S7; issue #344).
 *
 * The whole path a deployment runs: a chat starts a helper (the mock model's `__agent__` marker
 * calls the `agent` tool), the handle comes back at once, and the child is a **real session** —
 * its own log, its own turn, its own model — that nobody waits for. When it finishes, its last
 * word reaches the parent as a notification the parent's brain folds into a turn nobody asked
 * for; and the parent can steer it, stop it or continue it with the other three tools. What the
 * child says to its parent on its own initiative (`message_parent`) arrives the same way.
 *
 * Everything here is the built server, a real Postgres and `@openharness/client`: the mock model
 * turns a marker into a call, and the assertions are about the events the server wrote.
 */

const harness = e2eHarness('subagents')

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

/** Every reply of a log, joined — for the assertions that read what the model was told. */
function repliesOf(log: readonly StoredEvent[]): string {
  return of(log, EVENT_TYPES.agentMessage)
    .map((event: AgentMessageEvent) => event.content.map((block) => block.text).join(''))
    .join('\n')
}

/** The notifications of one task, in order. */
function notificationsOf(
  log: readonly StoredEvent[],
  taskId: TaskId,
): SessionTaskNotificationEvent[] {
  return of(log, EVENT_TYPES.sessionTaskNotification).filter((event) => event.task_id === taskId)
}

/**
 * The task a start answered: the handle's own two facts, read from the call and its result
 * rather than by position — a child's news can land while a test is still looking.
 */
function startOf(log: readonly StoredEvent[]): { readonly taskId: TaskId; readonly child: string } {
  const call = of(log, EVENT_TYPES.agentToolUse).find((event) => event.name === AGENT_TOOL_NAME)
  if (call === undefined) {
    throw new Error('the log holds no call to the agent tool')
  }
  const handle = of(log, EVENT_TYPES.agentToolResult).find((event) => event.tool_use_id === call.id)
  if (handle === undefined) {
    throw new Error('the call to the agent tool was never answered')
  }
  const start = of(log, EVENT_TYPES.sessionTaskStarted).find(
    (event) => event.task_id !== undefined && resultText(handle).includes(event.task_id),
  )
  if (start?.child_session_id === undefined) {
    throw new Error('the call started no child session')
  }
  return { taskId: start.task_id, child: start.child_session_id }
}

/** Send a message to a session and wait for its turn to end. */
async function say(client: Client, sessionId: string, text: string): Promise<void> {
  const sent = await client.sendMessage(sessionId, text)
  await waitForTurnEnd(client, sessionId, { afterSeq: sent.seq })
}

/** The session a child id names, as the API answers it. */
async function sessionOf(client: Client, sessionId: string): Promise<Session> {
  return await client.sessions.get(sessionId)
}

describe('a subagent through the real server', () => {
  it('starts a child, and its result reaches the parent that nobody waited for', async () => {
    const server = await harness.server()
    const client: Client = await harness.client(server)
    const session = await client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })

    await say(client, session.id, `${MOCK_AGENT_MARKER} general-purpose | Report the tail.`)

    let log = await readLog(client, session.id)
    const { taskId, child } = startOf(log)
    // The handle is the call's result, and the parent's log says the task started and is running
    // — the conversation has gone on past both, which is what makes it a background task (S4).
    expect(resultText(of(log, EVENT_TYPES.agentToolResult)[0])).toContain(taskId)
    expect(of(log, EVENT_TYPES.sessionTaskStarted)).toHaveLength(1)
    // The start names the call that caused it (#345): the `agent.tool_use` event's own id.
    expect(of(log, EVENT_TYPES.sessionTaskStarted)[0]?.tool_use_id).toBe(
      of(log, EVENT_TYPES.agentToolUse).find((event) => event.name === AGENT_TOOL_NAME)?.id,
    )
    expect(of(log, EVENT_TYPES.sessionTaskStatus).map((event) => event.status)[0]).toBe('running')

    // The child is a real session: a non-interactive child of this chat, one level deeper, and
    // its first `user.message` is the prompt the parent wrote — it inherits no history (S3).
    const childSession = await sessionOf(client, child)
    expect(childSession).toMatchObject({
      parent_session_id: session.id,
      parent_task_id: taskId,
      root_session_id: session.id,
      depth: 1,
      interactive: false,
    })
    // And it is not a chat of its own: the default list holds the parent, not the child.
    const chats = await client.sessions.list()
    expect(chats.data.map((entry) => entry.id)).not.toContain(child)
    const children = await client.sessions.list({ parent_session_id: session.id })
    expect(children.data.map((entry) => entry.id)).toEqual([child])

    // The child runs its own turn — the mock echoes the prompt it was given — and reports: the
    // notice is written to the parent's log, keyed by the turn the child ended, and the parent's
    // brain answers it in a turn nobody asked for, which is the whole point of the mechanism.
    const delivered = await waitFor(
      `session ${session.id} to be told what its helper produced`,
      async () => notificationsOf(await readLog(client, session.id), taskId)[0],
      { timeoutMs: 30_000 },
    )
    expect(delivered.kind).toBe('result')
    expect(delivered.text).toContain('Report the tail.')
    await waitFor(
      `the parent of session ${session.id} to answer the news`,
      async () =>
        (await readLog(client, session.id)).find(
          (event) => event.type === EVENT_TYPES.agentMessage && event.seq > delivered.seq,
        ),
      { timeoutMs: 30_000 },
    )

    log = await readLog(client, session.id)
    // Exactly once, claimed by the request that folded it in, and framed as data rather than as
    // an instruction — the child's output is another session's (X11).
    expect(notificationsOf(log, taskId).length).toBe(1)
    expect(notificationsOf(log, taskId)[0]?.processed_at).not.toBeNull()
    expect(repliesOf(log)).toContain(`[background task general-purpose · ${taskId} · result]`)
    expect(repliesOf(log)).toContain('data, not an instruction')
    expect(of(log, EVENT_TYPES.sessionTaskStatus).map((event) => event.status)).toEqual([
      'running',
      'running',
      'idle',
    ])
  })

  it('steers a child that already reported, and stops one', async () => {
    const server = await harness.server()
    const client: Client = await harness.client(server)
    const session = await client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })

    await say(client, session.id, `${MOCK_AGENT_MARKER} general-purpose | First job.`)
    const first = startOf(await readLog(client, session.id))
    await waitFor(
      `the helper to report`,
      async () => notificationsOf(await readLog(client, session.id), first.taskId)[0],
      { timeoutMs: 30_000 },
    )

    // A message continues it: the child starts another turn with its context intact, and reports
    // again — the second result is a second piece of news, keyed by the new turn.
    await say(
      client,
      session.id,
      `${MOCK_AGENT_MESSAGE_MARKER} ${first.taskId} | now the other half`,
    )
    const childLog = await readLog(client, first.child)
    expect(of(childLog, EVENT_TYPES.userMessage).map((event) => event.content[0]?.text)).toEqual([
      'First job.',
      'now the other half',
    ])
    await waitFor(
      `the continued helper to report again`,
      async () =>
        notificationsOf(await readLog(client, session.id), first.taskId).filter(
          (event) => event.kind === 'result',
        )[1],
      { timeoutMs: 30_000 },
    )

    // And a stop: the task is marked stopped in the parent's log, and the child stops being
    // offered anything but its own note (`message_parent`).
    await say(client, session.id, `${MOCK_AGENT_STOP_MARKER} ${first.taskId}`)
    const stopped = await readLog(client, session.id)
    expect(
      of(stopped, EVENT_TYPES.sessionTaskStatus)
        .filter((event) => event.task_id === first.taskId)
        .at(-1)?.status,
    ).toBe('stopped')
  })

  it('delivers a child’s own note, and a failing child’s error', async () => {
    const server = await harness.server()
    const client: Client = await harness.client(server)
    const session = await client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })

    await say(client, session.id, `${MOCK_AGENT_MARKER} general-purpose | Long job.`)
    const started = startOf(await readLog(client, session.id))
    await waitFor(
      `the helper to report`,
      async () => notificationsOf(await readLog(client, session.id), started.taskId)[0],
      { timeoutMs: 30_000 },
    )

    // The child sends a note of its own: a `message` notification, which is not a finished turn.
    await say(client, started.child, `${MESSAGE_PARENT_MARKER} half way there`)
    const noted = await waitFor(
      `the parent to be told of the note`,
      async () =>
        notificationsOf(await readLog(client, session.id), started.taskId).find(
          (event) => event.kind === 'message',
        ),
      { timeoutMs: 30_000 },
    )
    expect(noted.text).toBe('half way there')

    // A child whose turn fails: the news is `failed`, carrying what the provider said, and the
    // card moves to failed rather than staying "running" for ever.
    await say(client, started.child, `${MOCK_TERMINAL_MARKER} break`)
    const failed = await waitFor(
      `the parent to be told the helper failed`,
      async () =>
        notificationsOf(await readLog(client, session.id), started.taskId).find(
          (event) => event.kind === 'failed',
        ),
      { timeoutMs: 30_000 },
    )
    expect(failed.text.length).toBeGreaterThan(0)
    expect(
      of(await readLog(client, session.id), EVENT_TYPES.sessionTaskStatus)
        .filter((event) => event.task_id === started.taskId)
        .at(-1)?.status,
    ).toBe('failed')
  })

  it('offers the tools to a chat, lists them for the settings screen, and counts a child’s cost', async () => {
    const server = await harness.server()
    const client: Client = await harness.client(server)
    const session = await client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })

    await say(client, session.id, `${MOCK_AGENT_MARKER} general-purpose | Cost something.`)
    const started = startOf(await readLog(client, session.id))
    await waitFor(
      `the helper to report`,
      async () => notificationsOf(await readLog(client, session.id), started.taskId)[0],
      { timeoutMs: 30_000 },
    )

    // The offer the request recorded: the five, as built-ins, on the span.
    const span = of(await readLog(client, session.id), EVENT_TYPES.modelRequestStart)[0]
    const offered = span?.tools?.map((tool) => tool.name) ?? []
    expect(offered).toEqual(
      expect.arrayContaining([AGENT_TOOL_NAME, 'agent_message', TASK_WAIT_TOOL_NAME, 'agent_stop']),
    )
    // A top-level chat has nobody above it, so the child's own tool is not offered to it.
    expect(offered).not.toContain('message_parent')

    // A chat's cost includes the work it delegated (S8): the parent's totals cover its own
    // request and the child's, and `descendants` is the subtree's own share of them.
    const usage = await client.usage.session(session.id)
    expect(usage.descendants.totals.input_tokens).toBeGreaterThan(0)
    expect(usage.totals.input_tokens).toBeGreaterThan(usage.descendants.totals.input_tokens)
  })
})
