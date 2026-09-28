import { z } from 'zod'

/**
 * An RFC 3339 timestamp, for example `2026-03-15T10:00:00Z`.
 *
 * Matches the `format: date-time` fields of Anthropic's Managed Agents API. Both the UTC
 * (`Z`) and the numeric-offset (`+02:00`) forms are accepted; values are never normalised,
 * so a timestamp round-trips byte for byte.
 */
export const TimestampSchema = z.iso.datetime({ offset: true })

export type Timestamp = z.infer<typeof TimestampSchema>

/** Maximum number of key/value pairs Anthropic documents for a metadata map. */
export const METADATA_MAX_PAIRS = 16

/** Maximum length of a metadata key. */
export const METADATA_MAX_KEY_LENGTH = 64

/** Maximum length of a metadata value. */
export const METADATA_MAX_VALUE_LENGTH = 512

/**
 * An arbitrary string-keyed metadata map, bounded the way Anthropic bounds it: at most
 * {@link METADATA_MAX_PAIRS} pairs, keys up to {@link METADATA_MAX_KEY_LENGTH} characters and
 * values up to {@link METADATA_MAX_VALUE_LENGTH}.
 */
export const MetadataSchema = z
  .record(z.string().max(METADATA_MAX_KEY_LENGTH), z.string().max(METADATA_MAX_VALUE_LENGTH))
  .refine((metadata) => Object.keys(metadata).length <= METADATA_MAX_PAIRS, {
    error: `metadata holds at most ${METADATA_MAX_PAIRS} pairs`,
  })

export type Metadata = z.infer<typeof MetadataSchema>

/** Page size used when a list request omits `limit`. Matches Anthropic's default. */
export const DEFAULT_PAGE_LIMIT = 20

/** Largest page size a list request may ask for. Matches Anthropic's maximum. */
export const MAX_PAGE_LIMIT = 100

/**
 * The `limit` query parameter of every list endpoint.
 *
 * Query strings arrive as text, so this schema coerces: `'20'` and `20` both parse to `20`.
 */
export const PageLimitSchema = z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT)

export type PageLimit = z.infer<typeof PageLimitSchema>

/**
 * Sort direction for list endpoints. Anthropic's `order` parameter; `asc` (oldest first) is
 * the default everywhere in this package.
 */
export const ListOrderSchema = z.enum(['asc', 'desc'])

export type ListOrder = z.infer<typeof ListOrderSchema>
