import {
  AGENT_MESSAGE_TOOL_NAME,
  AGENT_STOP_TOOL_NAME,
  AGENT_TOOL_NAME,
  EVENT_TYPES,
  MESSAGE_PARENT_TOOL_NAME,
  TASK_WAIT_TOOL_NAME,
  deriveSessionTitle,
  newTaskId,
  ulid,
} from '@openharness/protocol'
import type {
  AgentMessageToolInput,
  AgentStopToolInput,
  MessageParentToolInput,
  ReasoningEffort,
  Session,
  SessionId,
  StoredEvent,
  TaskId,
  TaskNotificationKind,
  TaskStatus,
  UserMessageEventInput,
} from '@openharness/protocol'
import type { SessionStore } from '@openharness/session'
import { SessionNotFoundError } from '@openharness/session'
import {
  createSubagentTools,
  createToolRegistry,
  errorResult,
  isSubagentToolName,
  textResult,
} from '@openharness/hands'
import type { SubagentToolHandlers, ToolDefinition, ToolRegistry } from '@openharness/hands'

import { readLog } from './log'
import { awaitingTasks, taskStarts, taskStatuses } from './tasks'
import type { SubagentParent, SubagentTypeResolver } from './subagent'

/**
 * The parent side and the child side of a subagent (epic #340, S5; issue #344).
 *
 * `./subagent` carries the vocabulary and the child's prompt (#342); this module is what makes
 * the five tools *work*: it builds the definitions a session is offered, runs the calls that
 * start, steer and stop a helper, and writes what a child owes its parent. It is here rather
 * than in the host because every one of those needs the **store and the session** — a
 * `ToolDefinition` is handed neither — and the loop is the only thing that has both at the
 * moment a call runs.
 *
 * What the host still owns is what needs a database, a credential or a deployment setting: the
 * **types** (`SubagentTypeResolver`, the server's `subagent-types.ts`) and the two limits of S6,
 * which arrive as {@link SubagentRuntime}.
 */

/**
 * What a deployment tells the loop about subagents (epic #340, S6; #344).
 *
 * Absent means "this deployment has none", and it is a real answer rather than a missing one:
 * the loop then offers **none** of the five — they are taken out of the registry the host
 * built, so a chat cannot call a tool whose handler could only answer "the harness answers
 * this", and cannot park itself on an `agent_wait` no task can ever resolve (#365). A
 * deployment that **does** wire one has every one of the five decided here: a session offered
 * none loses them, so nothing can promise a helper the deployment will not start.
 */
export interface SubagentRuntime {
  /** The types a parent may start, and what one of them resolves to (#342). */
  readonly types: SubagentTypeResolver
  /**
   * How deep a tree may get (S6, `OPENHARNESS_MAX_AGENT_DEPTH`): a session at this depth is not
   * offered the tools that start another one. A top-level chat is depth 0, so a default of 3
   * offers them at depths 0, 1 and 2.
   */
  readonly maxDepth: number
  /**
   * How many of one root chat's descendants may be live at once (S6,
   * `OPENHARNESS_MAX_LIVE_TASKS`). Past it an `agent` call is answered with an `is_error` the
   * model acts on instead of starting anything.
   */
  readonly maxLiveTasks: number
  /**
   * How the host is told to look at a session now: `work` for a session with something to do (a
   * child that was just created or messaged, a parent whose task has news), `interrupt` to stop
   * a turn (S5's `agent_stop`).
   *
   * A signal is a hint, exactly as every other one is: what makes a start, a message or a stop
   * real is the event it appended, and a host that wired no signal loses latency and nothing
   * else — a child is a session, and the store's work scan finds one with a queued prompt.
   */
  readonly signal?: (sessionId: SessionId, kind: 'work' | 'interrupt') => void
}

/**
 * What {@link withSubagentTools} and the handlers need of the turn they run in.
 *
 * `parent` is the state the `agent` tool resolves a type against: what *this* request runs (the
 * mode's resolved model and effort when the chat follows one, its own otherwise), which mode
 * imposes the tool set, and — for `general-purpose` — what a child continues. It is asked when
 * a **call** runs rather than when the tools are built, because the effort in force is read off
 * the log at the request boundary, a few lines after this registry exists — and because the
 * answer belongs to the request the call was made in either way.
 */
export interface SubagentToolContext {
  /** The store a child session is created in and every task event is appended to. */
  readonly store: SessionStore
  /** The session the tools are offered to, as the request boundary re-read it. */
  readonly session: Session
  /** What this request runs, and the mode in force — `@openharness/brain`'s `SubagentParent`. */
  readonly parent: () => Promise<SubagentParent>
  /**
   * The deployment's types and limits, or `undefined` for one that wired none.
   *
   * `undefined` means the host wired no subagents: the five tools are taken out of the offer,
   * so a chat on a deployment that cannot start a helper is not offered one (#365).
   */
  readonly runtime: SubagentRuntime | undefined
}

