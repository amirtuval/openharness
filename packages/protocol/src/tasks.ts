import { z } from 'zod'

import { TaskIdSchema } from './ids'

/**
 * Background tasks: the vocabulary a session's log, its brain and the tool that starts one all
 * agree on (epic #340 decision S4; issue #343).
 *
 * A background task is work a session starts and does not wait for: starting one returns at
 * once, the conversation goes on while it runs, and what it produces reaches the parent model
 * as a **notification** rather than as a tool result. The mechanism is deliberately generic —
 * a subagent is the first kind of task, and a sandboxed `bash` will be the second — so nothing
 * here knows what a task *is*: the kinds are a closed list a later issue widens, and the whole
 * of a task's life in the parent's log is three events
 * (`session.task_started`, `session.task_status`, `session.task_notification`).
 *
 * The pieces that are not wire shapes live here too, because three packages have to agree on
 * them and none owns them:
 *
 * - {@link TASK_WAIT_TOOL_NAME} — the one tool whose call ends a turn in a **durable wait**
 *   (S5) rather than in a model request, spelled once for the brain (which recognises the call)
 *   and for the deployment that registers the tool.
 * - {@link TaskWaitInputSchema} and {@link taskWaitTimeoutMs} — what a wait asks for and how
 *   long it may last, so the brain and the tool that offers it agree on the bounds.
 * - the names and inputs of the subagent tools (S5; #344) — {@link AGENT_TOOL_NAME},
 *   {@link AGENT_MESSAGE_TOOL_NAME}, {@link AGENT_STOP_TOOL_NAME}, {@link MESSAGE_PARENT_TOOL_NAME}
 *   and their schemas — and the two nesting limits of S6 ({@link DEFAULT_MAX_AGENT_DEPTH},
 *   {@link DEFAULT_MAX_LIVE_TASKS}), because the deployment that offers the tools, the harness
 *   that answers them and the frontends that render a task's card all have to agree on them.
 */

/** The kinds of background task this build knows (S4). */
export const TASK_KINDS = [
  /**
   * A child session the parent started and does not wait for (A2's types, #342; the tool that
   * starts one: #344). The parent's log records the child's session id beside it.
   */
  'subagent',
] as const

/** One kind of background task. */
export type TaskKind = (typeof TASK_KINDS)[number]

/** The kind a `session.task_started` names. */
export const TaskKindSchema = z.enum(TASK_KINDS)

/**
 * What a task is doing, as the parent's log records it (S4).
 *
 * - `running` — the task is working. Written when it starts, and again if it is resumed.
 * - `idle` — the task's turn ended: what it produced reached the parent as a notification, and
 *   nothing is running for it until something asks it to continue.
 * - `failed` — the task ended in an error. The notification beside it says so.
 * - `stopped` — the task was stopped (a delete, an interrupt of the child, a parent going
 *   away). It will not run again.
 *
 * A status change is written to the **parent's** log as the child changes state, so a client
 * draws the card from the parent's log alone; live activity is read from the child's own
 * stream, and the child never reports progress.
 */
export const TASK_STATUSES = ['running', 'idle', 'failed', 'stopped'] as const

/** One task status. */
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** The status a `session.task_status` records. */
export const TaskStatusSchema = z.enum(TASK_STATUSES)

/**
 * What a notification says happened (S4).
 *
 * - `result` — the task finished a turn and this is what it produced. The text is the child's
 *   own output.
 * - `message` — something the task's session said to its parent that is not a finished turn
 *   (a question, a note).
 * - `failed` — the task's turn ended in an error; the text says what happened.
 */
export const TASK_NOTIFICATION_KINDS = ['result', 'message', 'failed'] as const

/** One notification kind. */
export type TaskNotificationKind = (typeof TASK_NOTIFICATION_KINDS)[number]

/** The kind a `session.task_notification` carries. */
export const TaskNotificationKindSchema = z.enum(TASK_NOTIFICATION_KINDS)

/**
 * The longest `description` a `session.task_started` may carry.
 *
 * Bounded like every other free-text field a caller sets (`SESSION_TITLE_MAX_LENGTH`,
 * `COMPACT_INSTRUCTIONS_MAX_LENGTH`): enough to say what the task is for, short enough that it
 * cannot smuggle a second prompt into a card or bloat the log. The notification's `text` is
 * deliberately **not** bounded — it is a task's output, as unbounded as a tool result.
 */
export const TASK_DESCRIPTION_MAX_LENGTH = 500

