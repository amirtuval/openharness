import type { ToolDefinition } from '@openharness/hands'
import { textResult } from '@openharness/hands'
import type {
  AskUserInput,
  EventId,
  SessionId,
  StoredEvent,
  UserId,
  UserToolConfirmationEventInput,
  UserToolSettings,
} from '@openharness/protocol'
import {
  ASK_USER_TOOL_NAME,
  AskUserInputSchema,
  EVENT_TYPES,
  MAX_PAGE_LIMIT,
  askUserAnswerProblems,
  parseAskUserInput,
} from '@openharness/protocol'
import type { SessionStore } from '@openharness/session'

import { invalidRequest } from './http/errors'

/**
 * The server's half of pausing (epic #303, X6; #309): the `ask_user` tool this process
 * registers, and the checks a `user.tool_confirmation` passes before it is stored.
 *
 * The brain owns what a pause *means* (`@openharness/brain`'s `pausing`); this module owns what
 * a client may send. A confirmation is a client-sent event the server writes, so the wire's
 * rules are here: it has to name a call that is really waiting in **this** session, its answers
 * have to fit the questions that call asked, and the two extensions have to make sense for the
 * call (`answers` for a question, `remember` for an approval). Anything else is the protocol's
 * 400 `invalid_request_error` and stores nothing — a confirmation nobody can act on would
 * otherwise sit in the log looking like an answer.
 */

/**
 * The `ask_user` tool, registered by every deployment (epic #303, X6; #309).
 *
 * A model that needs a decision asks for one: the call is stored, nothing runs it, and the
 * turn ends `requires_action` until one `user.tool_confirmation` carries the user's answers —
 * which the brain writes as the call's result. That is why `run` never produces anything a
 * model would read as an answer: the call is answered by the user or not at all, and this is
 * the sentence that reaches the log in the one case something runs it anyway (a client that
 * approves a question without answering it, which the route refuses).
 */
export const askUserTool: ToolDefinition<AskUserInput> = {
  name: ASK_USER_TOOL_NAME,
  description:
    'Ask the user a question and wait for their answer. Use it when you need a decision you ' +
    'cannot make yourself: a choice between options, a piece of information only they have, or ' +
    'a yes/no confirmation before doing something they may not want. One to four questions, ' +
    'and the user may always answer "Other" in their own words.',
  inputSchema: AskUserInputSchema,
  permission: 'allow',
  run: () =>
    textResult(
      'This call is answered by the user, not run: the user has not answered it yet. Do not ' +
        'try to answer it yourself.',
    ),
}

/** Whether an event a client sent is a tool confirmation. */
export function isConfirmation(event: {
  readonly type: string
}): event is UserToolConfirmationEventInput {
  return event.type === EVENT_TYPES.userToolConfirmation
}

/** What the checks need: the log, scoped to the caller. */
export interface PausingDeps {
  /** The store the call a confirmation names is read from. */
  readonly store: Pick<SessionStore, 'listEvents'>
}

/**
 * Check every confirmation in a batch, and refuse the whole request when one of them cannot be
 * acted on.
 *
 * The rules, in one place:
 *
 * - the call it names has to be an `agent.tool_use` of this session, with no
 *   `agent.tool_result` answering it and `evaluated_permission: ask` — a call that is really
 *   waiting. A confirmation for anything else (a call that already ran, a call the settings
 *   allowed outright, a call of another session) is the 400, and nothing is stored.
 * - `answers` belong to an `ask_user` call and are required to *allow* one (a denial means the
 *   user would not answer); `remember` belongs to an approval, never to a question, which is
 *   what a client would otherwise use to silence a question forever.
 * - the answers have to fit the questions the call asked: every question answered once, and
 *   each answer of the type its question takes (`askUserAnswerProblems`). A mismatch is a 400
 *   rather than a result the model would have to interpret.
 *
 * @param deps the store to read the session's calls from
 * @param sessionId the session the batch was posted to
 * @param ownerId the caller, for the owner-scoped read (A4)
 * @param confirmations the confirmations in the batch, in order
 * @returns the tool names the batch approved for `always` — what the caller writes the user's
 *   stored policy for, once the events are really stored
 * @throws HttpError the protocol's 400 for a confirmation that cannot be acted on
 */
export async function assertConfirmations(
  deps: PausingDeps,
  sessionId: SessionId,
  ownerId: UserId,
  confirmations: readonly UserToolConfirmationEventInput[],
): Promise<string[]> {
  if (confirmations.length === 0) {
    return []
  }
  const calls = await sessionCalls(deps, sessionId, ownerId)
  const always: string[] = []
  for (const confirmation of confirmations) {
    const call = calls.get(confirmation.tool_use_id)
    if (call === undefined) {
      throw invalidRequest(
        `no agent.tool_use of session ${sessionId} has the id ${confirmation.tool_use_id}, so there is nothing to confirm`,
      )
    }
    if (call.answered || call.evaluated_permission !== 'ask') {
      throw invalidRequest(
        `the call ${confirmation.tool_use_id} to ${call.name} is not waiting for the user: only a call the settings asked about, or one that was never answered, can be confirmed`,
      )
    }
    assertConfirmationFits(call, confirmation)
    if (confirmation.result === 'allow' && confirmation.remember === 'always') {
      always.push(call.name)
    }
  }
  return always
}

