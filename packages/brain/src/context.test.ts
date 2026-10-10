import { newEventId } from '@openharness/protocol'
import type {
  ContextSummaryEvent,
  EventId,
  ModelUsage,
  SessionRewindEvent,
  StoredEvent,
} from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import type { ContextSizeBaseline } from './context'
import {
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  OMISSION_MARKER,
  createContextStrategy,
  estimateNextRequestTokens,
  estimateTokens,
  promptTokensOf,
} from './context'

/** A message event, as the log stores one. */
function userMessage(seq: number, text: string): StoredEvent {
  return {
    id: newEventId(),
    type: 'user.message',
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
    content: [{ type: 'text', text }],
  }
}

/** An agent reply, as the log stores one. */
function agentMessage(seq: number, text: string): StoredEvent {
  return {
    id: newEventId(),
    type: 'agent.message',
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
    content: [{ type: 'text', text }],
  }
}

/** An event the context is not made of. */
function statusRunning(seq: number): StoredEvent {
  return {
    id: newEventId(),
    type: 'session.status_running',
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
  }
}

/** A `session.context_summary`, as the brain writes one (epic #277, K1). */
function contextSummary(
  seq: number,
  summary: string,
  toSeq: number,
  overrides: Partial<ContextSummaryEvent> = {},
): StoredEvent {
  const event: ContextSummaryEvent = {
    id: newEventId(),
    type: 'session.context_summary',
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
    summary,
    covers: { to_seq: toSeq },
    reason: 'threshold',
    tokens_before: 40_000,
    summary_model: 'anthropic/claude-sonnet-5',
    prompt_version: 'compact-v1',
    passes: 1,
    ...overrides,
  }
  return event
}

/** A `session.rewind`, as the store records one (#238). */
function rewind(seq: number, fromSeq: number, toSeq: number): StoredEvent {
  const event: SessionRewindEvent = {
    id: newEventId(),
    type: 'session.rewind',
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
    supersedes: { from_seq: fromSeq, to_seq: toSeq },
  }
  return event
}

/** A stored chunk of a reply in flight: an `event_start` or an `event_delta` (D9). */
function chunk(seq: number, of: EventId): StoredEvent {
  return seq % 2 === 0
    ? {
        id: newEventId(),
        type: 'event_delta',
        seq,
        processed_at: '2026-03-15T10:00:00.000Z',
        event_id: of,
        delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'half a rep' } },
      }
    : {
        id: newEventId(),
        type: 'event_start',
        seq,
        processed_at: '2026-03-15T10:00:00.000Z',
        event: { type: 'agent.message', id: of },
      }
}

const MODEL = { id: 'anthropic/claude-sonnet-5' }

/** A usage with the counters a test sets. */
function usage(overrides: Partial<ModelUsage> = {}): ModelUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...overrides,
  }
}

