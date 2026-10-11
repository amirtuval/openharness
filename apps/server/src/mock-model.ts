import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { AskUserInput, ModelUsage } from '@openharness/protocol'
import { ASK_USER_TOOL_NAME } from '@openharness/protocol'
import { MockLanguageModelV4 } from 'ai/test'

import type { ModelFactory } from '@openharness/brain'

import { TEST_TOOL_NAME } from './tools'

/**
 * The deterministic test model: what the server streams from when
 * `OPENHARNESS_TEST_MODEL=mock` is set.
 *
 * It exists so the whole server — scheduler, brain, store, SSE, the AI SDK adapter — can be
 * exercised end to end with no provider keys and no network. It is *only* reachable through
 * {@link resolveModelFactory} (`model.ts`), which reads the environment variable; nothing in
 * the server ever constructs it on its own, so a production process that does not set the
 * variable cannot end up talking to it.
 *
 * The model is an AI SDK `MockLanguageModelV4`, so the brain streams it through the same
 * `streamText` path it uses for a real provider — including aborts, error parts and usage.
 *
 * ## What it does
 *
 * | last user message        | what the model streams                                                           |
 * | ------------------------ | -------------------------------------------------------------------------------- |
 * | anything else            | the message echoed back in {@link MOCK_ECHO_CHUNKS} chunks, one delay each        |
 * | `__slow__`               | {@link MOCK_SLOW_CHUNKS} chunks over about {@link MOCK_SLOW_TOTAL_MS}, so a turn  |
 * |                          | can be interrupted, killed and resumed mid-stream                                 |
 * | `__hold__`               | one chunk, and then nothing: the request stays open until it is aborted, so a     |
 * |                          | test can hold a turn open as long as it needs and release it itself               |
 * | `__fail_retryable__`     | HTTP 503 (`model_overloaded_error`) on the *first* attempt, then the echo         |
 * | `__fail_terminal__`      | HTTP 400 (`model_request_failed_error`) on every attempt                          |
 *
 * A marker is matched against the *start* of the message, so a prompt can say
 * `__slow__ tell me something` and still stream slowly.
 *
 * Usage is fixed ({@link MOCK_MODEL_USAGE}), so a test can assert the exact token counts the
 * brain writes into `span.model_request_end`.
 */

/** The value of `OPENHARNESS_TEST_MODEL` that turns the mock on. */
export const MOCK_MODEL_ENV_VALUE = 'mock'

/** Streams a reply this many chunks for an ordinary message. */
export const MOCK_ECHO_CHUNKS = 4

/** The pause between two echoed chunks. Small: the point is that text arrives in pieces. */
export const MOCK_ECHO_CHUNK_DELAY_MS = 25

/** The marker that makes the model stream slowly, so a turn can be interrupted mid-flight. */
export const MOCK_SLOW_MARKER = '__slow__'

/** How many chunks a `__slow__` reply is streamed in. */
export const MOCK_SLOW_CHUNKS = 40

/** The pause between two `__slow__` chunks; {@link MOCK_SLOW_TOTAL_MS} in total. */
export const MOCK_SLOW_CHUNK_DELAY_MS = 250

/** How long a `__slow__` reply takes to stream, near enough: 40 × 250 ms. */
export const MOCK_SLOW_TOTAL_MS = MOCK_SLOW_CHUNKS * MOCK_SLOW_CHUNK_DELAY_MS

/**
 * The marker that streams one chunk and then stops producing anything while keeping the request
 * open, until whatever is streaming it aborts.
 *
 * A `__slow__` reply is *long*; this one is *endless*, which is the difference between a test
 * that hopes the turn is still running when its next request arrives and a test that knows it:
 * the turn stays open as long as the test needs, and the `user.interrupt` that ends it — the
 * way any reply in flight ends — is the test's own move (#261).
 */
export const MOCK_HOLD_MARKER = '__hold__'

/** The one chunk a `__hold__` reply streams before it waits. */
export const MOCK_HOLD_TEXT = 'holding the turn open'