/**
 * The subagent tools this session is offered, by name (epic #340, S5/S6; #344).
 *
 * Two rules, both structural rather than about the call:
 *
 * - the **parent side** (`agent`, `agent_message`, `agent_wait`, `agent_stop`) belongs to a
 *   session under the depth cap. Nesting is allowed and bounded (S6): a child at
 *   `depth < maxDepth` is offered them too, and one at the cap is not — which is how a tree
 *   stops growing without anything having to refuse a call.
 * - `message_parent` belongs to a **child** — the one tool a session with a parent gets for
 *   reaching up, and one a top-level chat has no use for (there is nobody above it).
 *
 * The user's own settings (and a mode's override) narrow this further, by name, exactly as they
 * do for every other built-in: the loop filters the registry this builds.
 */
export function offeredSubagentTools(
  session: Pick<Session, 'depth' | 'parent_session_id'>,
  runtime: SubagentRuntime,
): readonly string[] {
  const names: string[] = []
  if (session.depth < runtime.maxDepth) {
    names.push(AGENT_TOOL_NAME, AGENT_MESSAGE_TOOL_NAME, TASK_WAIT_TOOL_NAME, AGENT_STOP_TOOL_NAME)
  }
  if (session.parent_session_id !== null) {
    names.push(MESSAGE_PARENT_TOOL_NAME)
  }
  return names
}

/**
 * The registry a request is offered, with this session's subagent tools in it (S5; #344).
 *
 * Two things happen here, and both matter:
 *
 * - **The names a process registry may carry are replaced.** A deployment registers the five
 *   with `HARNESS_TOOL_HANDLERS` so a settings screen can list them (and a user can turn one
 *   off), and what goes in the offer is the real definition for this session — bound to its
 *   store, its owner and its depth. Leaving both would be a duplicate name, which the registry
 *   refuses.
 * - **A session offered none loses them.** A chat at the depth cap, or a deployment that wired
 *   no runtime at all, must not be offered a tool that could only refuse: what the model cannot
 *   see it cannot ask for, which is the rule `ask_user` follows in a non-interactive session.
 *   The no-runtime case is a deployment without subagents **at all**: the five are taken out of
 *   the offer even though the process registry carries them (a settings screen lists them), so a
 *   host that never starts a helper never offers one (#365).
 *
 * The types are listed per request, not per turn: the `agent` description is what the model
 * chooses from, and a mode edited between two starts is offered as it is now (#342).
 */
export async function withSubagentTools(
  registry: ToolRegistry | undefined,
  context: SubagentToolContext,
): Promise<ToolRegistry | undefined> {
  const runtime = context.runtime
  if (runtime === undefined) {
    // A deployment that wired **no runtime has no subagents**, so it offers none of the five —
    // whatever its process registry carries. The five are registered by every deployment (a
    // settings screen lists them so a user can turn one off, and a mode can override one), so
    // leaving them in the offer would hand a chat four calls whose handlers can only answer
    // "the harness answers this", and — worse — a **live** `agent_wait`, whose call really ends
    // the turn `waiting_on_tasks` with no task in existence to resolve it and only the deadline
    // or a user message to end it (#365). Offering a tool that could only refuse is what the
    // `ask_user` rule forbids everywhere else: what the model cannot see it cannot ask for.
    const kept = (registry?.tools ?? []).filter((tool) => !isSubagentToolName(tool.name))
    return sameTools(registry, kept)
  }
  const kept = (registry?.tools ?? []).filter((tool) => !isSubagentToolName(tool.name))
  const offered = offeredSubagentTools(context.session, runtime)
  if (offered.length === 0) {
    return sameTools(registry, kept)
  }
  // The list is what the `agent` tool's description is built from and the only reader of it, so
  // a session offered the other four but not `agent` does not ask the resolver for it.
  const types = offered.includes(AGENT_TOOL_NAME)
    ? await runtime.types.list(context.session.owner_id)
    : []
  const definitions: ToolDefinition[] = createSubagentTools({
    types,
    handlers: createSubagentHandlers({ ...context, runtime }),
  }).filter((tool) => offered.includes(tool.name))
  const tools = [...kept, ...definitions]
  return tools.length === 0 ? undefined : createToolRegistry(tools)
}

/** The registry a filter left — the same instance when it took nothing out of it. */
function sameTools(
  original: ToolRegistry | undefined,
  kept: readonly ToolDefinition[],
): ToolRegistry | undefined {
  if (kept.length === (original?.tools.length ?? 0)) {
    return original
  }
  return kept.length === 0 ? undefined : createToolRegistry(kept)
}

/**
 * What the harness does for the five tools, bound to one session (S5; #344).
 *
 * Every refusal is a result rather than a throw, because the reader is the **parent model**: an
 * unknown type, a full chat and an unknown handle are all sentences it acts on — pick another
 * type, wait, or do the work itself.
 */
