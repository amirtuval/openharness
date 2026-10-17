import { createToolRegistry, errorResult } from '@openharness/hands'
import type { ToolDefinition, ToolResult } from '@openharness/hands'
import type { AppendableEvent, InMemorySessionStore } from '@openharness/session'
import { createTestClock } from '@openharness/session/testing'
import type { TestClock } from '@openharness/session/testing'
import type {
  SessionId,
  SessionTaskNotificationEvent,
  SessionTaskStartedEvent,
  StoredEvent,
  StoredEventType,
  TaskId,
  TaskWaitInput,
} from '@openharness/protocol'
import {
  EVENT_TYPES,
  TASK_WAIT_DEFAULT_TIMEOUT_MS,
  TASK_WAIT_TOOL_NAME,
  TaskWaitInputSchema,
  newTaskId,
} from '@openharness/protocol'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { SubagentRuntime } from './agents'
import { RESOLVED_BY_MESSAGE, awaitingUser } from './pausing'
import {
  awaitingTasks,
  notificationText,
  pendingNotifications,
  settleTaskWait,
  settleTaskWaits,
  stillRunning,
  taskStatuses,
  taskStarts,
  taskWaitOf,
  taskWaitTimedOut,
  waitsForTasks,
} from './tasks'
import { eventTypes, logOf, message, newSession } from './testing/harness'
import { lostExecutions } from './tools'
import { mockModel, readPrompt, resolveTestCredential } from './testing/mock-model'
import { runTurn } from './turn'
import type { TurnOutcome } from './turn'

/**
 * Background tasks and the inbox, driven through the loop (epic #340, S4/S5; issue #343).
 *
 * Every path here is a real turn against a real store, with the model scripted: a task's news
 * is a `session.task_notification` in the parent's log, and what the tests look at is what the
 * *model* was told — the request's prompt, the claims the log holds, and the turn's outcome.
 * Nothing is mocked but the model, and the store is the in-memory one every other package's
 * tests use, so the store's own rules (queued, claimed, idempotent) are the ones in play.
 */

/** A script with nothing in it: a request that says nothing and calls nothing. */
const NOTHING = { text: [] as readonly string[] }

/**
 * The runtime a deployment that **has** subagents wires (epic #340, S6; #344).
 *
 * Every turn in this suite drives `agent_wait`, and since #365 the five subagent tools are
 * offered only to a deployment that wired a runtime — a host without one offers nobody a tool
 * that could only answer "the harness answers this", and rides on the loop recognising
 * `agent_wait` by name. Nothing here starts a helper, so the resolver offers no types.
 */
const SUBAGENTS: SubagentRuntime = {
  types: {
    list: () => Promise.resolve([]),
    resolve: () => Promise.resolve({ ok: false, message: 'This deployment starts no helpers.' }),
  },
  maxDepth: 3,
  maxLiveTasks: 10,
}

/** The `agent_wait` tool, as a deployment registers it: nothing runs a call to it. */
function waitTool(): {
  readonly tool: ToolDefinition<TaskWaitInput>
  readonly run: ReturnType<typeof vi.fn>
} {
  const run = vi.fn<() => ToolResult>(() => errorResult('agent_wait is answered by the log.'))
  return {
    tool: {
      name: TASK_WAIT_TOOL_NAME,
      description: 'Wait for background tasks.',
      inputSchema: TaskWaitInputSchema,
      permission: 'allow',
      run,
    },
    run,
  }
}

/**
 * An `echo` tool the model may really call, so a turn can loop across two requests.
 *
 * @param onRun something to do while the call is being run — after the calls are stored and
 *   before their answers are, which is the one window that puts an event *between* a call and
 *   its result
 */
function echo(onRun?: () => Promise<void>): ToolDefinition<{ text: string }> {
  return {
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: z.object({ text: z.string() }),
    permission: 'allow',
    run: async (input) => {
      await onRun?.()
      return { content: [{ type: 'text', text: input.text }] }
    },
  }
}

/** The stored events of one type, in order, narrowed to that kind. */
function of<T extends StoredEventType>(
  log: readonly StoredEvent[],
  type: T,
): Extract<StoredEvent, { type: T }>[] {
  return log.filter((event): event is Extract<StoredEvent, { type: T }> => event.type === type)
}

/** A `session.task_started` to append, as the tool that starts a task writes one. */
function startTask(
  taskId: TaskId,
  overrides: Partial<Omit<SessionTaskStartedEvent, 'id' | 'type' | 'seq' | 'processed_at'>> = {},
): AppendableEvent {
  return {
    type: EVENT_TYPES.sessionTaskStarted,
    task_id: taskId,
    kind: 'subagent',
    description: 'Research the event log',
    ...overrides,
  }
}

/** A `session.task_status` to append, as the task's own side writes one. */
function taskStatus(
  taskId: TaskId,
  status: 'running' | 'idle' | 'failed' | 'stopped',
): AppendableEvent {
  return { type: EVENT_TYPES.sessionTaskStatus, task_id: taskId, status }
}