/** The marker that fails the first attempt with a 503 and succeeds on the retry. */
export const MOCK_RETRYABLE_MARKER = '__fail_retryable__'

/** The marker that fails every attempt with a 400. */
export const MOCK_TERMINAL_MARKER = '__fail_terminal__'

/**
 * The marker that makes the model call the test `echo` tool (epic #303).
 *
 * The model calls it on the request that carries the marker and answers the result on the next
 * one, which is what makes a whole tool turn — the call stored, the tool run, the result stored,
 * the follow-up request — observable through the real server in an e2e test. The marker is
 * matched at the start of the message, like the others, and the text after it is what the tool
 * is called with.
 */
export const MOCK_TOOL_MARKER = '__tool__'

/**
 * The marker that makes the model ask the user a question (epic #303, X6; #309).
 *
 * The model calls `ask_user` on the request that carries the marker, so a whole pause can be
 * driven through the real server: the call is stored, the turn ends `requires_action`, and one
 * `user.tool_confirmation` carries the answers — after which the model is asked again and
 * answers what it was told, like any other tool result.
 */
export const MOCK_ASK_MARKER = '__ask__'

/**
 * The marker that makes the model call a **remote MCP tool** (epic #303, X10; #312).
 *
 * The text after it is `<the tool's offered name> <the arguments as JSON>`, so a test can drive
 * a whole remote tool turn — the tool listed from a stub server, the call stored, the tool
 * called over the wire, the result stored and answered — through the real server, scheduler,
 * brain and store. It is the one marker whose call is not this process's own tool, which is
 * exactly what makes it worth having.
 */
export const MOCK_MCP_MARKER = '__mcp__'

/**
 * The tool call a `__mcp__` prompt makes: the name it names, and the arguments it carries.
 *
 * A prompt with no arguments (or ones that are not JSON) calls the tool with `{}` — a test's
 * own typo is not something a test model should fail a turn over.
 */
export function mcpCallOf(message: string): { name: string; input: Record<string, unknown> } {
  const rest = message.slice(MOCK_MCP_MARKER.length).trim()
  const space = rest.indexOf(' ')
  const name = space === -1 ? rest : rest.slice(0, space)
  const json = space === -1 ? '{}' : rest.slice(space + 1)
  let input: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      input = parsed as Record<string, unknown>
    }
  } catch {
    input = {}
  }
  return { name, input }
}

/**
 * The question a `__ask__` prompt asks: one choice, one free-text — the two shapes an e2e test
 * can answer without inventing a UI, and enough to pin that the answers are validated against
 * the question they answer.
 */
export const MOCK_ASK_INPUT: AskUserInput = {
  questions: [
    {
      question: 'Which environment should I deploy to?',
      header: 'Environment',
      type: 'choice',
      options: [{ label: 'staging' }, { label: 'production' }],
    },
    { question: 'Anything else I should know?', header: 'Notes', type: 'text' },
  ],
}

/** The answers that fit {@link MOCK_ASK_INPUT}: what a test sends back unchanged. */
export const MOCK_ASK_ANSWERS = [
  { question: 'Which environment should I deploy to?', labels: ['staging'] },
  { question: 'Anything else I should know?', text: 'the release is on Thursday' },
] as const