describe('createContextStrategy', () => {
  it('turns the conversation into messages, oldest first', () => {
    const strategy = createContextStrategy()

    const { messages } = strategy(
      [
        statusRunning(1),
        userMessage(2, 'First'),
        agentMessage(3, 'Answer'),
        userMessage(4, 'Second'),
      ],
      { model: MODEL, system: 'Be terse.' },
    )

    expect(messages).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Answer' },
      { role: 'user', content: 'Second' },
    ])
  })

  it('leaves the system message out when the session has no prompt', () => {
    const strategy = createContextStrategy()

    expect(strategy([userMessage(1, 'Hi')], { model: MODEL, system: null }).messages).toEqual([
      { role: 'user', content: 'Hi' },
    ])
  })

  it('leaves out messages that carry no text', () => {
    const strategy = createContextStrategy()
    const empty: StoredEvent = {
      id: newEventId(),
      type: 'agent.message',
      seq: 2,
      processed_at: '2026-03-15T10:00:00.000Z',
      content: [],
    }

    expect(
      strategy([userMessage(1, 'Hi'), empty], { model: MODEL, system: null }).messages,
    ).toEqual([{ role: 'user', content: 'Hi' }])
  })

  it('ignores the stored chunks of a reply (D9)', () => {
    // Since D9 a reply is stored twice while it streams: as its chunks, and as the message that
    // supersedes them. The chunks are the stream's shape, not the conversation's — the model
    // must see one reply, once, and the empty text of a chunk would otherwise read as a message
    // the model did not send.
    const strategy = createContextStrategy()
    const reply = newEventId()

    expect(
      strategy(
        [
          userMessage(1, 'Hi'),
          chunk(2, reply),
          chunk(3, reply),
          chunk(4, reply),
          agentMessage(5, 'Hello there'),
        ],
        { model: MODEL, system: null },
      ).messages,
    ).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello there' },
    ])
  })

  it('joins a message of several blocks', () => {
    const strategy = createContextStrategy()
    const multi: StoredEvent = {
      id: newEventId(),
      type: 'user.message',
      seq: 1,
      processed_at: '2026-03-15T10:00:00.000Z',
      content: [
        { type: 'text', text: 'One' },
        { type: 'text', text: 'Two' },
      ],
    }

    expect(strategy([multi], { model: MODEL, system: null }).messages).toEqual([
      { role: 'user', content: 'OneTwo' },
    ])
  })

  it('drops the oldest turns when the history is over budget', () => {
    // A budget of 20 tokens is 80 characters at `CHARS_PER_TOKEN`.
    const strategy = createContextStrategy({ tokenBudget: 20 })
    const events = [
      userMessage(1, 'a'.repeat(40)),
      agentMessage(2, 'b'.repeat(40)),
      userMessage(3, 'c'.repeat(40)),
      agentMessage(4, 'd'.repeat(40)),
    ]

    const { messages } = strategy(events, { model: MODEL, system: null })

    expect(messages).toEqual([
      { role: 'user', content: 'c'.repeat(40) },
      { role: 'assistant', content: 'd'.repeat(40) },
    ])
  })

  it('keeps the newest message even when it alone is over budget', () => {
    // A budget of 1 token caps the newest message (K6) rather than dropping it: the text is cut
    // to a head and a tail around the marker, and never removed.
    const strategy = createContextStrategy({ tokenBudget: 1 })
    const events = [
      userMessage(1, 'a'.repeat(40)),
      agentMessage(2, 'b'.repeat(40)),
      userMessage(3, 'c'.repeat(400)),
    ]

    const { messages, truncated } = strategy(events, { model: MODEL, system: 'System prompt.' })

    expect(messages[0]).toEqual({ role: 'system', content: 'System prompt.' })
    expect(messages).toHaveLength(2)
    expect(messages[1]!.role).toBe('user')
    // The marker is all that fits a one-token budget, and the text is otherwise gone — but the
    // message is still there, which is the rule (K6).
    expect(messages[1]!.content).toContain('tokens omitted')
    expect(truncated).toEqual({
      seq: 3,
      tokens_before: 100,
      tokens_after: estimateTokens(OMISSION_MARKER(100)),
    })
  })

  it('never opens the history with a reply', () => {
    // Dropping whole turns from a log that starts with a user message keeps that shape, so this
    // is the defensive half of the rule: a history whose oldest kept message is a reply (a log
    // that opens with one) has it dropped too, leaving the question it was answering.
    const strategy = createContextStrategy({ tokenBudget: 25 })
    const events = [
      agentMessage(1, 'b'.repeat(40)),
      userMessage(2, 'c'.repeat(40)),
      agentMessage(3, 'd'.repeat(40)),
      userMessage(4, 'e'.repeat(4)),
    ]

    expect(strategy(events, { model: MODEL, system: null }).messages).toEqual([
      { role: 'user', content: 'e'.repeat(4) },
    ])
  })

  it('budgets per model through the resolver, with the default as the fallback', () => {
    // Each message is one token (four characters).
    const strategy = createContextStrategy({
      tokenBudget: 4,
      tokenBudgetFor: (modelId) => (modelId === 'tiny/one' ? 3 : undefined),
    })
    const events = [
      userMessage(1, 'aaaa'),
      agentMessage(2, 'bbbb'),
      userMessage(3, 'cccc'),
      agentMessage(4, 'dddd'),
    ]

    // `tiny/one` gets 3 tokens — only the newest turn survives.
    expect(strategy(events, { model: { id: 'tiny/one' }, system: null }).messages).toEqual([
      { role: 'user', content: 'cccc' },
      { role: 'assistant', content: 'dddd' },
    ])
    // `large/two` is not one the resolver knows, so the default 4-token budget applies and the
    // whole conversation fits.
    expect(strategy(events, { model: { id: 'large/two' }, system: null }).messages).toHaveLength(4)
  })

  it('asks the resolver for the model of the request it is building', () => {
    // The resolver is a seam for the per-request budget (#246): the strategy asks once per
    // call, with the id the request runs, so a switch between two calls trims differently.
    const asked: string[] = []
    const strategy = createContextStrategy({
      tokenBudgetFor: (modelId) => {
        asked.push(modelId)
        return undefined
      },
    })
    const events = [userMessage(1, 'hi')]

    strategy(events, { model: { id: 'one/a' }, system: null })
    strategy(events, { model: { id: 'two/b' }, system: null })

    expect(asked).toEqual(['one/a', 'two/b'])
  })
})

