import { makeGetPreferencesResponse, makeModelEntry } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import {
  CHARS_PER_TOKEN,
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  OUTPUT_RESERVE_RATIO,
  COMPACTING_LABEL,
  compactionThreshold,
  contextAfterSummary,
  contextMeter,
  contextTokenBudget,
  estimateTokens,
  manualCompactionNotice,
  modelContextBudget,
  summaryModelFallback,
  summaryDescription,
} from './compaction'
import type { TranscriptSummary } from './transcript'

/**
 * The meter's arithmetic (#280): the per-model budget, the share compaction fires at, the words
 * both frontends draw, and the estimate a summary leaves behind.
 *
 * The budget rule is the server's (#246, `apps/server/src/catalog/context-budget.ts`) restated
 * for the frontends, so the cases here are the ones that pin the restatement: a declared output
 * ceiling under the reserve, none at all, and a declared one that would take more than the
 * reserve (which it may not).
 */
describe('contextTokenBudget (#246, #280)', () => {
  it('takes the model’s own output ceiling when it is under the reserve', () => {
    expect(contextTokenBudget({ contextWindow: 200_000, maxOutput: 4_096 })).toBe(195_904)
  })

  it('reserves a quarter of the window when the model declares no ceiling', () => {
    const window = 200_000
    expect(contextTokenBudget({ contextWindow: window })).toBe(
      window - Math.floor(window * OUTPUT_RESERVE_RATIO),
    )
  })

  it('never reserves more than the quarter, however large the declared ceiling is', () => {
    expect(contextTokenBudget({ contextWindow: 100_000, maxOutput: 90_000 })).toBe(75_000)
  })

  it('measures a model with no window like any other unknown model', () => {
    expect(modelContextBudget(null)).toBe(DEFAULT_CONTEXT_TOKEN_BUDGET)
    expect(modelContextBudget(undefined)).toBe(DEFAULT_CONTEXT_TOKEN_BUDGET)
    expect(modelContextBudget({ context_window: null, max_output_tokens: null })).toBe(
      DEFAULT_CONTEXT_TOKEN_BUDGET,
    )
  })

  it('measures a catalog entry by its limits', () => {
    expect(modelContextBudget({ context_window: 128_000, max_output_tokens: 4_096 })).toBe(123_904)
    expect(modelContextBudget({ context_window: 128_000, max_output_tokens: null })).toBe(96_000)
  })

  it('takes the budget the server reports over one derived from the window (#280)', () => {
    // The server's `context_budget` is the number the brain really trims to. It differs from
    // the window rule exactly where it must: a model the registry does not know — a custom
    // endpoint, an Azure deployment under a named credential — is trimmed to the fallback even
    // though its window may describe something far larger, so a meter reading the window would
    // be measuring against a budget no request has.
    expect(
      modelContextBudget({
        context_window: 400_000,
        max_output_tokens: null,
        context_budget: DEFAULT_CONTEXT_TOKEN_BUDGET,
      }),
    ).toBe(DEFAULT_CONTEXT_TOKEN_BUDGET)
    // When the two agree, nothing changes.
    expect(
      modelContextBudget({
        context_window: 200_000,
        max_output_tokens: 8_000,
        context_budget: 192_000,
      }),
    ).toBe(192_000)
  })

  it('ignores a reported budget that could not be one', () => {
    // A response from a server that predates the field, or a nonsense zero: the window rule is
    // the fallback rather than a budget of nothing.
    expect(
      modelContextBudget({ context_window: 128_000, max_output_tokens: 4_096, context_budget: 0 }),
    ).toBe(123_904)
  })
})

describe('compactionThreshold (#277, C3; #280)', () => {
  it('reads the caller’s stored share when they chose one', () => {
    expect(compactionThreshold(makeGetPreferencesResponse({ compaction_threshold: 0.5 }))).toBe(0.5)
    expect(compactionThreshold(makeGetPreferencesResponse({ compaction_threshold: 0.95 }))).toBe(
      0.95,
    )
  })

  it('follows the share the server reports for a caller who chose none (#282)', () => {
    // `null` is "follow the deployment's", and a deployment may set its own — so the number
    // comes from the response's `defaults`, not from a constant of this package's.
    expect(
      compactionThreshold(
        makeGetPreferencesResponse({ compaction_threshold: null }, { compaction_threshold: 0.85 }),
      ),
    ).toBe(0.85)
    expect(compactionThreshold(makeGetPreferencesResponse({ compaction_threshold: null }))).toBe(
      DEFAULT_COMPACTION_THRESHOLD,
    )
  })

  it('falls back to 0.7 only when there are no preferences at all', () => {
    // A failed read, or a server that predates `GET /v1/me/preferences`: nothing to read.
    expect(compactionThreshold(null)).toBe(DEFAULT_COMPACTION_THRESHOLD)
    expect(compactionThreshold(undefined)).toBe(DEFAULT_COMPACTION_THRESHOLD)
  })
})

