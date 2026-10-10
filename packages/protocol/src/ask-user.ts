import { z } from 'zod'

/**
 * `ask_user`: the built-in tool whose call always pauses for the user (epic #303, #309).
 *
 * A model that needs a decision it cannot make itself asks for one, and the loop stores the
 * call, ends the turn `requires_action` and waits — no timeout, no guessing — until a
 * `user.tool_confirmation` answers it. The user's answer **is** the tool's result: `ask_user`
 * is never run, which is why this module and not `@openharness/hands` carries what a call and
 * its answer look like.
 *
 * Two schemas, one for each direction, and one validator, because every side has to agree
 * about them: the model is asked for {@link AskUserInputSchema}'s shape (the AI SDK turns it
 * into the JSON Schema the provider sends), the brain checks a call against it before it
 * pauses, the answers a client sends are checked against {@link AskUserAnswerSchema} **and**
 * against the questions the call asked, and the answers are written into the log as the
 * tool's result in {@link formatAskUserAnswers}'s wording.
 *
 * The narrowness is deliberate: a call that does not fit is answered with an `is_error`
 * result the model can fix rather than stored as a question nobody can answer, and an answer
 * that does not fit is a 400 rather than a result the model would have to interpret.
 */

/** The name the model calls this tool by, and the name a setting speaks of it as. */
export const ASK_USER_TOOL_NAME = 'ask_user'

/** The fewest questions one call may ask. */
export const ASK_USER_MIN_QUESTIONS = 1

/** The most questions one call may ask. */
export const ASK_USER_MAX_QUESTIONS = 4

/**
 * The longest a question's `header` may be.
 *
 * A header is the short label a client puts above the question — a chip, a column heading —
 * so it is bounded by what one fits on screen rather than by what a sentence needs. Twelve is
 * Anthropic's own bound for the field.
 */
export const ASK_USER_HEADER_MAX_LENGTH = 12

/** The fewest options a `choice` question may offer. */
export const ASK_USER_MIN_OPTIONS = 2

/** The most options a `choice` question may offer. */
export const ASK_USER_MAX_OPTIONS = 6

/**
 * One option of a `choice` question: the label the answer names it by, and what it means.
 *
 * A `description` is what a client shows beside the label when there is room — the
 * difference between "production" and "the live one" — and carries nothing but a sentence.
 */
export const AskUserChoiceOptionSchema = z.object({
  /** The option's name, the way an answer refers to it. */
  label: z.string().min(1),
  /** What choosing it means, when the label is not enough. */
  description: z.string().min(1).optional(),
})

export type AskUserChoiceOption = z.infer<typeof AskUserChoiceOptionSchema>

/** The fields every question carries, whatever its type. */
const questionBase = {
  /** What the user is being asked, in a sentence. */
  question: z.string().min(1),
  /** A short label a client shows above the question: at most twelve characters. */
  header: z.string().min(1).max(ASK_USER_HEADER_MAX_LENGTH),
}

/**
 * A question with a fixed set of answers.
 *
 * `multi_select` asks for more than one of them; absent means one at most. A user may always
 * answer "Other" with free text instead, which is why a client does not have to be told to
 * offer one — it is part of the type, not an option a call lists.
 */
export const AskUserChoiceQuestionSchema = z.object({
  ...questionBase,
  type: z.literal('choice'),
  /** The options to choose from: at least two, at most six. */
  options: z.array(AskUserChoiceOptionSchema).min(ASK_USER_MIN_OPTIONS).max(ASK_USER_MAX_OPTIONS),
  /** Whether several options may be chosen. Absent means one at most. */
  multi_select: z.boolean().optional(),
})

export type AskUserChoiceQuestion = z.infer<typeof AskUserChoiceQuestionSchema>

/** A question answered in the user's own words. */
export const AskUserTextQuestionSchema = z.object({
  ...questionBase,
  type: z.literal('text'),
  /** What an empty field suggests, when the call offers one. */
  placeholder: z.string().min(1).optional(),
})

export type AskUserTextQuestion = z.infer<typeof AskUserTextQuestionSchema>

/** A yes/no question. */
export const AskUserConfirmQuestionSchema = z.object({
  ...questionBase,
  type: z.literal('confirm'),
})

