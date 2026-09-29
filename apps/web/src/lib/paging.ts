import { MAX_PAGE_LIMIT } from '@openharness/protocol'

/**
 * The most items a screen will load from a list endpoint, however many the server has.
 *
 * A safety cap, not a page size: the walk below stops here and reports `truncated`, and the
 * screen says "and more…" rather than pretending the list is complete. A thousand rows is
 * already more than anyone reads in a sidebar, and it bounds what a server with a very long
 * list can make the browser hold.
 */
export const MAX_PAGE_ITEMS = 1000

/** One page of a list endpoint: the items, and the cursor to the next page (`null` at the end). */
export interface Page<T> {
  readonly data: readonly T[]
  readonly next_page: string | null
}

/** What a list endpoint is asked for: a page size, and the cursor of the page to read. */
export interface PageQuery {
  readonly limit: number
  readonly page?: string | undefined
}

/** What {@link listAllPages} takes besides the request itself. */
export interface ListAllOptions<T> {
  /** Cancels the walk; a page already in flight still resolves, but no further one is sent. */
  readonly signal?: AbortSignal | undefined
  /** Items per request; defaults to, and is capped at, the protocol's `MAX_PAGE_LIMIT`. */
  readonly limit?: number | undefined
  /** Where to stop; defaults to {@link MAX_PAGE_ITEMS}. */
  readonly maxItems?: number | undefined
  /**
   * Called with each page's items as they arrive, oldest page first, for a list that renders
   * while the rest is still loading.
   */
  readonly onPage?: ((items: readonly T[]) => void) | undefined
}

/** What {@link listAllPages} returns. */
export interface ListAllResult<T> {
  readonly data: readonly T[]
  /** The cap stopped the walk while the server still had more. */
  readonly truncated: boolean
}

/**
 * Read every page of a list endpoint.
 *
 * The API answers `{ data, next_page }` and documents `next_page` as the way to the rest, so
 * this asks for the largest page the protocol allows and then keeps asking with
 * `page: next_page` until the server says `null`. Cursors are opaque: they are handed back
 * exactly as they arrived and never decoded.
 *
 * The walk stops on the first of: `next_page === null` (the end), a cursor the server has
 * already given us (which would otherwise page forever), {@link MAX_PAGE_ITEMS} items, or an
 * aborted signal. The first two are a complete list; the last two are not, and only the cap
 * sets {@link ListAllResult.truncated} — an aborted walk is thrown away by the caller anyway.
 *
 * @param fetchPage one page of the list, e.g. `(query, options) => client.agents.list(query, options)`
 * @param options cancellation, the page size, the cap, and the per-page callback
 */
export async function listAllPages<T>(
  fetchPage: (
    query: PageQuery,
    options: { readonly signal?: AbortSignal | undefined },
  ) => Promise<Page<T>>,
  options: ListAllOptions<T> = {},
): Promise<ListAllResult<T>> {
  const limit = Math.min(options.limit ?? MAX_PAGE_LIMIT, MAX_PAGE_LIMIT)
  const maxItems = options.maxItems ?? MAX_PAGE_ITEMS
  const signal = options.signal

  const items: T[] = []
  let page: string | undefined

  for (;;) {
    if (signal?.aborted === true) {
      return { data: items, truncated: false }
    }

    const response = await fetchPage(page === undefined ? { limit } : { limit, page }, { signal })
    items.push(...response.data)
    options.onPage?.(response.data)

    const next = response.next_page
    if (next === null || next === page) {
      return { data: items, truncated: false }
    }
    if (items.length >= maxItems) {
      return { data: items.slice(0, maxItems), truncated: true }
    }
    page = next
  }
}

/**
 * `current` plus the items of `incoming` that are not in it yet, by `id`.
 *
 * For a list that is appended to page by page: an item created while the walk was running
 * (and already added to the list by the create call) is not listed twice when the page that
 * contains it arrives.
 */
export function appendUnseen<T extends { readonly id: string }>(
  current: readonly T[],
  incoming: readonly T[],
): readonly T[] {
  const seen = new Set(current.map((item) => item.id))
  const additions = incoming.filter((item) => !seen.has(item.id))
  return additions.length === 0 ? current : [...current, ...additions]
}
