import {
  AGENT_MESSAGE_TOOL_NAME,
  AGENT_STOP_TOOL_NAME,
  AGENT_TOOL_NAME,
  EVENT_TYPES,
  TASK_WAIT_TOOL_NAME,
  toolCallInput,
  toolCallOfferedName,
} from '@openharness/protocol'
import type {
  DeepReadonly,
  EventId,
  SessionId,
  StoredEvent,
  TaskKind,
  TaskNotificationKind,
  TaskStatus,
  ToolInput,
} from '@openharness/protocol'

/**
 * The task view both frontends share (epic #340, decision S9; issue #345).
 *
 * A chat can hand work to **background tasks** — a subagent today, a sandboxed `bash` later —
 * and both the web app and `oh` draw the same card for one. The parent's log is the whole of
 * the card except its live activity: three event types ({@link tasksFromEvents} reads them)
 * say what a task is, what it is doing and what reached the model from it, and everything a
 * reader sees in the card is derived here rather than stored twice.
 *
 * What this module does **not** know is what the child is doing *right now* — its current tool
 * call, its task list, its tokens. The child does not report progress (the epic's S4), so that
 * is read from the **child's own log** by `./task-activity`, and a frontend merges the two:
 * the card's {@link TaskCard.status} with the child's own stream, through
 * {@link taskCardStatus}.
 *
 * Everything here is pure — events in, plain data out — which is what lets the cards be
 * tested over fixture logs and rendered by React and Ink alike.
 */

/**
 * The status a card draws (epic #340, S9).
 *
 * Five words, and they are not the protocol's four: the parent's log records `running`,
 * `idle`, `failed` and `stopped` (the protocol's {@link TaskStatus}), and a card says **done** for an `idle`
 * task whose result was delivered, and **waiting** for a task the parent's log still calls
 * `running` but whose own session is paused in an `agent_wait` — a distinction only the
 * child's log can make, which is why {@link taskCardStatus} takes it as its own input.
 */
export type TaskCardStatus = 'running' | 'waiting' | 'done' | 'failed' | 'stopped'

/**
 * One line of the conversation between a parent and a task, in the parent's log's own words.
 *
 * `parent` is something the parent told the child — an `agent_message` call's `text`, which is
 * a `user.message` in the child's log; `child` is something the child said back, a `message`
 * notification. Both are drawn inline in the card (`→ researcher: …`, `researcher →: …`), in
 * the order they happened.
 */
export interface TaskMessage {
  /** Which way it went: the parent told the child, or the child told the parent. */
  readonly from: 'parent' | 'child'
  /** What was said. */
  readonly text: string
  /** Where it sits in the **parent's** log: the call's or the notification's own `seq`. */
  readonly seq: number
}

/**
 * What a task finished a turn with — the text a card folds in (epic #340, S4/S9).
 *
 * The newest `result` or `failed` notification the parent's log holds, which is the task's
 * latest outcome: a child continued with `agent_message` produces a second one, and the card
 * shows the newest. A `message` notification is **not** an outcome — it is a line in the
 * conversation ({@link TaskMessage}) — which is why it is excluded here.
 */
export interface TaskResult {
  /** Whether the turn produced output, or ended in an error. */
  readonly kind: Exclude<TaskNotificationKind, 'message'>
  /** The notification's `text`: the child's own words, or what went wrong. */
  readonly text: string
  /** Where the notification sits in the parent's log. */
  readonly seq: number
}

/**
 * One background task, as the parent's log records it (epic #340, S4; issue #345).
 *
 * The card the reader sees: what the task is, where it came from, what it is doing, what was
 * said between it and the parent, and what it last produced. The one thing missing is the live
 * activity line, which is the child's own log's — see `./task-activity`.
 */
export interface TaskCard {
  /** The task's id: the `task_` handle the tools take, and what its events name. */
  readonly id: string
  /** What kind of task it is: `subagent` today (epic #340, S4). */
  readonly kind: TaskKind
  /**
   * The session the task runs in, when it has one.
   *
   * A subagent does; the kinds a later issue adds (a subprocess, a scheduled job) may not,
   * which is why the field is nullable rather than the task being required to have one. A card
   * offers **Open** only when there is a session to open.
   */
  readonly childSessionId: SessionId | null
  /** The kind's own sub-kind — a subagent type, #342 — or `null` when the starter named none. */
  readonly type: string | null
  /** What the task is for, in the starter's words: the card's own line. */
  readonly description: string
  /**
   * What the card's status line says.
   *
   * Derived from the parent's log alone, so it is `running`, `done`, `failed` or `stopped` —
   * **never `waiting`**, which only the child's own log can say. {@link taskCardStatus} is
   * where the two are combined.
   */
  readonly status: TaskCardStatus
  /** What the parent and the child said to each other, in the order it happened. */
  readonly messages: readonly TaskMessage[]
  /** The newest turn the task finished with, or `null` while it has produced nothing. */
  readonly result: TaskResult | null
  /**
   * Where the card draws: the `seq` of the `agent` call that started the task.
   *
   * The task's own `session.task_started` arrives a step later — the tool writes it while it
   * runs — and it names that call in `tool_use_id`, so the card sits exactly where the call is
   * (see {@link tasksFromEvents}). A start **without** the field (a log stored before it
   * existed) is matched to the nearest unmatched `agent` call with its own description
   * instead, and one whose call the log no longer holds — a trimmed replay — falls back to the
   * start event's own `seq`, which is where the call's two suppressed lines would have been
   * anyway. Either way it is the position the transcript's `agent*` call was **not** drawn at
   * ({@link TranscriptState.taskEvents}): the card takes its place.
   */
  readonly position: number
}

