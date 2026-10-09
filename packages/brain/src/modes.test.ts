import { EVENT_TYPES, newModeId } from '@openharness/protocol'
import type { SessionId } from '@openharness/protocol'
import type { InMemorySessionStore } from '@openharness/session'
import { describe, expect, it } from 'vitest'

import type { ReasoningSupportFor } from './reasoning'
import { logOf, message, newSession, spanStartOf, TEST_SYSTEM } from './testing/harness'
import { mockModel, readPrompt, resolveTestCredential } from './testing/mock-model'
import type { ModeResolver, ResolvedMode } from './turn'
import { runTurn } from './turn'

/**
 * Modes at the loop's boundary (#245, M6): the session follows a mode, the host resolves it per
 * request, and the request runs the mode's model, effort and system-prompt addition — recorded,
 * with the mode's id and name, on its span.
 *
 * A mode lives in the host's database, not the log, so the loop is handed a resolver here the
 * way the server hands it one over the real store. The span is the durable statement: the
 * resolved model and effort are what the request ran with, and `mode` is which preset it was.
 */

/** A resolver over a fixed map of modes, by id. */
function resolverFor(modes: Readonly<Record<string, ResolvedMode>>): ModeResolver {
  return (_ownerId, modeId) => Promise.resolve(modes[modeId] ?? null)
}

/** A resolved mode, with the fields a test wants to override. */
function resolvedMode(overrides: Partial<ResolvedMode> = {}): ResolvedMode {
  return {
    id: newModeId(),
    name: 'deep',
    model: 'openai/gpt-5-mini',
    reasoningEffort: 'high',
    systemPromptAddition: 'Think step by step.',
    ...overrides,
  }
}

/** Every model takes all three levels, so the loop applies what it is asked for. */
const EVERY_LEVEL: ReasoningSupportFor = () => ['low', 'medium', 'high']

/** The turn's first `span.model_request_start`. */
async function firstSpanStart(store: InMemorySessionStore, sessionId: SessionId) {
  const event = (await logOf(store, sessionId)).find(
    (candidate) => candidate.type === EVENT_TYPES.modelRequestStart,
  )
  return spanStartOf(event)
}

describe('a request on a mode', () => {
  it('runs the mode’s model, effort and prompt addition, and records them on the span', async () => {
    // The fixture session runs `anthropic/claude-sonnet-5`; the mode resolves to another model.
    const mode = resolvedMode()
    const { store, sessionId } = await newSession([message('go')], { mode: mode.id })
    const { factory, calls } = mockModel({ text: ['thought about it'] })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      reasoningSupportFor: EVERY_LEVEL,
      resolveMode: resolverFor({ [mode.id]: mode }),
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    // The span says what the request ran: the mode's resolved model and effort, and the two
    // facts about the mode itself — its id and the name it had then (#245, M6).
    expect(await firstSpanStart(store, sessionId)).toMatchObject({
      model: 'openai/gpt-5-mini',
      mode: { id: mode.id, name: 'deep' },
      reasoning_effort: { requested: 'high', applied: 'high' },
    })
    // The provider got its own spelling of the effort.
    expect(calls[0]?.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } })
    // The mode's addition is appended after the session's own system prompt, never in place of
    // it.
    expect(readPrompt(calls[0]!)[0]).toEqual({
      role: 'system',
      text: `${TEST_SYSTEM}\n\nThink step by step.`,
    })
  })

  it('follows the mode live: an edit between requests applies from the next one', async () => {
    const mode = resolvedMode()
    const { store, sessionId } = await newSession([message('first')], { mode: mode.id })
    const { factory, calls } = mockModel({ text: ['one'] }, { text: ['two'] })
    let current = mode // the "database" the resolver reads

    const options = {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      reasoningSupportFor: EVERY_LEVEL,
      resolveMode: (_owner: string, modeId: string) =>
        Promise.resolve(modeId === current.id ? current : null),
    }
    await runTurn(sessionId, options)

    // The mode is edited: a new model, a new effort, a new addition. The next request uses it
    // without the chat being touched — that is what "follows it live" means.
    current = { ...mode, model: 'anthropic/claude-sonnet-5', reasoningEffort: 'low' }
    await store.appendEvents(sessionId, [message('second')])
    await runTurn(sessionId, options)

    const spans = (await logOf(store, sessionId)).flatMap((event) =>
      event.type === EVENT_TYPES.modelRequestStart ? [event] : [],
    )
    expect(spans[0]?.model).toBe('openai/gpt-5-mini')
    expect(spans[0]?.reasoning_effort).toEqual({ requested: 'high', applied: 'high' })
    expect(spans[1]?.model).toBe('anthropic/claude-sonnet-5')
    expect(spans[1]?.reasoning_effort).toEqual({ requested: 'low', applied: 'low' })
    expect(calls).toHaveLength(2)
  })

  it('lets an explicit message effort override the mode’s', async () => {
    const mode = resolvedMode({ reasoningEffort: 'low' })
    const { store, sessionId } = await newSession([message('go', 'high')], { mode: mode.id })
    const { factory } = mockModel({ text: ['ok'] })

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      reasoningSupportFor: EVERY_LEVEL,
      resolveMode: resolverFor({ [mode.id]: mode }),
    })

    // The reader asked for high on the message, so high wins over the mode's low.
    expect((await firstSpanStart(store, sessionId)).reasoning_effort).toEqual({
      requested: 'high',
      applied: 'high',
    })
  })

  it('runs the mode’s addition as the whole prompt when the session has none', async () => {
    const mode = resolvedMode()
    const { store, sessionId } = await newSession([message('go')], {
      mode: mode.id,
      system: null,
    })
    const { factory, calls } = mockModel({ text: ['ok'] })

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      resolveMode: resolverFor({ [mode.id]: mode }),
    })

    expect(readPrompt(calls[0]!)[0]).toEqual({
      role: 'system',
      text: 'Think step by step.',
    })
  })

  it('falls back to the session’s own model when the mode is gone, recording no mode', async () => {
    // A mode that was deleted answers null: the request continues on the model the chat last
    // ran, as a chat without a mode — no mode on the span, and the session's own system prompt.
    const { store, sessionId } = await newSession([message('go')], { mode: newModeId() })
    const { factory, calls } = mockModel({ text: ['ok'] })

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      resolveMode: resolverFor({}),
    })

    const span = await firstSpanStart(store, sessionId)
    expect(span.model).toBe('anthropic/claude-sonnet-5')
    expect(span.mode).toBeUndefined()
    expect(readPrompt(calls[0]!)[0]).toEqual({ role: 'system', text: TEST_SYSTEM })
  })

  it('runs the session’s own model when no resolver is injected', async () => {
    const { store, sessionId } = await newSession([message('go')], { mode: newModeId() })
    const { factory } = mockModel({ text: ['ok'] })

    await runTurn(sessionId, { store, model: factory, resolveCredential: resolveTestCredential })

    const span = await firstSpanStart(store, sessionId)
    expect(span.model).toBe('anthropic/claude-sonnet-5')
    expect(span.mode).toBeUndefined()
  })

  it('does not resolve a mode for a chat without one', async () => {
    const { store, sessionId } = await newSession([message('go')])
    const { factory } = mockModel({ text: ['ok'] })
    let asked = 0

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      resolveMode: () => {
        asked += 1
        return Promise.resolve(null)
      },
    })

    expect(asked).toBe(0)
    expect((await firstSpanStart(store, sessionId)).mode).toBeUndefined()
  })
})
