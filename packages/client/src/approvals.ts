import {
  ASK_USER_TOOL_NAME,
  askUserAnswerProblems,
  parseAskUserInput,
  type AskUserAnswer,
  type AskUserQuestion,
  type ToolConfirmationRemember,
  type ToolConfirmationResult,
  type UserToolConfirmationEventInput,
} from '@openharness/protocol'

import type { TranscriptToolCall } from './tools'

/**
 * The pause, as a frontend sees it (epic #303, X6; issues #309, #310).
 *
 * A turn ends waiting on the reader for one of two reasons, and both are the same event in the
 * log: a call the settings evaluated `ask` (the reader has to allow it before anything runs),
 * and a call to `ask_user` (the reader's answers **are** its result). The log says which by
 * the call's name — {@link ASK_USER_TOOL_NAME} — and the reading is deliberately shared, so
 * the page and `oh` agree about what a `waiting` line is asking for and about the one event
 * that answers it.
 *
 * Three things live here, and none of them touch a transport:
 *
 * - **which calls are waiting** ({@link pendingCalls}, {@link pendingCallKind}) — the calls a
 *   renderer draws a prompt for;
 * - **what a draft answers** ({@link answersFrom}, {@link draftProblems}) — the form's state
 *   turned into the wire's answers, checked with the protocol's own validator, so a client
 *   cannot send what the server would refuse with a 400;
 * - **the words** ({@link approvalChoiceLabel}, {@link confirmationSummary},
 *   {@link pendingCallsNotice}) — the sentences and labels a reader sees, in one place so the
 *   terminal and the page cannot disagree.
 *
 * The confirmation itself is built here too ({@link approvalConfirmation},
 * {@link answerConfirmation}, {@link declineConfirmation}): one `user.tool_confirmation` per
 * call, sent on `POST …/events` like any other user event. The server checks it against the
 * log before storing it and the brain writes the `agent.tool_result` the call is owed, so a
 * client never writes a result.
 */

/** Whether a waiting call is an approval to give or a question to answer. */
export type PendingCallKind = 'approval' | 'question'

/**
 * One call the reader owes an answer to, and which of the two prompts it needs.
 *
 * `questions` is the parsed input of an `ask_user` call — one to four questions, in the order
 * the model asked them — and is empty for an approval, whose whole content is the call itself.
 */
export interface PendingCall {
  /** The call, as the transcript holds it (`status: 'waiting'`). */
  readonly call: TranscriptToolCall
  /** Which prompt answers it. */
  readonly kind: PendingCallKind
  /** The questions an `ask_user` call asked; empty for an approval. */
  readonly questions: readonly AskUserQuestion[]
}

/**
 * The calls a reader owes an answer to, in the order the model made them (epic #303, #310).
 *
 * A call waits when it is `waiting` — the status the transcript derives, which is a call whose
 * `evaluated_permission` is `ask` and that no result has answered. That is the one reading, so a
 * prompt is drawn from exactly the fact that makes the turn a pause.
 */
export function pendingCalls(calls: readonly TranscriptToolCall[]): readonly PendingCall[] {
  const pending: PendingCall[] = []
  for (const call of calls) {
    const kind = pendingCallKind(call)
    if (kind === null) {
      continue
    }
    pending.push({ call, kind, questions: askUserQuestions(call) ?? [] })
  }
  return pending
}

/**
 * Which prompt a waiting call needs, or `null` when it is not waiting (epic #303, #310).
 *
 * The name decides: a call to `ask_user` is a question, and every other waiting call is an
 * approval. A call the log says is not waiting — one with a result, or one the policy ran
 * outright — is no one's to answer.
 */
export function pendingCallKind(call: TranscriptToolCall): PendingCallKind | null {
  if (call.status !== 'waiting') {
    return null
  }
  return call.name === ASK_USER_TOOL_NAME ? 'question' : 'approval'
}