/**
 * The parent-side tools that are a task's machinery rather than a tool line (epic #340, S5).
 *
 * A card draws where the `agent` call is, an `agent_message` draws as a line of its own
 * inside it, and `agent_wait` / `agent_stop` are the reader's own affordances rather than
 * something the model did worth a line — so none of the four is drawn as an ordinary tool call
 * (S9). The names are the protocol's own (#344 spells them once for the deployment that offers
 * them, the brain that answers them and the frontends that draw the card), gathered here so a
 * frontend does not have to list them again; `message_parent` is deliberately **not** one of
 * them, because it is a **child's** tool and never appears in the parent's log.
 */
export const TASK_TOOL_NAMES = [
  AGENT_TOOL_NAME,
  AGENT_MESSAGE_TOOL_NAME,
  TASK_WAIT_TOOL_NAME,
  AGENT_STOP_TOOL_NAME,
] as const

/**
 * Whether a tool call is one of the task machinery's own (epic #340, S9).
 *
 * The test the transcript suppresses a tool line with, and the one a frontend uses when it
 * decides which calls a card stands in for. It is the four names and nothing else: a remote
 * MCP server's tool is offered as `<server>__<tool>`, so no server can borrow the `agent`
 * prefix.
 *
 * @param name the name the model called the tool by
 */
