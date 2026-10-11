import { errorResult } from '@openharness/hands'
import type { ToolRegistry, ToolResult } from '@openharness/hands'
import type {
  AskUserAnswer,
  EventId,
  StoredEvent,
  TextBlock,
  ToolCallEvent,
  ToolInput,
  UserToolConfirmationEvent,
} from '@openharness/protocol'
import {
  ASK_USER_TOOL_NAME,
  EVENT_TYPES,
  askUserAnswerProblems,
  askUserInputProblems,
  formatAskUserAnswers,
  isToolCallEvent,
  isToolResultEvent,
  parseAskUserInput,
  toolCallInput,
  toolCallOfferedName,
  toolCallPermission,
  toolResultCallId,
} from '@openharness/protocol'
import type { AppendableEvent } from '@openharness/session'

import { toolResultForCall } from './events'

/**
 * The pause: the calls a turn waits on the user for, and what answers them (epic #303, X6;
 * #309).
 *
 * The log is the whole of it, which is what makes a pause survive a restart, a compaction and
 * a replay without storing anything beside it:
 *
 * - a call **waiting on the user** is an `agent.tool_use` with no `agent.tool_result` and
 *   `evaluated_permission: ask` — the permission the loop recorded for it, either because the
 *   settings in force said to ask or because the tool is `ask_user`, whose calls are always
 *   answered by the user. Nothing else marks it, and no timer is involved: the session is
 *   simply idle (`session.status_idle { requires_action }`) until something answers it.
 * - the **answer** is one `user.tool_confirmation` naming the call. The event is the record: a
 *   `remember: session` approval is read back from it on every request, so it lives exactly as
 *   long as the branch it is on — a `session.rewind` past it takes it back with everything else
 *   the edit replaced.
 *
 * This module owns those two questions and the ways a waiting call is answered — run it, refuse
 * it, or write the user's answers as its result — because every one of them is the same read of
 * the same log, whatever the tool is. An MCP tool that asks (#312) pauses through exactly this
 * path.
 */

/**
 * What a call is answered with when the user does something else instead of answering it.
 *
 * A `user.message` that arrives while calls are waiting resolves every one of them — the user
 * chose to say something rather than to answer — and an interrupt does the same, which is why
 * the sentence names the message rather than the act that ended the waiting (epic #303, #309).
 */
export const RESOLVED_BY_MESSAGE = 'The user sent a message instead.'

/**
 * The calls the log holds that are waiting on the user, in the order the model made them.
 *
 * A call is waiting when it has no result and the loop evaluated it under `ask`: the settings
 * said to ask first, or the tool is `ask_user`, whose calls only ever end in the user's
 * answers. `repairLostExecutions` is the complement — everything unanswered that is *not*
 * waiting was a call the brain never got to run, and a brain that inherits it must not run it
 * now.
 *
 * Built-in calls and remote MCP ones alike (#312): a remote tool's default policy is `ask`, so
 * this is the read that a remote tool's pause is found by.
 *
 * @param events the session's log, as the turn's replay read handed it over
 */
export function awaitingUser(events: readonly StoredEvent[]): ToolCallEvent[] {
  const answered = answeredCallIds(events)
  return events.filter(
    (event): event is ToolCallEvent =>
      isToolCallEvent(event) && toolCallPermission(event) === 'ask' && !answered.has(event.id),
  )
}

/** The ids of the calls the log answers, whichever pair each answer belongs to (#312). */
function answeredCallIds(events: readonly StoredEvent[]): Set<EventId> {
  const answered = new Set<EventId>()
  for (const event of events) {
    if (isToolResultEvent(event)) {
      answered.add(toolResultCallId(event))
    }
  }
  return answered
}

