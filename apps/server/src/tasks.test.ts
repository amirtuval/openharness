import { createToolRegistry } from '@openharness/hands'
import type { ToolRegistry } from '@openharness/hands'
import {
  API_VERSION_PREFIX,
  EVENT_TYPES,
  TASK_WAIT_TOOL_NAME,
  newEventId,
  newTaskId,
  type AgentToolResultEvent,
  type Session,
  type SessionId,
  type StoredEvent,
  type TaskId,
} from '@openharness/protocol'
import { InMemorySessionStore, type SessionStore } from '@openharness/session'
import { describe, expect, it } from 'vitest'

import { askUserTool } from './pausing'
import { createTaskNotifier, taskDescription } from './tasks'
import { testTaskTool, testTaskWaitTool } from './test-tasks'
import { createTurnRegistry } from './tools'
import { createTestApp, postJson, readHistory, waitFor, waitForIdle } from './test-support'
import type { TestContext } from './test-support'

/**
 * Background tasks over the real server (epic #340, S4/S5; issue #343).
 *
 * Three halves, each one only a server can be asked about. The **notifier** is the one function
 * anything that runs a task writes through — what it stores, what it signals, and that a second
 * notification for one `source_key` appends nothing. The **wait** is driven through the app: a
 * turn that called `agent_wait` ends `waiting_on_tasks`, and the next turn answers it with the
 * news that arrived, or with the deadline — the second is the process's timer, which is what
 * `PassQueue` arms and nothing in the log could. The **tool** is the one a deployment registers
 * (#344's, behind the test model): its call pauses the turn rather than running anything.
 */

const SESSIONS = `${API_VERSION_PREFIX}/sessions`

/** The registry the harness runs with: the real `ask_user` beside the task tools. */
function registry(): ToolRegistry {
  return createToolRegistry([askUserTool, testTaskTool, testTaskWaitTool])
}

/** A session created through the route. */
async function createSession(test: TestContext): Promise<Session> {
  const response = await postJson(test, SESSIONS, { model: { id: 'openai/gpt-5-mini' } })
  expect(response.status).toBe(201)
  return (await response.json()) as Session
}

/** Post one event and assert the append was accepted. */
async function send(test: TestContext, sessionId: SessionId, event: unknown): Promise<void> {
  const response = await postJson(test, `${SESSIONS}/${sessionId}/events`, { events: [event] })
  expect(response.status).toBe(200)
}

/** A `user.message`. */
function message(text: string): unknown {
  return { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }] }
}

/** Every stored event of a session. */
async function log(test: TestContext, sessionId: SessionId): Promise<StoredEvent[]> {
  return await readHistory(test.store, sessionId)
}

/** The stored events of one type, in order. */
function of<T extends StoredEvent['type']>(
  events: readonly StoredEvent[],
  type: T,
): Extract<StoredEvent, { type: T }>[] {
  return events.filter((event): event is Extract<StoredEvent, { type: T }> => event.type === type)
}

/** The text a result carried, joined. */
function resultText(result: AgentToolResultEvent | undefined): string {
  return result === undefined ? '' : result.content.map((block) => block.text).join('')
}

/** An inbox over a store, with the signals it sent recorded rather than routed. */
function inbox(store: SessionStore): {
  readonly tasks: ReturnType<typeof createTaskNotifier>
  readonly signals: { readonly sessionId: SessionId; readonly kind: string }[]
} {
  const signals: { sessionId: SessionId; kind: string }[] = []
  const tasks = createTaskNotifier({
    store,
    signal: (sessionId, kind) => signals.push({ sessionId, kind }),
  })
  return { tasks, signals }
}