/** The token counts every request of this model reports. Fixed, so tests can assert them. */
export const MOCK_MODEL_USAGE: ModelUsage = {
  input_tokens: 42,
  output_tokens: 17,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

/** The text block the mock streams under; a real provider picks its own ids. */
const TEXT_ID = 'mock-text-1'

/**
 * Build the {@link ModelFactory} the test hook uses.
 *
 * One model instance is shared by every call, which is what makes the retry markers work:
 * `__fail_retryable__` has to fail once and then succeed across two attempts of the same
 * turn, and the attempt count therefore has to outlive a single `doStream` call. The count
 * is kept per prompt, so two sessions sending the same test message do not interfere.
 */
export function createMockModelFactory(): ModelFactory {
  const attempts = new AttemptCounter()
  const model = new MockLanguageModelV4({
    provider: 'openharness-test',
    modelId: 'openharness-test-model',
    supportedUrls: {},
    doStream: (options) => {
      const message = lastUserText(options.prompt)
      // A prompt whose **last** message is a tool result is a request the tool loop made right
      // after a call: the model answers what the tool said rather than calling it again. The
      // last message, not any tool result: a chat's later turns carry the results of the calls
      // before them, and a new message behind one is a message like any other.
      const result = endsWithToolResult(options.prompt) ? lastToolResult(options.prompt) : undefined
      const plan =
        result === undefined
          ? planFor(message, attempts.record(message))
          : { chunks: chunkText(`the tool said: ${result}`, MOCK_ECHO_CHUNKS), delayMs: 0 }
      if (plan.error !== undefined) {
        return Promise.reject(plan.error)
      }
      return Promise.resolve({ stream: streamOf(plan, options.abortSignal) })
    },
  })
  return () => model
}

/** What the model does with one request. */
interface ModelPlan {
  /** The text chunks to stream, in order. */
  readonly chunks: readonly string[]
  /** How long to wait before each chunk. */
  readonly delayMs: number
  /** The error to reject the request with, if any. */
  readonly error?: Error
  /**
   * Whether the reply keeps its request open after the chunks, until the caller aborts it,
   * instead of closing itself and reporting usage.
   */
  readonly hold?: boolean
  /**
   * The tool calls the step makes, in order, after the chunks (epic #303). Their arguments
   * travel as JSON text, the way a provider sends them.
   */
  readonly toolCalls?: readonly { readonly name: string; readonly input: unknown }[]
}

/**
 * What the request answers with, from the last user message and how many times it has been
 * asked.
 *
 * @param message the last user message's text
 * @param attempt 1 for the first request of this prompt, 2 for the next, ...
 */
export function planFor(message: string, attempt: number): ModelPlan {
  if (message.startsWith(MOCK_TERMINAL_MARKER)) {
    return { chunks: [], delayMs: 0, error: providerError(400, 'the test model was told to fail') }
  }
  if (message.startsWith(MOCK_RETRYABLE_MARKER) && attempt === 1) {
    return {
      chunks: [],
      delayMs: 0,
      error: providerError(503, 'the test model is briefly overloaded'),
    }
  }
  if (message.startsWith(MOCK_SLOW_MARKER)) {
    const text = slowReplyText()
    return { chunks: chunkText(text, MOCK_SLOW_CHUNKS), delayMs: MOCK_SLOW_CHUNK_DELAY_MS }
  }
  if (message.startsWith(MOCK_HOLD_MARKER)) {
    return { chunks: [MOCK_HOLD_TEXT], delayMs: 0, hold: true }
  }
  if (message.startsWith(MOCK_ASK_MARKER)) {
    return {
      chunks: [],
      delayMs: 0,
      toolCalls: [{ name: ASK_USER_TOOL_NAME, input: MOCK_ASK_INPUT }],
    }
  }
  if (message.startsWith(MOCK_MCP_MARKER)) {
    return { chunks: [], delayMs: 0, toolCalls: [mcpCallOf(message)] }
  }
  if (message.startsWith(MOCK_TOOL_MARKER)) {
    // The text after the marker, or the marker-less message when the caller wrote none: either
    // way the tool is called with something the test can predict from its own prompt.
    const argument = message.slice(MOCK_TOOL_MARKER.length).trim()
    return {
      chunks: [],
      delayMs: 0,
      toolCalls: [
        { name: TEST_TOOL_NAME, input: { text: argument.length > 0 ? argument : message } },
      ],
    }
  }
  return { chunks: chunkText(message, MOCK_ECHO_CHUNKS), delayMs: MOCK_ECHO_CHUNK_DELAY_MS }
}

/**
 * The deterministic reply to a `__slow__` message: one numbered part per chunk, so both the
 * text and its split are the same on every run.
 */
export function slowReplyText(): string {
  return Array.from(
    { length: MOCK_SLOW_CHUNKS },
    (_, index) => `part ${index + 1}/${MOCK_SLOW_CHUNKS}`,
  ).join(' ')
}

/**
 * Split `text` into at most `count` pieces of roughly equal length, by code point so a
 * character outside the BMP is never cut in half.
 *
 * A text shorter than `count` characters yields one chunk per character: empty chunks would
 * be deltas the model never produced.
 */
export function chunkText(text: string, count: number): string[] {
  const characters = Array.from(text)
  if (characters.length === 0 || count <= 0) {
    return []
  }
  const size = Math.max(1, Math.ceil(characters.length / count))
  const chunks: string[] = []
  for (let index = 0; index < characters.length; index += size) {
    chunks.push(characters.slice(index, index + size).join(''))
  }
  return chunks
}

/** How often each prompt has been asked, so a marker can fail only its first attempt. */
class AttemptCounter {
  readonly #attempts = new Map<string, number>()

  /** Count this request and answer which attempt it is: 1 for the first, 2 for the next, ... */
  record(message: string): number {
    const attempt = (this.#attempts.get(message) ?? 0) + 1
    if (this.#attempts.size >= MAX_TRACKED_PROMPTS) {
      // A long-running server should not grow a map for every distinct test message. The
      // first-request markers have all been used by now; forgetting is harmless.
      this.#attempts.clear()
    }
    this.#attempts.set(message, attempt)
    return attempt
  }
}

/** How many prompts the attempt counter remembers before it starts over. */
const MAX_TRACKED_PROMPTS = 1000

/** A provider failure shaped the way the brain classifies one: a message and an HTTP status. */
function providerError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode })
}