/**
 * The calls the user has answered and whose turn has not run yet — the work a pause leaves.
 *
 * A confirmation is not a queued user event, so a session sitting on one looks idle to
 * everything that reads the store's pending list; this is what says it is not. The turn loop
 * asks it of the whole log, and the no-op guard asks the store for the newest tool event, which
 * is enough: between a confirmation and the turn it starts, nothing else writes one.
 *
 * @param events the session's log, as the turn's replay read handed it over
 */
export function answeredWaiting(events: readonly StoredEvent[]): ToolCallEvent[] {
  const confirmations = confirmationsByCall(events)
  return awaitingUser(events).filter((call) => confirmations.has(call.id))
}

/**
 * The confirmations the log holds, keyed by the call each answers — the newest one when a call
 * has more than one.
 *
 * A second confirmation for the same call is a reader who changed their mind (the route accepts
 * it while the call has no result), so the later event is the one that counts everywhere: what
 * runs, and what a `remember: session` means.
 *
 * @param events the session's log, as the turn's replay read handed it over
 */
export function confirmationsByCall(
  events: readonly StoredEvent[],
): ReadonlyMap<EventId, UserToolConfirmationEvent> {
  const byCall = new Map<EventId, UserToolConfirmationEvent>()
  for (const event of events) {
    if (event.type === EVENT_TYPES.userToolConfirmation) {
      byCall.set(event.tool_use_id, event)
    }
  }
  return byCall
}

/**
 * The tools this chat has been told to allow without asking again — `remember: session`, and
 * `always`, which is the same for this chat and additionally writes the user's stored setting.
 *
 * Read off the log on every request rather than kept anywhere: the confirmation events *are*
 * the record, so a compaction cannot drop it, a replay rebuilds it exactly, and a rewind past
 * the confirmation removes it along with the branch — which is what "remembered for this chat"
 * has to mean if the log is the source of truth.
 *
 * @param events the session's log, as the turn's replay read handed it over
 */
export function sessionApprovedTools(events: readonly StoredEvent[]): ReadonlySet<string> {
  const calls = new Map<EventId, string>()
  for (const event of events) {
    if (isToolCallEvent(event)) {
      // Keyed by the name the model called the tool by — for a remote tool the offered name
      // (#312), which is what a request's settings and registry are keyed by too.
      calls.set(event.id, toolCallOfferedName(event))
    }
  }
  const approved = new Set<string>()
  for (const event of events) {
    if (event.type !== EVENT_TYPES.userToolConfirmation || event.result !== 'allow') {
      continue
    }
    if (event.remember !== 'session' && event.remember !== 'always') {
      continue
    }
    const name = calls.get(event.tool_use_id)
    if (name !== undefined) {
      approved.add(name)
    }
  }
  return approved
}

/**
 * Whether a call is one the user has to answer before it can run (epic #303, #309).
 *
 * Two things make a call wait, and they are deliberately one predicate: the permission the loop
 * evaluated it under (`ask`, which the settings resolver answered or the tool's own declaration
 * did), and `ask_user`, whose calls are answered by the user whatever the policy says — the tool
 * has no `run` that could produce a result, so its pause is not a permission at all. A name this
 * deployment does not register waits for nothing: no tool of that name can be called, and the
 * registry is what says so.
 *
 * @param permission the permission the call was evaluated under
 * @param registered whether the request's registry holds a tool of that name
 * @param name the tool's name
 */
export function waitsForUser(permission: string, registered: boolean, name: string): boolean {
  return registered && (permission === 'ask' || name === ASK_USER_TOOL_NAME)
}

/**
 * What is wrong with an `ask_user` call's questions, or `null` when they can be asked — and
 * `null` for a call to any other tool.
 *
 * A malformed call is the one case a pause must not happen on: the model is told what was wrong
 * with its questions and asks again, rather than the turn ending on a question nobody can
 * answer. The check is the protocol's own ({@link askUserInputProblems}), so the shape the
 * model is held to is exactly the shape a client renders and an answer is validated against.
 *
 * @param call the call the model made
 */