describe('the inbox anything that runs a task writes through', () => {
  it('records a task as started and running, and says who it is for', async () => {
    const store = new InMemorySessionStore()
    const agent = await store.createAgent(
      { name: 'Parent', model: { id: 'openai/gpt-5-mini' } },
      'user_tasks_test',
    )
    const session = await store.createSession(agent.id, { ownerId: 'user_tasks_test' })
    const child = await store.createSession(agent.id, { ownerId: 'user_tasks_test' })
    const { tasks } = inbox(store)
    const taskId = newTaskId()
    const toolUseId = newEventId()

    await tasks.startTask(session.id, {
      taskId,
      toolUseId,
      childSessionId: child.id,
      taskType: 'researcher',
      description: '  Research   the event log  ',
    })

    const events = (await store.listEventsUnscoped(session.id, {})).data
    expect(of(events, EVENT_TYPES.sessionTaskStarted)[0]).toMatchObject({
      task_id: taskId,
      kind: 'subagent',
      // The call that started it, when the starter has one (#345).
      tool_use_id: toolUseId,
      child_session_id: child.id,
      task_type: 'researcher',
      // Collapsed and trimmed: a card's line, not a paragraph with the caller's whitespace in it.
      description: 'Research the event log',
    })
    expect(of(events, EVENT_TYPES.sessionTaskStatus)[0]).toMatchObject({
      task_id: taskId,
      status: 'running',
    })
  })

  it('delivers a notification once per source key, and wakes the session every time', async () => {
    const store = new InMemorySessionStore()
    const agent = await store.createAgent(
      { name: 'Parent', model: { id: 'openai/gpt-5-mini' } },
      'user_tasks_test',
    )
    const session = await store.createSession(agent.id, { ownerId: 'user_tasks_test' })
    const { tasks, signals } = inbox(store)
    const taskId = newTaskId()
    const input = {
      sessionId: session.id,
      taskId,
      kind: 'result' as const,
      text: 'The log is append-only.',
      sourceKey: `${taskId}:3`,
    }

    const first = await tasks.notify(input)
    const second = await tasks.notify(input)
    expect([first.appended, second.appended]).toEqual([true, false])
    expect(second.event).toEqual(first.event)
    const stored = await store.getPendingTaskNotifications(session.id)
    expect(stored.map((event) => event.id)).toEqual([first.event.id])
    // Nothing claimed it yet, so the parent's next turn is where it lands.
    expect(stored[0]?.processed_at).toBeNull()
    // Both calls woke the session: a redundant wake costs a turn that finds nothing to do, and
    // a missing one is the failure this seam exists to prevent.
    expect(signals).toEqual([
      { sessionId: session.id, kind: 'work' },
      { sessionId: session.id, kind: 'work' },
    ])

    // The status a task reports when its turn ends is its own event, and is not queued.
    await tasks.setStatus(session.id, taskId, 'idle')
    const events = (await store.listEventsUnscoped(session.id, {})).data
    expect(of(events, EVENT_TYPES.sessionTaskStatus).at(-1)).toMatchObject({
      task_id: taskId,
      status: 'idle',
    })
  })

  it('bounds a description rather than refusing the task', () => {
    expect(taskDescription('  a\n\nb  ')).toBe('a b')
    expect(taskDescription('')).toBe('A background task')
    expect(taskDescription('x'.repeat(5_000)).length).toBeLessThanOrEqual(500)
  })
})