/**
 * A task that says something, the way the store's idempotent append does it (#343).
 *
 * The real call, not a hand-built event: the news a parent is told is exactly
 * `SessionStore.appendTaskNotification`'s, and a test that built the event itself would not be
 * testing the path a subagent's turn will take.
 */
async function notify(
  store: InMemorySessionStore,
  sessionId: SessionId,
  taskId: TaskId,
  options: {
    readonly text?: string
    readonly kind?: 'result' | 'message' | 'failed'
    readonly key?: string
  } = {},
): Promise<SessionTaskNotificationEvent> {
  const { event } = await store.appendTaskNotification(sessionId, {
    taskId,
    kind: options.kind ?? 'result',
    text: options.text ?? 'The log is append-only; a rewind supersedes the tail.',
    sourceKey: options.key ?? `${taskId}:1`,
  })
  return event
}

/** The task's own line, as the model reads it — the frame the loop renders. */
function frame(taskId: TaskId, label: string, kind: string): string {
  return `[background task ${label} · ${taskId} · ${kind}]`
}

/** One recorded request, as its prompt: the messages the loop sent, in order. */
function promptAt(
  model: ReturnType<typeof mockModel>,
  index: number,
): readonly { readonly role: string; readonly text: string }[] {
  const call = model.calls[index]
  return call === undefined ? [] : readPrompt(call)
}

/** The text of one recorded request, joined — what an assertion about content reads. */
function promptText(model: ReturnType<typeof mockModel>, index: number): string {
  return promptAt(model, index)
    .map((entry) => entry.text)
    .join('\n')
}

/** The last request the model was sent, as its prompt. */
function lastPrompt(model: ReturnType<typeof mockModel>): string {
  return promptText(model, model.calls.length - 1)
}

/** The text one result carried, joined. */
function resultText(
  event: { readonly content: readonly { readonly text: string }[] } | undefined,
): string {
  return event === undefined ? '' : event.content.map((block) => block.text).join('')
}

/** The status idle that closed the last turn. */
function idleOf(
  log: readonly StoredEvent[],
): Extract<StoredEvent, { type: 'session.status_idle' }> {
  const idle = of(log, EVENT_TYPES.sessionStatusIdle).at(-1)
  if (idle === undefined) {
    throw new Error('the log holds no session.status_idle')
  }
  return idle
}

/** The one unanswered wait call the log holds. */
function waitCallOf(log: readonly StoredEvent[]): Extract<StoredEvent, { type: 'agent.tool_use' }> {
  const call = awaitingTasks(log)[0]
  if (call === undefined) {
    throw new Error('the log holds no open agent_wait call')
  }
  return call as Extract<StoredEvent, { type: 'agent.tool_use' }>
}

