import { ASK_USER_TOOL_NAME, TODO_WRITE_TOOL_NAME } from '@openharness/protocol'
import type {
  DeepReadonly,
  ModelEntry,
  ToolInput,
  ToolPermission,
  ToolSource,
  ToolResultTruncation,
} from '@openharness/protocol'

/**
 * A tool call's input as the log holds it: a readonly JSON object.
 *
 * The stored event's `input` is `DeepReadonly<ToolInput>` (D9), and a call's input is never
 * rewritten once stored, so this is the shape a frontend reads and shows.
 */
export type ToolCallInput = DeepReadonly<ToolInput>

/**
 * The tool-call view both frontends share (epic #303, X1/X5; issue #308).
 *
 * A tool call is a pair of stored events — `agent.tool_use` and its `agent.tool_result` — not a
 * part of a message, so what a UI draws for one is derived here once and rendered twice: by the
 * web app and by `oh`. The two things this module owns are:
 *
 * - **the status** ({@link toolCallStatus}) — the state a call line shows, read off the call's
 *   `evaluated_permission`, whether a result has landed and what that result says. It is
 *   deliberately derived rather than stored: the log is the state, and the same events have to
 *   produce the same line whether a client watched them live or replayed them.
 * - **the words** ({@link toolStatusLabel}, {@link toolCallSummary} and the notices below) — the
 *   sentences a reader sees, in one place so the terminal and the page cannot disagree.
 *
 * The shape is built to extend: #310's approval prompt reads a `waiting` call's `input`, and
 * #313's MCP calls will carry `source: 'mcp'` with the server in the name — nothing here assumes
 * a built-in tool.
 */

/**
 * The state a tool-call line shows (epic #303, X1; issue #308).
 *
 * - `running` — the call is out: the model asked for it, and nothing has answered yet while the
 *   turn is still working.
 * - `waiting` — the call is waiting on the reader (`evaluated_permission: 'ask'`, an `ask_user`
 *   question, or the turn ended `requires_action`). #310 answers it; until then the line says so.
 * - `done` — the call produced a result that is not an error.
 * - `error` — the call failed (its tool's own error, a timeout, a schema refusal, or a call the
 *   reader moved on from).
 * - `denied` — a policy or the reader refused the call without running it.
 * - `interrupted` — the reader stopped the turn while the call was out.
 * - `lost` — the turn that started the call died before it ran, so it never ran.
 */
export type ToolCallStatus =
  'running' | 'waiting' | 'done' | 'error' | 'denied' | 'interrupted' | 'lost'

/**
 * What a call produced, as the transcript keeps it (epic #303, X1).
 *
 * `content` is the result's text blocks joined — the log stores text blocks only today — and
 * `isError` is the `is_error` flag, which is what separates a failed call from an answer.
 */
export interface ToolCallResult {
  /** The result's text: its content blocks joined, as the tool answered. */
  readonly content: string
  /** Whether the call failed — a refusal, a timeout, an interrupt, or the tool's own error. */
  readonly isError: boolean
}

/**
 * One tool call the conversation holds (epic #303, X1/X5; issue #308).
 *
 * Built from an `agent.tool_use` and the `agent.tool_result` that answers it, keyed by the call's
 * id — which **is** the `agent.tool_use` event's id ({@link https://github.com/amirtuval/openharness/issues/303}).
 * `position` is that event's `seq`, so a call interleaves with the messages around it.
 */
export interface TranscriptToolCall {
  /** The call's id: the `agent.tool_use` event's id, which its result names. */
  readonly id: string
  /** The tool's name, as the model called it. */
  readonly name: string
  /** The arguments the model produced: a JSON object, shown in full when the line expands. */
  readonly input: ToolCallInput
  /** What the policy in force said about this call: `allow`, `ask` or `deny`. */
  readonly permission: ToolPermission
  /**
   * Where the tool comes from: `builtin` today, `mcp` when #312 puts one there.
   *
   * Read off the request's own `span.model_request_start.tools` record, so a call the log
   * describes is not re-interpreted by the build reading it, and an MCP call can name its
   * server without this module changing.
   */
  readonly source: ToolSource
  /** The state the line shows; see {@link ToolCallStatus}. */
  readonly status: ToolCallStatus
  /** Where the call sorts, in the log's numbering: its `agent.tool_use` event's `seq`. */
  readonly position: number
  /** What the call produced, once a result has landed. */
  readonly result?: ToolCallResult
}

/** The words a call's status is drawn with (epic #303, X5; issue #308). */
const STATUS_WORDS: Readonly<Record<ToolCallStatus, string>> = {
  running: 'running',
  waiting: 'waiting for you',
  done: 'done',
  error: 'failed',
  denied: 'denied',
  interrupted: 'interrupted',
  lost: 'execution lost',
}

