import { SessionSchema, type Session } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { formatContextWindow, modelLabel, sessionLabel } from './format'
import { modelNameLookup } from './models'

// Through the schema, like the fake server does, so the branded ids are real ones.
const SESSION: Session = SessionSchema.parse({
  id: 'sesn_01JZZZZZZZZZZZZZZZZZZZZZZZ',
  type: 'session',
  owner_id: 'user_01JZZZZZZZZZZZZZZZZZZZZZZZ',
  status: 'idle',
  title: null,
  metadata: {},
  model: { id: 'anthropic/claude-sonnet-5' },
  system: null,
  agent: null,
  created_at: '2026-10-04T10:00:00.000Z',
  updated_at: '2026-10-04T10:00:00.000Z',
})

const nameOf = modelNameLookup([
  {
    id: 'anthropic/claude-sonnet-5',
    provider: 'anthropic',
    name: 'Claude Sonnet 5',
    context_window: 200_000,
    max_output_tokens: 64_000,
    source: 'provider',
  },
])

describe('sessionLabel', () => {
  it('prefers the title', () => {
    expect(sessionLabel({ ...SESSION, title: 'Release checklist' }, nameOf)).toBe(
      'Release checklist',
    )
  })

  it('falls back to the catalog display name, then the id — never the agent', () => {
    expect(sessionLabel(SESSION, nameOf)).toBe('Claude Sonnet 5')
    expect(sessionLabel(SESSION)).toBe('anthropic/claude-sonnet-5')
    expect(sessionLabel({ ...SESSION, model: { id: 'deepseek/deepseek-chat' } }, nameOf)).toBe(
      'deepseek/deepseek-chat',
    )
  })
})

describe('modelLabel', () => {
  it('names a model from the catalog, or shows its id', () => {
    expect(modelLabel('anthropic/claude-sonnet-5', nameOf)).toBe('Claude Sonnet 5')
    expect(modelLabel('openai/gpt-4.1-mini', nameOf)).toBe('openai/gpt-4.1-mini')
  })
})

describe('formatContextWindow', () => {
  it('is short: K, M, or the number itself', () => {
    expect(formatContextWindow(128_000)).toBe('128K')
    expect(formatContextWindow(200_000)).toBe('200K')
    expect(formatContextWindow(1_000_000)).toBe('1M')
    expect(formatContextWindow(1_048_576)).toBe('1.0M')
    expect(formatContextWindow(512)).toBe('512')
  })
})