export function createSubagentHandlers(context: SubagentHandlerContext): SubagentToolHandlers {
  const { store, session, runtime } = context
  /** What this session's log says a task is, or `null` when the handle is not one of ours. */
  const taskOf = async (taskId: TaskId) => {
    const starts = taskStarts(await readLog(store, session.id))
    return starts.get(taskId) ?? null
  }
  return {
    start: async (input, execution) => {
      const parent = await context.parent()
      const resolved = await runtime.types.resolve(session.owner_id, input.type, parent)
      if (!resolved.ok) {
        return errorResult(resolved.message)
      }
      const type = resolved.type
      // S6's cap counts the **root chat's** live descendants, which is what makes it a cap on a
      // tree rather than on one level of it; the session itself is not in the count, so a
      // top-level chat's own turn does not eat a slot.
      const live = await store.countLiveDescendants(session.root_session_id)
      if (live >= runtime.maxLiveTasks) {
        return errorResult(
          `This chat already has ${live} helpers working, which is the limit. Wait for one to ` +
            'finish, or stop one with `agent_stop`, before starting another.',
        )
      }
      // The mode the child follows, and — only when it follows none — the type's own addition:
      // a mode's addition is applied per request by the loop, so applying it here as well would
      // put it in the child's prompt twice.
      const mode = type.modeId ?? parent.modeId
      const addition = mode === null ? type.systemPromptAddition : null
      const taskId = newTaskId()
      const child = await store.createSession(null, {
        ownerId: session.owner_id,
        interactive: false,
        parentSessionId: session.id,
        parentTaskId: taskId,
        model: { id: type.model },
        // The name the parent model gave this piece of work, as the child's title (epic #340).
        // A child is created here, straight through the store, so the server's route-level
        // auto-titling (`nameSessionFromFirstMessage`, which only ever sees a client's first
        // message) never runs for it — and a child whose title stays `null` is a row a client
        // can only label with its **model's** name, which is what the sidebar showed instead of
        // the description. Normalised by the same rule a chat's first message is, so a
        // multi-line or over-long description still becomes one bounded line.
        //
        // A description with no text in it at all — `" "`, `"\n"`, which the tool's `min(1)`
        // schema accepts — derives to `null` (`deriveSessionTitle` answers `null`, never `''`,
        // for input with nothing in it), and a child left untitled is the bug #379 fixed. The
        // type's name is then the fallback: it is always there, and "researcher" names the
        // helper better than its model does.
        title: deriveSessionTitle(input.description) ?? type.name,
        // The prompt a chat on this type would run with: the parent's own system prompt with the
        // type's addition after it. The subagent prompt itself is appended per request, by the
        // loop — every child runs with it, including one created before this issue existed.
        system: withAddition(session.system, addition),
        // `general-purpose` continues the parent, so it follows the parent's mode when it has
        // one; a mode type follows its own. That is what makes a type's tool and MCP-server
        // override real without a second configuration: the child is a chat on that mode, and
        // the loop resolves the mode for it live, exactly as it does for any chat (#245, M6).
        mode,
        initial_events: [promptEvent(input.prompt, type.reasoningEffort)],
      })
      await store.appendEvents(session.id, [
        {
          type: EVENT_TYPES.sessionTaskStarted,
          task_id: taskId,
          kind: 'subagent',
          // The call's own id, handed over by the loop (`ToolExecutionContext.toolUseId`): the
          // link a client places the card at, rather than a join by description (#345).
          ...(execution.toolUseId === undefined ? {} : { tool_use_id: execution.toolUseId }),
          child_session_id: child.id,
          // The frame a notification is labelled with reads `task_type` first (#343), so this is
          // what a parent sees news from rather than a generic "task".
          ...(type.name.length === 0 ? {} : { task_type: type.name }),
          description: input.description,
        },
        { type: EVENT_TYPES.sessionTaskStatus, task_id: taskId, status: 'running' },
      ])
      runtime.signal?.(child.id, 'work')
      return textResult(
        `Started ${type.name} as ${taskId}. It is working in a separate chat and its news will ` +
          'reach you as a background task notification — use `agent_wait` to wait for it, ' +
          '`agent_message` to steer it, or `agent_stop` to stop it.',
      )
    },
    message: async (input: AgentMessageToolInput) => {
      const task = await taskOf(input.task_id)
      if (task?.child_session_id === undefined) {
        return errorResult(unknownTask(input.task_id))
      }
      // A `user.message` in the child, which is exactly what steering is: the loop claims it in
      // the request that answers it, and a child that had gone idle starts another turn with its
      // context intact. The status follows from the child's own turn (`childTurnStart`) — one
      // writer, so a card cannot read "running" for a turn nobody started.
      await store.appendEvents(task.child_session_id, [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: input.text }] },
      ])
      runtime.signal?.(task.child_session_id, 'work')
      return textResult(`Your message was sent to ${input.task_id}.`)
    },
    stop: async (input: AgentStopToolInput) => {
      const task = await taskOf(input.task_id)
      if (task === null) {
        return errorResult(unknownTask(input.task_id))
      }
      await store.appendEvents(session.id, [
        { type: EVENT_TYPES.sessionTaskStatus, task_id: input.task_id, status: 'stopped' },
      ])
      const childId = task.child_session_id
      if (childId !== undefined) {
        // The child's own log is where "this turn was stopped" lives (S7; #348), so the interrupt
        // is written **before** the signal: the turn-end delivery then classifies the turn
        // `stopped` wherever the abort lands — a request in flight, a tool step, or nothing at
        // all — and reads exactly what a person's Stop, which appends the same event, reads.
        //
        // Only a child with work in flight is written to: one with a turn **open**, or one parked
        // in a task wait, whose pause is what the interrupt ends (S5). An interrupt of a child
        // that has already reported claims a turn of its own that the delivery reads as an
        // ordinary end, so appending one for a helper that had finished would answer the parent's
        // `agent_stop` with a second, contradictory `idle`. The stop is still signalled either
        // way.
        if (await childInterruptible(store, childId)) {
          await ignoreMissing(() =>
            store.appendEvents(childId, [{ type: EVENT_TYPES.userInterrupt }]),
          )
        }
        runtime.signal?.(childId, 'interrupt')
      }
      return textResult(
        `Stopped ${input.task_id}. It will not run again unless you send it a message with ` +
          '`agent_message`.',
      )
    },
    messageParent: async (input: MessageParentToolInput) => {
      const own = childTaskParent(session)
      if (own === null) {
        return errorResult(
          'This chat was not started by another chat, so there is no parent to send a note to.',
        )
      }
      await store.appendTaskNotification(own.parentSessionId, {
        taskId: own.taskId,
        kind: 'message',
        text: input.text,
        sourceKey: noteSourceKey(session.id),
      })
      runtime.signal?.(own.parentSessionId, 'work')
      return textResult('The note was sent to the chat that started you.')
    },
  }
}

