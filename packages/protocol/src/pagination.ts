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
  return PAGE_CURSOR_PREFIX + base64UrlEncode(payload)
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
    const payload = base64UrlDecode(cursor.slice(PAGE_CURSOR_PREFIX.length))
    if (payload === null) {
      return null
    }
    const decoded: unknown = JSON.parse(payload)
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

const textEncoder = new TextEncoder()

/** Strict, so bytes that are not UTF-8 fail the decode instead of becoming U+FFFD. */
const textDecoder = new TextDecoder('utf-8', { fatal: true })

/**
 * Base64url without padding, over the UTF-8 bytes of `text`.
 *
 * Built on `TextEncoder` and `btoa` rather than `Buffer`: this package is imported by the web
 * app, where `Buffer` does not exist. Both are Web APIs, so they are in Node 24 as well.
 */
function base64UrlEncode(text: string): string {
  let binary = ''
  for (const byte of textEncoder.encode(text)) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/**
 * {@link base64UrlEncode} in reverse, or `null` if `value` is not unpadded base64url of
 * well-formed UTF-8. Every failure — a stray character, a bad length, an invalid byte — is
 * the same answer to the caller.
 */
function base64UrlDecode(value: string): string | null {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  try {
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    return textDecoder.decode(bytes)
  } catch {
    return null
  }
}
