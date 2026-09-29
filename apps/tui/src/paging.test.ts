import { createFakeClient } from '@openharness/client/testing'
import { MAX_PAGE_LIMIT } from '@openharness/protocol'
import { makeAgent, makeSession } from '@openharness/protocol/fixtures'
import { describe, expect, it, vi } from 'vitest'

import { listAll, listAllAgents, listAllSessions, MAX_LIST_PAGES, type ListPage } from './paging'

/** A fetcher that answers from `pages`, and records the cursor each request carried. */
function pagingOver<T>(pages: readonly (readonly T[])[]) {
  const asked: (string | undefined)[] = []

  const fetchPage = (page: string | undefined): Promise<ListPage<T>> => {
    const index = page === undefined ? 0 : Number.parseInt(page, 10)
    asked.push(page)
    return Promise.resolve({
      data: pages[index] ?? [],
      next_page: index + 1 < pages.length ? String(index + 1) : null,
    })
  }

  return { fetchPage, asked }
}

describe('listAll', () => {
  it('returns the rows of every page, in order', async () => {
    const { fetchPage, asked } = pagingOver([['a', 'b'], ['c'], ['d', 'e', 'f']])

    const rows = await listAll(fetchPage)

    expect(rows).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(asked).toEqual([undefined, '1', '2'])
  })

  it('stops at a page that says there is no next one', async () => {
    const fetchPage = vi.fn((_page: string | undefined) =>
      Promise.resolve({ data: ['only'], next_page: null }),
    )

    expect(await listAll(fetchPage)).toEqual(['only'])
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('hands a cursor back byte for byte, without reading it', async () => {
    const cursors = ['page:2/token=abc', 'page:3/token=def']
    const asked: (string | undefined)[] = []
    const fetchPage = (page: string | undefined): Promise<ListPage<string>> => {
      asked.push(page)
      return Promise.resolve({ data: [String(page)], next_page: cursors[asked.length - 1] ?? null })
    }

    await listAll(fetchPage)

    expect(asked).toEqual([undefined, ...cursors])
  })

  it('stops rather than repeating a page the server hands back again', async () => {
    const fetchPage = vi.fn(() =>
      Promise.resolve({ data: ['x'], next_page: 'the-same-cursor-again' }),
    )

    expect(await listAll(fetchPage)).toEqual(['x', 'x'])
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('fails at the cap rather than returning part of the list', async () => {
    let answer = 0
    const fetchPage = vi.fn(() => {
      answer += 1
      return Promise.resolve({ data: [], next_page: `cursor-${String(answer)}` })
    })

    await expect(listAll(fetchPage)).rejects.toThrow(/more than 1000 pages/u)
    expect(fetchPage).toHaveBeenCalledTimes(MAX_LIST_PAGES)
  })
})

/** The `limit` and `page` a list request was made with. */
type ListParams = { readonly limit?: number | undefined; readonly page?: string | undefined }

describe('listAllAgents', () => {
  it('asks for the largest page the protocol allows, and follows the cursor', async () => {
    const fake = createFakeClient()
    const asked: (ListParams | undefined)[] = []
    const client = {
      ...fake,
      agents: {
        ...fake.agents,
        list: (params?: ListParams) => {
          asked.push(params)
          return Promise.resolve({
            data: [makeAgent({ name: 'Summarizer' })],
            next_page: asked.length === 1 ? 'next' : null,
          })
        },
      },
    }

    const agents = await listAllAgents(client)

    expect(asked).toEqual([
      { limit: MAX_PAGE_LIMIT, page: undefined },
      { limit: MAX_PAGE_LIMIT, page: 'next' },
    ])
    expect(agents).toHaveLength(2)
  })
})

describe('listAllSessions', () => {
  it('asks for the largest page the protocol allows, and follows the cursor', async () => {
    const fake = createFakeClient()
    const asked: (ListParams | undefined)[] = []
    const client = {
      ...fake,
      sessions: {
        ...fake.sessions,
        list: (params?: ListParams) => {
          asked.push(params)
          return Promise.resolve({
            data: [makeSession({ title: 'A chat' })],
            next_page: asked.length === 1 ? 'next' : null,
          })
        },
      },
    }

    const sessions = await listAllSessions(client)

    expect(asked).toEqual([
      { limit: MAX_PAGE_LIMIT, page: undefined },
      { limit: MAX_PAGE_LIMIT, page: 'next' },
    ])
    expect(sessions).toHaveLength(2)
  })
})
