import { SessionSchema, type Session } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import {
  formatContextWindow,
  formatCost,
  formatCostTotal,
  formatCount,
  formatDuration,
  modelLabel,
  sessionLabel,
  unpricedExplanation,
} from './format'
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
    cost: null,
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

describe('formatDuration', () => {
  it('keeps the tenth while a reply is fast, and drops it after that', () => {
    expect(formatDuration(0)).toBe('0.0s')
    expect(formatDuration(420)).toBe('0.4s')
    expect(formatDuration(4200)).toBe('4.2s')
    expect(formatDuration(9949)).toBe('9.9s')
    // Past ten seconds the decimal is noise — nobody reads "12.4s" — and the shapes are
    // chosen so the number never steps *backwards* as it grows.
    expect(formatDuration(9999)).toBe('10s')
    expect(formatDuration(12_400)).toBe('12s')
    // Rounded to 60, the line hands over to the clock rather than saying a number the row
    // below it would never say.
    expect(formatDuration(59_600)).toBe('59s')
  })

  it('is the working row’s clock past a minute', () => {
    // One shape for one wait: the row that counts up and the line that reports what it
    // counted are the same wait, and they read the same way.
    expect(formatDuration(60_000)).toBe('1m 00s')
    expect(formatDuration(65_400)).toBe('1m 05s')
    expect(formatDuration(3_725_000)).toBe('1h 02m')
  })

  it('never counts backwards from nothing', () => {
    // A duration is arithmetic on two server timestamps, and a clock that went backwards in
    // between would otherwise produce "-3s".
    expect(formatDuration(-3)).toBe('0.0s')
  })
})

describe('formatCount', () => {
  it('groups thousands, and leaves small numbers alone', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(1)).toBe('1')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1312)).toBe('1,312')
    expect(formatCount(1_234_567)).toBe('1,234,567')
  })
})

describe('formatCost (#247)', () => {
  it('reads an unknown cost as a dash, never as a number', () => {
    expect(formatCost(null)).toBe('—')
  })

  it('keeps the precision a small cost needs, and no more', () => {
    expect(formatCost(0)).toBe('$0.00')
    // A reply that cost a twentieth of a cent: rounding it to `$0.00` would read as free.
    expect(formatCost(0.0004)).toBe('$0.0004')
    expect(formatCost(0.001344)).toBe('$0.0013')
    expect(formatCost(0.024)).toBe('$0.024')
    expect(formatCost(0.01)).toBe('$0.01')
    expect(formatCost(0.5)).toBe('$0.5')
    expect(formatCost(1)).toBe('$1.00')
    expect(formatCost(3.4567)).toBe('$3.46')
    expect(formatCost(12.004)).toBe('$12.00')
  })

  it('says so rather than rounding a cost too small to print to zero', () => {
    expect(formatCost(0.00001)).toBe('<$0.0001')
  })
})

describe('formatCostTotal (#247, decided 2026-10-09)', () => {
  it('is just the money when every request was priced', () => {
    expect(formatCostTotal({ cost: 1.23, unpriced_requests: 0 })).toBe('$1.23')
  })

  it('sums the priced requests and names the unpriced ones', () => {
    expect(formatCostTotal({ cost: 1.23, unpriced_requests: 4 })).toBe('$1.23 + 4 unpriced')
    expect(formatCostTotal({ cost: 0.0013, unpriced_requests: 1 })).toBe('$0.0013 + 1 unpriced')
  })

  it('is a dash when nothing in the total is priced', () => {
    // There is no number to qualify: the whole total is the unknown part, and the dash says so.
    expect(formatCostTotal({ cost: null, unpriced_requests: 3 })).toBe('—')
    expect(formatCostTotal({ cost: null, unpriced_requests: 0 })).toBe('—')
  })

  it('explains the unpriced count in one sentence', () => {
    expect(unpricedExplanation(1)).toBe('1 request had no published price and is not in the total.')
    expect(unpricedExplanation(4)).toBe(
      '4 requests had no published price and are not in the total.',
    )
  })
})