/**
 * The questions an `ask_user` call asked, or `null` when it is not one or its input is not a
 * well-formed set of questions.
 *
 * Parsed with the protocol's own {@link parseAskUserInput}, which is the same check the brain
 * made before it paused — so a call that reaches a client as `ask_user` really does carry
 * questions, and a malformed call the model made is one the brain answered with an error
 * result rather than one a client has to render (that call is not waiting at all).
 */
export function askUserQuestions(call: {
  readonly name: string
  readonly input: TranscriptToolCall['input']
}): readonly AskUserQuestion[] | null {
  if (call.name !== ASK_USER_TOOL_NAME) {
    return null
  }
  const parsed = parseAskUserInput(call.input)
  return parsed === null ? null : parsed.questions
}

/** The four things a reader can say about a waiting call (epic #303, X6; #310). */
export type ApprovalChoice = 'allow-once' | 'allow-session' | 'allow-always' | 'deny'

/**
 * The choices an approval prompt offers, in the order they are drawn — the safe one first.
 *
 * `allow-session` and `allow-always` are the `remember` extension the protocol carries on the
 * confirmation: `session` allows every later call to the same tool in this chat (read back off
 * the log, so an edit that rewinds past it takes it back), and `always` is the same **and**
 * writes the reader's stored policy for that tool, which is what the next chat inherits.
 */
export const APPROVAL_CHOICES: readonly {
  readonly choice: ApprovalChoice
  readonly label: string
}[] = [
  { choice: 'allow-once', label: 'Allow once' },
  { choice: 'allow-session', label: 'Allow for this chat' },
  { choice: 'allow-always', label: 'Always allow' },
  { choice: 'deny', label: 'Deny' },
]

/** The words for one approval choice, the same in both frontends (epic #303, #310). */
export function approvalChoiceLabel(choice: ApprovalChoice): string {
  return APPROVAL_CHOICES.find((entry) => entry.choice === choice)?.label ?? choice
}

/**
 * What `remember` a choice sends, or `undefined` for the `once` the protocol defaults to.
 *
 * `allow-once` is `undefined` rather than the literal `'once'` because the field is an
 * extension: leaving it out is what a confirmation that means "this call and no other" says,
 * and it keeps an approval of a call made by an older client byte-identical.
 */
function rememberFor(choice: ApprovalChoice): ToolConfirmationRemember | undefined {
  switch (choice) {
    case 'allow-session':
      return 'session'
    case 'allow-always':
      return 'always'
    default:
      return undefined
  }
}

/** The `result` a choice sends: only `deny` refuses the call. */
function resultFor(choice: ApprovalChoice): ToolConfirmationResult {
  return choice === 'deny' ? 'deny' : 'allow'
}

/**
 * The event that answers one waiting call with an approval or a refusal (epic #303, X6; #310).
 *
 * A denial may carry the reader's own words, which the brain turns into the result the model
 * reads (`The user denied this: …`) — an empty or whitespace-only message is left out rather
 * than sent blank, because the protocol wants a non-empty one.
 *
 * @param toolUseId the call's id — the `agent.tool_use` event's own id
 * @param choice what the reader decided
 * @param denyMessage why, when it was a denial and the reader said so
 */
export function approvalConfirmation(
  toolUseId: string,
  choice: ApprovalChoice,
  denyMessage?: string,
): UserToolConfirmationEventInput {
  const remember = rememberFor(choice)
  const message = denyMessage?.trim()
  return {
    type: 'user.tool_confirmation',
    // The id is a call's own `agent.tool_use` id, which the protocol brands (`sevt_…`): it came
    // off a parsed event, so the brand is already true — the wire type is what spells it.
    tool_use_id: toolUseId as UserToolConfirmationEventInput['tool_use_id'],
    result: resultFor(choice),
    ...(choice === 'deny' && message !== undefined && message !== ''
      ? { deny_message: message }
      : {}),
    ...(remember === undefined ? {} : { remember }),
  }
}

/**
 * The events that answer several waiting calls the same way (epic #303, #310).
 *
 * "Allow all" and "Deny all" are one event per call — the log holds one confirmation per call,
 * which is what makes "every confirmation names a call that was waiting" readable one call at
 * a time — sent in one batch. The calls are answered in the order they were made, so the
 * results the brain writes read like the model's own questions.
 */
