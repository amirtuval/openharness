import type {
  EventId,
  SessionId,
  TaskId,
  TaskNotificationKind,
  TaskStatus,
} from '@openharness/protocol'
import { EVENT_TYPES, TASK_DESCRIPTION_MAX_LENGTH, TASK_KINDS } from '@openharness/protocol'
import type { SessionStore, TaskNotificationAppend } from '@openharness/session'

/**
 * Background tasks reaching a session from outside it (epic #340 decision S4; issue #343).
 *
 * This is the server's half of the inbox: one function that writes a task's events into the
 * **parent** session's log and wakes it. The store owns the durable parts — the queued
 * notification and the idempotent append on `source_key`
 * (`SessionStore.appendTaskNotification`, `@openharness/session`) — and this owns the two
 * things a store cannot do: writing the events that are not notifications through the same
 * path, and telling the scheduler so a chat reacts on its own instead of waiting for a sweep.
 *
 * What starts a task is [#344](https://github.com/amirtuval/openharness/issues/344) (a subagent
 * tool) and, as a test hook, `./test-tasks`; what a task *is* is nothing here's business — a
 * subagent is the first kind and a sandboxed `bash` will be the second.
 *
 * Nothing about this is fenced: an append with no `fence` is what a task's side makes, exactly
 * as the API appends a user's message. A notification is a queued event, so the owner's brain
 * claims it; the signal is a latency optimization and a lost one costs nothing (the store's
 * work scan finds a session holding unclaimed news).
 */

/** What a task's side needs to report into a session: the log, and the way to wake its owner. */
export interface TaskNotifierDeps {
  /** The session log the task's events go into — its parent's. */
  readonly store: SessionStore
  /** Tell the scheduler a session has something to do; the routes' own seam (`SessionScheduler`). */
  readonly signal: (sessionId: SessionId, kind: 'work' | 'interrupt') => void
}

/** What {@link TaskNotifier.startTask} writes: the task, and what it is for. */
export interface StartTaskInput {
  /** The task's id — the caller's, so it can name it in the handle it returns at once. */
  readonly taskId: TaskId
  /** The session the task runs in, when it has one. */
  readonly childSessionId?: SessionId
  /**
   * The tool call that started it, when a tool call did — the id of the `agent.tool_use` whose
   * result was the handle (the event's id *is* the call's id). A card is drawn at that call
   * rather than matched to it by description, so a starter that has the id passes it on.
   */
  readonly toolUseId?: EventId
  /** The kind's own sub-kind (a subagent's type, #342), when the starter named one. */
  readonly taskType?: string
  /** What the task is for — a card's line, bounded by the protocol. */
  readonly description: string
}

/** What {@link TaskNotifier.notify} writes: one piece of news from a task. */
export interface NotifyTaskInput {
  /** The session the news is for — the task's parent. */
  readonly sessionId: SessionId
  /** The task it came from. */
  readonly taskId: TaskId
  /** What happened: a finished turn's output, a message, or a failure. */
  readonly kind: TaskNotificationKind
  /** The text itself; a task's output, bounded by nothing but what the task produced. */
  readonly text: string
  /**
   * The task side's own key for this piece of news, e.g. `<child_session_id>:<idle seq>`.
   *
   * The whole of what makes delivery exactly once (S4): the append is idempotent on it, so a
   * retry, a recovery path or a second instance storing the same news changes nothing.
   */
  readonly sourceKey: string
}

/** The inbox: what anything that runs a background task says about it. */
export interface TaskNotifier {
  /** Record that a task started, and that it is running, in its parent's log. */
  startTask(sessionId: SessionId, input: StartTaskInput): Promise<void>
  /** Record what a task is doing now (`running` again when it is resumed, `stopped`, …). */
  setStatus(sessionId: SessionId, taskId: TaskId, status: TaskStatus): Promise<void>
  /**
   * Put a task's news in its parent's log, **once per `sourceKey`**, and wake the parent.
   *
   * The one way anything reaches a parent model from a task (S4). `appended: false` means this
   * news was already there — the caller learned nothing it did not know, and the parent will be
   * told exactly once.
   */
  notify(input: NotifyTaskInput): Promise<TaskNotificationAppend>
}

/**
 * The inbox, over one store and one scheduler.
 *
 * Built once per process (`main.ts`) and handed to whatever starts tasks. The signal is always
 * sent, even when the notification was already in the log: a redundant wake costs a turn that
 * finds nothing to do, while a *missing* one leaves a chat sitting on news until the next sweep
 * — and "signals are hints, the log is the record" is about which of the two failures is
 * acceptable, not about the log being wrong.
 */
export function createTaskNotifier(deps: TaskNotifierDeps): TaskNotifier {
  const { store, signal } = deps
  return {
    async startTask(sessionId, input) {
      await store.appendEvents(sessionId, [
        {
          type: EVENT_TYPES.sessionTaskStarted,
          task_id: input.taskId,
          kind: TASK_KINDS[0],
          ...(input.toolUseId === undefined ? {} : { tool_use_id: input.toolUseId }),
          ...(input.childSessionId === undefined ? {} : { child_session_id: input.childSessionId }),
          ...(input.taskType === undefined ? {} : { task_type: input.taskType }),
          description: taskDescription(input.description),
        },
        {
          type: EVENT_TYPES.sessionTaskStatus,
          task_id: input.taskId,
          status: 'running',
        },
      ])
    },

    async setStatus(sessionId, taskId, status) {
      await store.appendEvents(sessionId, [
        { type: EVENT_TYPES.sessionTaskStatus, task_id: taskId, status },
      ])
    },

    async notify(input) {
      const result = await store.appendTaskNotification(input.sessionId, {
        taskId: input.taskId,
        kind: input.kind,
        text: input.text,
        sourceKey: input.sourceKey,
      })
      signal(input.sessionId, 'work')
      return result
    },
  }
}

/**
 * The description a task's card and the model's frame are written from, bounded like every
 * other free-text field a caller sets — a starter that passed something enormous gets the
 * front of it rather than a refusal, because a task that started is worse to lose than a card
 * that reads short.
 *
 * @param description what the task is for
 */
export function taskDescription(description: string): string {
  const collapsed = description.replace(/\s+/g, ' ').trim()
  const capped =
    collapsed.length === 0
      ? 'A background task'
      : collapsed.length <= TASK_DESCRIPTION_MAX_LENGTH
        ? collapsed
        : `${collapsed.slice(0, TASK_DESCRIPTION_MAX_LENGTH - 1).trimEnd()}…`
  return capped
}
