import type {
  ModelPriceLookup,
  TranscriptMessage,
  TranscriptMessageMeta,
} from '@openharness/client'
import { describe, expect, it } from 'vitest'

import {
  formatCost,
  formatDuration,
  formatTokens,
  replyMetaLine,
  replyMetaLines,
} from './reply-meta'

/** A reply, settled, with the metadata the test is about. */
function message(
  id: string,
  meta: TranscriptMessageMeta | undefined,
  role: 'user' | 'agent' = 'agent',
): TranscriptMessage {
  return {
    id,
    role,
    text: 'hi',
    parts: [{ type: 'text', text: 'hi' }],
    pending: false,
    streaming: false,
    position: Number(id.replace(/\D/gu, '')),
    ...(meta === undefined ? {} : { meta }),
  }
}

describe('formatDuration', () => {
  it('counts a sub-second reply in milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(450)).toBe('450ms')
    expect(formatDuration(999)).toBe('999ms')
  })

  it('keeps a decimal below ten seconds, where the difference is worth reading', () => {
    expect(formatDuration(1000)).toBe('1s')
    expect(formatDuration(4200)).toBe('4.2s')
    expect(formatDuration(9999)).toBe('10s')
  })

  it('drops the decimal above ten seconds, where it is noise', () => {
    expect(formatDuration(12_000)).toBe('12s')
    expect(formatDuration(59_400)).toBe('59s')
  })

  it('reads a minute or more as minutes', () => {
    expect(formatDuration(60_000)).toBe('1m')
    expect(formatDuration(65_000)).toBe('1m 5s')
    expect(formatDuration(120_000)).toBe('2m')
    expect(formatDuration(3_723_000)).toBe('62m 3s')
  })
})

describe('formatTokens', () => {
  it('counts below a thousand exactly', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(850)).toBe('850')
    expect(formatTokens(999)).toBe('999')
  })

  it('keeps a decimal up to ten thousand, where 1.3k and 2.1k are different replies', () => {
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(1300)).toBe('1.3k')
    expect(formatTokens(9999)).toBe('10k')
  })

  it('rounds down to whole thousands past that, so nothing reads as 1000k', () => {
    expect(formatTokens(12_000)).toBe('12k')
    expect(formatTokens(12_345)).toBe('12k')
    expect(formatTokens(999_999)).toBe('999k')
  })

  it('counts a million or more in millions', () => {
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_250_000)).toBe('1.3M')
  })
})

describe('replyMetaLine', () => {
  const context = { currentModel: 'anthropic/claude-sonnet-5', previousModel: undefined }

  it('says nothing at all when the log said nothing', () => {
    expect(replyMetaLine(undefined, context)).toBeNull()
    expect(replyMetaLine({}, context)).toBeNull()
  })

  it('leaves out the model the session already runs, and keeps the rest', () => {
    expect(
      replyMetaLine(
        {
          model: 'anthropic/claude-sonnet-5',
          durationMs: 4200,
          usage: { input: 1000, output: 300, cacheCreation: 0, cacheRead: 0, total: 1300 },
        },
        context,
      ),
    ).toBe('4.2s · 1.3k tokens')
  })

  it('names the model when it is the news', () => {
    expect(replyMetaLine({ model: 'openai/gpt-4.1-mini', durationMs: 1000 }, context)).toBe(
      'openai/gpt-4.1-mini · 1s',
    )
  })

  it('leaves out a model the reply before it already ran on', () => {
    expect(
      replyMetaLine(
        { model: 'openai/gpt-4.1-mini', durationMs: 1000 },
        { currentModel: 'anthropic/claude-sonnet-5', previousModel: 'openai/gpt-4.1-mini' },
      ),
    ).toBe('1s')
  })

  it('prints whatever part of the metadata did arrive, and no more', () => {
    expect(replyMetaLine({ model: 'openai/gpt-4.1-mini' }, context)).toBe('openai/gpt-4.1-mini')
    expect(replyMetaLine({ durationMs: 800 }, context)).toBe('800ms')
    expect(
      replyMetaLine(
        { usage: { input: 10, output: 5, cacheCreation: 0, cacheRead: 0, total: 15 } },
        context,
      ),
    ).toBe('15 tokens')
  })

  it('counts zero as a number the model reported, not as nothing', () => {
    expect(
      replyMetaLine(
        { usage: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 } },
        context,
      ),
    ).toBe('0 tokens')
  })
})

