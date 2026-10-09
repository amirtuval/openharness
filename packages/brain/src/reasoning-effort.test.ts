import {
  EVENT_TYPES,
  type ModelConfig,
  type ReasoningEffort,
  type SessionId,
  type UserEventInput,
} from '@openharness/protocol'
import type { InMemorySessionStore } from '@openharness/session'
import { describe, expect, it } from 'vitest'

import { planReasoning, type ReasoningSupportFor } from './reasoning'
import { logOf, message, newSession, spanStartOf } from './testing/harness'
import { apiCallError, mockModel, resolveTestCredential } from './testing/mock-model'
import { runTurn } from './turn'

/**
 * The reasoning effort at the loop's boundary (#252): a `user.message` asks for one, the loop
 * reads the newest one the log carries at each request boundary, the provider is handed its own
 * option for it, and the request's span records what was asked for beside what was applied.
 *
 * The span is the loop's side of the contract: an effort rides the message rather than a session
 * field — the same reading as the per-message model of #111 — so the span is the durable
 * statement of what a request ran with, and a reader that asks "what did this run at" reads it.
 *
 * Which models take an effort is the injected resolver's answer (#252's follow-up), so the loop
 * is handed one here; the server's own is tested over HTTP in `apps/server`.
 */

/** A message that asks for an effort, the way a client sends one. */
function effortMessage(text: string, reasoningEffort: ReasoningEffort | null): UserEventInput {
  return {
    type: EVENT_TYPES.userMessage,
    content: [{ type: 'text', text }],
    reasoning_effort: reasoningEffort,
  }
}

/** A message that switches the model *and* asks for an effort. */
function switchingEffortMessage(
  text: string,
  model: ModelConfig,
  reasoningEffort: ReasoningEffort | null,
): UserEventInput {
  return {
    type: EVENT_TYPES.userMessage,
    content: [{ type: 'text', text }],
    model,
    reasoning_effort: reasoningEffort,
  }
}

/** Every `span.model_request_start`'s effort, in log order — `undefined` when it wrote none. */
async function effortsOf(store: InMemorySessionStore, sessionId: SessionId) {
  return (await logOf(store, sessionId)).flatMap((event) =>
    event.type === EVENT_TYPES.modelRequestStart ? [event.reasoning_effort] : [],
  )
}

/** The turn's first `span.model_request_start`, which the loop writes before every request. */
async function firstSpanStart(store: InMemorySessionStore, sessionId: SessionId) {
  const event = (await logOf(store, sessionId)).find(
    (candidate) => candidate.type === EVENT_TYPES.modelRequestStart,
  )
  return spanStartOf(event)
}

/** The resolver the loop tests hand `runTurn`: every model takes all three levels. */
const EVERY_LEVEL: ReasoningSupportFor = () => ['low', 'medium', 'high']

/** A resolver that knows one model takes no effort — the gate, read from the resolver. */
const TAKES_NONE: ReasoningSupportFor = () => []