/**
 * The longest `source_key` a notification may carry.
 *
 * The key is what makes delivery exactly once (S4): the parent's append is idempotent on it, so
 * it is an identifier written by the task's own side — `<child_session_id>:<idle seq>` for a
 * subagent — and not free text. Bounded so a log row cannot be made large by it.
 */
export const TASK_SOURCE_KEY_MAX_LENGTH = 200

/**
 * The name of the tool whose call is a **durable wait** (S5): `agent_wait { task_ids?,
 * timeout_s? }`.
 *
 * It is spelled once because two sides have to agree on it and neither owns it: the brain
 * recognises a call of this name and ends the turn `waiting_on_tasks` instead of running
 * anything, and the deployment registers the tool the model is offered. Its `run` is never
 * called — a wait is not something a tool executes, exactly as `ask_user`'s answers are not.
 */
export const TASK_WAIT_TOOL_NAME = 'agent_wait'

/** How long a wait lasts when the call does not ask for a time (S5): ten minutes. */
export const TASK_WAIT_DEFAULT_TIMEOUT_MS = 600_000

/** The longest a wait may last (S5): one hour, whatever the call asks for. */
export const TASK_WAIT_MAX_TIMEOUT_MS = 3_600_000

/**
 * What an `agent_wait` call carries (S5): the tasks to wait for, and how long to wait.
 *
 * Both are optional and both absences mean something. No `task_ids` waits for **any** task's
 * notification — "tell me when anything I started finishes" — and no `timeout_s` takes
 * {@link TASK_WAIT_DEFAULT_TIMEOUT_MS}. The bounds are the brain's to apply
 * ({@link taskWaitTimeoutMs}), so a call asking for a week waits an hour rather than holding a
 * session for one.
 */
export const TaskWaitInputSchema = z.object({
  /** The tasks this wait is for; absent or empty means any task of this session. */
  task_ids: z.array(TaskIdSchema).optional(),
  /** How long to wait, in seconds; absent means the default. */
  timeout_s: z.number().optional(),
})

/** What an `agent_wait` call carries. */
export type TaskWaitInput = z.infer<typeof TaskWaitInputSchema>

/**
 * What is wrong with an `agent_wait` call's arguments, or `[]` when they are a wait.
 *
 * The check the brain answers a malformed call with, so a wait on arguments nobody can honour
 * is a result the model learns from rather than a turn that pauses on it — the rule
 * `ask_user`'s questions follow (`askUserInputProblems`). Written against the call's raw
 * arguments, which is what the log holds.
 */
export function taskWaitInputProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [
      'the arguments must be an object: an optional `task_ids` list and an optional `timeout_s`',
    ]
  }
  const problems: string[] = []
  const { task_ids: taskIds, timeout_s: timeout } = value as {
    readonly task_ids?: unknown
    readonly timeout_s?: unknown
  }
  if (taskIds !== undefined) {
    if (!Array.isArray(taskIds) || !taskIds.every((id) => TaskIdSchema.safeParse(id).success)) {
      problems.push('`task_ids` must be a list of `task_` ids')
    }
  }
  if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout))) {
    problems.push('`timeout_s` must be a number of seconds')
  }
  return problems
}

/**
 * Parse an `agent_wait` call's arguments, or `null` when they are not a wait.
 *
 * The one reading the brain and the tool's own input schema share, so "what does this call ask
 * for?" has one answer. A call {@link taskWaitInputProblems} refuses is not a wait: the model is
 * told what was wrong with it and asks again, rather than the turn pausing on something nobody
 * can honour (the rule `ask_user`'s questions follow).
 */