describe('replyMetaLines', () => {
  it('compares each reply against the one before it, not against the first', () => {
    const lines = replyMetaLines(
      [
        message('sevt_1', { model: 'anthropic/claude-sonnet-5', durationMs: 1000 }, 'user'),
        message('sevt_2', { model: 'anthropic/claude-sonnet-5', durationMs: 1000 }),
        message('sevt_3', { model: 'openai/gpt-4.1-mini', durationMs: 2000 }),
        message('sevt_4', { model: 'openai/gpt-4.1-mini', durationMs: 3000 }),
      ],
      'anthropic/claude-sonnet-5',
    )

    // The first is on the session's model; the third is a change and says so; the fourth is
    // on the model the third named, and does not repeat it.
    expect(lines.get('sevt_2')).toBe('1s')
    expect(lines.get('sevt_3')).toBe('openai/gpt-4.1-mini · 2s')
    expect(lines.get('sevt_4')).toBe('3s')
  })

  it('carries the last named model over a reply that named none', () => {
    const lines = replyMetaLines(
      [
        message('sevt_1', { model: 'openai/gpt-4.1-mini', durationMs: 1000 }),
        message('sevt_2', { durationMs: 2000 }),
        message('sevt_3', { model: 'openai/gpt-4.1-mini', durationMs: 3000 }),
      ],
      'anthropic/claude-sonnet-5',
    )

    expect(lines.get('sevt_2')).toBe('2s')
    expect(lines.get('sevt_3')).toBe('3s')
  })

  it('has nothing to say about a message with no metadata at all', () => {
    const lines = replyMetaLines([message('sevt_1', undefined), message('sevt_2', {})], 'x')
    expect(lines.size).toBe(0)
  })
})

describe('the cost in the line (#247)', () => {
  // The session's own model, so the line names none: what is left is tokens and money.
  const context = { currentModel: 'anthropic/claude-sonnet-5', previousModel: undefined }
  const prices: ModelPriceLookup = (modelId) =>
    modelId === 'anthropic/claude-sonnet-5'
      ? { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 }
      : null

  it('prices the reply with its model’s rates, after the tokens', () => {
    expect(
      replyMetaLine(
        {
          model: 'anthropic/claude-sonnet-5',
          durationMs: 4200,
          usage: { input: 1000, output: 300, cacheCreation: 0, cacheRead: 0, total: 1300 },
        },
        context,
        prices,
      ),
    ).toBe('4.2s · 1.3k tokens · $0.005')
  })

  it('shows a dash for a model nobody publishes a price for', () => {
    expect(
      replyMetaLine(
        {
          model: 'anthropic/claude-sonnet-5',
          usage: { input: 10, output: 5, cacheCreation: 0, cacheRead: 0, total: 15 },
        },
        context,
        () => null,
      ),
    ).toBe('15 tokens · —')
  })

  it('leaves the cost off entirely when the caller has no catalog', () => {
    expect(
      replyMetaLine(
        {
          model: 'anthropic/claude-sonnet-5',
          usage: { input: 10, output: 5, cacheCreation: 0, cacheRead: 0, total: 15 },
        },
        context,
      ),
    ).toBe('15 tokens')
  })
})

describe('formatCost (#247)', () => {
  it('reads an unknown cost as a dash, never as a number', () => {
    expect(formatCost(null)).toBe('—')
  })

  it('keeps the precision a small cost needs, and no more', () => {
    expect(formatCost(0)).toBe('$0.00')
    expect(formatCost(0.0004)).toBe('$0.0004')
    expect(formatCost(0.001344)).toBe('$0.0013')
    expect(formatCost(0.024)).toBe('$0.024')
    expect(formatCost(1)).toBe('$1.00')
    expect(formatCost(3.4567)).toBe('$3.46')
  })

  it('says so rather than rounding a cost too small to print to zero', () => {
    expect(formatCost(0.00001)).toBe('<$0.0001')
  })
})