export function approvalConfirmations(
  calls: readonly TranscriptToolCall[],
  choice: ApprovalChoice,
): readonly UserToolConfirmationEventInput[] {
  return calls.map((call) => approvalConfirmation(call.id, choice))
}

/**
 * The event that refuses a call the reader will not answer (epic #303, #310).
 *
 * This is what an `ask_user` prompt's **Decline** sends: a question with no answers is not an
 * approval, and a denial is the one event that says "not answered" — the brain writes it as an
 * `is_error` result, so the model learns the reader moved on rather than reading silence.
 */
export function declineConfirmation(
  toolUseId: string,
  message?: string,
): UserToolConfirmationEventInput {
  return approvalConfirmation(toolUseId, 'deny', message)
}

/**
 * The event that carries an `ask_user` call's answers (epic #303, X6; #310).
 *
 * The answers **are** the call's result — the tool never runs — so this is an approval with
 * `answers` rather than a result of its own. The protocol refuses a question approved with no
 * answers, which is why {@link draftProblems} has to be clear before a form submits.
 */
export function answerConfirmation(
  toolUseId: string,
  answers: readonly AskUserAnswer[],
): UserToolConfirmationEventInput {
  return {
    type: 'user.tool_confirmation',
    tool_use_id: toolUseId as UserToolConfirmationEventInput['tool_use_id'],
    result: 'allow',
    answers,
  }
}

/**
 * The label a `choice` question always offers whatever its options are (epic #303, X6; #310).
 *
 * "Other" with free text is part of the type rather than an option a call lists — a model that
 * wants a write-in does not have to ask for one — so both forms draw this row themselves and
 * an answer that carries only `text` is the write-in.
 */
export const OTHER_CHOICE_LABEL = 'Other'

/** One question's answer as a form holds it, before it is turned into the wire's shape. */
export interface QuestionDraft {
  /** The offered labels the reader selected; never {@link OTHER_CHOICE_LABEL}. */
  readonly labels: readonly string[]
  /** The reader's own words: a `text` answer, or the write-in beside a `choice`. */
  readonly text: string
  /** Whether the write-in row is chosen on a `choice` question. */
  readonly other: boolean
  /** The answer to a `confirm` question, or `null` while the reader has not said. */
  readonly confirmed: boolean | null
}

/** The draft a question starts from: nothing said. */
export function emptyDraft(): QuestionDraft {
  return { labels: [], text: '', other: false, confirmed: null }
}

/** The drafts a form starts from: one per question, in the order they were asked. */
export function emptyDrafts(questions: readonly AskUserQuestion[]): readonly QuestionDraft[] {
  return questions.map(() => emptyDraft())
}

/**
 * Select or deselect an option of a `choice` question.
 *
 * A single-select question replaces what was chosen; a `multi_select` one toggles, so a reader
 * can pick several and unpick one. Choosing an option never touches the write-in: they are
 * sent side by side, which is exactly what an answer carrying both `labels` and `text` means.
 */
export function withLabel(
  draft: QuestionDraft,
  label: string,
  options: { readonly multi: boolean },
): QuestionDraft {
  if (!options.multi) {
    return { ...draft, labels: [label] }
  }
  return draft.labels.includes(label)
    ? { ...draft, labels: draft.labels.filter((chosen) => chosen !== label) }
    : { ...draft, labels: [...draft.labels, label] }
}

/** Turn the write-in row on or off, keeping whatever the reader has typed so far. */
export function withOther(draft: QuestionDraft, other: boolean): QuestionDraft {
  return { ...draft, other }
}

/** Set the reader's own words, for a `text` question or a write-in. */
export function withText(draft: QuestionDraft, text: string): QuestionDraft {
  return { ...draft, text }
}

/** Answer a `confirm` question. */
export function withConfirmed(draft: QuestionDraft, confirmed: boolean): QuestionDraft {
  return { ...draft, confirmed }
}

