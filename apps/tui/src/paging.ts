import type { Client } from '@openharness/client'
import { MAX_PAGE_LIMIT, type Agent, type Session } from '@openharness/protocol'

/**
 * How many pages a walk follows before it gives up.
 *
 * A page holds at most {@link MAX_PAGE_LIMIT} rows, so this is 100 000 of them — more than
 * any terminal can mean. It is the backstop for a server that keeps inventing cursors: the
 * cursor-repetition guard below catches a server that repeats itself, and this catches one
 * that never does.
 */
export const MAX_LIST_PAGES = 1000

/** One page of a list endpoint: the rows, and the cursor to the next page — or `null`. */
export interface ListPage<T> {
  readonly data: readonly T[]
  readonly next_page: string | null
}

/** Ask for one page: the cursor the previous page ended with, or `undefined` for the first. */
export type PageFetcher<T> = (page: string | undefined) => Promise<ListPage<T>>

/**
 * Walk a list endpoint, page by page, and return every row — not just the first page.
 *
 * Each request asks for {@link MAX_PAGE_LIMIT} rows, the most the protocol allows, and the
 * response's `next_page` is handed back as the next request's `page`, byte for byte: a
 * cursor is the server's business, never this helper's. The walk ends when a page answers
 * `next_page: null`.
 *
 * Two guards, because what this returns is a correctness path — `--agent` resolves against
 * it, and a silently short list is exactly the bug this helper exists to fix:
 *
 * - a cursor the server has handed back before ends the walk, the same guard
 *   `sessions.events.iterate` uses. A server that repeats itself cannot be paged past, and
 *   repeating a page forever is worse than stopping;
 * - {@link MAX_LIST_PAGES} requests is a hard cap. A server still handing out fresh cursors
 *   there gets an error rather than a partial list, so nobody concludes that an agent the
 *   server has does not exist.
 */
export async function listAll<T>(fetchPage: PageFetcher<T>): Promise<T[]> {
  const rows: T[] = []
  const seen = new Set<string>()
  let page: string | undefined

  for (let requests = 1; ; requests += 1) {
    if (requests > MAX_LIST_PAGES) {
      throw new Error(
        `the server sent more than ${MAX_LIST_PAGES} pages of results; stopping rather than walking forever.`,
      )
    }

    const response = await fetchPage(page)
    rows.push(...response.data)

    const next = response.next_page
    if (next === null || seen.has(next)) {
      return rows
    }

    seen.add(next)
    page = next
  }
}

/** Every agent the server has, oldest first. */
export function listAllAgents(client: Client): Promise<Agent[]> {
  return listAll((page) => client.agents.list({ limit: MAX_PAGE_LIMIT, page }))
}

/** Every session the server has, newest first. */
export function listAllSessions(client: Client): Promise<Session[]> {
  return listAll((page) => client.sessions.list({ limit: MAX_PAGE_LIMIT, page }))
}
