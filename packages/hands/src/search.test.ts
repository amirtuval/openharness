import { describe, expect, it } from 'vitest'

import {
  BRAVE_MAX_COUNT,
  BRAVE_SEARCH_ENDPOINT,
  createBraveSearchProvider,
  type SearchRequestInit,
  type SearchResponse,
  type SearchTransport,
} from './search'

/**
 * The Brave adapter (epic #303, #305).
 *
 * What a search API receives and what is read back out of its answer — against a stub
 * transport, so no test reaches the internet and the request itself is the assertion.
 */

/** A stub transport that answers with a canned response and records what it was asked for. */
function stub(answer: Partial<SearchResponse> & { json?: () => Promise<unknown> }): {
  transport: SearchTransport
  calls: { url: string; init: SearchRequestInit }[]
} {
  const calls: { url: string; init: SearchRequestInit }[] = []
  const transport: SearchTransport = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve({
      ok: answer.ok ?? true,
      status: answer.status ?? 200,
      json: answer.json ?? (() => Promise.resolve({})),
      text: () => Promise.resolve(''),
    })
  }
  return { transport, calls }
}

/** One Brave page of results, as the API sends it. */
function bravePayload(results: readonly Record<string, unknown>[]): () => Promise<unknown> {
  return () => Promise.resolve({ web: { results } })
}

describe('createBraveSearchProvider', () => {
  it('asks the fixed endpoint for the query, and authenticates with the operator’s key', async () => {
    const { transport, calls } = stub({ json: bravePayload([]) })
    const provider = createBraveSearchProvider({ transport })
    await provider.search({ query: 'openharness tools', count: 3, apiKey: 'brave-key' })
    expect(provider.name).toBe('brave')
    expect(calls).toHaveLength(1)
    const url = new URL(calls[0]?.url ?? '')
    expect(`${url.origin}${url.pathname}`).toBe(BRAVE_SEARCH_ENDPOINT)
    expect(url.searchParams.get('q')).toBe('openharness tools')
    expect(url.searchParams.get('count')).toBe('3')
    expect(calls[0]?.init.headers['x-subscription-token']).toBe('brave-key')
    expect(calls[0]?.init.headers.accept).toBe('application/json')
    // A deadline of the adapter's own, so a hung request ends even if the turn's signal never
    // fires — the registry's race is the other half.
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('reads title, URL and snippet out of the payload, in the provider’s order', async () => {
    const { transport } = stub({
      json: bravePayload([
        {
          title: 'One',
          url: 'https://one.example/',
          description: 'the <strong>first</strong>  one',
        },
        { title: 'Two', url: 'https://two.example/' },
      ]),
    })
    const provider = createBraveSearchProvider({ transport })
    const results = await provider.search({ query: 'q', count: 5, apiKey: 'k' })
    expect(results).toEqual([
      { title: 'One', url: 'https://one.example/', snippet: 'the first one' },
      // A result Brave sent with no description is still a result; it is shown without one.
      { title: 'Two', url: 'https://two.example/', snippet: '' },
    ])
  })

  it('caps the count at what Brave accepts, whatever the call asked for', async () => {
    const { transport, calls } = stub({ json: bravePayload([]) })
    await createBraveSearchProvider({ transport }).search({ query: 'q', count: 100, apiKey: 'k' })
    expect(new URL(calls[0]?.url ?? '').searchParams.get('count')).toBe(String(BRAVE_MAX_COUNT))
  })

  it('skips an entry a model could not go on', async () => {
    const { transport } = stub({
      json: bravePayload([
        { title: 'no url' },
        { url: '', title: 'empty url' },
        { url: 'https://kept.example/' },
      ]),
    })
    const results = await createBraveSearchProvider({ transport }).search({
      query: 'q',
      count: 5,
      apiKey: 'k',
    })
    expect(results).toEqual([
      { title: 'https://kept.example/', url: 'https://kept.example/', snippet: '' },
    ])
  })

  it('refuses a refusal, with what the provider said', async () => {
    const transport: SearchTransport = () =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('{"error":{"detail":"invalid api key"}}'),
      })
    await expect(
      createBraveSearchProvider({ transport }).search({ query: 'q', count: 1, apiKey: 'bad' }),
    ).rejects.toThrow(/401.*invalid api key/)
  })

  it('refuses a payload that is not a page of results', async () => {
    // "Brave refused us" and "nothing on the web matched" are different answers, so a shape
    // this adapter does not recognise is an error rather than an empty list.
    for (const payload of [{}, { web: {} }, { web: { results: null } }, null]) {
      const { transport } = stub({ json: () => Promise.resolve(payload) })
      await expect(
        createBraveSearchProvider({ transport }).search({ query: 'q', count: 1, apiKey: 'k' }),
      ).rejects.toThrow(/web results list/)
    }
  })

  it('reaches an endpoint a deployment names instead of Brave’s', async () => {
    const { transport, calls } = stub({ json: bravePayload([]) })
    await createBraveSearchProvider({ transport, endpoint: 'https://search.internal/api' }).search({
      query: 'q',
      count: 1,
      apiKey: 'k',
    })
    expect(calls[0]?.url).toBe('https://search.internal/api?q=q&count=1')
  })
})