describe('context summaries (epic #277, K1)', () => {
  const strategy = createContextStrategy()

  it('builds system prompt, then the summary, then what follows it', () => {
    const { messages } = strategy(
      [
        userMessage(1, 'an old question'),
        agentMessage(2, 'an old answer'),
        contextSummary(3, 'The user asked an old question.', 2),
        userMessage(4, 'a new question'),
      ],
      { model: MODEL, system: 'Be terse.' },
    )

    expect(messages).toHaveLength(3)
    expect(messages[0]).toEqual({ role: 'system', content: 'Be terse.' })
    expect(messages[1]!.role).toBe('system')
    expect(messages[1]!.content).toContain('The user asked an old question.')
    // The covered events are not in the request; the one after `covers.to_seq` is.
    expect(messages[2]).toEqual({ role: 'user', content: 'a new question' })
  })

  it('stands alone when the session has no system prompt', () => {
    const { messages } = strategy(
      [userMessage(1, 'old'), contextSummary(2, 'A summary.', 1), userMessage(3, 'new')],
      { model: MODEL, system: null },
    )

    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).toContain('A summary.')
    expect(messages[1]).toEqual({ role: 'user', content: 'new' })
  })

  it('takes the latest summary when the log holds several', () => {
    const { messages } = strategy(
      [
        userMessage(1, 'first'),
        contextSummary(2, 'SUMMARY ONE', 1),
        userMessage(3, 'second'),
        contextSummary(4, 'SUMMARY TWO', 3),
        userMessage(5, 'third'),
      ],
      { model: MODEL, system: null },
    )

    const summary = messages.find((message) => message.role === 'system')
    expect(summary?.content).toContain('SUMMARY TWO')
    expect(summary?.content).not.toContain('SUMMARY ONE')
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'third' })
  })

  it('ignores a summary a rewind has superseded', () => {
    // The rewind reaches back past the summary, so the edit took the branch the summary
    // described back with it (K1). The summary must not reach the model. The replay read the
    // brain uses would normally have dropped the covered events already; the strategy is asked
    // to hold the rule for a caller that hands it the whole log.
    const { messages } = strategy(
      [
        userMessage(1, 'the original question'),
        agentMessage(2, 'the original answer'),
        contextSummary(3, 'A summary of the original branch.', 2),
        userMessage(4, 'the edited question'),
        rewind(5, 1, 4),
      ],
      { model: MODEL, system: null },
    )

    expect(messages.some((message) => message.role === 'system')).toBe(false)
    expect(JSON.stringify(messages)).not.toContain('A summary of the original branch.')
  })

  it('ignores a summary written before the rewind but keeps the summary written after it', () => {
    // The rewind covers event 2 only, so the later summary is the one that stands.
    const { messages } = strategy(
      [
        userMessage(1, 'old'),
        contextSummary(2, 'BEFORE THE REWIND', 1),
        rewind(3, 1, 2),
        userMessage(4, 'edited'),
        contextSummary(5, 'AFTER THE REWIND', 4),
        userMessage(6, 'latest'),
      ],
      { model: MODEL, system: null },
    )

    const summary = messages.find((message) => message.role === 'system')
    expect(summary?.content).toContain('AFTER THE REWIND')
    expect(summary?.content).not.toContain('BEFORE THE REWIND')
  })

  it('keeps the summary through trimming', () => {
    // The summary is a system message, and `trimToBudget` drops history, never system messages
    // — which is what makes a summary the one part of a long chat that cannot be trimmed away.
    const small = createContextStrategy({ tokenBudget: 20 })
    const { messages } = small(
      [
        userMessage(1, 'a'.repeat(400)),
        agentMessage(2, 'b'.repeat(400)),
        contextSummary(3, 'KEEP ME', 2),
        userMessage(4, 'c'.repeat(40)),
      ],
      { model: MODEL, system: null },
    )

    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).toContain('KEEP ME')
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'c'.repeat(40) })
  })
})