export type AskUserConfirmQuestion = z.infer<typeof AskUserConfirmQuestionSchema>

/** One question of an `ask_user` call. */
export const AskUserQuestionSchema = z.discriminatedUnion('type', [
  AskUserChoiceQuestionSchema,
  AskUserTextQuestionSchema,
  AskUserConfirmQuestionSchema,
])

export type AskUserQuestion = z.infer<typeof AskUserQuestionSchema>

/**
 * What an `ask_user` call asks: one to four questions (epic #303, X6; #309).
 *
 * The questions must be **distinct in their `question` text**, because that text is how an
 * answer names what it answers ({@link AskUserAnswerSchema}), and two questions a reader
 * cannot tell apart are two questions whose answers could be swapped without anyone
 * noticing. A call that breaks any of this is a malformed call: the loop answers it with an
 * `is_error` result and does not pause, so the model fixes it and asks again.
 */
export const AskUserInputSchema = z
  .object({
    questions: z
      .array(AskUserQuestionSchema)
      .min(ASK_USER_MIN_QUESTIONS)
      .max(ASK_USER_MAX_QUESTIONS),
  })
  .refine(
    (input) =>
      new Set(input.questions.map((question) => question.question)).size === input.questions.length,
    { error: 'each question must be distinct: an answer names the question it answers' },
  )

export type AskUserInput = z.infer<typeof AskUserInputSchema>

/**
 * One answer to one question of an `ask_user` call.
 *
 * The `question` is the text of the question being answered — the call's own words, which the
 * distinctness rule makes unambiguous — and which of the other three fields an answer carries
 * is decided by that question's type: `labels` for a `choice` (several when it is
 * `multi_select`, and `text` as well when the user chose to write their own answer),
 * `text` for a `text` question, and `confirmed` for a `confirm` one. Anything else is a 400.
 */
export const AskUserAnswerSchema = z.object({
  /** The `question` text of the question this answers. */
  question: z.string().min(1),
  /** The labels chosen, for a `choice` question. */
  labels: z.array(z.string().min(1)).readonly().optional(),
  /** The user's own words: a `text` answer, or the write-in answer to a `choice`. */
  text: z.string().min(1).optional(),
  /** The answer to a `confirm` question. */
  confirmed: z.boolean().optional(),
})

export type AskUserAnswer = z.infer<typeof AskUserAnswerSchema>

/**
 * The answers to every question of a call, in the order they are given.
 *
 * A set rather than a map because the wire spelling of a list is an array: the pairing is by
 * the `question` each answer names, and {@link askUserAnswerProblems} is what says whether
 * every question got exactly one.
 */
export const AskUserAnswersSchema = z.array(AskUserAnswerSchema).readonly()

export type AskUserAnswers = z.infer<typeof AskUserAnswersSchema>

/**
 * The questions a value asks, or `null` when it is not a well-formed `ask_user` input.
 *
 * The one parser both sides use: the brain checks a call with it before it pauses, and the
 * server checks the call an answer is for with it before it validates the answers against it.
 */
