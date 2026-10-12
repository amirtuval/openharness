import { describe, expect, it } from 'vitest'

import { LocalDaySchema } from '../common'
import { SessionUsageSchema, UserUsageQuerySchema, UserUsageSchema } from './usage'

const totals = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 400,
}

const entry = {
  model: 'anthropic/claude-sonnet-5',
  usage: totals,
  requests: 2,
  cost: 0.0045,
  unpriced_requests: 0,
}

describe('SessionUsageSchema', () => {
  it('parses totals with their per-model breakdown and their costs', () => {
    const usage = {
      session_id: 'sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7',
      totals,
      cost: 0.0045,
      unpriced_requests: 0,
      by_model: [entry],
      searches: 0,
    }
    expect(SessionUsageSchema.parse(usage)).toEqual(usage)
  })

  it('parses a total that sums the priced requests and names the unpriced ones', () => {
    // A session that ran a priced model and an unpriced one (#247, decided 2026-10-09): the
    // total is what the priced requests came to, and `unpriced_requests` is how many were left
    // out — never a `null` whole answer, and never an estimate folded into the number.
    const usage = {
      session_id: 'sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7',
      totals,
      cost: 0.0045,
      unpriced_requests: 3,
      by_model: [entry, { ...entry, model: 'acme/mystery-1', cost: null, unpriced_requests: 3 }],
      searches: 2,
    }
    expect(SessionUsageSchema.parse(usage)).toEqual(usage)
  })

  it('takes a null cost for a total with nothing priced, and counts what was left out', () => {
    // The `null` of #245 kept its meaning — nothing here could be priced — but it is no longer
    // the answer to a single unpriced request in a total that also holds priced ones.
    const parsed = SessionUsageSchema.parse({
      session_id: 'sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7',
      totals,
      cost: null,
      unpriced_requests: 1,
      by_model: [{ ...entry, cost: null, unpriced_requests: 1 }],
      searches: 0,
    })
    expect(parsed.cost).toBeNull()
    expect(parsed.unpriced_requests).toBe(1)
    expect(parsed.by_model[0]?.cost).toBeNull()
    expect(parsed.by_model[0]?.usage.input_tokens).toBe(1000)
  })

  it('parses a session nothing has run on: zeros, no models, no cost', () => {
    const totalsZero = { ...totals, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }
    expect(
      SessionUsageSchema.parse({
        session_id: 'sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7',
        totals: totalsZero,
        cost: null,
        unpriced_requests: 0,
        by_model: [],
        searches: 0,
      }),
    ).toMatchObject({ cost: null, unpriced_requests: 0, by_model: [], searches: 0 })
  })

  it('refuses a negative count, a fractional request count and a negative cost', () => {
    const base = {
      session_id: 'sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7',
      totals,
      cost: 0,
      unpriced_requests: 0,
      by_model: [],
      searches: 0,
    }
    expect(SessionUsageSchema.safeParse({ ...base, cost: -1 }).success).toBe(false)
    expect(SessionUsageSchema.safeParse({ ...base, unpriced_requests: -1 }).success).toBe(false)
    expect(SessionUsageSchema.safeParse({ ...base, unpriced_requests: 0.5 }).success).toBe(false)
    expect(
      SessionUsageSchema.safeParse({
        ...base,
        by_model: [{ ...entry, requests: 1.5 }],
      }).success,
    ).toBe(false)
    expect(
      SessionUsageSchema.safeParse({ ...base, by_model: [{ ...entry, model: '' }] }).success,
    ).toBe(false)
  })
})

describe('UserUsageSchema', () => {
  it('parses a range with its models and its days', () => {
    const usage = {
      from: '2026-10-01',
      to: '2026-10-08',
      tz: 'Asia/Kolkata',
      totals,
      cost: 0.0045,
      unpriced_requests: 0,
      by_model: [entry],
      by_day: [{ day: '2026-10-08', totals, cost: 0.0045, unpriced_requests: 0, searches: 1 }],
      searches: 1,
    }
    expect(UserUsageSchema.parse(usage)).toEqual(usage)
  })

  it('refuses a day that is not a calendar day', () => {
    const usage = {
      from: '2026-10-01',
      to: '2026-10-08',
      tz: 'UTC',
      totals,
      cost: null,
      unpriced_requests: 0,
      by_model: [],
      by_day: [
        { day: '2026-10-08T10:00:00Z', totals, cost: null, unpriced_requests: 0, searches: 0 },
      ],
      searches: 0,
    }
    expect(UserUsageSchema.safeParse(usage).success).toBe(false)
  })
})

describe('UserUsageQuerySchema', () => {
  it('takes an empty query: the defaults are the server’s', () => {
    expect(UserUsageQuerySchema.parse({})).toEqual({})
  })

  it('takes a range and a zone', () => {
    expect(
      UserUsageQuerySchema.parse({ from: '2026-10-01', to: '2026-10-08', tz: 'Asia/Kolkata' }),
    ).toEqual({ from: '2026-10-01', to: '2026-10-08', tz: 'Asia/Kolkata' })
  })

  it('refuses what is not a real calendar day', () => {
    // The shape check is the calendar's, not the zone's: the day exists or it does not, and a
    // zone only decides which instants it covers. `2026-02-30` is not a day anywhere.
    expect(UserUsageQuerySchema.safeParse({ from: '2026-02-30' }).success).toBe(false)
    expect(UserUsageQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(false)
    expect(UserUsageQuerySchema.safeParse({ tz: '' }).success).toBe(false)
  })
})

describe('LocalDaySchema', () => {
  it('is a bare calendar day, with no zone of its own', () => {
    expect(LocalDaySchema.parse('2026-10-08')).toBe('2026-10-08')
    for (const value of ['2026-10-08T00:00:00Z', '08/10/2026', '2026-1-8']) {
      expect(LocalDaySchema.safeParse(value).success, value).toBe(false)
    }
  })
})
