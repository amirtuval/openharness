import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { ModelCredential, ModelFactory, ResolveCredential } from '@openharness/brain'

import type { ResolveSessionCredential } from '../credentials'
import { MockLanguageModelV4 } from 'ai/test'

/**
 * A model a test scripts, so a turn takes as long as the test wants it to and answers what
 * the test says.
 *
 * The production test model (`mock-model.ts`) is deterministic and keyed off the user's
 * message; this one is for tests that need to act *during* a turn — send a steering message
 * mid-stream, interrupt, kill the process — and so need a turn they can hold open. Anything
 * that can be said about the server's behaviour under a slow model needs a model whose pace
 * is the test's to set.
 */

/** What one model request answers with. */
export interface ScriptedReply {
  /** The text chunks to stream, in order. Default: one empty reply. */
  readonly text?: readonly string[]
  /** How long to wait before each chunk, and before the request finishes. */
  readonly delayMs?: number
  /** Reject the request instead of streaming — a provider failure. */
  readonly failWith?: Error
  /** Called as each chunk is about to be served; a test can act here. */
  readonly onChunk?: (chunk: string, index: number) => Promise<void> | void
}

/** One message of a prompt the scripted model received, as the test reads it back. */
export interface ScriptedPromptMessage {
  readonly role: string
  readonly text: string
}

/** The model a test drives, and what it has seen. */
export interface ScriptedModel {
  /** Hand this to a scheduler or a `runTurn`. */
  readonly factory: ModelFactory
  /** How many model requests have been started. */
  readonly requests: number
  /** The most requests that were ever in flight at the same time. */
  readonly maxConcurrent: number
  /** The last user message of every request, in order. */
  readonly prompts: string[]
  /**
   * Every message of every request's prompt, in order — what the context strategy sent, not
   * just its last user turn. `prompts` answers "which prompt was this"; this answers "how much
   * history did it carry", which is what a context-budget assertion (#246) needs.
   */
  readonly histories: readonly (readonly ScriptedPromptMessage[])[]
  /** Append a reply for the next request; without one, replies repeat. */
  push(...replies: ScriptedReply[]): void
  /** Resolve when `requests` reaches `count`. */
  waitForRequests(count: number, timeoutMs?: number): Promise<void>
}

const TEXT_ID = 'scripted-text-1'

/** The credential a scripted request is made with. The scripted model ignores it. */
export const TEST_CREDENTIAL: ModelCredential = { type: 'api_key', apiKey: 'oh-server-test-key' }

/**
 * The credential resolver a runner with a scripted model is given.
 *
 * The brain asks for a credential before every model request — a turn with none ends with
 * `missing_provider_credential` instead of streaming — and the scripted model does not care
 * what it is handed, so a test passes this and the turn runs.
 */
export const resolveTestCredential: ResolveCredential = () => Promise.resolve(TEST_CREDENTIAL)

/**
 * The same answer, in the session-bound form the server's runner hands the brain (A5).
 *
 * A scripted model ignores credentials entirely, so the session id earns nothing here — but
 * the runner's resolver is session-bound, and passing this keeps every test on the same code
 * path as a deployment.
 */
export const resolveTestSessionCredential: ResolveSessionCredential = (_sessionId, provider) =>
  resolveTestCredential(provider)

/** Build a {@link ScriptedModel} from the replies the first requests answer with. */
export function createScriptedModel(...replies: ScriptedReply[]): ScriptedModel {
  const queue = [...replies]
  const prompts: string[] = []
  const histories: ScriptedPromptMessage[][] = []
  let inFlight = 0
  let maxConcurrent = 0
  let requests = 0
  const waiters: { count: number; resolve: () => void }[] = []

  const model = new MockLanguageModelV4({
    provider: 'openharness-test',
    modelId: 'scripted-model',
    supportedUrls: {},
    doStream: (options) => {
      const reply = queue.length === 0 ? {} : queue.length === 1 ? queue[0] : queue.shift()
      prompts.push(lastUserText(options.prompt))
      histories.push(
        options.prompt.map((message) => ({ role: message.role, text: textOf(message) })),
      )
      requests += 1
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      settleWaiters(waiters, requests)
      if (reply?.failWith !== undefined) {
        inFlight -= 1
        return Promise.reject(reply.failWith)
      }
      return Promise.resolve({
        stream: streamOf(reply ?? {}, () => {
          inFlight -= 1
        }),
      })
    },
  })

  return {
    factory: () => model,
    get requests() {
      return requests
    },
    get maxConcurrent() {
      return maxConcurrent
    },
    get prompts() {
      return prompts
    },
    get histories() {
      return histories
    },
    push(...more) {
      queue.push(...more)
    },
    waitForRequests(count, timeoutMs = 5000) {
      if (requests >= count) {
        return Promise.resolve()
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`only ${requests} of ${count} model requests arrived in time`))
        }, timeoutMs)
        timer.unref()
        waiters.push({
          count,
          resolve: () => {
            clearTimeout(timer)
            resolve()
          },
        })
      })
    },
  }
}

