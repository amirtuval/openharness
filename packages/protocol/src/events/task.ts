import { z } from 'zod'

import { EventIdSchema, SessionIdSchema, TaskIdSchema } from '../ids'
import type { DeepReadonly } from '../readonly'
import {
  TASK_DESCRIPTION_MAX_LENGTH,
  TASK_SOURCE_KEY_MAX_LENGTH,
  TaskKindSchema,
  TaskNotificationKindSchema,
  TaskStatusSchema,
} from '../tasks'
import { EventSeqSchema, ProcessedAtSchema, QueuedProcessedAtSchema } from './common'

/**
 * The background tasks a session started: what it started (epic #340 decision S4; issue #343),
 * what each one is doing, and what reached the parent model from it.
 *
 * A background task is work a session does not wait for. Starting one returns at once — the
 * tool's result is a handle — and the conversation goes on while it runs, so the parent model
 * learns what happened through the log rather than through a call that blocked. Three events
 * carry the whole of a task's life in the **parent's** log:
 *
 * ```
 *   session.task_started    { task_id, kind, tool_use_id?, child_session_id?, task_type?,
 *                             description }
 *   session.task_status     { task_id, status }        running | idle | failed | stopped
 *   session.task_notification { task_id, kind, text, source_key }   queued, claimed
 * ```
 *
 * The split is the epic's: a client draws a task's card from the parent's log alone
 * (`task_started` names it, `task_status` says what it is doing), live activity is read from
 * the **child's** own stream, and the only thing that reaches the parent model is a
 * notification.
 *
 * A notification is the one **queued** event of the three — its `processed_at` is `null` until
 * a turn claims it, exactly as a `user.*` event's is — because it is addressed to the model
 * rather than being a fact about the session: it is delivered by the parent's brain (folded
 * into the next model request, or starting a turn on an idle session, or resolving a wait),
 * and never placed between a tool call and its result. What it carries is another session's
 * output, so it reaches the model framed as data, never as an instruction — see
 * [`docs/threat-model.md`](../../../docs/threat-model.md).
 *
 * Anthropic has no equivalent: its API has no background task, no way for a child session to
 * reach its parent, and no event a client draws a running task from.
 */

/**
 * // extension: a session started a background task and did not wait for it (S4).
 *
 * `kind` is what kind of task it is ({@link TASK_KINDS} — `subagent` today, and a sandboxed
 * `bash` later), and `child_session_id` is the session the task runs in, when it has one. A
 * task that is not a session of its own — a subprocess, a scheduled job — carries none, which
 * is why the field is optional rather than the task being required to have one.
 *
 * `task_type` is the kind's own sub-kind when it has one (a subagent's type, #342), and
 * `description` is what the task is for, written for a reader rather than for the model. Both
 * are the starter's to say; the brain writes neither — a task is started by the tool that
 * starts it (S4's "the tool's result is the handle"), through the deployment's own append.
 *
 * `tool_use_id` is the **call** that started the task: the id of the `agent.tool_use` whose
 * result was the handle (the event's id *is* the call's id, X1), so a reader places a task's
 * card at the exact call it belongs to instead of guessing by `description` (#345). It is
 * optional because not every task kind is started by a tool call of this log — a future
 * background kind may be started by something else — and because a log stored before the field
 * existed carries none; a reader that finds none falls back to matching by `description`.
 *
 * The epic spells the sub-kind `type` (S4); it is `task_type` here because a stored event's
 * `type` is its own discriminant, and two fields of one object cannot share a name.
 */
export const SessionTaskStartedEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal('session.task_started'),
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
  /** The task's id, `task_`-prefixed: what its statuses and notifications name. */
  task_id: TaskIdSchema,
  /** What kind of background task it is. */
  kind: TaskKindSchema,
  /**
   * The tool call that started it — the id of the `agent.tool_use` whose result was the handle
   * — when a tool call started it. Absent for a kind nothing of this log called, and for a log
   * stored before the field existed.
   */
  tool_use_id: EventIdSchema.optional(),
  /**
   * The session the task runs in, when it has one. Written so a client can follow the task's
   * live activity: the child's own stream is where its progress is, and the parent's log only
   * says what it is doing.
   */
  child_session_id: SessionIdSchema.optional(),
  /** The kind's own sub-kind (a subagent's type, #342), when the starter named one. */
  task_type: z.string().min(1).optional(),
  /** What the task is for, in the starter's words: a card's line, never a prompt. */
  description: z.string().min(1).max(TASK_DESCRIPTION_MAX_LENGTH),
})