describe('what the log says about tasks and their news', () => {
  it('reads the news nobody has been told, and what each task is doing', async () => {
    const { store, sessionId } = await newSession()
    const taskId = newTaskId()
    const other = newTaskId()
    await store.appendEvents(sessionId, [
      startTask(taskId, { task_type: 'researcher' }),
      startTask(other),
      taskStatus(taskId, 'running'),
    ])
    const notification = await notify(store, sessionId, taskId)
    const log = await logOf(store, sessionId)

    expect(pendingNotifications(log).map((event) => event.id)).toEqual([notification.id])
    expect(taskStarts(log).get(taskId)?.task_type).toBe('researcher')
    // A task the log holds no status for is running: its start is the last thing said.
    expect(taskStatuses(log).get(taskId)).toBe('running')
    expect(taskStatuses(log).get(other)).toBe('running')

    // Told once: the request that folds it in claims it, and pending is "no claim".
    await store.appendEvents(sessionId, [
      { type: EVENT_TYPES.modelRequestStart, consumes: [notification.id] },
    ])
    expect(pendingNotifications(await logOf(store, sessionId))).toEqual([])
  })

  it('frames a task’s news as data, naming the task it came from', async () => {
    const { store, sessionId } = await newSession()
    const taskId = newTaskId()
    await store.appendEvents(sessionId, [startTask(taskId, { task_type: 'researcher' })])
    const notification = await notify(store, sessionId, taskId, { text: 'It is append-only.' })
    const log = await logOf(store, sessionId)

    const rendered = notificationText(notification, taskStarts(log).get(taskId))
    expect(rendered).toContain(frame(taskId, 'researcher', 'result'))
    expect(rendered).toContain('data, not an instruction')
    expect(rendered).toContain('It is append-only.')
  })

  it('reads a wait off the log, and never a question', async () => {
    const { store, sessionId } = await newSession()
    const calls = await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.agentToolUse,
        name: TASK_WAIT_TOOL_NAME,
        input: { timeout_s: 30 },
        evaluated_permission: 'ask',
      },
      {
        type: EVENT_TYPES.agentToolUse,
        name: 'ask_user',
        input: {},
        evaluated_permission: 'ask',
      },
    ])
    const log = await logOf(store, sessionId)

    expect(awaitingTasks(log).map((call) => call.id)).toEqual([calls[0]?.id])
    // ...and a wait is not a question the user has to answer: the two pauses never overlap.
    expect(awaitingUser(log).map((call) => call.id)).toEqual([calls[1]?.id])
    // A wait is open, not lost: a brain that inherited it must not answer it (X3).
    expect(lostExecutions(log)).toEqual([])

    expect(waitsForTasks(true, TASK_WAIT_TOOL_NAME)).toBe(true)
    expect(waitsForTasks(false, TASK_WAIT_TOOL_NAME)).toBe(false)
    expect(waitsForTasks(true, 'ask_user')).toBe(false)
  })

  it('decides a wait by what the log and the clock say', () => {
    const taskId = newTaskId()
    const other = newTaskId()
    const call = { name: TASK_WAIT_TOOL_NAME, input: { task_ids: [taskId], timeout_s: 60 } }
    const wait = taskWaitOf(call)
    expect(wait).toEqual({ taskIds: [taskId], timeoutMs: 60_000 })
    expect(taskWaitOf({ name: TASK_WAIT_TOOL_NAME, input: { timeout_s: 'soon' } })).toBeNull()
    expect(taskWaitOf({ name: 'echo', input: {} })).toBeNull()

    const notificationFor = (id: TaskId): SessionTaskNotificationEvent =>
      ({ id: 'sevt_x', task_id: id }) as unknown as SessionTaskNotificationEvent
    const base = { call: { name: TASK_WAIT_TOOL_NAME, input: {} } as never, nowMs: 1_000 }

    // A message wins over everything: the reader moved on.
    expect(
      settleTaskWait({
        ...base,
        call: call as never,
        notifications: [notificationFor(taskId)],
        endedByMessage: true,
        recordedDeadline: null,
      }),
    ).toEqual({ kind: 'message' })

    // Its own tasks first...
    expect(
      settleTaskWait({
        ...base,
        call: call as never,
        notifications: [notificationFor(taskId), notificationFor(other)],
        endedByMessage: false,
        recordedDeadline: null,
      }),
    ).toMatchObject({ kind: 'notified', notifications: [{ task_id: taskId }] })

    // ...news for another task still resolves it — a paused turn cannot carry it any other way.
    expect(
      settleTaskWait({
        ...base,
        call: call as never,
        notifications: [notificationFor(other)],
        endedByMessage: false,
        recordedDeadline: null,
      }),
    ).toMatchObject({ kind: 'notified', notifications: [{ task_id: other }] })

    // A wait that named no task takes any of them.
    expect(
      settleTaskWait({
        ...base,
        notifications: [notificationFor(taskId)],
        endedByMessage: false,
        recordedDeadline: null,
      }),
    ).toMatchObject({ kind: 'notified' })

    // Nothing has answered it: the deadline the log recorded is the one it waits for.
    expect(
      settleTaskWait({
        ...base,
        notifications: [],
        endedByMessage: false,
        recordedDeadline: '1970-01-01T00:00:05.000Z',
      }),
    ).toEqual({ kind: 'waiting', deadlineMs: 5_000 })
    // ...and once it has passed, the wait is over.
    expect(
      settleTaskWait({
        ...base,
        notifications: [],
        endedByMessage: false,
        recordedDeadline: '1970-01-01T00:00:01.000Z',
      }),
    ).toEqual({ kind: 'timed_out' })
    // A wait whose pause was never written falls back to what its arguments asked for.
    expect(
      settleTaskWait({
        ...base,
        call: call as never,
        notifications: [],
        endedByMessage: false,
        recordedDeadline: null,
      }),
    ).toEqual({ kind: 'waiting', deadlineMs: 1_000 + 60_000 })
  })

  it('gives one notification to one wait when several are open (#363)', () => {
    const first = newTaskId()
    const second = newTaskId()
    const notificationFor = (id: TaskId): SessionTaskNotificationEvent =>
      ({ id: `sevt_${id}`, task_id: id }) as unknown as SessionTaskNotificationEvent
    const callTo = (taskId: TaskId): never =>
      ({ name: TASK_WAIT_TOOL_NAME, input: { task_ids: [taskId] } }) as never
    const options = { endedByMessage: false, recordedDeadline: () => null, nowMs: 1_000 }

    // The wait that named the task gets the news; the other keeps waiting. Handing it to both
    // would put one notification id in two results' `consumes`, an append the store refuses
    // whole — the wedge #363 fixes.
    expect(
      settleTaskWaits({
        ...options,
        calls: [callTo(first), callTo(second)],
        notifications: [notificationFor(second)],
      }),
    ).toEqual([
      { kind: 'waiting', deadlineMs: 1_000 + TASK_WAIT_DEFAULT_TIMEOUT_MS },
      { kind: 'notified', notifications: [notificationFor(second)] },
    ])

    // Two notifications, two waits: each takes its own.
    expect(
      settleTaskWaits({
        ...options,
        calls: [callTo(first), callTo(second)],
        notifications: [notificationFor(first), notificationFor(second)],
      }),
    ).toEqual([
      { kind: 'notified', notifications: [notificationFor(first)] },
      { kind: 'notified', notifications: [notificationFor(second)] },
    ])

    // A wait that named nothing takes what nothing else claimed, and the **first** of two such
    // waits is the one that gets it.
    expect(
      settleTaskWaits({
        ...options,
        calls: [{ name: TASK_WAIT_TOOL_NAME, input: {} } as never, callTo(second)],
        notifications: [notificationFor(first)],
      }),
    ).toEqual([
      { kind: 'notified', notifications: [notificationFor(first)] },
      { kind: 'waiting', deadlineMs: 1_000 + TASK_WAIT_DEFAULT_TIMEOUT_MS },
    ])
  })

  it('says which tasks a timed-out wait still has running', () => {
    const running = newTaskId()
    const done = newTaskId()
    const statuses = new Map([
      [running, 'running' as const],
      [done, 'idle' as const],
    ])
    expect(stillRunning([running, done], statuses)).toEqual([running])
    expect(taskWaitTimedOut([running])).toContain(running)
    expect(taskWaitTimedOut([])).toContain('none of them')
  })
})

