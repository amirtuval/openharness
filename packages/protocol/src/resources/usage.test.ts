import { describe, expect, it } from 'vitest'

import { LocalDaySchema } from '../common'
import { SessionUsageSchema, UserUsageQuerySchema, UserUsageSchema } from './usage'

const totals = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 400,
}

const entry = { model: 'anthropic/claude-sonnet-5', usage: totals, requests: 2, cost: 0.0045 }

describe('SessionUsageSchema', () => {
  it('parses totals with their per-model breakdown and their costs', () => {
    const usage = {
      session_id: 'sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7',
      totals,
      cost: 0.0045,
      by_model: [entry],
    }
    expect(SessionUsageSchema.parse(usage)).toEqual(usage)
  })

  it('takes a null cost for a model nobody published a price for', () => {
    // The whole point of `null` (#245): the tokens are there, the money is not known, and the
    // total is unknown with them.
    const parsed = SessionUsageSchema.parse({
      session_id: 'sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7',
      totals,
      cost: null,
      by_model: [{ ...entry, cost: null }],
    })
    expect(parsed.cost).toBeNull()
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
        by_model: [],
      }),
    ).toMatchObject({ cost: null, by_model: [] })
  })

  it('refuses a negative count, a fractional request count and a negative cost', () => {
    const base = { session_id: 'sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7', totals, cost: 0, by_model: [] }
    expect(SessionUsageSchema.safeParse({ ...base, cost: -1 }).success).toBe(false)
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
      by_model: [entry],
      by_day: [{ day: '2026-10-08', totals, cost: 0.0045 }],
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
      by_model: [],
      by_day: [{ day: '2026-10-08T10:00:00Z', totals, cost: null }],
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