/** A stored `session.task_started`, deep-readonly like every event. */
export type SessionTaskStartedEvent = DeepReadonly<z.infer<typeof SessionTaskStartedEventSchema>>

/**
 * // extension: the task's state changed (S4).
 *
 * Written to the **parent's** log as the task changes state — `running` when it starts and
 * whenever it is resumed, `idle` when its turn ends (its notification follows), `failed` when
 * it ends in an error, `stopped` when it is stopped — so a client draws a task's card, and
 * tells a finished task from a running one, from the parent's log alone. The task itself does
 * not report progress: what it is doing *now* is on its own stream.
 *
 * The newest status of a task is its state, so replay answers "what is this task doing?" with
 * a fold rather than with a flag. A log that holds a `task_started` and no status yet reads as
 * a task that has just started.
 */
export const SessionTaskStatusEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal('session.task_status'),
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
  /** The task this is a status of. */
  task_id: TaskIdSchema,
  /** What the task is doing now. */
  status: TaskStatusSchema,
})

/** A stored `session.task_status`, deep-readonly like every event. */
export type SessionTaskStatusEvent = DeepReadonly<z.infer<typeof SessionTaskStatusEventSchema>>

/**
 * // extension: something reached the parent model from a task (S4).
 *
 * The one way anything gets from a task to the model it belongs to. It is a **queued** event:
 * stored with `processed_at: null` and claimed by the parent's brain the way a `user.message`
 * is — by the `consumes` list of the event that answers it — so "has the model been told?"
 * is answered by the log rather than by a flag, and a crash between the append and the claim
 * loses nothing. It is never placed between a tool call and its result: the brain claims it
 * where it claims steering, and where a wait is resolved it *becomes* the wait's result.
 *
 * **Delivery is exactly once** (S4). `source_key` is the task side's own key for this
 * notification — `<child_session_id>:<idle seq>` for a subagent, so the same finished turn
 * cannot be announced twice however many times a recovery path runs — and the append is
 * idempotent on it: a second append naming a key this session's log already holds is a no-op
 * that changes nothing. That is what makes a crash plus a re-delivery neither a loss nor a
 * duplicate.
 *
 * To the model it is a clearly framed user-role message naming the task, and its `text` is
 * **data, not instructions**: a task's output can carry what that session read from the web or
 * from an MCP server, so the frame says so (X11).
 */
export const SessionTaskNotificationEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal('session.task_notification'),
  seq: EventSeqSchema,
  processed_at: QueuedProcessedAtSchema,
  /** The task this came from; it names a `session.task_started` in the same log. */
  task_id: TaskIdSchema,
  /** What happened: a finished turn's output, a message, or a failure. */
  kind: TaskNotificationKindSchema,
  /**
   * The text itself — a task's output, framed as data when the model is told it. Unbounded on
   * purpose: it is what a child produced, and the caps that keep a *request* small
   * (epic #303, X9) are the request's business, not the log's.
   */
  text: z.string(),
  /** The task side's key for this notification; a second append with the same one is a no-op. */
  source_key: z.string().min(1).max(TASK_SOURCE_KEY_MAX_LENGTH),
})

/** A stored `session.task_notification`, deep-readonly like every event. */
export type SessionTaskNotificationEvent = DeepReadonly<
  z.infer<typeof SessionTaskNotificationEventSchema>
>

/** Any stored background-task event. */
export const TaskEventSchema = z.discriminatedUnion('type', [
  SessionTaskStartedEventSchema,
  SessionTaskStatusEventSchema,
  SessionTaskNotificationEventSchema,
])

/** Any stored background-task event, deep-readonly like every event. */
export type TaskEvent = DeepReadonly<z.infer<typeof TaskEventSchema>>