/**
 * The words for a status, the same in both frontends — "waiting for you" is a sentence a reader
 * is owed, not chrome either side may reword.
 *
 * @param status the call's state
 */
export function toolStatusLabel(status: ToolCallStatus): string {
  return STATUS_WORDS[status]
}

/**
 * The status of a call, from what the log says about it (epic #303, X1/X6; issue #308).
 *
 * The three inputs are the whole of it: what the policy evaluated the call under, whether a
 * result has landed (and what it said), and the turn's own state. A call with no result is
 * `waiting` when it is one the reader has to answer — its permission is `ask`, or the turn ended
 * naming it `requires_action` — and `running` while the turn is still working; a call with no
 * result on a turn that has ended is `lost`, the one thing the log can say about a call nothing
 * answered.
 *
 * @param permission the call's `evaluated_permission`
 * @param result what answered the call, or `undefined` while nothing has
 * @param options `waiting` when the turn ended on this call, `running` while the turn is working
 */
export function toolCallStatus(
  permission: ToolPermission,
  result: ToolCallResult | undefined,
  options: { readonly waiting: boolean; readonly running: boolean },
): ToolCallStatus {
  if (result !== undefined) {
    return statusFromResult(result)
  }
  if (permission === 'ask' || options.waiting) {
    return 'waiting'
  }
  // No result and not waiting: the turn is either still working (the call is out) or over, in
  // which case nothing ever answered it — `execution lost`, the only thing left to say.
  return options.running ? 'running' : 'lost'
}

/**
 * The status a result's own words mean — the brain's sentences are the record (epic #303, X3/X6).
 *
 * A result is `is_error` for everything that is not what the tool produced, so the text is what
 * tells a denial from an interrupt from a lost execution from a tool's own failure. The phrases
 * are the brain's own (`packages/brain/src/pausing.ts`, `tools.ts`), matched the way they are
 * written; anything else `is_error` is the tool's failure.
 */
function statusFromResult(result: ToolCallResult): ToolCallStatus {
  if (!result.isError) {
    return 'done'
  }
  const text = result.content
  if (text.startsWith('Interrupted by the user.')) {
    return 'interrupted'
  }
  if (text.includes('execution lost')) {
    return 'lost'
  }
  if (
    /^Permission to use .+ has been denied\./.test(text) ||
    text.startsWith('The user denied this')
  ) {
    return 'denied'
  }
  return 'error'
}

/**
 * The built-in tool names this module knows how to summarize.
 *
 * Spelled here rather than imported: `web_fetch` and `web_search` are named by
 * `@openharness/hands`, which this package may not depend on (the allowed graph is
 * `protocol` alone), and their names are part of the wire the log records.
 */
const WEB_FETCH_TOOL = 'web_fetch'
const WEB_SEARCH_TOOL = 'web_search'

/** The input fields a short summary of a call is drawn from, keyed by the built-in tools. */
const SUMMARY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [WEB_FETCH_TOOL]: ['url'],
  [WEB_SEARCH_TOOL]: ['query'],
}

/**
 * A short summary of what a call asked for, or `null` when the input says nothing short
 * (epic #303, X5; issue #308) — the one-line part of a call's compact row.
 *
 * The per-tool cases are the ones worth their own words: a fetch is its URL, a search its query,
 * `todo_write` its task count and `ask_user` its first question. Everything else falls back to
 * the first string value in the input, so an `echo` reads as its text and an unknown tool (an
 * MCP one, say) shows what it can rather than nothing.
 *
 * @param call the call's name and input
 */
export function toolCallSummary(call: {
  readonly name: string
  readonly input: ToolCallInput
}): string | null {
  for (const field of SUMMARY_FIELDS[call.name] ?? []) {
    const value = call.input[field]
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }
  if (call.name === TODO_WRITE_TOOL_NAME) {
    const todos = call.input.todos
    if (Array.isArray(todos)) {
      return todos.length === 1 ? '1 task' : `${todos.length} tasks`
    }
  }
  if (call.name === ASK_USER_TOOL_NAME) {
    const questions = call.input.questions
    if (Array.isArray(questions)) {
      const first: unknown = questions[0]
      if (isJsonObject(first) && typeof first.question === 'string' && first.question.length > 0) {
        return first.question
      }
      return questions.length === 1 ? '1 question' : `${questions.length} questions`
    }
  }
  return firstString(call.input)
}

/** The first string value of an object, in insertion order, or `null`. */
function firstString(input: ToolCallInput): string | null {
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }
  return null
}

/** Whether a JSON value is an object (and not an array or `null`). */
function isJsonObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The input rendered for a reader who expanded the line, pretty-printed and stable.
 *
 * The JSON a model produced, two-space indented: the full input is the one thing the compact line
 * exists to hide, so this is what it shows instead when opened.
 */
export function formatToolInput(input: ToolCallInput): string {
  return JSON.stringify(input, null, 2)
}

