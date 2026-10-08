import { describe, expect, it } from 'vitest'
import { EVENT_TYPES, type ModelConfig, type UserEventInput } from '@openharness/protocol'

import type { ModelFactory, ResolveCredential } from './model'
import { runTurn } from './turn'
import { logOf, message, newSession, TEST_MODEL_ID } from './testing/harness'
import { mockModel, resolveTestCredential } from './testing/mock-model'

/**
 * The per-request model (epic #116, U3): `session.model` is the projection a `user.message`
 * carrying a `model` switches in the append transaction, and the loop re-reads the session at
 * every request boundary — so a switch applies from the next request on, spanning providers,
 * and a message that carried one before the turn even started is what the first request runs.
 */

/** These tests' session is created with the fixture model; a switch names another provider. */
const SWITCH: ModelConfig = { id: 'openai/gpt-5-mini' }

/** A message that also switches the session's model, the way a client sends one (U3). */
function switchingMessage(text: string, model: ModelConfig = SWITCH): UserEventInput {
  return {
    type: EVENT_TYPES.userMessage,
    content: [{ type: 'text', text }],
    model,
  }
}

/** A model factory and a credential resolver that record the ids/providers they were asked for. */
function recording(modelIds: string[], providers: string[]) {
  const { factory: inner, calls } = mockModel(
    ...[{ text: ['first answer'] }, { text: ['second answer'] }],
  )
  const factory: ModelFactory = (id, credential) => {
    modelIds.push(id)
    return inner(id, credential)
  }
  const resolveCredential: ResolveCredential = (provider) => {
    providers.push(provider)
    return resolveTestCredential(provider)
  }
  return { factory, resolveCredential, calls }
}

describe('the session’s current model is resolved per request (U3)', () => {
  it('runs a queued message that switched the model with the switched one, from the first request', async () => {
    const { store, sessionId } = await newSession([switchingMessage('use the new model')])
    const modelIds: string[] = []
    const providers: string[] = []
    const { factory, resolveCredential } = recording(modelIds, providers)

    const outcome = await runTurn(sessionId, { store, model: factory, resolveCredential })

    expect(outcome).toEqual({ outcome: 'idle' })
    const span = (await logOf(store, sessionId)).find(
      (event) => event.type === EVENT_TYPES.modelRequestStart,
    )
    expect(span).toMatchObject({ type: EVENT_TYPES.modelRequestStart, model: SWITCH.id })
    expect(modelIds).toEqual([SWITCH.id])
    // The credential is the switched model's provider's, not the session's original one.
    expect(providers).toEqual(['openai'])
    expect((await store.getSessionUnscoped(sessionId))?.model).toEqual(SWITCH)
  })

  it('switches across providers mid-chat: the next request uses the new model', async () => {
    const { store, sessionId } = await newSession([message('First')])
    const { factory: inner } = mockModel(
      {
        text: ['Answering ', 'the first'],
        onChunk: async (_chunk, index) => {
          // The steering message — carrying the switch — lands while the first request streams.
          if (index === 0) {
            await store.appendEvents(sessionId, [switchingMessage('answer with the new model')])
          }
        },
      },
      { text: ['Answering on the new model'] },
    )
    const recorded: string[] = []
    const recordedProviders: string[] = []
    const model: ModelFactory = (id, credential) => {
      recorded.push(id)
      return inner(id, credential)
    }
    const resolveCredential: ResolveCredential = (provider) => {
      recordedProviders.push(provider)
      return resolveTestCredential(provider)
    }

    const outcome = await runTurn(sessionId, { store, model, resolveCredential })

    expect(outcome).toEqual({ outcome: 'idle' })
    const models = (await logOf(store, sessionId)).flatMap((event) =>
      event.type === EVENT_TYPES.modelRequestStart ? [event.model] : [],
    )
    // The first request ran the session's original model; the second one — the reply to the
    // steering message — ran the model that message switched to, from a different provider.
    expect(models).toEqual([TEST_MODEL_ID, SWITCH.id])
    expect(recorded).toEqual([TEST_MODEL_ID, SWITCH.id])
    expect(recordedProviders).toEqual(['anthropic', 'openai'])
    // The running totals break down by model (#247): the switch is exactly why a session's
    // usage is not one number — the two models are priced at different rates, so a reader has
    // to be able to tell which requests ran on which.
    const totals = (await logOf(store, sessionId)).flatMap((event) =>
      event.type === EVENT_TYPES.sessionUsage ? [event] : [],
    )
    expect(totals).toHaveLength(2)
    expect(totals[1]?.models.map((entry) => entry.model)).toEqual([TEST_MODEL_ID, SWITCH.id])
    expect(totals[1]?.input_tokens).toBe(
      (totals[0]?.input_tokens ?? 0) * 2,
    )
    // The log is the source of truth and the projection follows it: the session keeps running
    // the switched model.
    expect((await store.getSessionUnscoped(sessionId))?.model).toEqual(SWITCH)
  })

  it('runs the newest switch when several messages were queued before the turn', async () => {
    // Two queued messages, the second one switching the model: both are claimed by the first
    // (only) request, which runs what the session's projection says at its boundary — the
    // last switch among them.
    const { store, sessionId } = await newSession([
      message('one'),
      switchingMessage('two', { id: 'openai/gpt-4.1-mini' }),
    ])
    const modelIds: string[] = []
    const providers: string[] = []
    const { factory, resolveCredential } = recording(modelIds, providers)

    await runTurn(sessionId, { store, model: factory, resolveCredential })

    expect(modelIds).toEqual(['openai/gpt-4.1-mini'])
    expect(providers).toEqual(['openai'])
  })
})