export function malformedQuestion(call: {
  readonly name: string
  readonly input: ToolInput
}): string | null {
  if (call.name !== ASK_USER_TOOL_NAME) {
    return null
  }
  const problems = askUserInputProblems(call.input)
  if (problems.length === 0) {
    return null
  }
  return `Invalid input for ${call.name}: ${problems.join('; ')}`
}

/** What a call of a step is answered with, or `null` for a call left waiting on the user. */
export type CallOutcome = ToolResult | null

/**
 * What a call the user has answered is answered with — or `null` for one they have not.
 *
 * Three outcomes, and the one that is interesting is `null`: a confirmation with no answers for
 * a tool the user *approved* is not answered here at all. The loop runs it (that is what the
 * approval was for), and this function only says what the log already decided — a refusal, the
 * answers themselves, or "nothing yet".
 *
 * A denial is refused with the user's own words when they gave any. An `ask_user` call is
 * answered with its answers, validated against the questions the call asked: the answers *are*
 * the result, because the tool never runs.
 *
 * @param call the call being answered
 * @param confirmation the confirmation the log holds for it
 * @param recovered whether this turn inherited an open turn — a resumed brain must not run a
 *   tool again, so an approval it finds unfinished is answered as lost (X3)
 */
export function confirmationOutcome(
  call: ToolCallEvent,
  confirmation: UserToolConfirmationEvent,
  recovered: boolean,
): CallOutcome {
  if (confirmation.result === 'deny') {
    return errorResult(denied(confirmation.deny_message))
  }
  const answers = confirmation.answers
  if (answers !== undefined) {
    return answersOutcome(call, answers)
  }
  return recovered ? errorResult(executionLost(toolCallOfferedName(call))) : null
}

/** What a denial is answered with: the user's own words when they gave any. */
export function denied(message: string | undefined): string {
  return message === undefined ? 'The user denied this.' : `The user denied this: ${message}`
}

/** What a call whose turn died before running it is answered with (X3). */
export function executionLost(name: string): string {
  return (
    `Tool ${name}: execution lost. The turn that started this call did not finish, ` +
    'so it was not run again.'
  )
}

/** The answers a confirmation carried, as the result the call is owed. */
function answersOutcome(call: ToolCallEvent, answers: readonly AskUserAnswer[]): ToolResult {
  const name = toolCallOfferedName(call)
  const input = parseAskUserInput(toolCallInput(call))
  if (input === null) {
    // The call was stored paused, so its questions parsed when it was made — unless the tool it
    // names was called with something else entirely. Either way the answers cannot be written:
    // say so rather than storing a result nothing can read.
    return errorResult(
      `Tool ${name} was not called with questions, so the answers to it cannot be stored.`,
    )
  }
  const problems = askUserAnswerProblems(input, answers)
  if (problems.length > 0) {
    // The route refuses these before they are stored; a log assembled another way could still
    // hold them, and a result the model cannot act on is worse than one that says what is wrong.
    return errorResult(`Invalid answers for ${name}: ${problems.join('; ')}`)
  }
  return { content: [text(formatAskUserAnswers(input, answers))] }
}

/** One text block, the shape every result's content has. */
function text(value: string): TextBlock {
  return { type: 'text', text: value }
}

