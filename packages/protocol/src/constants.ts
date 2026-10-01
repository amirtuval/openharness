/**
 * Values every part of openharness agrees on: route prefix, header names, page limits and
 * the session → partition function.
 *
 * Nothing here does I/O; the server, the store and the clients all import these constants so
 * that they cannot drift apart.
 */

/** Prefix of every HTTP route in the API (`/v1/agents`, `/v1/sessions`, ...). */
export const API_VERSION_PREFIX = '/v1'

/** Header carrying the API version date (Anthropic: `2023-06-01`). */
export const ANTHROPIC_VERSION_HEADER = 'anthropic-version'

/** Header opting into beta features (Anthropic Managed Agents: `managed-agents-2026-04-01`). */
export const ANTHROPIC_BETA_HEADER = 'anthropic-beta'

/**
 * API version date this server speaks, sent in {@link ANTHROPIC_VERSION_HEADER}. Anthropic's
 * `2023-06-01` sentinel; the Managed Agents surface itself is versioned by the
 * `managed-agents-2026-04-01` beta header.
 */
export const API_VERSION_DATE = '2023-06-01'

/**
 * SSE resume header. On a stream request it carries the `id` of the last `sevt_` event the
 * client already saw; the server replays everything after that event's `seq`.
 *
 * `last-event-id` is the standard `EventSource` header, so browsers send it automatically.
 */
export const LAST_EVENT_ID_HEADER = 'last-event-id'

/** Header carrying the server-assigned request id. Mirrored in error bodies as `request_id`. */
export const REQUEST_ID_HEADER = 'request-id'

/** `content-type` of JSON request and response bodies. */
export const JSON_CONTENT_TYPE = 'application/json'

/** `content-type` of the SSE event stream. */
export const SSE_CONTENT_TYPE = 'text/event-stream'

/**
 * Default number of session partitions.
 *
 * A `sessionId` hashes to exactly one of these; a server instance owns a set of partitions.
 * See {@link partitionOf}.
 */
export const DEFAULT_PARTITION_COUNT = 64

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET_BASIS = 0x811c9dc5

/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193

const utf8 = new TextEncoder()

/**
 * MurmurHash3's 32-bit finalizer: spreads the low bits of `hash` across the whole word.
 *
 * FNV-1a alone is not a good mixer for the low bits, which is exactly the part `% n` keeps.
 * Measured over `sesn_0` … `sesn_255`, plain FNV-1a maps consecutive ids to consecutive
 * partitions in a near-cyclic pattern — χ² across 64 bins is 2 rather than ~63, and only 26
 * of the 64 possible step sizes between neighbours appear. Uniform *counts* are not enough:
 * partitions would follow id order, so any structured id space (a test fixture, a migration,
 * a client that mints its own ids) could be steered into one partition. fmix32 restores
 * avalanche: every step size appears, and χ² sits at the expected ~63.
 */
function fmix32(hash: number): number {
  let h = hash
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** FNV-1a over the UTF-8 bytes of `value`. */
function fnv1a32(value: string): number {
  let hash = FNV_OFFSET_BASIS
  for (const byte of utf8.encode(value)) {
    hash ^= byte
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

/**
 * The partition a session belongs to, in `[0, partitionCount)`.
 *
 * A stable, pure hash of `sessionId`: the server and the store call it with the same id and
 * get the same partition, so ownership survives restarts and deploys. FNV-1a alone would put
 * a `sesn_` id's ULID timestamp in the high bits of the result, which would cluster sessions
 * created in the same millisecond, so the hash is finished with {@link fmix32}.
 *
 * @param sessionId the `sesn_` session id (any string works; it is hashed as UTF-8 bytes)
 * @param partitionCount number of partitions; defaults to {@link DEFAULT_PARTITION_COUNT}
 * @throws RangeError if `partitionCount` is not a positive integer
 */
export function partitionOf(
  sessionId: string,
  partitionCount: number = DEFAULT_PARTITION_COUNT,
): number {
  if (!Number.isInteger(partitionCount) || partitionCount <= 0) {
    throw new RangeError(`partitionCount must be a positive integer, got ${partitionCount}`)
  }
  return fmix32(fnv1a32(sessionId)) % partitionCount
}