/** The text of the last user message of a provider-level prompt, or `''` when there is none. */
function lastUserText(prompt: readonly PromptMessage[]): string {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const message = prompt[index]
    if (message === undefined || message.role !== 'user') {
      continue
    }
    if (typeof message.content === 'string') {
      return message.content
    }
    return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  }
  return ''
}

/**
 * Whether the prompt's last message is a tool result — the shape of the request that follows a
 * tool step, and the only one the mock answers with what the tool said.
 */
function endsWithToolResult(prompt: readonly PromptMessage[]): boolean {
  const last = prompt[prompt.length - 1]
  return last !== undefined && last.role === 'tool'
}

/**
 * The text of the last tool result in a provider-level prompt, or `undefined` when it holds none.
 *
 * This is how the mock knows it is being asked *after* a tool ran rather than before: the loop
 * puts the calls and their answers in the next request's prompt, and the `tool` message's parts
 * carry the text the tool produced.
 */
function lastToolResult(prompt: readonly PromptMessage[]): string | undefined {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const message = prompt[index]
    if (message === undefined || message.role !== 'tool' || typeof message.content === 'string') {
      continue
    }
    const text = message.content.flatMap((part) => {
      const output = (part as { readonly output?: { readonly value?: unknown } }).output
      return typeof output?.value === 'string' ? [output.value] : []
    })
    if (text.length > 0) {
      return text.join('')
    }
  }
  return undefined
}

/** One message of a provider-level prompt: what `streamText` sends the model. */
interface PromptMessage {
  readonly role: string
  readonly content: string | readonly PromptPart[]
}

/** One content part of a prompt message. */
interface PromptPart {
  readonly type: string
  readonly text?: string
}

/**
 * The stream one plan produces: the chunks, one per pull, with the plan's delay before each
 * of them, then the usage.
 *
 * Pulled rather than pushed on purpose — a consumer that stops reading (an abort) stops the
 * stream, which is exactly what makes `__slow__` interruptible and a `hold` reply endable: a
 * held pull settles only when the request is aborted, so the request stays open until the
 * caller interrupts it and then closes like any other aborted reply.
 */