describe('the wait for background tasks over HTTP', () => {
  /** An app whose task tools are registered and whose model waits for a task. */
  async function waiting(
    options: {
      readonly timeoutS?: number
      readonly taskIds?: readonly TaskId[]
    } = {},
  ): Promise<{
    readonly test: TestContext
    readonly sessionId: SessionId
    readonly taskId: TaskId
    readonly tasks: ReturnType<typeof createTaskNotifier>
  }> {
    const taskId = newTaskId()
    const test = createTestApp({
      tools: registry(),
      replies: [
        {
          toolCalls: [
            {
              name: TASK_WAIT_TOOL_NAME,
              input: {
                task_ids: options.taskIds ?? [taskId],
                timeout_s: options.timeoutS ?? 60,
              },
            },
          ],
        },
        { text: ['Thanks.'] },
      ],
    })
    const session = await createSession(test)
    // The inbox as `main.ts` builds one: the signal really reaches the scheduler, which is what
    // makes a chat react to a task's news instead of waiting for a sweep.
    const tasks = createTaskNotifier({
      store: test.store,
      signal: (sessionId, kind) => test.scheduler.signal(sessionId, kind),
    })
    await tasks.startTask(session.id, { taskId, description: 'Research the log' })
    await send(test, session.id, message('wait for the researcher'))
    await waitForIdle(test.store, session.id)
    return { test, sessionId: session.id, taskId, tasks }
  }

  it('ends the turn waiting, naming the task and the deadline', async () => {
    const { test, sessionId, taskId } = await waiting()
    const events = await log(test, sessionId)
    const call = of(events, EVENT_TYPES.agentToolUse)[0]
    expect(call).toMatchObject({ name: TASK_WAIT_TOOL_NAME, evaluated_permission: 'ask' })
    expect(of(events, EVENT_TYPES.agentToolResult)).toEqual([])
    const idle = of(events, EVENT_TYPES.sessionStatusIdle).at(-1)
    expect(idle?.stop_reason).toMatchObject({ type: 'waiting_on_tasks', task_ids: [taskId] })
    await test.close()
  })

  it('answers the wait with the news that arrives, and asks the model again', async () => {
    const { test, sessionId, taskId, tasks } = await waiting()
    const notification = await tasks.notify({
      sessionId,
      taskId,
      kind: 'result',
      text: 'It is append-only.',
      sourceKey: `${taskId}:1`,
    })

    await waitFor(
      async () => of(await log(test, sessionId), EVENT_TYPES.agentToolResult).length > 0,
      { message: 'the wait was never answered' },
    )
    const events = await log(test, sessionId)
    const result = of(events, EVENT_TYPES.agentToolResult)[0]
    expect(result).toMatchObject({ is_error: false })
    expect(resultText(result)).toContain('It is append-only.')
    // The result is the news, so it claims it; the follow-up request saw the answer once.
    expect(result?.consumes).toEqual([notification.event.id])
    expect(await test.store.getPendingTaskNotifications(sessionId)).toEqual([])
    // The request that followed carried the call's answer...
    const followUp = test.model.histories.at(-1) ?? []
    expect(followUp.some((entry) => entry.role === 'tool')).toBe(true)
    // ...and the news was not *also* folded in as a message of its own.
    expect(test.model.prompts.some((prompt) => prompt.includes('It is append-only.'))).toBe(false)
    await test.close()
  })

  it('times the wait out on its own deadline, through the scheduler’s timer', async () => {
    // A deadline the test can outlive: nothing else would resume a wait whose news never comes,
    // so this is the timer the queue arms from the turn's outcome.
    const taskId = newTaskId()
    const test = createTestApp({
      tools: registry(),
      replies: [
        {
          toolCalls: [{ name: TASK_WAIT_TOOL_NAME, input: { task_ids: [taskId], timeout_s: 0.2 } }],
        },
        { text: ['Gave up.'] },
      ],
    })
    const session = await createSession(test)
    const tasks = createTaskNotifier({
      store: test.store,
      signal: (sessionId, kind) => test.scheduler.signal(sessionId, kind),
    })
    await tasks.startTask(session.id, { taskId, description: 'Research the log' })
    await send(test, session.id, message('wait for the researcher'))
    await waitForIdle(test.store, session.id)

    await waitFor(
      async () => of(await log(test, session.id), EVENT_TYPES.agentToolResult).length > 0,
      { message: 'the deadline never fired', timeoutMs: 10_000 },
    )
    const events = await log(test, session.id)
    const result = of(events, EVENT_TYPES.agentToolResult)[0]
    expect(result?.is_error).toBe(false)
    expect(resultText(result)).toContain('The wait timed out')
    // Naming what it was waiting for and what the log says about it: still running.
    expect(resultText(result)).toContain(taskId)
    await test.close()
  })

  it('leaves a wait the model named no task for until anything reports', async () => {
    const { test, sessionId, tasks } = await waiting({ taskIds: [] })
    const taskId = newTaskId()
    await tasks.startTask(sessionId, { taskId, description: 'Something else' })
    await tasks.notify({
      sessionId,
      taskId,
      kind: 'message',
      text: 'Anything landed.',
      sourceKey: `${taskId}:1`,
    })
    await waitFor(
      async () => of(await log(test, sessionId), EVENT_TYPES.agentToolResult).length > 0,
      {
        message: 'the wait was never answered',
      },
    )
    expect(resultText(of(await log(test, sessionId), EVENT_TYPES.agentToolResult)[0])).toContain(
      'Anything landed.',
    )
    await test.close()
  })

  it('resolves the wait when the user says something instead', async () => {
    const { test, sessionId } = await waiting()
    await send(test, sessionId, message('never mind'))
    await waitFor(
      async () => of(await log(test, sessionId), EVENT_TYPES.agentToolResult).length > 0,
      {
        message: 'the wait was never answered',
      },
    )
    expect(resultText(of(await log(test, sessionId), EVENT_TYPES.agentToolResult)[0])).toBe(
      'The user sent a message instead.',
    )
    await test.close()
  })

  it('offers the task tools through the registry, and lists agent_wait as available', async () => {
    const test = createTestApp({ tools: registry() })
    const response = await test.request(`${API_VERSION_PREFIX}/me/tools`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { name: string; available: boolean }[] }
    expect(body.data.find((entry) => entry.name === TASK_WAIT_TOOL_NAME)?.available).toBe(true)
    await test.close()
  })
})

describe('the test background task', () => {
  it('returns a handle at once and leaves the news to the process that owns the store', async () => {
    // What the tool does is the handle; what the store proxy does with the call is #343's test
    // hook, and is driven end to end in `e2e/src/tasks.test.ts`.
    const taskId = newTaskId()
    const result = await testTaskTool.run({ task_id: taskId, description: 'x' }, {} as never)
    expect(result.isError).not.toBe(true)
    expect(JSON.parse(result.content.map((block) => block.text).join(''))).toEqual({
      task_id: taskId,
      type: 'test',
      status: 'running',
    })

    // The wait tool's own `run` is never reached by the loop: it exists so the model can be
    // offered the name, and says so if something runs it by hand.
    const ran = await testTaskWaitTool.run({}, {} as never)
    expect(ran.isError).toBe(true)
  })

  it('registers the wait for every deployment, and the test task for the mock model', () => {
    // #344 registered `agent_wait` (and the rest of the subagent tools) for every deployment, so
    // the wait is no longer a test hook: it is a tool a real chat is offered. What still rides on
    // the mock model is the task the test model can **start** — a real deployment's is `agent`.
    const mocked = createTurnRegistry({ kind: 'mock' }).tools.map((tool) => tool.name)
    const provider = createTurnRegistry({ kind: 'provider' }).tools.map((tool) => tool.name)
    expect(mocked).toContain(TASK_WAIT_TOOL_NAME)
    expect(provider).toContain(TASK_WAIT_TOOL_NAME)
    expect(mocked).toContain('task_start')
    expect(provider).not.toContain('task_start')
  })
})