export function parseAskUserInput(value: unknown): AskUserInput | null {
  const parsed = AskUserInputSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** What is wrong with a value as an `ask_user` input, one `path: message` per problem. */
export function askUserInputProblems(value: unknown): string[] {
  const parsed = AskUserInputSchema.safeParse(value)
  return parsed.success ? [] : issuesOf(parsed.error.issues)
}

/**
 * What is wrong with a set of answers for the questions a call asked, one `path: message`
 * per problem — empty when the answers are usable.
 *
 * Every question has to be answered exactly once, by the text it asked, and the answer has to
 * be one the question's own type can carry: a label the question offers (and one at most
 * unless it is `multi_select`), the user's own words for a `text` question or beside a chosen
 * label, and a yes/no for a `confirm`. This is the rule a malformed **answer** is refused by —
 * a 400 at the server, never a result the model has to interpret.
 *
 * @param input the questions the call asked, already parsed
 * @param answers the answers a client sent
 */
export function askUserAnswerProblems(
  input: AskUserInput,
  answers: readonly AskUserAnswer[],
): string[] {
  const problems: string[] = []
  const byQuestion = new Map<string, AskUserAnswer[]>()
  for (const answer of answers) {
    const bucket = byQuestion.get(answer.question)
    if (bucket === undefined) {
      byQuestion.set(answer.question, [answer])
    } else {
      bucket.push(answer)
    }
  }
  for (const question of input.questions) {
    const given = byQuestion.get(question.question) ?? []
    if (given.length === 0) {
      problems.push(`${question.header}: no answer was given`)
      continue
    }
    if (given.length > 1) {
      problems.push(`${question.header}: answered more than once`)
      continue
    }
    problems.push(...problemsOf(question, given[0] as AskUserAnswer))
  }
  for (const answer of answers) {
    if (!input.questions.some((question) => question.question === answer.question)) {
      problems.push(`(answers): "${answer.question}" is not a question this call asked`)
    }
  }
  return problems
}

/** What is wrong with one answer for one question. */
function problemsOf(question: AskUserQuestion, answer: AskUserAnswer): string[] {
  const where = question.header
  const labels = answer.labels ?? []
  const text = answer.text
  const confirmed = answer.confirmed
  if (confirmed !== undefined && question.type !== 'confirm') {
    return [`${where}: a yes/no answer does not answer a ${question.type} question`]
  }
  if (question.type === 'confirm') {
    if (confirmed === undefined) {
      return [`${where}: a yes/no question needs \`confirmed\``]
    }
    if (labels.length > 0 || text !== undefined) {
      return [`${where}: a yes/no answer carries nothing but \`confirmed\``]
    }
    return []
  }
  if (question.type === 'text') {
    if (text === undefined) {
      return [`${where}: a text question needs \`text\``]
    }
    if (labels.length > 0) {
      return [`${where}: a text question has no options to choose from`]
    }
    return []
  }
  const offered = new Set(question.options.map((option) => option.label))
  const unknown = labels.filter((label) => !offered.has(label))
  if (unknown.length > 0) {
    return [
      `${where}: ${unknown.map((label) => `"${label}"`).join(', ')} is not an option this question offers`,
    ]
  }
  if (labels.length > 1 && question.multi_select !== true) {
    return [`${where}: this question takes one option, not ${labels.length}`]
  }
  if (labels.length === 0 && text === undefined) {
    return [`${where}: choose an option, or write an answer of your own`]
  }
  return []
}

/**
 * The answers as the text the model is shown, one line per question (epic #303, X6; #309).
 *
 * The answer is what the loop writes as the call's `agent.tool_result` — the tool never runs,
 * so this text **is** what the model gets — and it is the one place the wording lives, so a
 * client showing the answers and a model reading them cannot drift. A line leads with the
 * question the model asked rather than the header, because that is what the model wrote and
 * what it can match against its own call:
 *
 * ```
 * Which environment should I deploy to?: staging
 * Anything else I should know?: the release is on Thursday
 * ```
 *
 * Callers pass answers that {@link askUserAnswerProblems} accepted; an answer for an unknown
 * question, or a missing one, is simply not rendered here.
 */
export function formatAskUserAnswers(
  input: AskUserInput,
  answers: readonly AskUserAnswer[],
): string {
  const byQuestion = new Map(answers.map((answer) => [answer.question, answer]))
  return input.questions
    .map((question) => {
      const answer = byQuestion.get(question.question)
      return `${question.question}: ${answer === undefined ? '(no answer)' : rendered(question, answer)}`
    })
    .join('\n')
}

/** What one answer reads as, for the question it answers. */
function rendered(question: AskUserQuestion, answer: AskUserAnswer): string {
  if (question.type === 'confirm') {
    return answer.confirmed === true ? 'Yes' : 'No'
  }
  if (question.type === 'text') {
    return answer.text ?? ''
  }
  const labels = answer.labels ?? []
  if (answer.text === undefined) {
    return labels.join(', ')
  }
  return labels.length === 0 ? answer.text : `${labels.join(', ')} (write-in: ${answer.text})`
}

/** The zod issues as the `path: message` lines a caller can act on. */
function issuesOf(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string[] {
  return issues.map((issue) => `${issue.path.join('.') || '(input)'}: ${issue.message}`)
}
