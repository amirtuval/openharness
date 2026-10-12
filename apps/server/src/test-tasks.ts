import type { SessionId, TaskId } from '@openharness/protocol'
import {
  EVENT_TYPES,
  TASK_WAIT_DEFAULT_TIMEOUT_MS,
  TASK_WAIT_MAX_TIMEOUT_MS,
  TASK_WAIT_TOOL_NAME,
  TaskWaitInputSchema,
  newTaskId,
} from '@openharness/protocol'
import type { ToolDefinition } from '@openharness/hands'
import { errorResult, textResult } from '@openharness/hands'
import type { AppendableEvent, SessionStore } from '@openharness/session'
import { z } from 'zod'

import { taskDescription } from './tasks'
import type { TaskNotifier } from './tasks'

/**
 * The test hooks for background tasks (epic #340, S4; issue #343).
 *
 * The mechanism is what #344 will use; before a subagent exists, the only way to exercise it
 * end to end — through the real server, scheduler, brain, store and log — is a task the test
 * model can start. This module is that, and it is wired only under
 * `OPENHARNESS_TEST_MODEL=mock`, exactly as `testEchoTool` and the mock model are:
 *
 * - {@link testTaskTool} is a tool that **returns at once** and does nothing itself: its result
 *   is the handle a real background tool returns (`task_id`, `type`, `running`).
 * - {@link withTestBackgroundTasks} is a **store proxy** that watches for a call to it and does
 *   the task's side of the story: it records the start in the parent's log, and after the delay
 *   the call asked for it records the status and the notification.
 *
 * A tool cannot write to the log — `ToolRunContext` is a signal and a secret map, and the tool
 * has no idea which session it was called in — so the delivery belongs to the process that
 * owns the store, which is what the proxy is. It is deliberately the *same* shape as the
 * `withSessionTraces` proxy (#158): one seam, forwarding everything, acting on the appends it
 * cares about.
 *
 * **What the tests rely on.** The handle's `task_id` is chosen by the *model's* call — the mock
 * model mints it with `newTaskId()` and puts it in the tool's arguments — so the handle the
 * model reads and the events the parent's log holds name one task without the proxy having to
 * report back to the tool. A real background tool mints its own id and writes its own
 * `session.task_started` through {@link TaskNotifier}, which is why the notifier exists
 * separately from this.
 */

/** The name of the test background tool; the mock model calls it by this name. */
export const TEST_TASK_TOOL_NAME = 'task_start'

/** What the test background tool says it does — written for a model, since a model reads it. */
export const TEST_TASK_TOOL_DESCRIPTION =
  'Start a background task that reports back later. Returns a handle at once.'

/** How long a test task waits before it reports, when the call does not say. */
export const TEST_TASK_DELAY_MS = 25

/** What the test background tool's arguments are, as the mock model builds them. */
export const TestTaskInputSchema = z.object({
  /** The task's id: the caller's, so the handle and the log name one task. */
  task_id: z.string().optional(),
  /** What the task is for. */
  description: z.string().optional(),
  /** How long it works before it reports, in milliseconds. */
  delay_ms: z.number().optional(),
})

/** The arguments a test background call may carry. */
export type TestTaskInput = z.infer<typeof TestTaskInputSchema>

/**
 * `task_start`: the test background tool.
 *
 * It returns the handle and nothing else — the task's own side is {@link
 * withTestBackgroundTasks}'s — so a turn that calls it goes straight on, which is the whole
 * point of a background task (S4).
 */
export const testTaskTool: ToolDefinition<TestTaskInput> = {
  name: TEST_TASK_TOOL_NAME,
  description: TEST_TASK_TOOL_DESCRIPTION,
  inputSchema: TestTaskInputSchema,
  permission: 'allow',
  run: (input) =>
    textResult(
      JSON.stringify({
        task_id: input.task_id ?? newTaskId(),
        type: 'test',
        status: 'running',
      }),
    ),
}

/**
 * `agent_wait`: the tool a model waits for background tasks with (S5).
 *
 * Registered here, under the test model only, because #344 owns the tool a deployment offers:
 * what the brain needs for the mechanism to work is a *name* it recognises, and a registry that
 * holds it. Its `run` is never called — a wait is not something a tool executes, exactly as
 * `ask_user`'s answers are not — so it answers with a sentence saying so, which only a host
 * that ran it by hand could ever see.
 */