/** What the loop tells {@link answerConfirmations} about the calls it is answering. */
export interface AnswerConfirmationsOptions {
  /** The calls the user has answered, in call order. */
  readonly calls: readonly ToolCallEvent[]
  /** The confirmations the log holds, keyed by the call each answers. */
  readonly confirmations: ReadonlyMap<EventId, UserToolConfirmationEvent>
  /**
   * The tools a call may be run with — the deployment's registry with the request's remote MCP
   * tools in it, or `undefined` for a host that registers none. An approved call is run through
   * **this** registry rather than a request's offer: the user has answered for that tool, and
   * the offer decides what a model may ask for, not whether an answer the user gave is honoured.
   * It is the combined one because an approved remote call has to be runnable (#312) — and one
   * whose server has since been removed is answered by this registry's own "not registered".
   */
  readonly registry: ToolRegistry | undefined
  /** The per-user values the host resolved for this turn (X4). */
  readonly secrets?: Readonly<Record<string, string>>
  /** The turn's signal: an aborted call is answered as interrupted. */
  readonly signal?: AbortSignal
  /** Whether this turn inherited an open turn; see {@link confirmationOutcome}. */
  readonly recovered: boolean
  /** The turn's one write path: validated, fenced, and atomic per append. */
  readonly append: (events: AppendableEvent[]) => Promise<StoredEvent[]>
}

/**
 * Answer the calls the user has answered since the last request (epic #303, X6; #309).
 *
 * One append, in call order, like the loop's own tool step: the calls the user approved run
 * concurrently through the registry — with the same signal, timeout and secret-scrubbing every
 * call goes through — the ones they refused are answered with the refusal, and an `ask_user`
 * call is answered with the answers themselves. The caller re-reads the log afterwards, because
 * these results are what the next request is built from.
 *
 * Nothing here decides *whether* to pause: a call the user has not answered is not in `calls`,
 * and stays waiting.
 */
export async function answerConfirmations(options: AnswerConfirmationsOptions): Promise<void> {
  const { calls, confirmations, registry, append } = options
  if (calls.length === 0) {
    return
  }
  const outcomes = await Promise.all(
    calls.map(async (call): Promise<CallOutcome> => {
      // The name the model called the tool by — for a remote MCP tool the offered name (#312),
      // which is what this deployment's registry is keyed by.
      const name = toolCallOfferedName(call)
      const confirmation = confirmations.get(call.id)
      const decided =
        confirmation === undefined
          ? null
          : confirmationOutcome(call, confirmation, options.recovered)
      if (decided !== null || confirmation === undefined) {
        return decided
      }
      // An approval with no answers: the call runs now, because the user said it may. The
      // registry answers a name it does not hold itself (`No tool named … is registered.`).
      if (registry === undefined) {
        return errorResult(
          `Tool ${name}: the call was approved, but this deployment registers no tools ` +
            'to run it with.',
        )
      }
      return await registry.execute(name, toolCallInput(call), {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      })
    }),
  )
  const stored = await append(
    calls.map((call, index) => {
      const result = outcomes[index]
      // The result is written in the call's own pair: an approved remote tool is answered with
      // an `agent.mcp_tool_result`, exactly as the step that called it would have (#312).
      return toolResultForCall(call, result?.content ?? [], result?.isError === true)
    }),
  )
  if (stored.length !== calls.length) {
    throw new Error('the store did not return the tool results it was asked to append')
  }
}

/** What the loop tells {@link resolveWaiting} about the calls it is giving up on. */
export interface ResolveWaitingOptions {
  /** The calls that are still waiting on the user, in call order. */
  readonly calls: readonly ToolCallEvent[]
  /** The turn's one write path. */
  readonly append: (events: AppendableEvent[]) => Promise<StoredEvent[]>
}

/**
 * Answer every call still waiting, because the user did something else instead (epic #303, #309).
 *
 * A `user.message` that arrives while a call waits — and an interrupt, which ends the turn the
 * user asked to end — resolves it: the approval is a denial the user never made, but the effect
 * is the same, and a question simply goes unanswered. Both are written as one `is_error` result
 * with {@link RESOLVED_BY_MESSAGE}, so the model is told what happened rather than left to guess
 * why its call never came back.
 */
export async function resolveWaiting(options: ResolveWaitingOptions): Promise<void> {
  const { calls, append } = options
  if (calls.length === 0) {
    return
  }
  await append(calls.map((call) => toolResultForCall(call, [text(RESOLVED_BY_MESSAGE)], true)))
}
