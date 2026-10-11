import { describe, expect, it } from 'vitest'

import { createToolRegistry } from './registry'
import type { SearchProvider, SearchRequest, SearchResult } from './search'
import {
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  WEB_SEARCH_API_KEY,
  WEB_SEARCH_TOOL_NAME,
  createWebSearchTool,
} from './web-search'

/**
 * `web_search` (epic #303, #305).
 *
 * The tool's own half: what it renders, what it does with no key in the turn's values (the
 * daily allowance being used up), what a failing provider becomes, and what its schema refuses.
 * The provider is a stub — the adapter has its own suite (`search.test.ts`).
 */

/** A provider that answers canned results and records the requests it was asked for. */
function provider(answer: readonly SearchResult[] | Error): {
  provider: SearchProvider
  requests: SearchRequest[]
} {
  const requests: SearchRequest[] = []
  return {
    provider: {
      name: 'brave',
      search: (request) => {
        requests.push(request)
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
      },
    },
    requests,
  }
}

/** One call through the real registry, with the per-user values the host would inject. */
async function call(
  options: Parameters<typeof createWebSearchTool>[0],
  input: unknown,
  secrets: Readonly<Record<string, string>>,
): Promise<{ text: string; isError: boolean }> {
  const registry = createToolRegistry([createWebSearchTool(options)])
  const result = await registry.execute(WEB_SEARCH_TOOL_NAME, input, { secrets })
  return {
    text: result.content.map((block) => block.text).join(''),
    isError: result.isError === true,
  }
}

const RESULTS: SearchResult[] = [
  { title: 'First', url: 'https://one.example/', snippet: 'about one' },
  { title: 'Second', url: 'https://two.example/', snippet: '' },
]

describe('createWebSearchTool', () => {
  it('renders the results it was handed, numbered, with their URLs', async () => {
    const { provider: search } = provider(RESULTS)
    const result = await call(
      { provider: search, dailyLimit: 20 },
      { query: 'tools' },
      {
        [WEB_SEARCH_API_KEY]: 'key',
      },
    )
    expect(result.isError).toBe(false)
    expect(result.text).toContain('Results for "tools" (2)')
    expect(result.text).toContain('1. First — https://one.example/')
    expect(result.text).toContain('about one')
    expect(result.text).toContain('2. Second — https://two.example/')
  })

  it('asks for the default count, and never for more than the cap', async () => {
    const withDefault = provider(RESULTS)
    await call(
      { provider: withDefault.provider, dailyLimit: 20 },
      { query: 'q' },
      {
        [WEB_SEARCH_API_KEY]: 'k',
      },
    )
    expect(withDefault.requests[0]?.count).toBe(DEFAULT_SEARCH_COUNT)

    const clamped = provider(RESULTS)
    await call(
      { provider: clamped.provider, dailyLimit: 20 },
      { query: 'q', count: 3 },
      {
        [WEB_SEARCH_API_KEY]: 'k',
      },
    )
    expect(clamped.requests[0]?.count).toBe(3)

    const named = provider(RESULTS)
    await call(
      { provider: named.provider, dailyLimit: 20, defaultCount: 2 },
      { query: 'q' },
      {
        [WEB_SEARCH_API_KEY]: 'k',
      },
    )
    expect(named.requests[0]?.count).toBe(2)
  })

  it('hands the provider the operator’s key, per call', async () => {
    const { provider: search, requests } = provider(RESULTS)
    await call(
      { provider: search, dailyLimit: 20 },
      { query: 'q' },
      {
        [WEB_SEARCH_API_KEY]: 'operator-key',
      },
    )
    expect(requests[0]?.apiKey).toBe('operator-key')
  })

  it('answers with the allowance notice when the turn carries no key', async () => {
    // The host withholds the key exactly when the day's allowance is used up, which is the one
    // reason a registered search tool is handed none (see the tool's TSDoc).
    const { provider: search, requests } = provider(RESULTS)
    const result = await call({ provider: search, dailyLimit: 7 }, { query: 'q' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Search limit reached')
    expect(result.text).toContain('7')
    expect(result.text).toContain('tomorrow')
    expect(requests).toHaveLength(0)
  })

  it('answers a failing provider with an is_error result, not a throw', async () => {
    const { provider: search } = provider(new Error('brave answered 429: slow down'))
    const result = await call(
      { provider: search, dailyLimit: 20 },
      { query: 'q' },
      {
        [WEB_SEARCH_API_KEY]: 'k',
      },
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Search failed')
    expect(result.text).toContain('429')
  })

  it('says so when the provider found nothing', async () => {
    const { provider: search } = provider([])
    const result = await call(
      { provider: search, dailyLimit: 20 },
      { query: 'nothing at all' },
      {
        [WEB_SEARCH_API_KEY]: 'k',
      },
    )
    expect(result.isError).toBe(false)
    expect(result.text).toContain('No results')
  })

  it('refuses input its schema does not match, naming the field', async () => {
    const { provider: search, requests } = provider(RESULTS)
    const options = { provider: search, dailyLimit: 20 }
    const missing = await call(options, { count: 3 }, { [WEB_SEARCH_API_KEY]: 'k' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('query')

    const zero = await call(options, { query: 'q', count: 0 }, { [WEB_SEARCH_API_KEY]: 'k' })
    expect(zero.isError).toBe(true)

    const tooMany = await call(
      options,
      { query: 'q', count: MAX_SEARCH_COUNT + 1 },
      {
        [WEB_SEARCH_API_KEY]: 'k',
      },
    )
    expect(tooMany.isError).toBe(true)
    expect(requests).toHaveLength(0)
  })
})
