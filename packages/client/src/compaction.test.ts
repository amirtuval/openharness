import { makeModelEntry } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import { modelContextBudget, summaryModelFallback } from './compaction'

/**
 * The pass math behind the Settings → Context warning (epic #277, C3; #282).
 *
 * The numbers are exact, so the assertions are arithmetic rather than a snapshot of whatever
 * the mirror happens to compute: a 200k chat model with an 8k ceiling has a 192k budget, and a
 * 8k summarizer with a 2k ceiling folds 3k tokens a pass.
 */

describe('modelContextBudget (#246)', () => {
  it('subtracts the model’s own output ceiling when it is under a quarter of the window', () => {
    expect(modelContextBudget(model(200_000, 8_000))).toBe(192_000)
  })

  it('subtracts a quarter of the window when the ceiling is larger, or when there is none', () => {
    // 25% of 200k is 50k, so a 100k ceiling reserves the quarter and not itself, and a model
    // that declares no ceiling reserves exactly the same quarter.
    expect(modelContextBudget(model(200_000, 100_000))).toBe(150_000)
    expect(modelContextBudget(model(200_000, null))).toBe(150_000)
  })

  it('answers null for a model the catalog gives no window', () => {
    expect(modelContextBudget(model(null, 8_000))).toBeNull()
    expect(modelContextBudget(model(0, 8_000))).toBeNull()
  })
})

describe('summaryModelFallback (epic #277, K5; #282)', () => {
  /** A 200k chat model and an 80k summarizer, with the default limit of three passes. */
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

  it('says nothing when either model’s window is unknown, because the math cannot', () => {
    expect(summaryModelFallback({ chat, summary: model(null, 2_000), maxPasses: 1 })).toBeNull()
    expect(
      summaryModelFallback({ chat: model(null, null), summary: chat, maxPasses: 1 }),
    ).toBeNull()
  })
})

/** A catalog entry carrying just the two limits the math reads. */
function model(
  contextWindow: number | null,
  maxOutput: number | null,
): ReturnType<typeof makeModelEntry> {
  return makeModelEntry({ context_window: contextWindow, max_output_tokens: maxOutput })
}