/**
 * What the handler set needs — {@link SubagentToolContext} with a deployment behind it.
 *
 * The narrowing is the point: the tools are built only where a runtime exists, so the handlers
 * can work with one rather than guarding every call, and the offer is what decides that (see
 * {@link withSubagentTools}).
 */
export interface SubagentHandlerContext {
  /** The store a child session is created in and every task event is appended to. */
  readonly store: SessionStore
  /** The session the tools are offered to, as the request boundary re-read it. */
  readonly session: Session
  /** What this request runs, asked when a call runs. */
  readonly parent: () => Promise<SubagentParent>
  /** The deployment's types and limits. */
  readonly runtime: SubagentRuntime
}

/** The sentence a call naming a handle this chat does not have is answered with (S5). */
function unknownTask(taskId: TaskId): string {
  return (
    `This chat has no background task with the id ${taskId}. Use the \`task_id\` an \`agent\` ` +
    'call answered with.'
  )
}

/**
 * The key a `message_parent` note is stored under.
 *
 * A result is keyed by the turn it ends — `<child_session_id>:<idle seq>` — and a note is not a
 * turn: one child sends many, each its own piece of news, so a key two notes shared would make
 * the store drop the second. The suffix is therefore a fresh id per note, and what the key has
 * to be unique about is the note rather than a repeat of one (a call is never re-run after a
 * crash, so there is no repeat to fold). It still names the child, so a reader sees where the
 * news came from.
 */
function noteSourceKey(childSessionId: SessionId): string {
  return `${childSessionId}:note:${ulid()}`
}

/** The first `user.message` a child runs on: the prompt the parent wrote (S3). */
function promptEvent(prompt: string, effort: ReasoningEffort | null): UserMessageEventInput {
  return {
    type: EVENT_TYPES.userMessage,
    content: [{ type: 'text', text: prompt }],
    // The type's effort rides the message the way a user's own choice does (#252): nothing is
    // stored on the session, and the loop reads it back per request. `null` is the provider's
    // default, and it is what a mode with no effort means as well.
    ...(effort === null ? {} : { reasoning_effort: effort }),
  }
}

/** The system prompt a child is stored with: the parent's, with the type's addition after it. */
function withAddition(system: string | null, addition: string | null): string | null {
  const base = system !== null && system.length > 0 ? system : null
  const extra = addition !== null && addition.length > 0 ? addition : null
  if (extra === null) {
    return base
  }
  return base === null ? extra : `${base}\n\n${extra}`
}

/**
 * The task a child session owes its parent, or `null` when it has none (S3/S4).
 *
 * Both halves are the session's own — the log that holds the task events, and the handle it is
 * named by — so a child cannot address anybody else and nothing has to be carried through a
 * turn.
 */
export function childTaskParent(
  session: Pick<Session, 'parent_session_id' | 'parent_task_id'>,
): { readonly parentSessionId: SessionId; readonly taskId: TaskId } | null {
  if (session.parent_session_id === null || session.parent_task_id === null) {
    return null
  }
  return { parentSessionId: session.parent_session_id, taskId: session.parent_task_id }
}