describe('the newest item (epic #277, K6)', () => {
  it('caps the newest item to a head and a tail with an omission marker', () => {
    const budget = 20
    const strategy = createContextStrategy({ tokenBudget: budget })
    const text = 'h'.repeat(200) + 'TAILTAILTAIL'
    const { messages, truncated } = strategy([userMessage(1, text)], {
      model: MODEL,
      system: null,
    })

    const content = messages.at(-1)!.content as string
    expect(content).toContain('tokens omitted')
    expect(content.startsWith('h'.repeat(10))).toBe(true)
    expect(content.endsWith('TAILTAILTAIL')).toBe(true)
    expect(estimateTokens(content)).toBeLessThanOrEqual(budget)
    expect(truncated).toEqual({
      seq: 1,
      tokens_before: estimateTokens(text),
      tokens_after: estimateTokens(content),
    })
  })

  it('reports how many tokens the marker stands for', () => {
    const strategy = createContextStrategy({ tokenBudget: 20 })
    const text = 'x'.repeat(4000)
    const { messages, truncated } = strategy([userMessage(7, text)], {
      model: MODEL,
      system: null,
    })

    const content = messages.at(-1)!.content as string
    expect(truncated?.seq).toBe(7)
    expect(truncated?.tokens_before).toBe(1000)
    expect(truncated?.tokens_after).toBe(estimateTokens(content))
    expect(content).toContain(OMISSION_MARKER(truncated!.tokens_before - truncated!.tokens_after))
  })

  it('cuts nothing when the newest item fits', () => {
    const strategy = createContextStrategy({ tokenBudget: 20 })
    const { messages, truncated } = strategy([userMessage(1, 'short')], {
      model: MODEL,
      system: null,
    })

    expect(messages).toEqual([{ role: 'user', content: 'short' }])
    expect(truncated).toBeUndefined()
  })

  it('caps an oversized newest reply too, keeping its role', () => {
    const strategy = createContextStrategy({ tokenBudget: 20 })
    const { messages, truncated } = strategy(
      [userMessage(1, 'hi'), agentMessage(2, 'a'.repeat(400))],
      { model: MODEL, system: null },
    )

    expect(messages.at(-1)!.role).toBe('assistant')
    expect(messages.at(-1)!.content).toContain('tokens omitted')
    expect(truncated?.seq).toBe(2)
  })
})

describe('estimateTokens', () => {
  it('is four characters per token, rounded up', () => {
    expect(CHARS_PER_TOKEN).toBe(4)
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('has a sane default budget', () => {
    expect(DEFAULT_CONTEXT_TOKEN_BUDGET).toBeGreaterThan(1_000)
  })
})

describe('the real prompt size (epic #277, K2)', () => {
  it('is the three input-side counters summed', () => {
    expect(promptTokensOf(usage({ input_tokens: 10 }))).toBe(10)
    expect(promptTokensOf(usage({ input_tokens: 10, cache_read_input_tokens: 4 }))).toBe(14)
    expect(
      promptTokensOf(
        usage({ input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 }),
      ),
    ).toBe(16)
  })
})

describe('estimateNextRequestTokens (epic #277, K2)', () => {
  const previous = (overrides: Partial<ContextSizeBaseline> = {}): ContextSizeBaseline => ({
    model: 'anthropic/claude-sonnet-5',
    usage: usage({ input_tokens: 1_000, cache_read_input_tokens: 200 }),
    ...overrides,
  })

  it('uses the previous request and only estimates what is new', () => {
    expect(
      estimateNextRequestTokens({
        model: 'anthropic/claude-sonnet-5',
        previous: previous(),
        // Two new items of four characters each: 2 tokens at `CHARS_PER_TOKEN`.
        since: ['abcd', 'efgh'],
      }),
    ).toBe(1_202)
  })

  it('estimates the whole history when there is no previous request', () => {
    expect(
      estimateNextRequestTokens({
        model: 'anthropic/claude-sonnet-5',
        previous: null,
        since: ['abcd', 'efgh'],
      }),
    ).toBe(2)
    expect(
      estimateNextRequestTokens({ model: 'anthropic/claude-sonnet-5', since: ['abcdefgh'] }),
    ).toBe(2)
  })

  it('falls back when the previous request summarized history', () => {
    expect(
      estimateNextRequestTokens({
        model: 'anthropic/claude-sonnet-5',
        previous: previous({ purpose: 'summary' }),
        since: ['abcd'],
      }),
    ).toBe(1)
  })

  it('falls back when the previous request ran on another model', () => {
    expect(
      estimateNextRequestTokens({
        model: 'openai/gpt-5',
        previous: previous(),
        since: ['abcd'],
      }),
    ).toBe(1)
    // A span start from before D9 carries no model, and an unknown model is no model.
    expect(
      estimateNextRequestTokens({
        model: 'anthropic/claude-sonnet-5',
        previous: previous({ model: null }),
        since: ['abcd'],
      }),
    ).toBe(1)
  })

  it('falls back when a rewind superseded the previous request', () => {
    expect(
      estimateNextRequestTokens({
        model: 'anthropic/claude-sonnet-5',
        previous: previous({ superseded: true }),
        since: ['abcd'],
      }),
    ).toBe(1)
  })

  it('is zero for an empty context with no baseline', () => {
    expect(estimateNextRequestTokens({ model: 'anthropic/claude-sonnet-5', since: [] })).toBe(0)
  })
})