describe('contextMeter (#280)', () => {
  const model = { context_window: 100_000, max_output_tokens: 20_000 }

  it('is absent until something has measured a prompt', () => {
    expect(contextMeter(null, { model })).toBeNull()
  })

  it('says how full the context is, against the model’s budget', () => {
    // 100,000 − min(20,000, 25,000) = 80,000, so 49,600 is 62%.
    const meter = contextMeter({ tokens: 49_600, estimated: false }, { model })

    expect(meter).toMatchObject({
      budget: 80_000,
      ratio: 0.62,
      percent: 62,
      nearThreshold: false,
      estimated: false,
      label: '62% of context used',
      shortLabel: '62%',
    })
  })

  it('marks the context the chat compacts at', () => {
    const under = contextMeter({ tokens: 55_000, estimated: false }, { model })
    const at = contextMeter({ tokens: 56_000, estimated: false }, { model })
    const over = contextMeter({ tokens: 80_000, estimated: false }, { model })

    expect(under?.nearThreshold).toBe(false)
    // 56,000 / 80,000 is exactly 0.7, the default threshold.
    expect(at?.nearThreshold).toBe(true)
    expect(over?.nearThreshold).toBe(true)
    // Over the budget is a real state, not a capped one: the meter says 100%.
    expect(over?.percent).toBe(100)
  })

  it('takes the caller’s threshold when there is one', () => {
    const strict = contextMeter({ tokens: 24_000, estimated: false }, { model, threshold: 0.25 })

    expect(strict?.nearThreshold).toBe(true)
    expect(strict?.threshold).toBe(0.25)
  })

  it('says when the number is an estimate', () => {
    const meter = contextMeter({ tokens: 49_600, estimated: true }, { model })

    expect(meter).toMatchObject({
      estimated: true,
      label: '~62% of context used',
      shortLabel: '~62%',
    })
  })

  it('measures against the default budget for a model the catalog does not carry', () => {
    const meter = contextMeter({ tokens: 16_384, estimated: false }, {})

    expect(meter).toMatchObject({
      budget: DEFAULT_CONTEXT_TOKEN_BUDGET,
      percent: 50,
      label: '50% of context used',
    })
  })

  it('measures against the model it is handed, so a switch moves the meter', () => {
    const wide = contextMeter({ tokens: 49_600, estimated: false }, { model })
    const narrow = contextMeter(
      { tokens: 49_600, estimated: false },
      { model: { context_window: 64_000, max_output_tokens: 8_192 } },
    )

    expect(wide?.percent).toBe(62)
    // 64,000 − 8,192 = 55,808: the same context is 89% of a narrower model.
    expect(narrow?.percent).toBe(89)
    expect(narrow?.nearThreshold).toBe(true)
  })
})

describe('estimateTokens (#280)', () => {
  it('estimates at the same characters-per-token the budget is measured in', () => {
    expect(CHARS_PER_TOKEN).toBe(4)
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })
})

describe('contextAfterSummary (#280)', () => {
  it('takes the covered history out of the baseline and puts the summary back', () => {
    // 800 characters covered (200 tokens) replaced by five (2): the baseline drops by 198.
    expect(
      contextAfterSummary({ baseline: 1_000, summary: 'short', coveredText: 'x'.repeat(800) }),
    ).toBe(802)
  })

  it('is never smaller than the summary the model is told', () => {
    // The estimate would go below the summary itself — the covered text may over-count against
    // the provider's own tokenizer — and the floor is what the prompt at least holds.
    const tokens = contextAfterSummary({
      baseline: 10,
      summary: 'y'.repeat(400),
      coveredText: 'x'.repeat(4_000),
    })

    expect(tokens).toBe(100)
  })

  it('adds the summary when the covered conversation is not in the transcript', () => {
    // A client that joined after the history it covers sees nothing to subtract: the estimate
    // errs high, which is the safe direction for a meter whose job is to warn early.
    expect(contextAfterSummary({ baseline: 5_000, summary: 'short', coveredText: '' })).toBe(5_002)
  })
})

describe('summaryDescription (#280)', () => {
  const summary = (overrides: Partial<TranscriptSummary> = {}): TranscriptSummary => ({
    id: 'sevt_1',
    summary: 'text',
    reason: 'threshold',
    model: 'anthropic/claude-sonnet-5',
    passes: 1,
    tokensBefore: 1_000,
    position: 4,
    seq: 5,
    ...overrides,
  })

  it('calls the automatic reason what a reader calls it', () => {
    expect(summaryDescription(summary())).toBe('automatic · anthropic/claude-sonnet-5 · 1 pass')
    expect(summaryDescription(summary({ passes: 3 }))).toBe(
      'automatic · anthropic/claude-sonnet-5 · 3 passes',
    )
  })

  it('names the two reasons a reader asked for', () => {
    expect(summaryDescription(summary({ reason: 'overflow' }))).toContain('overflow')
    expect(summaryDescription(summary({ reason: 'manual' }))).toContain('manual')
  })
})