export const testTaskWaitTool: ToolDefinition<unknown> = {
  name: TASK_WAIT_TOOL_NAME,
  description:
    'Wait for background tasks you started to report back. Returns what they said, or times ' +
    `out after ${TASK_WAIT_DEFAULT_TIMEOUT_MS / 60_000} minutes ` +
    `(${TASK_WAIT_MAX_TIMEOUT_MS / 3_600_000} at most).`,
  inputSchema: TaskWaitInputSchema,
  permission: 'allow',
  run: () => errorResult('agent_wait is answered by the log, not by running it.'),
}

/** What {@link withTestBackgroundTasks} needs. */
export interface TestBackgroundTasksOptions {
  /** The inbox the task's events are written through. */
  readonly tasks: TaskNotifier
  /** How long a task waits before reporting when the call does not say; default 25 ms. */
  readonly delayMs?: number
  /**
   * Schedule the delayed delivery. Injected so a test can drive the timers by hand; the
   * default is `setTimeout`, `unref`'d so a task that never reports cannot hold a process up.
   */
  readonly schedule?: (work: () => void, delayMs: number) => void
}

/**
 * Wrap a store so that a call to {@link testTaskTool} becomes a task that reports later.
 *
 * Every append is forwarded unchanged, and the batch is scanned for the one thing this cares
 * about: an `agent.tool_use` naming {@link TEST_TASK_TOOL_NAME}. Seeing one, it starts the task
 * in that session's log — with the id the call carried, so the handle the model was given and
 * the events the log holds agree — and schedules what a real task's turn would write when it
 * ends: `session.task_status { idle }` and the notification that carries what it produced.
 *
 * Delivery goes through {@link TaskNotifier.notify}, so it is the **same** idempotent path a
 * subagent will use, keyed by `<task_id>:1`: a test can call it twice and see one notification.
 *
 * @param store the store the server runs on
 * @param options the inbox, the delay and the timer
 */
export function withTestBackgroundTasks(
  store: SessionStore,
  options: TestBackgroundTasksOptions,
): SessionStore {
  const schedule =
    options.schedule ??
    ((work: () => void, delayMs: number): void => {
      const timer = setTimeout(work, delayMs)
      timer.unref?.()
    })
  const defaultDelay = options.delayMs ?? TEST_TASK_DELAY_MS
  return new Proxy(store, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, receiver) as unknown
      if (property !== 'appendEvents' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value
      }
      return async (sessionId: SessionId, events: AppendableEvent[], ...rest: unknown[]) => {
        const appended = await store.appendEvents(sessionId, events, ...(rest as never[]))
        for (const event of appended) {
          if (event.type !== EVENT_TYPES.agentToolUse || event.name !== TEST_TASK_TOOL_NAME) {
            continue
          }
          const input = event.input as TestTaskInput
          const taskId = (input.task_id ?? newTaskId()) as TaskId
          const delayMs = typeof input.delay_ms === 'number' ? input.delay_ms : defaultDelay
          void startTestTask(options.tasks, sessionId, taskId, input, delayMs, schedule)
        }
        return appended
      }
    },
  })
}

/**
 * The task's own side, run once a call to the test tool is in the log: start it, then report.
 *
 * A failure is swallowed on purpose — a test hook that took the process down over its own
 * delivery would be worse than one that did not deliver — and the notification itself is
 * idempotent, so a retry from anywhere is safe.
 */
async function startTestTask(
  tasks: TaskNotifier,
  sessionId: SessionId,
  taskId: TaskId,
  input: TestTaskInput,
  delayMs: number,
  schedule: (work: () => void, delayMs: number) => void,
): Promise<void> {
  try {
    await tasks.startTask(sessionId, {
      taskId,
      description: taskDescription(input.description ?? 'A test background task'),
    })
  } catch {
    return
  }
  schedule(() => {
    void (async () => {
      try {
        await tasks.setStatus(sessionId, taskId, 'idle')
        await tasks.notify({
          sessionId,
          taskId,
          kind: 'result',
          text: `The background task finished a turn. ${TEST_TASK_RESULT}`,
          sourceKey: `${taskId}:1`,
        })
      } catch {
        // Swallowed: see above — the test's own assertions are what say whether it reported.
      }
    })()
  }, delayMs)
}

/** What a test task reports, in its own words — a body a test can look for in the log. */
export const TEST_TASK_RESULT = 'Nothing to report yet.'