function streamOf(
  plan: ModelPlan,
  abortSignal: AbortSignal | undefined,
): ReadableStream<LanguageModelV4StreamPart> {
  const steps: (() => Promise<LanguageModelV4StreamPart>)[] = [
    () => Promise.resolve({ type: 'stream-start', warnings: [] }),
    () => Promise.resolve({ type: 'text-start', id: TEXT_ID }),
    ...plan.chunks.map((chunk) => async (): Promise<LanguageModelV4StreamPart> => {
      await delay(plan.delayMs)
      return { type: 'text-delta', id: TEXT_ID, delta: chunk }
    }),
    ...toolSteps(plan.toolCalls ?? []),
    ...(plan.hold === true ? [] : [closing, () => finishing(plan)]),
  ]
  let step = 0
  return new ReadableStream<LanguageModelV4StreamPart>({
    async pull(controller) {
      if (plan.hold === true && step >= steps.length) {
        // A held reply produces nothing more of its own: its one remaining pull waits for the
        // abort a `user.interrupt` raises, and closes the stream there. Nothing else can end
        // it, which is the whole point — the turn is open for as long as the test needs.
        await aborted(abortSignal)
        controller.close()
        return
      }
      const next = steps[step]
      step += 1
      if (next === undefined) {
        controller.close()
        return
      }
      controller.enqueue(await next())
    },
  })
}

/** The provider-level parts one tool call is streamed as: its input arrives as JSON text. */
function toolSteps(
  calls: readonly { readonly name: string; readonly input: unknown }[],
): (() => Promise<LanguageModelV4StreamPart>)[] {
  return calls.flatMap((call, index) => {
    const id = `mock-tool-call-${index + 1}`
    const input = JSON.stringify(call.input)
    return [
      () => Promise.resolve({ type: 'tool-input-start', id, toolName: call.name }),
      () => Promise.resolve({ type: 'tool-input-delta', id, delta: input }),
      () => Promise.resolve({ type: 'tool-input-end', id }),
      () => Promise.resolve({ type: 'tool-call', toolCallId: id, toolName: call.name, input }),
    ]
  })
}

/** The `text-end` a reply that ran to completion closes its text block with. */
function closing(): Promise<LanguageModelV4StreamPart> {
  return Promise.resolve({ type: 'text-end', id: TEXT_ID })
}

/**
 * The `finish` a reply that ran to completion ends with, carrying the fixed usage.
 *
 * The finish reason is `tool-calls` for a step that called something, which is what a provider
 * reports and what the SDK keeps on the step.
 */
function finishing(plan: ModelPlan): Promise<LanguageModelV4StreamPart> {
  return Promise.resolve({
    type: 'finish',
    finishReason: {
      unified: (plan.toolCalls?.length ?? 0) > 0 ? 'tool-calls' : 'stop',
      raw: undefined,
    },
    usage: {
      inputTokens: {
        // `MOCK_MODEL_USAGE.input_tokens` is the cache-inclusive total, the way an
        // OpenAI-shaped report reads, so the uncached half is it minus both cache counters
        // (epic #277, K2). The fixed counts carry no cache, so the two are equal today.
        total: MOCK_MODEL_USAGE.input_tokens,
        noCache:
          MOCK_MODEL_USAGE.input_tokens -
          MOCK_MODEL_USAGE.cache_read_input_tokens -
          MOCK_MODEL_USAGE.cache_creation_input_tokens,
        cacheRead: MOCK_MODEL_USAGE.cache_read_input_tokens,
        cacheWrite: MOCK_MODEL_USAGE.cache_creation_input_tokens,
      },
      outputTokens: {
        total: MOCK_MODEL_USAGE.output_tokens,
        text: MOCK_MODEL_USAGE.output_tokens,
        reasoning: 0,
      },
    },
  })
}

/**
 * Resolve when `signal` aborts, or at once when it already has.
 *
 * A `__hold__` reply cannot be ended without one: without a signal there is nothing that could
 * abort it, and waiting would hang the request it is meant to hold — so it fails loudly
 * instead.
 */
function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    throw new Error(`${MOCK_HOLD_MARKER} needs an abort signal: nothing could end this reply`)
  }
  if (signal.aborted) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

/** Sleep `ms`; a zero or negative delay is not a delay at all. */
function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