/**
 * What a finished child turn says to its parent (S4/S7), read off the child's own log.
 *
 * One per turn, keyed by the turn's idle `seq`, and built from the last turn's events alone:
 *
 * - the turn was **stopped** — a `user.interrupt` is in it, whether a person's Stop in a
 *   frontend or the one `agent_stop` appends on the model's behalf — so the news is a `result`
 *   saying so and the status beside it is `stopped`; read as `idle`, a card would show **done**
 *   and the parent model would believe its helper had finished (S7; #348);
 * - the turn ended in an error — a `session.error` after the last status — so the news is
 *   `failed`, carrying what the provider said;
 * - otherwise the news is `result`, carrying the last reply the turn stored;
 * - otherwise — a turn that stored no text at all, an interrupt with nothing streamed — it is
 *   still a `result`, because **a turn that ended owes its parent an announcement**: that is
 *   what tells the parent the helper stopped working, and a turn with nothing to say still
 *   stopped.
 *
 * `null` means "not a turn that ended": a child that paused in a task wait of its own is still
 * working, and one whose log holds no idle status has not run at all.
 */
export interface ChildTurnDelivery {
  /** What the notification says happened: `result`, or `failed` for a turn that errored. */
  readonly kind: Extract<TaskNotificationKind, 'result' | 'failed'>
  /** The text the parent model reads. */
  readonly text: string
  /** The key the append is idempotent on: `<child_session_id>:<idle seq>`. */
  readonly sourceKey: string
  /**
   * The status the parent's card moves to: `failed` for an errored turn, `stopped` for one that
   * was stopped, else `idle`.
   */
  readonly status: Extract<TaskStatus, 'idle' | 'failed' | 'stopped'>
}

/** The sentence a turn that ended with nothing to say is announced with. */
export const EMPTY_TURN_RESULT = 'The helper finished a turn without saying anything.'

/**
 * The sentence a turn that was stopped is announced with (S7; #348).
 *
 * The status a stopped turn moves the card to is `stopped`, and the one word it is not is
 * `done` — which is exactly what `idle` reads as, so the parent model would take a stopped
 * helper for one that finished. The wording names the user because the stop is the user's:
 * `agent_stop` is the model's own tool, but S7 and [`docs/api.md`](../../../docs/api.md) list it
 * beside a card's Stop, and it is the user's work the model is stopping on their behalf.
 */
export const STOPPED_TURN_RESULT = 'The user stopped this subagent before it finished.'

/**
 * The sentence a turn the **server** aborted is announced with (#378).
 *
 * A rolling deploy drains by aborting the turns in flight (`stopper.abort()`, the same abort a
 * shutdown and a delete's stop use), which ends a turn exactly as a person's Stop does — an
 * `interrupted` span end and nothing else. No human intent is in the log for it, so the parent
 * model must not be told the user stopped its helper; and unlike a stop this is not the end of
 * the work: the child is idle with its context intact, and `agent_message` continues it.
 */
export const RESTARTED_TURN_RESULT =
  "This subagent's turn was interrupted by the server (a restart or shutdown). Send it a " +
  'message with `agent_message` to continue.'

export function childTurnDelivery(
  events: readonly StoredEvent[],
  session: Pick<Session, 'id'>,
): ChildTurnDelivery | null {
  const idle = lastEndedTurn(events)
  if (idle === null) {
    return null
  }
  const turn = events.slice(turnStartIndex(events, idle.index), idle.index)
  const sourceKey = `${session.id}:${idle.seq}`
  // A turn whose window is **empty** and which answered nothing is not a turn that ended
  // (#371). An interrupt written into an idle child is what produces one: nothing is queued, so
  // the loop's first check ends the turn with nothing in flight and its idle claims the
  // interrupt. Announcing that as a stop would tell the parent model its helper was stopped
  // *before it finished* after it had already finished, and flip a card that read **done** back
  // to stopped. A turn the child was really in the middle of leaves something in the window —
  // the reply it streamed, a call it made, or, for a child parked in a task wait, the result
  // that ends the wait. A window can also be empty while the turn really did answer something:
  // the idle itself may claim the prompt a child's first turn was, so a claimed message or
  // notification is what keeps that one a turn. The store's undelivered-turn scan reads the same
  // rule (`@openharness/session`), which is what stops it waking a child for news that cannot
  // exist.
  if (turn.length === 0 && !answeredBy(events, idle.index)) {
    return null
  }
  const stop = turnStop(turn, events, idle.index)
  const reply = turn
    .filter(
      (event): event is Extract<StoredEvent, { type: 'agent.message' }> =>
        event.type === EVENT_TYPES.agentMessage,
    )
    .at(-1)
  const text = reply?.content.map((block) => block.text).join('') ?? ''
  // A stop outranks a retryable failure beside it: the turn ended because it was stopped, which
  // is the fact the parent has to act on, and whatever error preceded it was being retried.
  if (stop === 'user') {
    return {
      kind: 'result',
      text:
        text.length > 0
          ? `${STOPPED_TURN_RESULT} Its partial output: ${text}`
          : STOPPED_TURN_RESULT,
      sourceKey,
      status: 'stopped',
    }
  }
  // The host aborted the turn and **nobody said "stop"** (#378): a rolling deploy's drain, a
  // shutdown, a delete that was already stopping this child. The log holds no human intent
  // there, so the parent must not be told the user stopped it — the sentence a drain would
  // otherwise produce is a lie the model acts on. The turn is over all the same, so the news
  // says what really happened and how to carry on.
  if (stop === 'server') {
    return {
      kind: 'result',
      text:
        text.length > 0
          ? `${RESTARTED_TURN_RESULT} Its partial output: ${text}`
          : RESTARTED_TURN_RESULT,
      sourceKey,
      status: 'idle',
    }
  }
  const failed = turn.find(
    (event): event is Extract<StoredEvent, { type: 'session.error' }> =>
      event.type === EVENT_TYPES.sessionError,
  )
  if (failed !== undefined) {
    return {
      kind: 'failed',
      text: failed.error.message,
      sourceKey,
      status: 'failed',
    }
  }
  return {
    kind: 'result',
    text: text.length > 0 ? text : EMPTY_TURN_RESULT,
    sourceKey,
    status: 'idle',
  }
}