export function parseTaskWaitInput(value: unknown): TaskWaitInput | null {
  if (taskWaitInputProblems(value).length > 0) {
    return null
  }
  const parsed = TaskWaitInputSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * How long a wait lasts: what the call asked for, capped (S5).
 *
 * A call that asked for nothing waits {@link TASK_WAIT_DEFAULT_TIMEOUT_MS}, a call that asked
 * for more than {@link TASK_WAIT_MAX_TIMEOUT_MS} waits that, and a call that asked for
 * something that is not a positive number waits the default — a wait of zero would be a pause
 * that resolves as soon as it is taken, which is not what any model means by asking for one.
 */
export function taskWaitTimeoutMs(input: TaskWaitInput | null): number {
  const asked = input?.timeout_s
  if (typeof asked !== 'number' || !Number.isFinite(asked) || asked <= 0) {
    return TASK_WAIT_DEFAULT_TIMEOUT_MS
  }
  return Math.min(Math.round(asked * 1000), TASK_WAIT_MAX_TIMEOUT_MS)
}

/**
 * The name of the tool that starts a helper (S5): `agent { type, description, prompt }`.
 *
 * It is the one tool that starts a task, and its result is the handle — so it is spelled once
 * for the deployment that offers it, the brain that answers it, and the frontends that render
 * the card it produces. A call to it is not run by `@openharness/hands`: the harness itself
 * creates the child, which is why the name is here rather than in a tool's own module.
 */
export const AGENT_TOOL_NAME = 'agent'

/** The name of the tool that sends a running or finished helper a message (S5): `agent_message`. */
export const AGENT_MESSAGE_TOOL_NAME = 'agent_message'

/** The name of the tool that stops a helper (S5): `agent_stop`. */
export const AGENT_STOP_TOOL_NAME = 'agent_stop'

/**
 * The name of the tool a **child** sends its parent a note with (S5): `message_parent`.
 *
 * The one tool only a child is offered — the other four belong to the parent side — and it does
 * not block: it writes a `message` notification and returns.
 */
export const MESSAGE_PARENT_TOOL_NAME = 'message_parent'

/**
 * What an `agent` call carries (S5): which type to start, what for, and the prompt.
 *
 * `type` is a name the server's type resolver knows (`general-purpose`, or one of the owner's
 * modes with a description, S2) and is deliberately **not** checked against a closed list here:
 * the list is the owner's own and moves with their modes, so "is this a type" is the resolver's
 * answer (`{ ok: false, message }`), which the parent model reads and acts on.
 *
 * `description` is what the task is for — it is the `description` of the `session.task_started`
 * the call writes and what a card shows — and is bounded like every other free text a caller
 * sets (`TASK_DESCRIPTION_MAX_LENGTH`). `prompt` is not: it becomes the child's first
 * `user.message`, as unbounded as any message.
 */
export const AgentToolInputSchema = z.object({
  /** The type of helper to start: a mode's name, or `general-purpose`. */
  type: z.string().min(1),
  /** What the helper is for, in a sentence; the task's description. */
  description: z.string().min(1).max(TASK_DESCRIPTION_MAX_LENGTH),
  /** What the helper is asked to do — its first `user.message`, and its whole context. */
  prompt: z.string().min(1),
})

/** What an `agent` call carries. */
export type AgentToolInput = z.infer<typeof AgentToolInputSchema>

/**
 * What an `agent_message` call carries (S5): the task to steer, and what to say.
 *
 * The text is a `user.message` in the child — it steers a running child, and starts a new turn
 * on one that has already reported, with its context intact — so it is unbounded like any other
 * message.
 */
export const AgentMessageToolInputSchema = z.object({
  /** The task to send the message to; its `task_` id, as the `agent` call answered it. */
  task_id: TaskIdSchema,
  /** What to tell the child. */
  text: z.string().min(1),
})

/** What an `agent_message` call carries. */
export type AgentMessageToolInput = z.infer<typeof AgentMessageToolInputSchema>

/** What an `agent_stop` call carries (S5): the task to interrupt. */
export const AgentStopToolInputSchema = z.object({
  /** The task to stop; its `task_` id. */
  task_id: TaskIdSchema,
})

/** What an `agent_stop` call carries. */
export type AgentStopToolInput = z.infer<typeof AgentStopToolInputSchema>

/**
 * What a child's `message_parent` call carries (S5): a note to the parent.
 *
 * One field, because there is nothing else to say about it: the parent is the session's own
 * (`Session.parent_session_id`) and the task is its own `parent_task_id`, so a child cannot
 * address anybody else. The text is delivered as a `message` notification, framed the way a
 * result is.
 */
export const MessageParentToolInputSchema = z.object({
  /** What to tell the parent. */
  text: z.string().min(1),
})

/** What a `message_parent` call carries. */
export type MessageParentToolInput = z.infer<typeof MessageParentToolInputSchema>

/**
 * How deep a tree of helpers may get when the deployment says nothing (S6): a top-level chat
 * (depth 0), its children (1) and their children (2) are offered the tools that start one; a
 * session at depth 3 is not.
 */
export const DEFAULT_MAX_AGENT_DEPTH = 3

/**
 * How many descendants of one root chat may be live at once when the deployment says nothing
 * (S6): ten. Past it an `agent` call is answered with an `is_error` the model can act on rather
 * than starting anything.
 */
export const DEFAULT_MAX_LIVE_TASKS = 10
