import {
  AGENT_MESSAGE_TOOL_NAME,
  AGENT_STOP_TOOL_NAME,
  AGENT_TOOL_NAME,
  AgentMessageToolInputSchema,
  AgentStopToolInputSchema,
  AgentToolInputSchema,
  MESSAGE_PARENT_TOOL_NAME,
  MessageParentToolInputSchema,
  TASK_WAIT_TOOL_NAME,
  TaskWaitInputSchema,
} from '@openharness/protocol'
import type {
  AgentMessageToolInput,
  AgentStopToolInput,
  AgentToolInput,
  MessageParentToolInput,
  TaskWaitInput,
} from '@openharness/protocol'

import { errorResult } from './tool'
import type { ToolDefinition, ToolExecutionContext, ToolResult } from './tool'

/**
 * The subagent tools (epic #340, S5; issue #344): the five definitions the model is offered —
 * four on the parent side (`agent`, `agent_message`, `agent_wait`, `agent_stop`) and one on the
 * child side (`message_parent`).
 *
 * This module is the **surface**: the names (`@openharness/protocol` spells them once), the
 * words a model reads, the input schema a call is checked against, and the `allow` policy each
 * starts with. What a call *does* is not here and cannot be: start the child session, write the
 * task's events in the parent's log, wake the child's partition — all of that needs the store,
 * the session and the harness handle, and a `ToolDefinition` is handed none of them. So each
 * definition delegates to a {@link SubagentToolHandlers} the caller supplies, and
 * `@openharness/brain` — which has the store and the session — is the only real implementation
 * (`./agents`). Nothing in this package knows what a subagent is beyond the words.
 *
 * The one exception is `agent_wait`, which needs no handler at all: its call is recognised by
 * name and never run — the turn ends in a durable wait instead (`@openharness/brain`'s
 * `waitsForTasks`) — exactly as `ask_user`'s call is answered by the user rather than by a tool.
 */

/**
 * What the harness does for a subagent tool, as a `ToolDefinition` sees it.
 *
 * Every method answers a `ToolResult` rather than throwing, including the refusals a model is
 * meant to act on (an unknown `type`, a `task_id` that names no task of this session): the
 * parent model reads the sentence and does something else, and an exception would only be caught
 * one frame up and turned into that same sentence.
 */
export interface SubagentToolHandlers {
  /**
   * Start a helper of the named type and answer its handle.
   *
   * `context` is the call's own: it carries `toolUseId` — the `agent.tool_use` event the loop
   * stored for this call — which the starter writes onto the `session.task_started` it
   * appends, so a client places the task's card at that exact call rather than matching by
   * description (#345).
   */
  start(input: AgentToolInput, context: ToolExecutionContext): Promise<ToolResult> | ToolResult
  /** Send a task a message. */
  message(input: AgentMessageToolInput): Promise<ToolResult> | ToolResult
  /** Interrupt a task and mark it stopped. */
  stop(input: AgentStopToolInput): Promise<ToolResult> | ToolResult
  /** (A child) send the parent chat a note. */
  messageParent(input: MessageParentToolInput): Promise<ToolResult> | ToolResult
}

/**
 * What a definition answers when nothing is wired behind it.
 *
 * A definition must carry a `run`, and the process-wide registry the settings screen reads
 * carries these five before any turn replaces them with the session-bound ones (or leaves them
 * out) — so this is the sentence the log would hold if something ran one anyway. It says what is
 * true rather than pretending to have started anything, which is the rule `ask_user`'s own `run`
 * follows.
 */
export const HARNESS_ANSWERED = 'This call is answered by the harness, not by running the tool.'

/**
 * The handlers {@link HARNESS_ANSWERED} answers for, for a caller that offers the tools without
 * being able to run them — the process-wide registry, whose definitions a settings screen lists
 * and a turn replaces.
 */
export const HARNESS_TOOL_HANDLERS: SubagentToolHandlers = {
  start: () => errorResult(HARNESS_ANSWERED),
  message: () => errorResult(HARNESS_ANSWERED),
  stop: () => errorResult(HARNESS_ANSWERED),
  messageParent: () => errorResult(HARNESS_ANSWERED),
}

/**
 * One subagent type as the `agent` tool's description lists it: a name the model passes, and the
 * sentence it chooses by.
 *
 * Structural rather than imported: the type is `@openharness/brain`'s `SubagentTypeSummary`
 * (a mode with a description, plus the one built-in), and this package may not depend on the
 * brain — it is handed the list, not the type.
 */
export interface SubagentTypeSummaryLike {
  /** The type's name: a mode's name, or `general-purpose`. */
  readonly name: string
  /** What the type is good for, in the words the parent model chooses by. */
  readonly description: string
}

/** What {@link createSubagentTools} is built with. */
export interface SubagentToolsOptions {
  /**
   * The types this deployment offers, in the order they are listed — `general-purpose` first,
   * then the owner's modes with a description (`@openharness/brain`'s resolver answers this).
   */
  readonly types: readonly SubagentTypeSummaryLike[]
  /** What each tool does. */
  readonly handlers: SubagentToolHandlers
}

/**
 * What the `agent` tool tells the model, before the list of types.
 *
 * Written for a model, and deliberately explicit about the two things a model gets wrong: the
 * helper does not see this conversation (the prompt is all it gets), and the result of the call
 * is a **handle**, not an answer — the answer arrives later as a background-task notification.
 */