/** What a call in the log looks like to the checks. */
interface CallInLog {
  readonly id: EventId
  readonly name: string
  /** The call's arguments, as stored. */
  readonly input: unknown
  /** What the policy in force said about it — `ask` is what makes it wait. */
  readonly evaluated_permission: string
  /** Whether an `agent.tool_result` answers it. */
  readonly answered: boolean
}

/**
 * The calls this session's log holds, by id — the ones a confirmation could name.
 *
 * Read with a `types` filter, so the walk is over the tool events a session made and not its
 * whole conversation: a session that has never called a tool costs one empty page, and one that
 * has called a thousand pays for the calls alone. Replay skips what a supersession covers, so a
 * call an edit took back is not a call anybody can confirm.
 */
async function sessionCalls(
  deps: PausingDeps,
  sessionId: SessionId,
  ownerId: UserId,
): Promise<Map<string, CallInLog>> {
  const calls = new Map<string, CallInLog>()
  let page = undefined as string | undefined
  for (;;) {
    const answer = await deps.store.listEvents(sessionId, {
      ownerId,
      types: [EVENT_TYPES.agentToolUse, EVENT_TYPES.agentToolResult],
      limit: MAX_PAGE_LIMIT,
      ...(page === undefined ? {} : { page }),
    })
    for (const event of answer.data) {
      recordCall(calls, event)
    }
    if (answer.next_page === null) {
      return calls
    }
    page = answer.next_page
  }
}

/** Fold one stored event into the map: a call starts one, a result marks it answered. */
function recordCall(calls: Map<string, CallInLog>, event: StoredEvent): void {
  if (event.type === EVENT_TYPES.agentToolUse) {
    calls.set(event.id, {
      id: event.id,
      name: event.name,
      input: event.input,
      evaluated_permission: event.evaluated_permission,
      answered: false,
    })
    return
  }
  if (event.type === EVENT_TYPES.agentToolResult) {
    const call = calls.get(event.tool_use_id)
    if (call !== undefined) {
      calls.set(call.id, { ...call, answered: true })
    }
  }
}

/** Refuse a confirmation whose extensions do not fit the call they answer. */
function assertConfirmationFits(
  call: CallInLog,
  confirmation: UserToolConfirmationEventInput,
): void {
  const answers = confirmation.answers
  if (call.name !== ASK_USER_TOOL_NAME) {
    if (answers !== undefined) {
      throw invalidRequest(
        `the call to ${call.name} asks no questions, so it cannot be answered with \`answers\``,
      )
    }
    return
  }
  if (confirmation.remember !== undefined) {
    throw invalidRequest(
      'a question is not an approval: `remember` cannot silence the next `ask_user` call',
    )
  }
  if (answers === undefined) {
    if (confirmation.result === 'allow') {
      throw invalidRequest(
        'a call to ask_user is answered with `answers`: allow it with the user’s answers, or deny it because they would not answer',
      )
    }
    return
  }
  const questions = parseAskUserInput(call.input)
  if (questions === null) {
    throw invalidRequest(
      `the call ${confirmation.tool_use_id} was not stored with questions this deployment can read`,
    )
  }
  const problems = askUserAnswerProblems(questions, answers)
  if (problems.length > 0) {
    throw invalidRequest(`the answers do not fit the questions asked: ${problems.join('; ')}`)
  }
}

/**
 * The tool names an `always` approval writes the user's stored policy for (epic #303, #309;
 * #307).
 *
 * "Remember: always" means the *next* chat inherits it, which is the settings row and not the
 * log: the confirmation is this chat's record, and this is the user's choice about the tool
 * itself. Only an approval of a real tool is one — a question is never remembered (the route
 * refuses it) — and the row keeps whatever `enabled` the user had, so remembering an approval
 * never turns a tool on behind their back.
 *
 * @param stored the user's current settings
 * @param approvals the tool names the batch approved for always
 */
export interface RememberDeps {
  /** The user's stored tool choices: the row an `always` approval writes. */
  readonly store: Pick<SessionStore, 'getToolSettings' | 'putToolSettings'>
}

/**
 * Write the user's stored policy for the tools a batch approved `always` (epic #303, #309).
 *
 * One read and one write per batch, and only when there is something to remember: the settings
 * are a value (one row per user), so the merge is a plain read-modify-write and a request that
 * carries no `always` approval never touches them. The confirmation in the log is already the
 * record of this chat's answer; this is the part the *next* chat inherits.
 *
 * @param deps the store the settings live in
 * @param ownerId the user whose settings they are
 * @param toolNames the tools to remember, in the order they were approved
 */
export async function rememberAlwaysApprovals(
  deps: RememberDeps,
  ownerId: UserId,
  toolNames: readonly string[],
): Promise<void> {
  if (toolNames.length === 0) {
    return
  }
  const stored = await deps.store.getToolSettings(ownerId)
  await deps.store.putToolSettings(ownerId, withAlwaysApprovals(stored, toolNames))
}

export function withAlwaysApprovals(
  stored: UserToolSettings,
  approvals: readonly string[],
): UserToolSettings {
  const builtin: Record<string, { enabled: boolean; policy: 'allow' | 'ask' | 'deny' }> = {}
  for (const [name, setting] of Object.entries(stored.builtin)) {
    builtin[name] = { enabled: setting.enabled, policy: setting.policy }
  }
  for (const name of approvals) {
    builtin[name] = { enabled: builtin[name]?.enabled ?? true, policy: 'allow' }
  }
  return { builtin }
}
