import { z } from 'zod'

import { type Timestamp, TimestampSchema } from './common'

/**
 * Opaque pagination cursors.
 *
 * Every list endpoint in the API answers with the Anthropic list envelope
 * (`{ data, next_page }`). `next_page` is a cursor the client hands back verbatim as the
 * `page` query parameter; it is never parsed by clients.
 *
 * The cursor is `page_` followed by the URL-safe base64 of a small JSON payload, tagged with
 * the kind of resume position it carries:
 *
 * - `seq` — the events list. The log has a running sequence number, so the position is the
 *   `seq` of the last event on the page.
 * - `key` — the agent and session lists. Both are ordered by `(created_at, id)`, so the
 *   position is that keyset for the last item on the page, and the next page is the items
 *   strictly before it. An item offset would not do: sessions are listed newest first, so a
 *   session created between two page fetches would shift every later offset, duplicating or
 *   skipping items that were already returned.
 *
 * Clients must not depend on any of this: the payload is an implementation detail and can
 * change without notice.
 */

/** Prefix of every page cursor. */
export const PAGE_CURSOR_PREFIX = 'page_'

/**
 * A position in the event log: the `seq` of the last event returned.
 *
 * The next page starts after it, so `seq` is never the sequence number of an event the client
 * has not seen. `0` is the start of the log, mirroring `after_seq` on the events query.
 */
export const SeqCursorSchema = z.object({
  kind: z.literal('seq'),
  seq: z.number().int().nonnegative(),
})

export type SeqCursor = z.infer<typeof SeqCursorSchema>

/**
 * A keyset position in a list ordered by `(created_at, id)`: the `created_at` and `id` of the
 * last item on the page.
 *
 * `created_at` alone is not enough — two items can be created in the same millisecond — so
 * `id` breaks the tie. Ids are ULIDs, which sort by creation time as well, making
 * `(created_at, id)` a total order the store can seek into with a single comparison.
 */
export const KeyCursorSchema = z.object({
  kind: z.literal('key'),
  created_at: TimestampSchema,
  id: z.string().min(1),
})

export type KeyCursor = z.infer<typeof KeyCursorSchema>

/**
 * The position a {@link KeyCursor} carries, without its tag.
 *
 * These are exactly the fields of the last item on a page, so an `Agent` or a `Session` — or
 * anything else with a `created_at` and an `id` — can be passed to {@link encodeKeyCursor}
 * as it is; nothing else about it is encoded.
 */
export interface KeyCursorPosition {
  /** `created_at` of the last item returned. */
  readonly created_at: Timestamp
  /** `id` of the last item returned. */
  readonly id: string
}

/** The decoded payload of a page cursor: a `seq` position or a keyset `key` position. */
export const PageCursorSchema = z.discriminatedUnion('kind', [SeqCursorSchema, KeyCursorSchema])

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

/**
 * The `page` query parameter of a list request. Rejects a cursor this package cannot decode.
 *
 * Either kind decodes here: which one an endpoint expects is for the server to decide, and
 * the cursor stays opaque to clients either way.
 */
export const PageCursorStringSchema = z
  .string()
  .refine((value) => tryDecodePageCursor(value) !== null, {
    error: 'must be a `page_` pagination cursor',
  })

/**
 * Encode the `seq` of the last event on a page, for the `next_page` field of an events list
 * response.
 *
 * Refuses a position that would not survive the round trip, so a server cannot hand a client
 * a `next_page` that {@link decodePageCursor} — and therefore `ListEventsQuerySchema`, which
 * validates `page` — would reject.
 *
 * @param seq the resume position, see {@link SeqCursor}
 * @throws RangeError if `seq` is not a non-negative integer
 */
export function encodeSeqCursor(seq: number): string {
  return encodeCursor({ kind: 'seq', seq })
}

/**
 * Encode the keyset position of the last item on a page, for the `next_page` field of an
 * agent or session list response.
 *
 * Refuses a position that would not survive the round trip, the same way
 * {@link encodeSeqCursor} does.
 *
 * @param position the resume position, see {@link KeyCursorPosition}
 * @throws RangeError if `created_at` is not an RFC 3339 timestamp or `id` is empty
 */
export function encodeKeyCursor(position: KeyCursorPosition): string {
  return encodeCursor({ kind: 'key', created_at: position.created_at, id: position.id })
}

/**
 * Validate a position and write it out: the one place a canonical cursor spelling comes from.
 *
 * The payload is rebuilt from the parsed fields rather than stringified from the argument, so
 * the same position always encodes to the same string — whatever object it came in as, and
 * whatever order its keys were in.
 */
function encodeCursor(cursor: PageCursor): string {
  const parsed = PageCursorSchema.safeParse(cursor)
  if (!parsed.success) {
    throw new RangeError(`not a valid page cursor: ${JSON.stringify(cursor)}`)
  }
  const payload =
    parsed.data.kind === 'seq'
      ? JSON.stringify({ kind: 'seq', seq: parsed.data.seq })
      : JSON.stringify({
          kind: 'key',
          created_at: parsed.data.created_at,
          id: parsed.data.id,
        })
  return PAGE_CURSOR_PREFIX + base64UrlEncode(payload)
}

/**
 * Decode a cursor received as the `page` query parameter, or `null` if it is not one this
 * package produced.
 *
 * Only the canonical form round-trips: the string must be exactly what
 * {@link encodeSeqCursor} or {@link encodeKeyCursor} emits for the position it carries, so
 * two different spellings can never mean the same page.
 */
export function tryDecodePageCursor(cursor: string): PageCursor | null {
  if (!isPageCursor(cursor)) {
    return null
  }
  const payload = base64UrlDecode(cursor.slice(PAGE_CURSOR_PREFIX.length))
  if (payload === null) {
    return null
  }
  try {
    const decoded: unknown = JSON.parse(payload)
    const parsed = PageCursorSchema.safeParse(decoded)
    if (!parsed.success) {
      return null
    }
    return encodeCursor(parsed.data) === cursor ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Decode a cursor received as the `page` query parameter.
 *
 * @throws RangeError if `cursor` is not a cursor produced by {@link encodeSeqCursor} or
 *   {@link encodeKeyCursor}
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