export const AGENT_TOOL_DESCRIPTION =
  'Start a helper: a separate chat with its own context that does one job and reports back. ' +
  'The call returns at once with a handle — the helper runs in the background, and its final ' +
  'message reaches you later as a background-task notification. The helper does not see this ' +
  'conversation and you do not see its steps, so the prompt you write is all it has: make it ' +
  'self-contained, and say what the helper should report. Use `agent_message` to steer it or ' +
  'continue it, `agent_wait` to wait for its news, and `agent_stop` to stop it.'

/**
 * The description the `agent` tool is offered with: what it does, then the types this deployment
 * has.
 *
 * The list is part of the description because it is what the model chooses from, and it is built
 * per turn — a mode edited between two starts is offered as it is now (#342). A deployment with
 * no types beyond the built-in still lists that one, so the tool always has something to name.
 */
export function agentToolDescription(types: readonly SubagentTypeSummaryLike[]): string {
  if (types.length === 0) {
    return AGENT_TOOL_DESCRIPTION
  }
  const listed = types.map((type) => `- ${type.name}: ${type.description}`).join('\n')
  return `${AGENT_TOOL_DESCRIPTION}\n\nTypes:\n${listed}`
}

/** One definition of the five, with the policy and schema every one of them shares. */
function subagentTool<Input>(
  definition: Omit<ToolDefinition<Input>, 'permission'>,
): ToolDefinition<Input> {
  return { ...definition, permission: 'allow' }
}

/**
 * The four parent-side tools, and the one a child is offered.
 *
 * One array rather than five exports, because the five are decided about together: a mode's
 * override and the settings screen speak of all of them by name, and the offer is a filter over
 * this list (`@openharness/brain`'s `offeredSubagentTools` — the parent side goes to a session
 * under the depth cap, `message_parent` to a child).
 */
export function createSubagentTools(options: SubagentToolsOptions): ToolDefinition[] {
  const { handlers } = options
  return [
    subagentTool({
      name: AGENT_TOOL_NAME,
      description: agentToolDescription(options.types),
      inputSchema: AgentToolInputSchema,
      run: (input, context) => handlers.start(input, context),
    }),
    subagentTool({
      name: AGENT_MESSAGE_TOOL_NAME,
      description:
        'Send a background task a message. A task still running is steered by it; a task that ' +
        'has already reported starts another turn with its context intact, so this is how you ' +
        'continue one. Pass the `task_id` the `agent` call answered with.',
      inputSchema: AgentMessageToolInputSchema,
      run: (input) => handlers.message(input),
    }),
    agentWaitTool(),
    subagentTool({
      name: AGENT_STOP_TOOL_NAME,
      description:
        'Stop a background task: its turn is interrupted and it will not run again unless you ' +
        'send it a message with `agent_message`. Pass the `task_id` the `agent` call answered ' +
        'with.',
      inputSchema: AgentStopToolInputSchema,
      run: (input) => handlers.stop(input),
    }),
    subagentTool({
      name: MESSAGE_PARENT_TOOL_NAME,
      description:
        'Send the chat that started you a short note about your progress. It does not block and ' +
        'it is not a question — the parent cannot answer — and your final message is what the ' +
        'parent receives anyway, so use it only for something the parent should know before you ' +
        'are done.',
      inputSchema: MessageParentToolInputSchema,
      run: (input) => handlers.messageParent(input),
    }),
  ]
}

/**
 * `agent_wait`: the call that ends a turn in a durable wait rather than making another request
 * (epic #340, S5; #343).
 *
 * It carries no handler because nothing runs it. The call is stored, nothing is executed, and
 * the turn writes `session.status_idle { stop_reason: waiting_on_tasks, task_ids, deadline }` —
 * the brain recognises the name exactly as it recognises `ask_user` (`waitsForTasks`). The `run`
 * below is the sentence the log would hold if something ran it anyway, which is the shape
 * `ask_user`'s `run` already has.
 */
export function agentWaitTool(): ToolDefinition<TaskWaitInput> {
  return subagentTool({
    name: TASK_WAIT_TOOL_NAME,
    description:
      'Wait for the background tasks you started to report something. This ends the turn ' +
      'instead of answering at once: a task notification for one of the tasks you name — or for ' +
      'any task when you name none — becomes this call’s result, and the conversation carries ' +
      'on from it. Use it instead of polling. `timeout_s` defaults to 600 and is capped at ' +
      '3600; the result says which tasks were still running when it ran out.',
    inputSchema: TaskWaitInputSchema,
    run: () => errorResult(HARNESS_ANSWERED),
  })
}

/** The names of the five, for a caller that has to filter a registry by them. */
export const SUBAGENT_TOOL_NAMES = [
  AGENT_TOOL_NAME,
  AGENT_MESSAGE_TOOL_NAME,
  TASK_WAIT_TOOL_NAME,
  AGENT_STOP_TOOL_NAME,
  MESSAGE_PARENT_TOOL_NAME,
] as const

/** Whether a tool name is one of the subagent tools. */
export function isSubagentToolName(name: string): boolean {
  return (SUBAGENT_TOOL_NAMES as readonly string[]).includes(name)
}