describe('the reasoning effort of a request', () => {
  it('records the effort the log asked for, and asks the provider for it', async () => {
    // The fixture session runs `anthropic/claude-sonnet-5`, which takes an Anthropic `effort`.
    const { store, sessionId } = await newSession([effortMessage('think hard', 'high')])
    const { factory, calls } = mockModel({ text: ['thought about it'] })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      reasoningSupportFor: EVERY_LEVEL,
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect((await firstSpanStart(store, sessionId)).reasoning_effort).toEqual({
      requested: 'high',
      applied: 'high',
    })
    // The option reached the model call — in the provider's own spelling of it.
    expect(calls[0]?.providerOptions).toEqual({ anthropic: { effort: 'high' } })
  })

  it('records an effort asked for and not applied, for a model that takes none', async () => {
    // `openai/gpt-4o-mini` is not a reasoning model: OpenAI rejects the parameter for it, so the
    // request keeps the provider's default and the span says so.
    const { store, sessionId } = await newSession([
      switchingEffortMessage('answer briefly', { id: 'openai/gpt-4o-mini' }, 'low'),
    ])
    const { factory, calls } = mockModel({ text: ['briefly'] })

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      reasoningSupportFor: TAKES_NONE,
    })

    expect(await firstSpanStart(store, sessionId)).toMatchObject({
      model: 'openai/gpt-4o-mini',
      reasoning_effort: { requested: 'low', applied: null },
    })
    expect(calls[0]?.providerOptions).toBeUndefined()
  })

  it('sends nothing at all when no resolver is injected', async () => {
    // The safe default: a host that wires no resolver knows no model takes an effort, so every
    // request keeps its provider's default.
    const { store, sessionId } = await newSession([effortMessage('think hard', 'high')])
    const { factory, calls } = mockModel({ text: ['thought about it'] })

    await runTurn(sessionId, { store, model: factory, resolveCredential: resolveTestCredential })

    expect(await firstSpanStart(store, sessionId)).toMatchObject({
      reasoning_effort: { requested: 'high', applied: null },
    })
    expect(calls[0]?.providerOptions).toBeUndefined()
  })

  it('writes no effort at all for a session that never asked for one', async () => {
    // Every session stored before #252 looks like this, and its requests are unchanged.
    const { store, sessionId } = await newSession([message('hello')])
    const { factory, calls } = mockModel({ text: ['hi'] })

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      reasoningSupportFor: EVERY_LEVEL,
    })

    expect(await effortsOf(store, sessionId)).toEqual([undefined])
    expect(calls[0]?.providerOptions).toBeUndefined()
  })

  it('applies a switch that arrives while a request streams to the next request', async () => {
    const { store, sessionId } = await newSession([effortMessage('one', 'low')])
    const { factory } = mockModel(
      {
        text: ['answering ', 'the first'],
        onChunk: async (_chunk, index) => {
          if (index === 0) {
            await store.appendEvents(sessionId, [effortMessage('two', 'high')])
          }
        },
      },
      { text: ['answering the second'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      reasoningSupportFor: EVERY_LEVEL,
    })

    // The first request ran at what its own message asked for; the steering message is the
    // second request's, and the log keeps both.
    expect(await effortsOf(store, sessionId)).toEqual([
      { requested: 'low', applied: 'low' },
      { requested: 'high', applied: 'high' },
    ])
  })

  it('takes an explicit null as "back to the provider default"', async () => {
    const { store, sessionId } = await newSession([effortMessage('one', 'high')])
    const { factory } = mockModel(
      {
        text: ['answering ', 'the first'],
        onChunk: async (_chunk, index) => {
          if (index === 0) {
            await store.appendEvents(sessionId, [effortMessage('two', null)])
          }
        },
      },
      { text: ['answering the second'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      reasoningSupportFor: EVERY_LEVEL,
    })

    expect(await effortsOf(store, sessionId)).toEqual([
      { requested: 'high', applied: 'high' },
      undefined,
    ])
  })

  it('runs a retry of a request at the same effort: the attempt is a fresh request', async () => {
    const { store, sessionId } = await newSession([effortMessage('please work', 'medium')])
    const { factory } = mockModel({ failWith: apiCallError(503) }, { text: ['it worked'] })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      reasoningSupportFor: EVERY_LEVEL,
      retry: { baseDelayMs: 1, maxDelayMs: 1 },
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(await effortsOf(store, sessionId)).toEqual([
      { requested: 'medium', applied: 'medium' },
      { requested: 'medium', applied: 'medium' },
    ])
  })

  it('sends no option for a provider this build cannot ask one of', () => {
    // The resolver may describe the model, but there is nothing to send an effort to: the
    // request would end as an unsupported provider before it is made.
    const unknown = planReasoning('someone-else/some-model', 'high', EVERY_LEVEL)
    expect(unknown.providerOptions).toBeUndefined()
    expect(unknown.record).toEqual({ requested: 'high', applied: null })
  })
})
