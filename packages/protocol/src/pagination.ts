import { z } from 'zod'

/**
 * Opaque pagination cursors.
 *
 * Every list endpoint in the API answers with the Anthropic list envelope
 * (`{ data, next_page }`). `next_page` is a cursor the client hands back verbatim as the
 * `page` query parameter; it is never parsed by clients.
 *
 * The cursor is `page_` followed by the URL-safe base64 of a small JSON payload. For the
 * events list the payload carries `seq`, the sequence number of the last event on the page.
 * For the agent and session lists — which have no event sequence — the same field carries the
 * number of items already returned. Clients must not depend on either: the payload is an
 * implementation detail and can change without notice.
 */

/** Prefix of every page cursor. */
export const PAGE_CURSOR_PREFIX = 'page_'

/**
 * The decoded payload of a page cursor.
 *
 * `seq` is the resume position: the next page starts after it. For the event list that is the
 * `seq` of the last event returned; for the agent and session lists it is the count of items
 * returned so far.
 */
export const PageCursorSchema = z.object({
  seq: z.number().int().nonnegative(),
})

export type PageCursor = z.infer<typeof PageCursorSchema>

/** `next_page` in a list response: an encoded cursor, or `null` when the page was the last. */
export const NextPageSchema = z.string().nullable()

export type NextPage = z.infer<typeof NextPageSchema>

/**
 * Whether `value` looks like a page cursor, by its prefix.
 *
 * A cheap guard for branching, not a validity check: {@link tryDecodePageCursor} is what
 * decides whether the payload inside is one of ours.
 */
export function isPageCursor(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PAGE_CURSOR_PREFIX)
}

/** The `page` query parameter of a list request. Rejects a cursor this package cannot decode. */
export const PageCursorStringSchema = z
  .string()
  .refine((value) => tryDecodePageCursor(value) !== null, {
    error: 'must be a `page_` pagination cursor',
  })

/**
 * Encode a cursor for the `next_page` field of a list response.
 *
 * Refuses a position that would not survive the round trip, so a server cannot hand a client
 * a `next_page` that {@link decodePageCursor} — and therefore `ListEventsQuerySchema`, which
 * validates `page` — would reject. `seq` must be a non-negative integer.
 *
 * @param cursor the resume position, see {@link PageCursor}
 * @throws RangeError if `cursor.seq` is not a non-negative integer
 */
export function encodePageCursor(cursor: PageCursor): string {
  const parsed = PageCursorSchema.safeParse(cursor)
  if (!parsed.success) {
    throw new RangeError(`not a valid page cursor: ${JSON.stringify(cursor)}`)
  }
  const payload = JSON.stringify({ seq: parsed.data.seq })
  return PAGE_CURSOR_PREFIX + Buffer.from(payload, 'utf8').toString('base64url')
}

/**
 * Decode a cursor received as the `page` query parameter, or `null` if it is not one this
 * package produced.
 *
 * Only the canonical form round-trips: the string must be exactly what
 * {@link encodePageCursor} emits for the position it carries, so two different spellings can
 * never mean the same page.
 */
export function tryDecodePageCursor(cursor: string): PageCursor | null {
  if (!isPageCursor(cursor)) {
    return null
  }
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor.slice(PAGE_CURSOR_PREFIX.length), 'base64url').toString('utf8'),
    )
    const parsed = PageCursorSchema.safeParse(decoded)
    if (!parsed.success) {
      return null
    }
    return encodePageCursor(parsed.data) === cursor ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Decode a cursor received as the `page` query parameter.
 *
 * @throws RangeError if `cursor` is not a cursor produced by {@link encodePageCursor}
 */
export function decodePageCursor(cursor: string): PageCursor {
  const decoded = tryDecodePageCursor(cursor)
  if (decoded === null) {
    throw new RangeError(`not a page cursor: ${JSON.stringify(cursor)}`)
  }
  return decoded
}