/**
 * The drafts as the wire's answers, one per question (epic #303, #310).
 *
 * Fields a question's type does not carry are left out rather than sent empty — a `choice`
 * with no label and no write-in sends neither, which is what makes the server's validator see
 * the answer a reader really gave. Callers should have checked {@link draftProblems} first;
 * this builds the shape and does not decide whether it fits.
 *
 * @param questions the questions the call asked, in order
 * @param drafts one draft per question, by index
 */
export function answersFrom(
  questions: readonly AskUserQuestion[],
  drafts: readonly QuestionDraft[],
): readonly AskUserAnswer[] {
  return questions.map((question, index) => {
    const draft = drafts[index] ?? emptyDraft()
    const text = draft.text.trim()
    if (question.type === 'confirm') {
      return {
        question: question.question,
        ...(draft.confirmed === null ? {} : { confirmed: draft.confirmed }),
      }
    }
    if (question.type === 'text') {
      return { question: question.question, ...(text === '' ? {} : { text }) }
    }
    return {
      question: question.question,
      ...(draft.labels.length === 0 ? {} : { labels: draft.labels }),
      ...(draft.other && text !== '' ? { text } : {}),
    }
  })
}

/**
 * What is wrong with the drafts, one `header: message` per problem — empty when they can be
 * sent (epic #303, X6; #310).
 *
 * The check is the protocol's own {@link askUserAnswerProblems}, so a form is held to exactly
 * the shape the server refuses a 400 for — the reader sees why next to the question rather
 * than the whole submission coming back as an error. A caller disables Submit on a non-empty
 * answer and shows the lines beside the questions.
 */
export function draftProblems(
  questions: readonly AskUserQuestion[],
  drafts: readonly QuestionDraft[],
): readonly string[] {
  return askUserAnswerProblems({ questions: [...questions] }, answersFrom(questions, drafts))
}

/** Whether every question is answered well enough to submit ({@link draftProblems} is empty). */
export function draftComplete(
  questions: readonly AskUserQuestion[],
  drafts: readonly QuestionDraft[],
): boolean {
  return draftProblems(questions, drafts).length === 0
}

/**
 * What an answered pause shows in the transcript, or `null` when it needs no line of its own
 * (epic #303, X6; #310).
 *
 * The `user.tool_confirmation` is the log's record of the decision, and the transcript keeps
 * it so a call that ran can say **how** it was allowed — "Allowed once", "Allowed for this
 * chat", "Always allowed" — which the tool's own result cannot: a result is what the tool
 * answered, not what the reader decided. A denial is drawn from the result the brain wrote
 * (the reader's own words are in it), and an `ask_user` call's answers **are** its result, so
 * both answer `null`: the call line already says them.
 */
export function confirmationSummary(confirmation: {
  readonly result: ToolConfirmationResult
  readonly remember?: ToolConfirmationRemember | undefined
  readonly answers?: readonly AskUserAnswer[] | undefined
}): string | null {
  if (confirmation.result === 'deny') {
    return null
  }
  if (confirmation.answers !== undefined) {
    return null
  }
  switch (confirmation.remember) {
    case 'session':
      return 'Allowed for this chat'
    case 'always':
      return 'Always allowed'
    default:
      return 'Allowed once'
  }
}

/**
 * The line a reader is owed while calls are waiting and they are typing a message instead
 * (epic #303, #310).
 *
 * A `user.message` that arrives while a turn waits resolves every waiting call — the brain
 * answers each `The user sent a message instead.` — so sending one is a decision about all of
 * them, and the composer says so before the reader presses Enter rather than after. The count
 * is what makes it honest when several calls are waiting at once.
 *
 * @param count how many calls are waiting on the reader
 */
export function pendingCallsNotice(count: number): string | null {
  if (count <= 0) {
    return null
  }
  return count === 1
    ? 'Sending a message will decline the item waiting on you.'
    : `Sending a message will decline the ${count} items waiting on you.`
}