/**
 * Whether the idle that ended a turn claims a message or a task's news — something the turn
 * really answered even though nothing was written inside its window (#371).
 *
 * The one shape that matters is a child's first turn, whose idle may claim the prompt it
 * answered; the store's undelivered-turn scan asks the same question of a child's log so the
 * two cannot disagree about which ends are worth announcing.
 */
function answeredBy(events: readonly StoredEvent[], idleIndex: number): boolean {
  const idle = events[idleIndex]
  const claimed = new Set(
    (idle?.type === EVENT_TYPES.sessionStatusIdle ? idle.consumes : undefined)?.map(String) ?? [],
  )
  if (claimed.size === 0) {
    return false
  }
  return events.some(
    (event) =>
      claimed.has(String(event.id)) &&
      (event.type === EVENT_TYPES.userMessage ||
        event.type === EVENT_TYPES.sessionTaskNotification),
  )
}

/** Who — if anyone — stopped the ended turn (S7; #348; #378). */
type TurnStop = 'user' | 'server' | null

/**
 * Whether the ended turn was stopped, and by **whom** (S7; #348; #378).
 *
 * Two shapes and two different facts, which is the point of the split. A `user.interrupt` in
 * the turn is what a person's Stop leaves — appended by the route that accepts it, or by
 * `agent_stop` on the user's behalf — and it is claimed by the span end it stopped or by the
 * turn's idle event (P4); so is one the ended idle itself claims, for a child that was paused
 * in a task wait when it arrived ({@link stoppedClaimedBy}). An `interrupted` span end with no
 * such event is the **host** aborting a turn with a signal: a rolling deploy's drain, a
 * shutdown, a delete already stopping this child. Nothing in the log records a person's intent
 * there, so a delivery that read it as a user stop would tell the parent model the user stopped
 * a helper the operator restarted.
 */
function turnStop(
  turn: readonly StoredEvent[],
  events: readonly StoredEvent[],
  idleIndex: number,
): TurnStop {
  const byEvent = turn.some((event) => event.type === EVENT_TYPES.userInterrupt)
  if (byEvent || stoppedClaimedBy(events, idleIndex)) {
    return 'user'
  }
  const aborted = turn.some(
    (event) => event.type === EVENT_TYPES.modelRequestEnd && event.error?.type === 'interrupted',
  )
  return aborted ? 'server' : null
}

/**
 * Whether the turn's own idle status claims a `user.interrupt` — a stop of a **paused** child
 * (S5/S7; #348).
 *
 * A child parked in a task wait is idle — its pause *is* its turn's end — so the interrupt that
 * ends that wait is appended **before** the turn the signal starts, and the turn window
 * {@link turnStartIndex} slices holds none of it. The **claim** is what says the turn ended
 * because it was stopped: the idle event carries the interrupts it ended on (P4), and this reads
 * that record rather than the window's shape. It is the same fact {@link turnStop} reads for a
 * running child, where the interrupt really is inside the window.
 */
function stoppedClaimedBy(events: readonly StoredEvent[], idleIndex: number): boolean {
  const idle = events[idleIndex]
  const claimed = new Set(
    (idle?.type === EVENT_TYPES.sessionStatusIdle ? idle.consumes : undefined)?.map(String) ?? [],
  )
  if (claimed.size === 0) {
    return false
  }
  return events.some(
    (event) => event.type === EVENT_TYPES.userInterrupt && claimed.has(String(event.id)),
  )
}

/** The turn-ending idle status a log's newest turn left, or `null` when nothing ended. */
function lastEndedTurn(
  events: readonly StoredEvent[],
): { readonly index: number; readonly seq: number } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || !isStatusEvent(event)) {
      continue
    }
    // The newest status event is the whole test: a `session.status_idle` ends a turn, and one
    // that ended `waiting_on_tasks` (S5) or `requires_action` (#309) is a **pause** — the child
    // is still working, and announcing a paused turn as a result would tell the parent its
    // helper had finished when it had not.
    if (event.type === EVENT_TYPES.sessionStatusIdle && event.stop_reason.type === 'end_turn') {
      return { index, seq: event.seq }
    }
    return null
  }
  return null
}

