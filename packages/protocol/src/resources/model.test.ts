import { describe, expect, it } from 'vitest'

import {
  ListModelsQuerySchema,
  ListModelsResponseSchema,
  ModelEntrySchema,
  ProviderCatalogStatusSchema,
} from './model'

const entry = {
  id: 'anthropic/claude-sonnet-5',
  provider: 'anthropic',
  name: 'Claude Sonnet 5',
  context_window: 200_000,
  max_output_tokens: 64_000,
  source: 'provider',
}

const status = {
  provider: 'anthropic',
  status: 'ok',
  fetched_at: '2026-03-15T10:00:00Z',
  message: null,
}

describe('ModelEntrySchema', () => {
  it('parses an entry, with nulls for metadata neither side knows', () => {
    expect(ModelEntrySchema.parse(entry)).toEqual(entry)
    expect(
      ModelEntrySchema.parse({
        ...entry,
        context_window: null,
        max_output_tokens: null,
        source: 'registry',
      }),
    ).toMatchObject({ context_window: null, max_output_tokens: null, source: 'registry' })
  })

  it('accepts exactly the two sources', () => {
    expect(ModelEntrySchema.safeParse({ ...entry, source: 'registry' }).success).toBe(true)
    for (const source of ['mastra', 'anthropic', '']) {
      expect(ModelEntrySchema.safeParse({ ...entry, source }).success, source).toBe(false)
    }
  })

  it('requires every field, nullable ones included', () => {
    for (const field of [
      'id',
      'provider',
      'name',
      'context_window',
      'max_output_tokens',
      'source',
    ] as const) {
      const { [field]: _dropped, ...partial } = entry
      expect(ModelEntrySchema.safeParse(partial).success, `without ${field}`).toBe(false)
    }
  })

  it('rejects an empty id, provider or name, and token counts that are not counts', () => {
    expect(ModelEntrySchema.safeParse({ ...entry, id: '' }).success).toBe(false)
    expect(ModelEntrySchema.safeParse({ ...entry, provider: '' }).success).toBe(false)
    expect(ModelEntrySchema.safeParse({ ...entry, name: '' }).success).toBe(false)
    expect(ModelEntrySchema.safeParse({ ...entry, context_window: '200k' }).success).toBe(false)
    expect(ModelEntrySchema.safeParse({ ...entry, max_output_tokens: -1 }).success).toBe(false)
    expect(ModelEntrySchema.safeParse({ ...entry, context_window: 1.5 }).success).toBe(false)
  })
})

describe('ProviderCatalogStatusSchema', () => {
  it('parses both statuses: ok with a fetch time, fallback with the reason', () => {
    expect(ProviderCatalogStatusSchema.parse(status)).toEqual(status)
    const fallback = {
      provider: 'openai',
      status: 'fallback',
      fetched_at: null,
      message: 'The provider model list timed out.',
    }
    expect(ProviderCatalogStatusSchema.parse(fallback)).toEqual(fallback)
    expect(ProviderCatalogStatusSchema.parse({ ...fallback, message: null }).message).toBeNull()
  })

  it('rejects an unknown status and a malformed fetched_at', () => {
    for (const value of ['cached', 'error', '']) {
      expect(ProviderCatalogStatusSchema.safeParse({ ...status, status: value }).success).toBe(
        false,
      )
    }
    expect(ProviderCatalogStatusSchema.safeParse({ ...status, fetched_at: 'now' }).success).toBe(
      false,
    )
    expect(ProviderCatalogStatusSchema.safeParse({ ...status, fetched_at: 2026 }).success).toBe(
      false,
    )
  })

  it('requires every field, nullable ones included', () => {
    for (const field of ['provider', 'status', 'fetched_at', 'message'] as const) {
      const { [field]: _dropped, ...partial } = status
      expect(ProviderCatalogStatusSchema.safeParse(partial).success, `without ${field}`).toBe(false)
    }
  })
})

describe('ListModelsResponseSchema', () => {
  it('parses the catalog, and the empty one an account with no keys sees', () => {
    expect(ListModelsResponseSchema.parse({ data: [entry], providers: [status] })).toEqual({
      data: [entry],
      providers: [status],
    })
    expect(ListModelsResponseSchema.parse({ data: [], providers: [] })).toEqual({
      data: [],
      providers: [],
    })
  })

  it('rejects a missing or non-array data or providers', () => {
    expect(ListModelsResponseSchema.safeParse({}).success).toBe(false)
    expect(ListModelsResponseSchema.safeParse({ data: [entry] }).success).toBe(false)
    expect(ListModelsResponseSchema.safeParse({ data: {}, providers: [] }).success).toBe(false)
    expect(ListModelsResponseSchema.safeParse({ data: [entry], providers: {} }).success).toBe(false)
    expect(ListModelsResponseSchema.safeParse([entry]).success).toBe(false)
  })

  it('rejects an entry or a status that does not parse inside the arrays', () => {
    expect(
      ListModelsResponseSchema.safeParse({ data: [{ ...entry, source: 'live' }], providers: [] })
        .success,
    ).toBe(false)
    expect(
      ListModelsResponseSchema.safeParse({ data: [], providers: [{ ...status, status: 'stale' }] })
        .success,
    ).toBe(false)
  })
})

describe('ListModelsQuerySchema', () => {
  it('reads refresh as a boolean, and omitting it as undefined', () => {
    expect(ListModelsQuerySchema.parse({ refresh: true })).toEqual({ refresh: true })
    expect(ListModelsQuerySchema.parse({ refresh: false })).toEqual({ refresh: false })
    expect(ListModelsQuerySchema.parse({})).toEqual({})
    expect(ListModelsQuerySchema.parse({}).refresh).toBeUndefined()
  })

  it('accepts the text form a query string carries', () => {
    expect(ListModelsQuerySchema.parse({ refresh: 'true' })).toEqual({ refresh: true })
    expect(ListModelsQuerySchema.parse({ refresh: 'false' })).toEqual({ refresh: false })
  })

  it('rejects the spellings that are neither', () => {
    for (const value of ['1', 'yes', 'TRUE', '', 1]) {
      expect(ListModelsQuerySchema.safeParse({ refresh: value }).success, String(value)).toBe(false)
    }
  })

  it('strips unknown query parameters, like every object schema', () => {
    expect(ListModelsQuerySchema.parse({ refresh: 'true', limit: '5' })).toEqual({ refresh: true })
  })
})