export function isTaskToolName(name: string): boolean {
  return (TASK_TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * The status a card draws, given what the child's own stream says (epic #340, S9).
 *
 * The refinement agreed with the maintainer: the parent's `task_status` stays
 * `running | idle | failed | stopped`, and **waiting** is the child's own fact — its last
 * `session.status_idle` ended with `waiting_on_tasks` — so a frontend that is watching the
 * child passes it in here. Only a task the parent still calls `running` can be waiting;
 * anything else — a task that finished, failed or was stopped — has an answer waiting cannot
 * improve on.
 *
 * @param status the status the parent's log derived ({@link TaskCard.status})
 * @param waiting whether the child's own log says it is paused in an `agent_wait`
 */
export function taskCardStatus(status: TaskCardStatus, waiting: boolean): TaskCardStatus {
  return waiting && status === 'running' ? 'waiting' : status
}

/**
 * The tasks a session's log holds, in the order a card draws (epic #340, S4; issue #345).
 *
 * One pass over the events, and the whole card comes out of it:
 *
 * - `session.task_started` opens a card and places it at the `agent` call that started it —
 *   the call whose id its `tool_use_id` names, or, for a start without one, the nearest
 *   unmatched `agent` call carrying its description;
 * - `session.task_status` moves the status, the newest one winning;
 * - `session.task_notification` adds a line (`message`) or the latest outcome (`result` /
 *   `failed`);
 * - an `agent_message` call adds the parent's own half of the conversation.
 *
 * The status is the parent's four words mapped onto the card's five: `stopped` and `failed`
 * are themselves, `idle` is **done** once a result has been delivered (S9) — and, before one
 * has been, still `running`, because a turn that ended without telling the parent anything is
 * not a completion — and `running` is `running`.
 *
 * A log that holds an `agent.tool_result` or an unrelated call simply has nothing to say here:
 * the derivation reads the task events and the `agent*` calls, and ignores everything else, so
 * it can be handed a whole session log or just the events a transcript kept.
 *
 * @param events the events to fold, in log order — a whole session's log, or a transcript's
 *   task events
 */
export function tasksFromEvents(events: Iterable<StoredEvent>): readonly TaskCard[] {
  const builders = new Map<string, Builder>()
  // The `agent` calls the log has offered and no start has claimed yet, oldest first. A start
  // names its call in `tool_use_id`, which is the exact join; the order and the description
  // matter only for a start that carries none (a log stored before the field existed), where
  // the match is the nearest unmatched call with the same description — which keeps a call that
  // started nothing (one the live-task limit refused) from stealing a later task's place.
  const calls: AgentCall[] = []

  for (const event of events) {
    if (event.type === EVENT_TYPES.agentToolUse) {
      const name = toolCallOfferedName(event)
      const input = toolCallInput(event)
      if (name === AGENT_TOOL_NAME) {
        calls.push({ id: event.id, seq: event.seq, description: stringField(input, 'description') })
      } else if (name === AGENT_MESSAGE_TOOL_NAME) {
        const taskId = stringField(input, 'task_id')
        const text = stringField(input, 'text')
        const builder = taskId === null ? undefined : builders.get(taskId)
        if (builder !== undefined && text !== null) {
          builder.messages.push({ from: 'parent', text, seq: event.seq })
        }
      }
      continue
    }

    if (event.type === EVENT_TYPES.sessionTaskStarted) {
      const builder: Builder = {
        id: event.task_id,
        kind: event.kind,
        childSessionId: event.child_session_id ?? null,
        type: event.task_type ?? null,
        description: event.description,
        parentStatus: 'running',
        messages: [],
        result: null,
        position: claimCall(calls, event.tool_use_id, event.description) ?? event.seq,
      }
      builders.set(event.task_id, builder)
      continue
    }

    if (event.type === EVENT_TYPES.sessionTaskStatus) {
      const builder = builders.get(event.task_id)
      if (builder !== undefined) {
        builder.parentStatus = event.status
      }
      continue
    }

    if (event.type === EVENT_TYPES.sessionTaskNotification) {
      const builder = builders.get(event.task_id)
      if (builder === undefined) {
        continue
      }
      if (event.kind === 'message') {
        builder.messages.push({ from: 'child', text: event.text, seq: event.seq })
      } else {
        builder.result = { kind: event.kind, text: event.text, seq: event.seq }
      }
    }
  }

  return [...builders.values()]
    .map((builder) => ({
      id: builder.id,
      kind: builder.kind,
      childSessionId: builder.childSessionId,
      type: builder.type,
      description: builder.description,
      status: cardStatus(builder.parentStatus, builder.result !== null),
      messages: builder.messages,
      result: builder.result,
      position: builder.position,
    }))
    .sort((left, right) => left.position - right.position)
}

/** The `agent` call a `session.task_started` has not claimed yet. */
interface AgentCall {
  /** The call's own id — the event's id, which is the call's id (X1) — a start names it by. */
  readonly id: EventId
  readonly seq: number
  readonly description: string | null
}

/** A task as it is built, before its four parent-log statuses become the card's five. */
interface Builder {
  readonly id: string
  readonly kind: TaskKind
  readonly childSessionId: SessionId | null
  readonly type: string | null
  readonly description: string
  parentStatus: TaskStatus
  readonly messages: TaskMessage[]
  result: TaskResult | null
  position: number
}

/** The card's status from the parent's four and whether a turn's outcome has landed. */
function cardStatus(status: TaskStatus, hasResult: boolean): TaskCardStatus {
  if (status === 'idle') {
    return hasResult ? 'done' : 'running'
  }
  return status
}

/**
 * The `agent` call that started a task, or `null` when the log no longer holds it.
 *
 * A start that names its call (`tool_use_id`) is answered by that call alone — the exact join,
 * and why the field was added (#345): two calls may share a description, and the older
 * heuristic then put a card at the wrong one. The id is matched against the calls this fold has
 * seen, and anything it cannot find (a trimmed replay) is `null`, so the card falls back to the
 * start's own `seq` rather than being placed at some other call.
 *
 * A start **without** the field — every log stored before it existed — keeps the old heuristic:
 * the nearest unmatched call whose description is the task's own, which is what the call and
 * the start share there. A matched call is removed so two tasks cannot claim one call, and a
 * call that matches nothing leaves the others alone.
 *
 * @param calls the unmatched `agent` calls, oldest first
 * @param toolUseId the id of the call that started the task, when the start names one
 * @param description the task's own description — the fallback's only join
 */
function claimCall(
  calls: AgentCall[],
  toolUseId: EventId | undefined,
  description: string,
): number | null {
  if (toolUseId !== undefined) {
    const index = calls.findIndex((call) => call.id === toolUseId)
    if (index === -1) {
      return null
    }
    const [call] = calls.splice(index, 1)
    return call?.seq ?? null
  }
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    if (calls[index]?.description === description) {
      const [call] = calls.splice(index, 1)
      return call?.seq ?? null
    }
  }
  return null
}

/** A string field of a tool call's input, or `null` when it is absent or not a string. */
function stringField(input: DeepReadonly<ToolInput>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}