/** Where the turn ending at `end` began: after the status event before it. */
function turnStartIndex(events: readonly StoredEvent[], end: number): number {
  for (let index = end - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && isStatusEvent(event)) {
      return index + 1
    }
  }
  return 0
}

/** Whether an event is one of the three the loop writes around a turn. */
function isStatusEvent(event: StoredEvent): boolean {
  return (
    event.type === EVENT_TYPES.sessionStatusRunning ||
    event.type === EVENT_TYPES.sessionStatusIdle ||
    event.type === EVENT_TYPES.sessionStatusRescheduled
  )
}

/**
 * Tell the parent a child's turn has started (S4): `session.task_status { running }`.
 *
 * Written by the child, into the parent's log, at the turn's start — which is what makes a card
 * follow the child without either side polling: the status is the child's own transition, not
 * something the parent's tools have to remember to write.
 *
 * The parent may be gone (a delete takes the subtree and stops every descendant's turn first, so
 * this is a race rather than a state) and is then simply not told.
 */
export async function childTurnStart(store: SessionStore, session: Session): Promise<boolean> {
  const own = childTaskParent(session)
  if (own === null) {
    return false
  }
  return inParent(store, own.parentSessionId, async () => {
    await store.appendEvents(own.parentSessionId, [
      { type: EVENT_TYPES.sessionTaskStatus, task_id: own.taskId, status: 'running' },
    ])
    return true
  })
}

/**
 * Give the parent what the child's finished turn owes it (S4).
 *
 * The news and the status that moves the card are **one append** through the store's idempotent
 * `appendTaskNotification` (#363), so this is safe to call more than once — the turn's end calls
 * it, and a turn started on a child whose last one was never delivered calls it again (the no-op
 * guard in `./turn`) — and the status is written exactly once, by the one call that also wrote
 * the notification. As two appends the pair had a window nothing repaired: a crash or a fence
 * between them delivered the news and lost the status, leaving the parent's card `running` for
 * the rest of the session while the model acted on a result for a task that looked unfinished.
 *
 * Returns whether this call is the one that delivered it. A child with no parent, a turn that
 * has not ended, and a turn the parent has already been told about are all `false`.
 */
export async function deliverChildTurn(
  store: SessionStore,
  session: Session,
  runtime: SubagentRuntime,
): Promise<boolean> {
  const own = childTaskParent(session)
  if (own === null) {
    return false
  }
  const delivery = childTurnDelivery(await readLog(store, session.id), session)
  if (delivery === null) {
    return false
  }
  const delivered = await inParent(store, own.parentSessionId, async () => {
    const { appended } = await store.appendTaskNotification(own.parentSessionId, {
      taskId: own.taskId,
      kind: delivery.kind,
      text: delivery.text,
      sourceKey: delivery.sourceKey,
      status: delivery.status,
    })
    return appended
  })
  if (!delivered) {
    return false
  }
  // The parent may be idle, and nothing else would tell it: a notification is a queued event, so
  // a signal is what starts the turn that folds it in (the store's work scan finds it too,
  // whichever instance gets there first).
  runtime.signal?.(own.parentSessionId, 'work')
  return true
}

/**
 * Do something in the parent's log, tolerating a parent that is gone.
 *
 * A child's writes cross into another session — the one thing in the loop that does — and the
 * parent can have been deleted between the child's read and its write (a hard delete takes the
 * subtree and stops every descendant's turn first, which is what makes this a race and not a
 * state). `false` says "nobody was told", which is exactly true: a task whose parent does not
 * exist has nobody to report to, and failing the child's turn over it would be worse than the
 * news going nowhere.
 */
async function inParent<T>(
  store: SessionStore,
  parentSessionId: SessionId,
  write: () => Promise<T>,
): Promise<T | false> {
  try {
    return await write()
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return false
    }
    throw error
  }
}

/**
 * Write to a session that may have been deleted, and say nothing when it was.
 *
 * The same race {@link inParent} tolerates in the other direction: a **child** can be hard
 * deleted on its own, so a parent-model tool that reaches down to one (`agent_stop`) finds
 * nothing to talk to rather than failing the parent's turn over it. Any other failure is real
 * and propagates.
 */
async function ignoreMissing(write: () => Promise<unknown>): Promise<void> {
  try {
    await write()
  } catch (error) {
    if (!(error instanceof SessionNotFoundError)) {
      throw error
    }
  }
}

/**
 * Whether a child has a turn open right now, tolerating one that is gone.
 *
 * The one question `agent_stop` asks before writing its interrupt into the child (S7; #348): a
 * child that is idle has no turn for an interrupt to end, and a hard-deleted one has no log to
 * write to at all.
 */
async function childTurnOpen(store: SessionStore, childId: SessionId): Promise<boolean> {
  try {
    return (await store.getTurnState(childId)).state !== 'idle'
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return false
    }
    throw error
  }
}