describe('a task’s news reaches the parent model', () => {
  it('is folded into a running turn’s next request, as steering is', async () => {
    const { store, sessionId } = await newSession([message('tidy up')])
    const taskId = newTaskId()
    await store.appendEvents(sessionId, [startTask(taskId, { task_type: 'researcher' })])
    let notification: SessionTaskNotificationEvent | undefined
    const model = mockModel(
      {
        text: ['Working.'],
        // The step calls a tool, so the turn makes a second request — and the news lands while
        // the first one is streaming, which is exactly the window steering is for.
        toolCalls: [{ name: 'echo', input: { text: 'tidy up' } }],
        onChunk: async () => {
          notification ??= await notify(store, sessionId, taskId, { text: 'Research is done.' })
        },
      },
      NOTHING,
    )

    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      subagents: SUBAGENTS,
      tools: createToolRegistry([echo(), waitTool().tool]),
    })
    expect(outcome).toEqual({ outcome: 'idle' })
    expect(notification).toBeDefined()

    // The second request carries the frame — in the user role, as a message of its own — and
    // the first, which was already streaming when the news landed, does not.
    expect(promptText(model, 1)).toContain(frame(taskId, 'researcher', 'result'))
    expect(promptText(model, 1)).toContain('Research is done.')
    expect(promptText(model, 0)).not.toContain(frame(taskId, 'researcher', 'result'))
    expect(promptAt(model, 1).find((entry) => entry.text.includes('Research is done.'))?.role).toBe(
      'user',
    )

    // Claimed by the request that folded it in, so nothing tells the model twice.
    const log = await logOf(store, sessionId)
    const starts = of(log, EVENT_TYPES.modelRequestStart)
    expect(starts[1]?.consumes).toEqual([notification?.id])
    expect(pendingNotifications(log)).toEqual([])
  })

  it('starts a turn of its own on an idle session', async () => {
    const { store, sessionId } = await newSession([message('start something')])
    const taskId = newTaskId()
    await store.appendEvents(sessionId, [startTask(taskId), taskStatus(taskId, 'running')])
    // The parent's turn ends, and *then* the task reports — the case the scan exists for.
    const model = mockModel({ text: ['Started it.'] }, { text: ['I read the result.'] })
    expect(
      await runTurn(sessionId, {
        store,
        model: model.factory,
        resolveCredential: resolveTestCredential,
      }),
    ).toEqual({ outcome: 'idle' })
    const notification = await notify(store, sessionId, taskId, {
      kind: 'result',
      text: 'Found it.',
    })

    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
    })
    expect(outcome).toEqual({ outcome: 'idle' })
    expect(lastPrompt(model)).toContain(frame(taskId, 'Research the event log', 'result'))
    expect(lastPrompt(model)).toContain('Found it.')

    const log = await logOf(store, sessionId)
    expect(pendingNotifications(log)).toEqual([])
    const claim = of(log, EVENT_TYPES.modelRequestStart).at(-1)?.consumes
    expect(claim).toEqual([notification.id])
  })

  it('delivers several at once, in the order the log holds them', async () => {
    const { store, sessionId } = await newSession()
    const [question] = await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.userMessage,
        content: [{ type: 'text', text: 'start two' }],
      },
    ])
    const first = newTaskId()
    const second = newTaskId()
    await store.appendEvents(sessionId, [startTask(first), startTask(second)])
    const one = await notify(store, sessionId, first, { text: 'First done.' })
    const two = await notify(store, sessionId, second, { text: 'Second done.', key: `${second}:1` })

    const model = mockModel({ text: ['Both are in.'] })
    expect(
      await runTurn(sessionId, {
        store,
        model: model.factory,
        resolveCredential: resolveTestCredential,
      }),
    ).toEqual({ outcome: 'idle' })

    const prompt = lastPrompt(model)
    expect(prompt.indexOf('First done.')).toBeLessThan(prompt.indexOf('Second done.'))
    // One request answers the message and both notifications: the claim is the one append, in
    // the order the log holds them.
    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.modelRequestStart).at(-1)?.consumes).toEqual([
      question?.id,
      one.id,
      two.id,
    ])
    expect(pendingNotifications(log)).toEqual([])
  })

  it('re-runs the request a dead turn had claimed the news for, telling the model once', async () => {
    const { store, sessionId } = await newSession()
    const taskId = newTaskId()
    await store.appendEvents(sessionId, [startTask(taskId)])
    const notification = await notify(store, sessionId, taskId, { text: 'Still append-only.' })
    // A turn that opened, claimed the news, and died before its request finished.
    await store.appendEvents(sessionId, [
      { type: EVENT_TYPES.sessionStatusRunning },
      { type: EVENT_TYPES.modelRequestStart, consumes: [notification.id] },
    ])

    const model = mockModel({ text: ['Thanks.'] })
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
    })
    expect(outcome).toEqual({ outcome: 'idle' })

    // The frame is in the request the recovery ran, and the news is in the log once.
    expect(lastPrompt(model)).toContain('Still append-only.')
    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.sessionTaskNotification).length).toBe(1)
    expect(pendingNotifications(log)).toEqual([])
  })

  it('keeps a task’s statuses and its start out of the conversation', async () => {
    const { store, sessionId } = await newSession([message('go')])
    const taskId = newTaskId()
    await store.appendEvents(sessionId, [startTask(taskId, { description: 'secret prompt' })])
    const model = mockModel({ text: ['ok'] })
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
    })

    const prompt = lastPrompt(model)
    expect(prompt).not.toContain('secret prompt')
    expect(eventTypes(await logOf(store, sessionId))).toContain(EVENT_TYPES.sessionTaskStarted)
  })
})