function settleWaiters(waiters: { count: number; resolve: () => void }[], requests: number): void {
  for (let index = waiters.length - 1; index >= 0; index -= 1) {
    const waiter = waiters[index]
    if (waiter !== undefined && requests >= waiter.count) {
      waiters.splice(index, 1)
      waiter.resolve()
    }
  }
}

/** The stream one reply produces: a delay before each chunk, then the usage. */
function streamOf(
  reply: ScriptedReply,
  onEnd: () => void,
): ReadableStream<LanguageModelV4StreamPart> {
  const chunks = reply.text ?? ['']
  const delayMs = reply.delayMs ?? 0
  const steps: (() => Promise<LanguageModelV4StreamPart>)[] = [
    () => Promise.resolve({ type: 'stream-start', warnings: [] }),
    () => Promise.resolve({ type: 'text-start', id: TEXT_ID }),
    ...chunks.map((chunk, index) => async (): Promise<LanguageModelV4StreamPart> => {
      await reply.onChunk?.(chunk, index)
      await delay(delayMs)
      return { type: 'text-delta', id: TEXT_ID, delta: chunk }
    }),
    () => Promise.resolve({ type: 'text-end', id: TEXT_ID }),
    () => {
      onEnd()
      return Promise.resolve<LanguageModelV4StreamPart>({
        type: 'finish',
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: chunks.length, text: chunks.length, reasoning: 0 },
        },
      })
    },
  ]
  let step = 0
  return new ReadableStream<LanguageModelV4StreamPart>({
    async pull(controller) {
      const next = steps[step]
      step += 1
      if (next === undefined) {
        controller.close()
        return
      }
      controller.enqueue(await next())
    },
    cancel() {
      onEnd()
    },
  })
}

/** One message of a provider-level prompt: what `streamText` hands the model. */
interface PromptMessage {
  readonly role: string
  readonly content: string | readonly { readonly type: string; readonly text?: string }[]
}

/** The text of one prompt message, whatever shape its content has — what {@link histories} reads. */
function textOf(message: PromptMessage): string {
  if (typeof message.content === 'string') {
    return message.content
  }
  return message.content.flatMap((part) => (part.type === 'text' ? [part.text ?? ''] : [])).join('')
}

/** The last user message of a provider-level prompt. */
function lastUserText(prompt: readonly PromptMessage[]): string {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const message = prompt[index]
    if (message === undefined || message.role !== 'user') {
      continue
    }
    return textOf(message)
  }
  return ''
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** A failure shaped the way the brain classifies one: a message and an HTTP status. */
export function modelError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode })
}

/** A promise only the test can settle; what {@link defer} hands back. */
export interface Deferred {
  /** What a {@link ScriptedReply}'s `onChunk` awaits to hold the reply. */
  readonly promise: Promise<void>
  /** Let the reply continue. Settling twice is a no-op. */
  release(): void
}

/**
 * How long a test that holds a reply open may take, in milliseconds.
 *
 * Vitest's own default is 10 seconds, which is *less* than the waits such a test makes: a
 * reload mid-reply reads with a 10-second bound, the frames it expects next with 5 more, and
 * the end of the turn with 15 — each of them a condition with room for a slow machine, and
 * together more than the default allows. A budget under the sum of the waits fails tests
 * that were about to pass; this one is above it, and the waits inside are what the
 * assertions are still made of.
 */
export const HELD_REPLY_TEST_TIMEOUT_MS = 30_000

/**
 * A gate for a scripted reply.
 *
 * A test that has to act *during* a turn — reload mid-reply, read the preview the store
 * holds — must be able to stop the turn where it wants it rather than hope the reply is
 * still streaming when it looks. `onChunk` awaiting one of these is how: the model produces
 * everything before it and nothing after it until {@link Deferred.release} is called, so
 * what the turn has published is a fact the test controls instead of a race.
 */
export function defer(): Deferred {
  let release: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
