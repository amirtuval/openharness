import { describe, expect, it } from 'vitest'

import { ModelRequestStartEventSchema } from './events/span'
import { UserMessageEventInputSchema } from './events/user'
import { ReasoningEffortRunSchema, ReasoningEffortSchema, REASONING_EFFORTS } from './reasoning'

/**
 * The reasoning effort on the wire: the three levels, the `user.message` that asks for one, and
 * the span record of what a request was asked for and ran with.
 *
 * The shape has to stay a strict superset of what came before #252 — a message or a span stored
 * without an effort still parses, and nothing new is required.
 */

describe('ReasoningEffortSchema', () => {
  it('is the three levels a provider knob has in common', () => {
    expect(REASONING_EFFORTS).toEqual(['low', 'medium', 'high'])
  })

  it('refuses a level outside them, including the ones only some providers have', () => {
    for (const value of ['minimal', 'xhigh', 'max', 'none', 'HIGH', '']) {
      expect(ReasoningEffortSchema.safeParse(value).success).toBe(false)
    }
  })
})

describe('ReasoningEffortRunSchema', () => {
  it('carries what was asked for and what was applied', () => {
    expect(ReasoningEffortRunSchema.parse({ requested: 'high', applied: 'high' })).toEqual({
      requested: 'high',
      applied: 'high',
    })
  })

  it('reads a null as "asked for, not applied"', () => {
    expect(ReasoningEffortRunSchema.parse({ requested: 'low', applied: null })).toEqual({
      requested: 'low',
      applied: null,
    })
  })

  it('requires both fields: an effort asked for is never recorded without what ran', () => {
    expect(ReasoningEffortRunSchema.safeParse({ requested: 'low' }).success).toBe(false)
    expect(ReasoningEffortRunSchema.safeParse({ applied: null }).success).toBe(false)
  })
})

describe('the effort a client sends', () => {
  const content = [{ type: 'text', text: 'think' }]

  it('accepts a message with an effort, and one that clears it', () => {
    const asked = UserMessageEventInputSchema.parse({
      type: 'user.message',
      content,
      reasoning_effort: 'medium',
    })
    expect(asked.reasoning_effort).toBe('medium')

    const cleared = UserMessageEventInputSchema.parse({
      type: 'user.message',
      content,
      reasoning_effort: null,
    })
    expect(cleared.reasoning_effort).toBeNull()
  })

  it('leaves a message without one alone: every message stored before #252 parses', () => {
    const message = UserMessageEventInputSchema.parse({ type: 'user.message', content })
    expect(message.reasoning_effort).toBeUndefined()
    expect('reasoning_effort' in message).toBe(false)
  })

  it('refuses a level the protocol does not have', () => {
    const refused = UserMessageEventInputSchema.safeParse({
      type: 'user.message',
      content,
      reasoning_effort: 'xhigh',
    })
    expect(refused.success).toBe(false)
  })
})

describe('the effort a request records', () => {
  it('parses on a span start, beside the model that ran', () => {
    const span = ModelRequestStartEventSchema.parse({
      id: 'sevt_00000000000000000000000000',
      type: 'span.model_request_start',
      seq: 3,
      processed_at: '2026-01-01T00:00:00.000Z',
      model: 'openai/o4-mini',
      reasoning_effort: { requested: 'high', applied: 'high' },
    })
    expect(span.reasoning_effort).toEqual({ requested: 'high', applied: 'high' })
  })

  it('leaves a span stored without one parsing: the field is optional', () => {
    const span = ModelRequestStartEventSchema.parse({
      id: 'sevt_00000000000000000000000000',
      type: 'span.model_request_start',
      seq: 3,
      processed_at: '2026-01-01T00:00:00.000Z',
      model: 'openai/o4-mini',
    })
    expect(span.reasoning_effort).toBeUndefined()
  })
})