describe('the durable wait for background tasks', () => {
  /** A session whose model asked to wait for a task, and the task it is for. */
  async function waiting(options: { readonly timeoutS?: number } = {}): Promise<{
    readonly store: InMemorySessionStore
    readonly sessionId: SessionId
    readonly clock: TestClock
    readonly taskId: TaskId
    readonly model: ReturnType<typeof mockModel>
    readonly run: ReturnType<typeof vi.fn>
  }> {
    const clock = createTestClock()
    const { store, sessionId } = await newSession([message('ask the researcher')], { clock })
    const taskId = newTaskId()
    await store.appendEvents(sessionId, [startTask(taskId), taskStatus(taskId, 'running')])
    const { tool, run } = waitTool()
    const model = mockModel(
      {
        toolCalls: [
          {
            name: TASK_WAIT_TOOL_NAME,
            input: { task_ids: [taskId], timeout_s: options.timeoutS ?? 60 },
          },
        ],
      },
      { text: ['The researcher found it.'] },
    )
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      subagents: SUBAGENTS,
      tools: createToolRegistry([tool]),
      now: clock.now,
    })
    expect(outcome).toMatchObject({ outcome: 'waiting' })
    // Nothing ran the call: a wait is not something a tool executes, so the log holds the call
    // with no answer at all. (The registry's own `run` is not the evidence: a deployment that
    // wired a runtime is offered the harness's `agent_wait`, which replaces this one — see the
    // suite's `SUBAGENTS`.)
    const stored = await logOf(store, sessionId)
    expect(stored.some((event) => event.type === EVENT_TYPES.agentToolResult)).toBe(false)
    return { store, sessionId, clock, taskId, model, run }
  }

  it('ends the turn waiting, holding no lease, a slot or an open request', async () => {
    const { store, sessionId, clock, taskId, model } = await waiting()

    const log = await logOf(store, sessionId)
    expect(waitCallOf(log).name).toBe(TASK_WAIT_TOOL_NAME)
    expect(of(log, EVENT_TYPES.agentToolResult)).toEqual([])
    expect(idleOf(log).stop_reason).toEqual({
      type: 'waiting_on_tasks',
      task_ids: [taskId],
      deadline: new Date(clock.currentMs + 60_000).toISOString(),
    })
    // The session reads idle, and nothing is held open: the pause is in the log and nowhere else.
    expect((await store.getTurnState(sessionId)).state).toBe('idle')
    // No request was made after the call: a turn does not ask the model anything while a call
    // of its own has no answer (a provider refuses that).
    expect(model.calls.length).toBe(1)
  })

  it('goes back to waiting when nothing has answered it, keeping the deadline it wrote', async () => {
    const { store, sessionId, clock, model } = await waiting()
    const deadline = new Date(clock.currentMs + 60_000).toISOString()

    // A turn woken for some other reason — here, a plain sweep — settles nothing and re-enters
    // the wait rather than asking the model again.
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      subagents: SUBAGENTS,
      tools: createToolRegistry([waitTool().tool]),
      now: clock.now,
    })
    expect(outcome).toEqual({
      outcome: 'waiting',
      waiting: { taskIds: [expect.any(String)], deadline },
    })
    expect(model.calls.length).toBe(1)
    expect(idleOf(await logOf(store, sessionId)).stop_reason).toMatchObject({ deadline })
  })

  it('resumes on a notification for one of its tasks, which becomes the call’s result', async () => {
    const { store, sessionId, clock, taskId, model } = await waiting()
    const callId = waitCallOf(await logOf(store, sessionId)).id
    const notification = await notify(store, sessionId, taskId, {
      text: 'A rewind supersedes the tail.',
      key: `${taskId}:3`,
    })

    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      subagents: SUBAGENTS,
      tools: createToolRegistry([waitTool().tool]),
      now: clock.now,
    })
    expect(outcome).toEqual({ outcome: 'idle' })

    const log = await logOf(store, sessionId)
    const result = of(log, EVENT_TYPES.agentToolResult)[0]
    expect(result).toMatchObject({ tool_use_id: callId, is_error: false })
    const text = resultText(result)
    expect(text).toContain(frame(taskId, 'Research the event log', 'result'))
    expect(text).toContain('A rewind supersedes the tail.')
    // The result **is** the news, so it claims it: the request that follows is not handed the
    // same text twice.
    expect(result?.consumes).toEqual([notification.id])
    expect(pendingNotifications(log)).toEqual([])
    // The request that follows carries the call's answer (`readPrompt` cannot read a tool
    // result's body, so the prompt says the result is there and the assertion above says what
    // it holds) — and the news is **not** also a user message of its own: the result is it.
    const prompt = promptAt(model, model.calls.length - 1)
    expect(prompt.some((entry) => entry.role === 'tool')).toBe(true)
    expect(prompt.some((entry) => entry.text.includes('A rewind supersedes the tail.'))).toBe(false)
  })

  it('resolves a wait when the user sends a message instead', async () => {
    const { store, sessionId, clock, model } = await waiting()
    await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.userMessage,
        content: [{ type: 'text', text: 'never mind' }],
      },
    ])

    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      subagents: SUBAGENTS,
      tools: createToolRegistry([waitTool().tool]),
      now: clock.now,
    })
    expect(outcome).toEqual({ outcome: 'idle' })

    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.agentToolResult)[0]).toMatchObject({ is_error: true })
    expect(resultText(of(log, EVENT_TYPES.agentToolResult)[0])).toBe(RESOLVED_BY_MESSAGE)
    // The message it moved on for is answered by the request that follows.
    expect(lastPrompt(model)).toContain('never mind')
  })

  it('resolves a wait when the turn is interrupted', async () => {
    const { store, sessionId, clock, model } = await waiting()
    await store.appendEvents(sessionId, [{ type: EVENT_TYPES.userInterrupt }])

    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      subagents: SUBAGENTS,
      tools: createToolRegistry([waitTool().tool]),
      now: clock.now,
    })
    expect(outcome).toEqual({ outcome: 'interrupted' })
    expect(resultText(of(await logOf(store, sessionId), EVENT_TYPES.agentToolResult)[0])).toBe(
      RESOLVED_BY_MESSAGE,
    )
  })

  it('answers a wait that outlives its deadline, naming the tasks still running', async () => {
    const { store, sessionId, clock, taskId, model } = await waiting({ timeoutS: 30 })
    clock.advance(30_000)

    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      subagents: SUBAGENTS,
      tools: createToolRegistry([waitTool().tool]),
      now: clock.now,
    })
    expect(outcome).toEqual({ outcome: 'idle' })

    const log = await logOf(store, sessionId)
    const result = of(log, EVENT_TYPES.agentToolResult)[0]
    // A result, not a failure: the model asked to wait, and this is the answer to that.
    expect(result?.is_error).toBe(false)
    expect(resultText(result)).toContain('The wait timed out')
    expect(resultText(result)).toContain(taskId)
    expect(pendingNotifications(log)).toEqual([])
  })

  it('answers a malformed wait instead of pausing on it', async () => {
    const { store, sessionId } = await newSession([message('wait badly')])
    const model = mockModel(
      { toolCalls: [{ name: TASK_WAIT_TOOL_NAME, input: { timeout_s: 'soon' } }] },
      { text: ['Understood.'] },
    )
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      subagents: SUBAGENTS,
      tools: createToolRegistry([waitTool().tool]),
    })
    expect(outcome).toEqual({ outcome: 'idle' })
    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.agentToolResult)[0]).toMatchObject({ is_error: true })
    expect(resultText(of(log, EVENT_TYPES.agentToolResult)[0])).toContain(
      'Invalid input for agent_wait',
    )
  })

  it('refuses a wait the user turned off, rather than pausing on it', async () => {
    const { store, sessionId } = await newSession([message('wait')])
    const model = mockModel(
      { toolCalls: [{ name: TASK_WAIT_TOOL_NAME, input: {} }] },
      { text: ['Fine.'] },
    )
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      subagents: SUBAGENTS,
      tools: createToolRegistry([waitTool().tool]),
      toolSettings: () => ({ [TASK_WAIT_TOOL_NAME]: { enabled: true, permission: 'deny' } }),
    })
    expect(outcome).toEqual({ outcome: 'idle' })
    expect(resultText(of(await logOf(store, sessionId), EVENT_TYPES.agentToolResult)[0])).toBe(
      `Permission to use ${TASK_WAIT_TOOL_NAME} has been denied.`,
    )
  })

  it('recovers a wait from a crash that never wrote the pause', async () => {
    const { store, sessionId, clock } = await newSession()
    const taskId = newTaskId()
    await store.appendEvents(sessionId, [startTask(taskId)])
    // The turn stored the call and died before it could end itself: the deadline has to come
    // from the call's own arguments.
    await store.appendEvents(sessionId, [
      { type: EVENT_TYPES.sessionStatusRunning },
      {
        type: EVENT_TYPES.agentToolUse,
        name: TASK_WAIT_TOOL_NAME,
        input: { task_ids: [taskId], timeout_s: 120 },
        evaluated_permission: 'ask',
      },
    ])

    const model = mockModel({ text: [] })
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      subagents: SUBAGENTS,
      tools: createToolRegistry([waitTool().tool]),
      now: clock.now,
    })
    expect(outcome).toEqual({
      outcome: 'waiting',
      waiting: { taskIds: [taskId], deadline: new Date(clock.currentMs + 120_000).toISOString() },
    })
    expect(idleOf(await logOf(store, sessionId)).stop_reason).toMatchObject({
      type: 'waiting_on_tasks',
      deadline: new Date(clock.currentMs + 120_000).toISOString(),
    })

    // ...and the wait it recovered is the one a notification resolves.
    await notify(store, sessionId, taskId, { text: 'Done at last.' })
    const resumed: TurnOutcome = await runTurn(sessionId, {
      store,
      model: mockModel({ text: ['Read it.'] }).factory,
      resolveCredential: resolveTestCredential,
      subagents: SUBAGENTS,
      tools: createToolRegistry([waitTool().tool]),
      now: clock.now,
    })
    expect(resumed).toEqual({ outcome: 'idle' })
    expect(resultText(of(await logOf(store, sessionId), EVENT_TYPES.agentToolResult)[0])).toContain(
      'Done at last.',
    )
  })

  it('waits for anything when the call named no tasks', async () => {
    const { store, sessionId, clock } = await newSession([message('tell me when anything lands')])
    const taskId = newTaskId()
    await store.appendEvents(sessionId, [startTask(taskId)])
    const model = mockModel(
      { toolCalls: [{ name: TASK_WAIT_TOOL_NAME, input: {} }] },
      { text: ['ok'] },
    )
    expect(
      await runTurn(sessionId, {
        store,
        model: model.factory,
        resolveCredential: resolveTestCredential,
        subagents: SUBAGENTS,
        tools: createToolRegistry([waitTool().tool]),
        now: clock.now,
      }),
    ).toMatchObject({ outcome: 'waiting' })

    const notification = await notify(store, sessionId, taskId, { text: 'Anything landed.' })
    expect(
      await runTurn(sessionId, {
        store,
        model: model.factory,
        resolveCredential: resolveTestCredential,
        subagents: SUBAGENTS,
        tools: createToolRegistry([waitTool().tool]),
        now: clock.now,
      }),
    ).toEqual({ outcome: 'idle' })
    expect(of(await logOf(store, sessionId), EVENT_TYPES.agentToolResult)[0]?.consumes).toEqual([
      notification.id,
    ])
    expect(TASK_WAIT_DEFAULT_TIMEOUT_MS).toBe(600_000)
  })

  it('resumes two open waits with one notification, claiming it once (#363)', async () => {
    // A model that made **two** `agent_wait` calls in one step — not one call naming both tasks.
    // Both are open when the first news arrives, and a result naming that notification twice is
    // an append the store refuses whole (`ClaimConflictError`), so the news was never delivered
    // and every later wake retried the same refused append: the turn was wedged.
    const clock = createTestClock()
    const { store, sessionId } = await newSession([message('wait for both')], { clock })
    const first = newTaskId()
    const second = newTaskId()
    await store.appendEvents(sessionId, [
      startTask(first),
      taskStatus(first, 'running'),
      startTask(second),
      taskStatus(second, 'running'),
    ])
    const model = mockModel(
      {
        toolCalls: [
          { name: TASK_WAIT_TOOL_NAME, input: { task_ids: [first], timeout_s: 60 } },
          { name: TASK_WAIT_TOOL_NAME, input: { task_ids: [second], timeout_s: 60 } },
        ],
      },
      { text: ['Carrying on.'] },
    )
    const options = {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      subagents: SUBAGENTS,
      tools: createToolRegistry([waitTool().tool]),
      now: clock.now,
    }
    expect(await runTurn(sessionId, options)).toMatchObject({ outcome: 'waiting' })

    // The **second** task reports: its wait is the one that named it, so it is the one answered —
    // and the append lands (no `ClaimConflictError`), which is the whole fix.
    const news = await notify(store, sessionId, second, { text: 'Second is done.' })
    expect(await runTurn(sessionId, options)).toMatchObject({ outcome: 'waiting' })
    let results = of(await logOf(store, sessionId), EVENT_TYPES.agentToolResult)
    expect(results).toHaveLength(1)
    expect(results[0]?.consumes).toEqual([news.id])
    expect(resultText(results[0])).toContain('Second is done.')
    // The news was told to the parent **once**: it is claimed, so it is not pending any more.
    expect(await store.getPendingTaskNotifications(sessionId)).toHaveLength(0)
    // The turn is paused again on a wait: the one that asked for the still-quiet task is open,
    // and what is still missing is its result. (The pause names the union of the open calls'
    // tasks, so the resolved one is in the list too — the open call is the sharper reading.)
    const log = await logOf(store, sessionId)
    expect(idleOf(log).stop_reason).toMatchObject({ type: 'waiting_on_tasks' })
    const open = awaitingTasks(log)
    expect(open).toHaveLength(1)
    expect(taskWaitOf({ name: open[0]?.name ?? '', input: open[0]?.input })).toMatchObject({
      taskIds: [first],
    })

    // The first task reports too: the other wait is answered, and the turn carries on.
    await notify(store, sessionId, first, { text: 'First is done.' })
    expect(await runTurn(sessionId, options)).toEqual({ outcome: 'idle' })
    results = of(await logOf(store, sessionId), EVENT_TYPES.agentToolResult)
    expect(results).toHaveLength(2)
    expect(results.map((result) => result.consumes?.length)).toEqual([1, 1])
    // The request that follows carries both answers (one `tool` message holds every result of
    // the step): `promptAt` cannot read a result's body, and the assertions above say what each
    // one holds.
    expect(model.calls).toHaveLength(2)
    expect(promptAt(model, 1).some((entry) => entry.role === 'tool')).toBe(true)
  })

  it('answers two open waits from two notifications, one each (#363)', async () => {
    const clock = createTestClock()
    const { store, sessionId } = await newSession([message('wait for both')], { clock })
    const first = newTaskId()
    const second = newTaskId()
    await store.appendEvents(sessionId, [
      startTask(first),
      taskStatus(first, 'running'),
      startTask(second),
      taskStatus(second, 'running'),
    ])
    const model = mockModel(
      {
        toolCalls: [
          { name: TASK_WAIT_TOOL_NAME, input: { task_ids: [first], timeout_s: 60 } },
          { name: TASK_WAIT_TOOL_NAME, input: { task_ids: [second], timeout_s: 60 } },
        ],
      },
      { text: ['Both reported.'] },
    )
    const options = {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      subagents: SUBAGENTS,
      tools: createToolRegistry([waitTool().tool]),
      now: clock.now,
    }
    expect(await runTurn(sessionId, options)).toMatchObject({ outcome: 'waiting' })

    const firstNews = await notify(store, sessionId, first, { text: 'First is done.' })
    const secondNews = await notify(store, sessionId, second, { text: 'Second is done.' })
    expect(await runTurn(sessionId, options)).toEqual({ outcome: 'idle' })

    // Each wait claimed its own task's news, once: two results, two distinct claims, and a
    // request that reads both.
    const results = of(await logOf(store, sessionId), EVENT_TYPES.agentToolResult)
    expect(results.map((result) => result.consumes)).toEqual([[firstNews.id], [secondNews.id]])
    expect(await store.getPendingTaskNotifications(sessionId)).toHaveLength(0)
    // Both results reached the request that followed, so the model really was told — and told
    // once each: the claims are what keep the news out of the same request as steering.
    expect(model.calls).toHaveLength(2)
    expect(promptAt(model, 1).some((entry) => entry.role === 'tool')).toBe(true)
  })
})