/**
 * Whether a child is parked in a task wait — idle to {@link childTurnOpen}, still working (S5).
 *
 * A child that called `agent_wait` has no open turn and no request in flight: its pause is a turn
 * end, and a pending `user.interrupt` is one of the things that resolves it (the lifecycle's
 * TASK WAIT). So a stop has to be written into such a child's log as well, or the interrupt is
 * only a signal — and a signal on an idle session starts a turn that finds the same open wait and
 * pauses again, which leaves a helper the model stopped still running, and lets the turn that
 * eventually ends announce the parent an `idle` after the `stopped`.
 *
 * Tolerates a child that is gone, exactly as {@link childTurnOpen} does.
 */
async function childPausedOnTasks(store: SessionStore, childId: SessionId): Promise<boolean> {
  try {
    return awaitingTasks(await readLog(store, childId)).length > 0
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return false
    }
    throw error
  }
}

/** Whether an interrupt of this child is one that ends work it is in the middle of (S7). */
async function childInterruptible(store: SessionStore, childId: SessionId): Promise<boolean> {
  return (await childTurnOpen(store, childId)) || (await childPausedOnTasks(store, childId))
}

/**
 * Stop the children a rewind took the parent's `agent` call back from (S7; #344).
 *
 * A rewind is the reader saying "that did not happen", and a helper still working on something
 * the chat has taken back is exactly the work that should stop: the child's turn is interrupted
 * and the task is written `stopped` in the parent's log, so the card the reader sees agrees, and
 * the news it sends later is dropped (`./tasks`' `deliverableNotifications`).
 *
 * **Where the orphan is found.** A rewound `session.task_started` is gone from the log a reader
 * sees, but the child it names is not: it is a session with `parent_session_id` this one and a
 * `parent_task_id` no visible start accounts for. So the parent's **children** are compared
 * against its tasks rather than its raw log read — one indexed list, no superseded read — and a
 * child whose task the log no longer names is one the chat took back. A task already `stopped`
 * is left alone, so several turns after one rewind write the stop once.
 *
 * It runs at the turn's start rather than in the rewind's own request because the store is what
 * records the range: the rewind's batch is appended, and the turn that follows is the first
 * reader that can tell what it covered.
 */
export async function stopOrphanedTasks(
  store: SessionStore,
  session: Session,
  runtime: SubagentRuntime,
): Promise<number> {
  const children = await childSessions(store, session)
  if (children.length === 0) {
    return 0
  }
  const visible = await readLog(store, session.id)
  const starts = taskStarts(visible)
  const statuses = taskStatuses(visible)
  const orphans = children.flatMap((child) => {
    const taskId = child.parent_task_id
    if (taskId === null || starts.has(taskId) || statuses.get(taskId) === 'stopped') {
      return []
    }
    return [{ child, taskId }]
  })
  if (orphans.length === 0) {
    return 0
  }
  await store.appendEvents(
    session.id,
    orphans.map((orphan) => ({
      type: EVENT_TYPES.sessionTaskStatus,
      task_id: orphan.taskId,
      status: 'stopped' as const,
    })),
  )
  for (const orphan of orphans) {
    // The stop is written into the child as an **event** before the signal, exactly as
    // `agent_stop` does (S7; #348): a signal is a hint that a lost `LISTEN`, a child owned by an
    // instance that is restarting or a dropped notification can swallow, and then the helper a
    // rewind removed from the log keeps running and later delivers news for a task that no
    // longer exists. A **paused** orphan is the sharper case — its pause is a turn end, so a
    // bare signal starts a turn that finds the same open wait and pauses again — and a running
    // one is the same fact one step earlier. `childInterruptible` is the test for both: a turn
    // is open, or there is a wait to end. A child that has already reported is left alone: an
    // interrupt of one opens a turn of its own whose delivery would be a stop for work that had
    // finished (which `childTurnDelivery` now refuses to send, #371).
    if (await childInterruptible(store, orphan.child.id)) {
      await ignoreMissing(() =>
        store.appendEvents(orphan.child.id, [{ type: EVENT_TYPES.userInterrupt }]),
      )
    }
    runtime.signal?.(orphan.child.id, 'interrupt')
  }
  return orphans.length
}

/**
 * Every child session of one, oldest first.
 *
 * A child is not a chat (#341), so the list is the store's `parentSessionId` filter, paged: a
 * long-lived chat may have started more helpers than one page holds, and a task whose start a
 * rewind took back is exactly the kind that is old rather than recent.
 */
async function childSessions(store: SessionStore, session: Session): Promise<readonly Session[]> {
  const children: Session[] = []
  let page: string | undefined
  for (;;) {
    const answer = await store.listSessions({
      ownerId: session.owner_id,
      parentSessionId: session.id,
      ...(page === undefined ? {} : { page }),
    })
    children.push(...answer.data)
    if (answer.next_page === null) {
      return children
    }
    page = answer.next_page
  }
}