/** One tool result a request had to shorten before it entered the prompt (epic #303, X9; #306). */
export interface TruncatedToolResult {
  /** The `seq` of the `agent.tool_result` that was shortened. */
  readonly seq: number
  /** The tool the result came from. */
  readonly tool: string
  /** What the result cost before it was cut, in tokens. */
  readonly tokensBefore: number
  /** What the shortened result costs, in tokens. */
  readonly tokensAfter: number
}

/** The old tool results a request cleared out of the prompt (epic #303, X9; #306). */
export interface ClearedToolResults {
  /** How many results had their body replaced by a placeholder. */
  readonly results: number
  /** What those results cost before they were cleared, in tokens. */
  readonly tokens: number
}

/**
 * The tool results the newest request had to shorten, and the ones it cleared
 * (epic #303, X9; #306; issue #308).
 *
 * Both are the request's own record — the stored `agent.tool_result` keeps its whole body — so a
 * frontend says the tool's answer was trimmed rather than letting it silently disappear.
 */
export interface ToolResultsNotice {
  /** The results the request capped, newest-first as the span listed them. */
  readonly truncated: readonly TruncatedToolResult[]
  /** The old results whose bodies it replaced with a placeholder. */
  readonly cleared: ClearedToolResults | null
}

/** The truncation record a `span.model_request_start` carries, as the transcript keeps it. */
export function truncatedResultsFrom(truncation: {
  readonly results?: readonly ToolResultTruncation[] | undefined
}): readonly TruncatedToolResult[] {
  return (truncation.results ?? []).map((result) => ({
    seq: result.seq,
    tool: result.tool,
    tokensBefore: result.tokens_before,
    tokensAfter: result.tokens_after,
  }))
}

/** The clearing record a `span.model_request_start` carries, as the transcript keeps it. */
export function clearedResultsFrom(cleared: {
  readonly results: number
  readonly tokens: number
}): ClearedToolResults {
  return { results: cleared.results, tokens: cleared.tokens }
}

/**
 * The line a reader is owed when a request had to shorten tool results, or `null` when it did not.
 *
 * Counts rather than names, because a request may cap several results of one step and the count
 * is what the reader acts on; the whole answer is still in the transcript.
 */
export function truncatedResultsNotice(results: readonly TruncatedToolResult[]): string | null {
  if (results.length === 0) {
    return null
  }
  return results.length === 1
    ? 'One tool result was too long for this model and was shortened.'
    : `${results.length} tool results were too long for this model and were shortened.`
}

/**
 * The line a reader is owed when a request cleared old tool results, or `null` when it did not.
 *
 * Clearing is the first answer to a filling context (X9) — no model call, nothing summarized —
 * so it is a fact worth saying rather than a silent edit to what the model was shown.
 */
export function clearedResultsNotice(cleared: ClearedToolResults | null): string | null {
  if (cleared === null || cleared.results === 0) {
    return null
  }
  return cleared.results === 1
    ? 'An older tool result was cleared to make room in the context.'
    : `${cleared.results} older tool results were cleared to make room in the context.`
}

/** The sentence a turn that ran out of tool steps is reported with (epic #303, X2; #308). */
export const TOOL_STEPS_EXHAUSTED_NOTICE =
  'This turn reached its tool-step limit before the model finished, so it was ended.'

/**
 * The step-limit notice from the log's last error, or `null` (epic #303, X2; issue #308).
 *
 * The brain sends its own sentence in the `session.error` (`tool_steps_exhausted_error`) — how
 * many steps it had, and that a new message carries on — so that message is what a reader is
 * shown; {@link TOOL_STEPS_EXHAUSTED_NOTICE} is only the fallback for one that carried none.
 *
 * @param error the transcript's `lastError`
 */
export function stepLimitNotice(
  error: { readonly type: string; readonly message: string } | null,
): string | null {
  if (error === null || error.type !== 'tool_steps_exhausted_error') {
    return null
  }
  return error.message.length > 0 ? error.message : TOOL_STEPS_EXHAUSTED_NOTICE
}

/** The sentence shown when the chat's model cannot call tools at all (epic #303, X2; #308). */
export const TOOLS_UNSUPPORTED_NOTICE = "This model can't use tools."

/**
 * Whether a catalog entry's model can call tools, or `null` when the catalog does not say
 * (epic #303, X2; issue #308).
 *
 * `tool_call` is the server's answer, read off models.dev, and `true` for a model the registry
 * does not know. A caller with no entry — the catalog has not loaded, or the chat runs a
 * free-text id it does not list — gets `null`: nothing is claimed either way, so a screen shows
 * no notice rather than a wrong one.
 *
 * @param entry the catalog entry for the model the chat runs
 */
export function modelSupportsTools(entry: ModelEntry | null | undefined): boolean | null {
  return entry === undefined || entry === null ? null : entry.tool_call
}