describe('the news stays out of a tool call’s way', () => {
  it('never puts a notification between a call and its result', async () => {
    const { store, sessionId } = await newSession([message('tidy up')])
    const taskId = newTaskId()
    await store.appendEvents(sessionId, [startTask(taskId)])
    // The task reports *while its call is being run* — after the call is stored and before its
    // answer is, which is the one window that would interleave the two in the log.
    const reporting = echo(async () => {
      await notify(store, sessionId, taskId, { text: 'Done researching.' })
    })
    const model = mockModel(
      { text: ['Working.'], toolCalls: [{ name: 'echo', input: { text: 'tidy up' } }] },
      NOTHING,
    )
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      subagents: SUBAGENTS,
      tools: createToolRegistry([reporting, waitTool().tool]),
    })

    const log = await logOf(store, sessionId)
    const types = eventTypes(log)
    const callAt = types.indexOf(EVENT_TYPES.agentToolUse)
    const resultAt = types.indexOf(EVENT_TYPES.agentToolResult)
    const newsAt = types.indexOf(EVENT_TYPES.sessionTaskNotification)
    // The log holds them in the order they happened, whatever the model would make of that...
    expect(callAt).toBeLessThan(newsAt)
    expect(newsAt).toBeLessThan(resultAt)

    // ...and the request that follows answers the call with its result *before* the news, so
    // the provider is never handed an assistant turn whose calls are not the next message.
    const prompt = promptAt(model, 1)
    const toolAt = prompt.findIndex((entry) => entry.role === 'tool')
    const newsFrame = prompt.findIndex((entry) => entry.text.includes('Done researching.'))
    expect(toolAt).toBeGreaterThanOrEqual(0)
    expect(toolAt).toBeLessThan(newsFrame)
  })
})
