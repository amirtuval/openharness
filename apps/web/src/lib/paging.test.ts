import { MAX_PAGE_LIMIT } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { appendUnseen, listAllPages, type Page, type PageQuery } from './paging'

/** A list endpoint that answers from a script of pages, and records what it was asked for. */
function scriptedPages(items: readonly string[], pageSize: number) {
  const queries: PageQuery[] = []
  const list = (query: PageQuery): Promise<Page<string>> => {
    queries.push(query)
    const start = query.page === undefined ? 0 : Number(query.page)
    const data = items.slice(start, start + pageSize)
    const next = start + data.length
    return Promise.resolve({ data, next_page: next < items.length ? String(next) : null })
  }
  return { queries, list }
}

/** Items named `item-0`… `item-{count-1}`. */
function items(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `item-${index}`)
}

describe('listAllPages', () => {
  it('asks for the largest page the protocol allows and stops at the end', async () => {
    const { queries, list } = scriptedPages(items(3), 2)

    const result = await listAllPages(list)

    expect(result).toEqual({ data: ['item-0', 'item-1', 'item-2'], truncated: false })
    // The first request asks for a full page and carries no cursor; the script's own page
    // size, not `limit`, is what makes it take two requests.
    expect(queries[0]).toEqual({ limit: MAX_PAGE_LIMIT })
    expect(queries).toHaveLength(2)
  })

  it('follows next_page until it is null, handing each cursor back verbatim', async () => {
    const { queries, list } = scriptedPages(items(5), 2)
    const pages: string[][] = []

    const result = await listAllPages(list, {
      onPage: (page) => {
        pages.push([...page])
      },
    })

    expect(result.data).toEqual(items(5))
    expect(pages).toEqual([['item-0', 'item-1'], ['item-2', 'item-3'], ['item-4']])
    // The first request has no cursor; the next two carry exactly what the server sent.
    expect(queries).toEqual([
      { limit: MAX_PAGE_LIMIT },
      { limit: MAX_PAGE_LIMIT, page: '2' },
      { limit: MAX_PAGE_LIMIT, page: '4' },
    ])
  })

  it('stops at the cap and says so, keeping the pages it already read', async () => {
    const { queries, list } = scriptedPages(items(10), 2)

    const result = await listAllPages(list, { maxItems: 4 })

    expect(result.data).toEqual(['item-0', 'item-1', 'item-2', 'item-3'])
    expect(result.truncated).toBe(true)
    expect(queries).toHaveLength(2)
  })

  it('stops when a server hands back a cursor it has already been given', async () => {
    const queries: PageQuery[] = []
    const list = (query: PageQuery): Promise<Page<string>> => {
      queries.push(query)
      // A server that always answers with the same cursor: one page forever, without the guard.
      return Promise.resolve({ data: ['item'], next_page: 'stuck' })
    }

    const result = await listAllPages(list, { maxItems: 100 })

    expect(result).toEqual({ data: ['item', 'item'], truncated: false })
    expect(queries).toHaveLength(2)
  })

  it('stops asking once the signal is aborted', async () => {
    const { queries, list } = scriptedPages(items(10), 2)
    const controller = new AbortController()

    const result = await listAllPages(list, {
      signal: controller.signal,
      onPage: () => {
        controller.abort()
      },
    })

    expect(result.data).toEqual(['item-0', 'item-1'])
    expect(queries).toHaveLength(1)
  })

  it('never asks for a page larger than the protocol allows', async () => {
    const { queries, list } = scriptedPages(items(1), 1)

    await listAllPages(list, { limit: MAX_PAGE_LIMIT * 10 })

    expect(queries).toEqual([{ limit: MAX_PAGE_LIMIT }])
  })
})

describe('appendUnseen', () => {
  it('appends what is new and keeps the order it already had', () => {
    const current = [{ id: 'b' }, { id: 'c' }]

    expect(appendUnseen(current, [{ id: 'a' }, { id: 'c' }, { id: 'd' }])).toEqual([
      { id: 'b' },
      { id: 'c' },
      { id: 'a' },
      { id: 'd' },
    ])
  })

  it('returns the same array when nothing is new', () => {
    const current = [{ id: 'a' }]

    expect(appendUnseen(current, [{ id: 'a' }])).toBe(current)
  })
})
