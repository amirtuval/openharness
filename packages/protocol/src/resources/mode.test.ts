import { describe, expect, it } from 'vitest'

import { newModeId } from '../ids'
import {
  CreateModeRequestSchema,
  ListModesResponseSchema,
  MAX_MODES_PER_USER,
  MODE_DEFAULT_MODEL,
  MODE_NAME_MAX_LENGTH,
  ModeModelSchema,
  ModeReferenceSchema,
  ModeSchema,
  UpdateModeRequestSchema,
} from './mode'

const mode = {
  id: newModeId(),
  type: 'mode',
  owner_id: 'Qm3xT7bR9kL2nV5wZ8yA4cD6fG1hJ0pS',
  name: 'deep',
  model: 'anthropic/claude-sonnet-5',
  reasoning_effort: 'high',
  system_prompt_addition: 'Think step by step.',
  created_at: '2026-03-15T10:00:00Z',
  updated_at: '2026-03-15T10:00:00Z',
}

describe('ModeSchema', () => {
  it('parses a mode', () => {
    expect(ModeSchema.parse(mode)).toEqual(mode)
  })

  it('accepts "my default model" as the model, and null effort and addition', () => {
    expect(
      ModeSchema.parse({
        ...mode,
        model: MODE_DEFAULT_MODEL,
        reasoning_effort: null,
        system_prompt_addition: null,
      }),
    ).toMatchObject({
      model: MODE_DEFAULT_MODEL,
      reasoning_effort: null,
      system_prompt_addition: null,
    })
  })

  it('requires the owner the server assigned, and accepts nothing else as one', () => {
    const { owner_id: _owner, ...withoutOwner } = mode
    expect(ModeSchema.safeParse(withoutOwner).success).toBe(false)
    expect(ModeSchema.safeParse({ ...mode, owner_id: '' }).success).toBe(false)
    expect(ModeSchema.safeParse({ ...mode, owner_id: 7 }).success).toBe(false)
  })

  it('rejects a bad id, an empty name and a missing timestamp', () => {
    expect(ModeSchema.safeParse({ ...mode, id: 'mode_nope' }).success).toBe(false)
    expect(
      ModeSchema.safeParse({ ...mode, id: newModeId().replace('mode_', 'sesn_') }).success,
    ).toBe(false)
    expect(ModeSchema.safeParse({ ...mode, name: '' }).success).toBe(false)
    expect(
      ModeSchema.safeParse({ ...mode, name: 'x'.repeat(MODE_NAME_MAX_LENGTH + 1) }).success,
    ).toBe(false)
    const { updated_at: _updated, ...withoutUpdatedAt } = mode
    expect(ModeSchema.safeParse(withoutUpdatedAt).success).toBe(false)
  })
})

describe('ModeModelSchema', () => {
  it('accepts a `provider/model` id and the default-model sentinel', () => {
    expect(ModeModelSchema.parse('anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5')
    expect(ModeModelSchema.parse('openrouter/meta-llama/llama-3.3-70b')).toBe(
      'openrouter/meta-llama/llama-3.3-70b',
    )
    expect(ModeModelSchema.parse(MODE_DEFAULT_MODEL)).toBe(MODE_DEFAULT_MODEL)
  })

  it('rejects a bare model name, an empty string and whitespace', () => {
    expect(ModeModelSchema.safeParse('claude-sonnet-5').success).toBe(false)
    expect(ModeModelSchema.safeParse('').success).toBe(false)
    expect(ModeModelSchema.safeParse('anthropic /claude-sonnet-5').success).toBe(false)
    expect(ModeModelSchema.safeParse('anthropic/').success).toBe(false)
  })
})

describe('ModeReferenceSchema', () => {
  it('carries the id a request ran under and the name it had then', () => {
    expect(ModeReferenceSchema.parse({ id: mode.id, name: mode.name })).toEqual({
      id: mode.id,
      name: mode.name,
    })
    expect(ModeReferenceSchema.safeParse({ id: mode.id, name: '' }).success).toBe(false)
    expect(ModeReferenceSchema.safeParse({ id: mode.id }).success).toBe(false)
  })
})

describe('mode request schemas', () => {
  it('accepts a minimal create body', () => {
    expect(CreateModeRequestSchema.parse({ name: 'fast', model: 'openai/gpt-4.1-mini' })).toEqual({
      name: 'fast',
      model: 'openai/gpt-4.1-mini',
    })
  })

  it('accepts the default-model sentinel and the optional fields on create', () => {
    expect(
      CreateModeRequestSchema.parse({
        name: 'mine',
        model: MODE_DEFAULT_MODEL,
        reasoning_effort: 'low',
        system_prompt_addition: 'Be terse.',
      }),
    ).toEqual({
      name: 'mine',
      model: MODE_DEFAULT_MODEL,
      reasoning_effort: 'low',
      system_prompt_addition: 'Be terse.',
    })
  })

  it('requires a name and a model on create', () => {
    expect(CreateModeRequestSchema.safeParse({ name: 'A' }).success).toBe(false)
    expect(CreateModeRequestSchema.safeParse({ model: 'x/y' }).success).toBe(false)
    expect(CreateModeRequestSchema.safeParse({ name: '', model: 'x/y' }).success).toBe(false)
    expect(
      CreateModeRequestSchema.safeParse({ name: 'A', model: 'x/y', owner_id: 'x' }).success,
    ).toBe(true)
  })

  it('never takes owner_id from a request: the server assigns the owner', () => {
    const created = CreateModeRequestSchema.parse({
      name: 'A',
      model: 'x/y',
      owner_id: 'somebody-else',
    })
    expect(created).not.toHaveProperty('owner_id')
    const updated = UpdateModeRequestSchema.parse({ owner_id: 'somebody-else' })
    expect(updated).not.toHaveProperty('owner_id')
  })

  it('accepts an empty update body, since every field is optional', () => {
    expect(UpdateModeRequestSchema.parse({})).toEqual({})
    expect(UpdateModeRequestSchema.parse({ system_prompt_addition: null })).toEqual({
      system_prompt_addition: null,
    })
    expect(UpdateModeRequestSchema.parse({ reasoning_effort: null })).toEqual({
      reasoning_effort: null,
    })
    expect(UpdateModeRequestSchema.safeParse({ name: '' }).success).toBe(false)
    expect(UpdateModeRequestSchema.safeParse({ reasoning_effort: 'extreme' }).success).toBe(false)
  })

  it('parses the list envelope', () => {
    expect(ListModesResponseSchema.parse({ data: [mode] })).toEqual({ data: [mode] })
    expect(ListModesResponseSchema.parse({ data: [] })).toEqual({ data: [] })
    expect(ListModesResponseSchema.safeParse({ data: {} }).success).toBe(false)
  })

  it('caps a user at twenty modes', () => {
    expect(MAX_MODES_PER_USER).toBe(20)
  })
})
