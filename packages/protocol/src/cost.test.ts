import { describe, expect, it } from 'vitest'

import { totalCost, usageCost } from './cost'
import type { ModelCost } from './resources/model'
import type { ModelUsage } from './events/span'

/** A usage the counters of which a test can set one at a time. */
function usage(overrides: Partial<ModelUsage> = {}): ModelUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...overrides,
  }
}

/** Claude Sonnet 5's real rates, in USD per million tokens. */
const SONNET: ModelCost = { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 }

describe('usageCost', () => {
  it('prices each counter at its own rate, per million tokens', () => {
    // 1M of each: the prices read straight off the rates.
    const million = usage({
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    })
    expect(usageCost(million, SONNET)).toBeCloseTo(2 + 10 + 2.5 + 0.2, 10)
  })

  it('prices a real request', () => {
    // 1,000 in, 200 out, no cache: $0.002 + $0.002.
    expect(usageCost(usage({ input_tokens: 1000, output_tokens: 200 }), SONNET)).toBeCloseTo(
      0.004,
      10,
    )
  })

  it('prices cache tokens separately, not as a fraction of the input rate', () => {
    // A read token is a tenth of an input token here, a write token more than one — which is
    // the whole reason the rates are separate rather than derived.
    const cached = usage({
      input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    })
    expect(usageCost(cached, SONNET)).toBeCloseTo(2 + 0.2 + 2.5, 10)
  })

  it('is zero for a request that reported nothing', () => {
    expect(usageCost(usage(), SONNET)).toBe(0)
  })

  it('is unknown when the model has no price at all', () => {
    expect(usageCost(usage({ input_tokens: 1000 }), null)).toBeNull()
  })

  it('ignores a missing rate for a counter that is zero', () => {
    // The common real shape: models.dev prices input and output for almost every model but
    // cache rates for far fewer. A request that used no cache tokens is still priceable.
    const noCacheRates: ModelCost = { input: 3, output: 15, cache_read: null, cache_write: null }
    expect(usageCost(usage({ input_tokens: 1000, output_tokens: 100 }), noCacheRates)).toBeCloseTo(
      0.0045,
      10,
    )
  })

  it('is unknown when a counter with no published rate is not zero', () => {
    // Something really was spent on cache writes and nobody published a rate: charging nothing
    // for them would understate the bill, so the cost is unknown rather than lower (#245: cost
    // is never estimated).
    const noCacheRates: ModelCost = { input: 3, output: 15, cache_read: null, cache_write: null }
    expect(
      usageCost(usage({ input_tokens: 1000, cache_creation_input_tokens: 500 }), noCacheRates),
    ).toBeNull()
    expect(
      usageCost(usage({ input_tokens: 1000, cache_read_input_tokens: 1 }), noCacheRates),
    ).toBeNull()
  })

  it('prices a free model as zero', () => {
    const free: ModelCost = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
    expect(usageCost(usage({ input_tokens: 100, output_tokens: 100 }), free)).toBe(0)
  })
})

describe('totalCost', () => {
  it('adds every part up, and counts nothing unpriced', () => {
    expect(totalCost([0.002, 0.5, 1])).toEqual({ cost: 1.502, unpriced_requests: 0 })
  })

  it('sums the priced parts and counts the unpriced ones', () => {
    // The 2026-10-09 decision (#247): one request nobody prices no longer makes the whole total
    // unreadable — the priced part is the money, and the unknown part is named beside it.
    expect(totalCost([0.002, null, 1])).toEqual({ cost: 1.002, unpriced_requests: 1 })
    expect(totalCost([null, 0.5, null])).toEqual({ cost: 0.5, unpriced_requests: 2 })
  })

  it('is unknown, naming what it left out, when nothing in it is priced', () => {
    expect(totalCost([null])).toEqual({ cost: null, unpriced_requests: 1 })
    expect(totalCost([null, null])).toEqual({ cost: null, unpriced_requests: 2 })
  })

  it('is unknown, with nothing left out, for an empty set', () => {
    expect(totalCost([])).toEqual({ cost: null, unpriced_requests: 0 })
  })

  it('is zero when every part is a real zero', () => {
    expect(totalCost([0, 0])).toEqual({ cost: 0, unpriced_requests: 0 })
  })
})