/**
 * The pass math behind the Settings → Context warning (epic #277, C3; #282).
 *
 * The numbers are exact, so the assertions are arithmetic rather than a snapshot of whatever
 * the mirror happens to compute: a 200k chat model with an 8k ceiling has a 192k budget, and a
 * 8k summarizer with a 2k ceiling folds 3k tokens a pass.
 */
describe('summaryModelFallback (epic #277, K5; #282)', () => {
  /** A 200k chat model with an 8k ceiling — the budget the example folds. */
  const chat = model(200_000, 8_000)

  it('flags a summarizer that cannot fold the chat budget in the allowed passes', () => {
    // summary budget 6000, so a pass folds 3000; folding 192000 takes 64 passes, over 3.
    const fallback = summaryModelFallback({ chat, summary: model(8_000, 2_000), maxPasses: 3 })

    expect(fallback).toEqual({
      chatBudget: 192_000,
      summaryBudget: 6_000,
      passesNeeded: 64,
      maxPasses: 3,
    })
  })

  it('says nothing for a summarizer that fits within the limit', () => {
    // A summarizer as wide as the chat model folds the 192k budget in two passes, and needing
    // exactly the limit (64) is not a warning either — only more than it is.
    expect(summaryModelFallback({ chat, summary: model(200_000, 8_000), maxPasses: 3 })).toBeNull()
    expect(summaryModelFallback({ chat, summary: model(8_000, 2_000), maxPasses: 64 })).toBeNull()
  })

  it('raises the limit that clears the warning, because the rule is the pass count', () => {
    // The same 8k/2k summarizer is fine at 64 passes and not at 63 — the boundary the rule
    // turns on, which a ratio of two windows could not express.
    const summary = model(8_000, 2_000)
    expect(summaryModelFallback({ chat, summary, maxPasses: 63 })).not.toBeNull()
    expect(summaryModelFallback({ chat, summary, maxPasses: 64 })).toBeNull()
  })

  it('sizes a model the catalog cannot window against the brain’s own fallback budget', () => {
    // A model with no window is what the server hands the brain as no budget at all, so both
    // sides fall back to DEFAULT_CONTEXT_TOKEN_BUDGET — the warning measures that number rather
    // than going silent, because it is the number the engine will really compact against.
    expect(summaryModelFallback({ chat, summary: model(null, 2_000), maxPasses: 1 })).toEqual({
      chatBudget: 192_000,
      summaryBudget: DEFAULT_CONTEXT_TOKEN_BUDGET,
      passesNeeded: Math.ceil(192_000 / Math.floor(DEFAULT_CONTEXT_TOKEN_BUDGET * 0.5)),
      maxPasses: 1,
    })
  })
})

/**
 * A catalog entry as the server would send it: the limits, and the `context_budget` they
 * resolve to (#280).
 *
 * The budget is what the meter reads, so a test of the pass math has to carry one — the window
 * rule is only the fallback for a response that predates the field. A model with no window is
 * what the server has nothing to derive from, so it reports the brain's own fallback.
 */
function model(
  contextWindow: number | null,
  maxOutput: number | null,
): ReturnType<typeof makeModelEntry> {
  return makeModelEntry({
    context_window: contextWindow,
    max_output_tokens: maxOutput,
    context_budget:
      contextWindow === null || contextWindow <= 0
        ? DEFAULT_CONTEXT_TOKEN_BUDGET
        : contextTokenBudget({
            contextWindow,
            ...(maxOutput === null ? {} : { maxOutput }),
          }),
  })
}

describe('the manual compaction’s words (#277, K8; #283)', () => {
  it('says “Compacting…” while the brain has not answered', () => {
    // One string for both frontends, so the terminal and the web word the same wait alike.
    expect(COMPACTING_LABEL).toBe('Compacting…')
  })

  it('needs no notice for a summary, because the divider is the outcome', () => {
    expect(manualCompactionNotice({ outcome: 'summarized' })).toBeNull()
    expect(manualCompactionNotice({ outcome: null })).toBeNull()
  })

  it('shows the brain’s own sentence when it sent one', () => {
    expect(
      manualCompactionNotice({ outcome: 'nothing_to_summarize', message: 'Nothing older yet.' }),
    ).toEqual({ tone: 'info', text: 'Nothing older yet.' })
    expect(manualCompactionNotice({ outcome: 'failed', message: 'The model refused.' })).toEqual({
      tone: 'error',
      text: 'The model refused.',
    })
  })

  it('falls back to a fixed sentence when it did not', () => {
    expect(manualCompactionNotice({ outcome: 'nothing_to_summarize' })).toEqual({
      tone: 'info',
      text: 'There was no older history to summarize.',
    })
    expect(manualCompactionNotice({ outcome: 'failed' })).toEqual({
      tone: 'error',
      text: 'The summary could not be written.',
    })
  })
})
