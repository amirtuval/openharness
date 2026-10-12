import { z } from 'zod'

/**
 * Resource and event identifiers.
 *
 * Every id is `<prefix><ULID>`, using the same prefixes as Anthropic's Managed Agents API —
 * `agent_` for agents, `sesn_` for sessions and `sevt_` for stored session events — plus
 * `pcred_` for provider credentials, `mode_` for modes and `mcps_` for remote MCP servers
 * (openharness extensions; Anthropic has none of the three). A ULID is 26 Crockford base32 characters: a 48-bit millisecond
 * timestamp followed by 80 random bits, so ids sort by creation time and are globally unique
 * without coordination.
 *
 * The ids this module produces are also **branded** at the type level
 * ({@link AgentId}, {@link SessionId}, {@link EventId}, {@link ProviderCredentialId},
 * {@link ModeId}, {@link McpServerId}), so a session id cannot be passed where an event id is
 * expected.
 */

/** The id prefixes this protocol uses, keyed by the kind of thing they name. */
export const ID_PREFIXES = {
  agent: 'agent_',
  session: 'sesn_',
  event: 'sevt_',
  providerCredential: 'pcred_',
  mode: 'mode_',
  mcpServer: 'mcps_',
} as const

/**
 * A key of {@link ID_PREFIXES}:
 * `'agent' | 'session' | 'event' | 'providerCredential' | 'mode' | 'mcpServer'`.
 */
export type IdType = keyof typeof ID_PREFIXES

const ID_PREFIX_ENTRIES: readonly (readonly [IdType, string])[] = [
  ['agent', ID_PREFIXES.agent],
  ['session', ID_PREFIXES.session],
  ['event', ID_PREFIXES.event],
  ['providerCredential', ID_PREFIXES.providerCredential],
  ['mode', ID_PREFIXES.mode],
  ['mcpServer', ID_PREFIXES.mcpServer],
]

/** Length of the ULID part of an id. */
export const ULID_LENGTH = 26

/** Crockford base32: `0-9` then `A-Z` without `I`, `L`, `O` and `U`. */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * 26 Crockford base32 characters, with the first one capped at `7`.
 *
 * A ULID's 10-character time prefix carries 50 bits but only 48 are a timestamp: the top two
 * bits must be zero, which limits the first character to `7`. Without the cap, `isUlid` would
 * accept a value encoding an instant past 2^48 ms — one {@link ulid} can never produce and
 * that is not comparable with the timestamps next to it.
 */
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

const ULID_TIME_LENGTH = 10

const ULID_RANDOM_BYTES = 10

/** Largest 48-bit millisecond timestamp a ULID can encode. */
const ULID_MAX_TIME = 2 ** 48 - 1

/**
 * Encode a millisecond timestamp as the 10-character time prefix of a ULID.
 *
 * @param timestampMs milliseconds since the Unix epoch, `0 <= timestampMs <= 2^48 - 1`
 */
function encodeTime(timestampMs: number): string {
  let remaining = timestampMs
  let encoded = ''
  for (let i = 0; i < ULID_TIME_LENGTH; i += 1) {
    encoded = ULID_ALPHABET.charAt(remaining % 32) + encoded
    remaining = Math.floor(remaining / 32)
  }
  return encoded
}

/** Encode 10 random bytes as the 16-character random suffix of a ULID. */
function encodeRandom(bytes: Uint8Array): string {
  let value = 0n
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte)
  }
  let encoded = ''
  for (let i = 0; i < ULID_LENGTH - ULID_TIME_LENGTH; i += 1) {
    encoded = ULID_ALPHABET.charAt(Number(value & 31n)) + encoded
    value >>= 5n
  }
  return encoded
}

/**
 * Generate a ULID from the current time and a fresh 80-bit random value.
 *
 * @param timestampMs creation time to encode; defaults to `Date.now()`
 * @param randomBytes exactly 10 bytes of randomness; defaults to `crypto.getRandomValues`.
 *   Pass your own only in tests, where a deterministic id is worth more than uniqueness.
 * @throws RangeError if `timestampMs` is outside the 48-bit range or `randomBytes` is the
 *   wrong length
 */
export function ulid(
  timestampMs: number = Date.now(),
  randomBytes: Uint8Array = crypto.getRandomValues(new Uint8Array(ULID_RANDOM_BYTES)),
): string {
  const time = Math.floor(timestampMs)
  if (!Number.isFinite(time) || time < 0 || time > ULID_MAX_TIME) {
    throw new RangeError(`ULID timestamp out of range: ${timestampMs}`)
  }
  if (randomBytes.length !== ULID_RANDOM_BYTES) {
    throw new RangeError(`ULID randomness must be ${ULID_RANDOM_BYTES} bytes`)
  }
  return encodeTime(time) + encodeRandom(randomBytes)
}

/**
 * Whether `value` is a ULID this package could have generated: 26 Crockford base32
 * characters, no `I`/`L`/`O`/`U`, and a time prefix within the 48-bit range.
 */
export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value)
}

/** A parsed id: the kind of resource it names, and its ULID. */
export interface ParsedId {
  /** Which resource or event kind the id names. */
  readonly type: IdType
  /** The prefix that was matched, e.g. `sesn_`. */
  readonly prefix: string
  /** The 26-character ULID that followed the prefix. */
  readonly ulid: string
}

/**
 * Whether `value` is an id of `type` (or of any type when `type` is omitted).
 *
 * @param value candidate id
 * @param type when given, the id must name exactly this kind of thing
 */
export function isId(value: unknown, type?: IdType): value is string {
  const parsed = typeof value === 'string' ? tryParseId(value) : null
  return parsed !== null && (type === undefined || parsed.type === type)
}

/** Whether `value` is an `agent_` id. */
export function isAgentId(value: unknown): value is string {
  return isId(value, 'agent')
}

/** Whether `value` is a `sesn_` id. */
export function isSessionId(value: unknown): value is string {
  return isId(value, 'session')
}

/** Whether `value` is a `sevt_` id. */
export function isEventId(value: unknown): value is string {
  return isId(value, 'event')
}

/** Whether `value` is a `pcred_` id. */
export function isProviderCredentialId(value: unknown): value is string {
  return isId(value, 'providerCredential')
}

/** Whether `value` is a `mode_` id. */
export function isModeId(value: unknown): value is string {
  return isId(value, 'mode')
}

/**
 * Parse an id into its prefix and ULID.
 *
 * @throws RangeError if `value` is not a known prefix followed by a valid ULID
 */
export function parseId(value: string): ParsedId {
  for (const [type, prefix] of ID_PREFIX_ENTRIES) {
    if (value.startsWith(prefix)) {
      const suffix = value.slice(prefix.length)
      if (isUlid(suffix)) {
        return { type, prefix, ulid: suffix }
      }
    }
  }
  throw new RangeError(`not a valid id: ${JSON.stringify(value)}`)
}

/** {@link parseId}, returning `null` instead of throwing. */
export function tryParseId(value: string): ParsedId | null {
  try {
    return parseId(value)
  } catch {
    return null
  }
}

/**
 * Generate a new id of the given kind: prefix + ULID.
 *
 * @param type which prefix to use
 * @param timestampMs creation time to encode; defaults to `Date.now()`
 */
export function generateId(type: IdType, timestampMs?: number): string {
  return ID_PREFIXES[type] + ulid(timestampMs)
}

/** A new `agent_` id. */
export function newAgentId(timestampMs?: number): AgentId {
  return AgentIdSchema.parse(generateId('agent', timestampMs))
}

/** A new `sesn_` id. */
export function newSessionId(timestampMs?: number): SessionId {
  return SessionIdSchema.parse(generateId('session', timestampMs))
}

/** A new `sevt_` id. */
export function newEventId(timestampMs?: number): EventId {
  return EventIdSchema.parse(generateId('event', timestampMs))
}

/** A new `pcred_` id: a provider credential's metadata row. */
export function newProviderCredentialId(timestampMs?: number): ProviderCredentialId {
  return ProviderCredentialIdSchema.parse(generateId('providerCredential', timestampMs))
}

/** A new `mode_` id: a user's mode. */
export function newModeId(timestampMs?: number): ModeId {
  return ModeIdSchema.parse(generateId('mode', timestampMs))
}

/** A new `mcps_` id: a user's remote MCP server. */
export function newMcpServerId(timestampMs?: number): McpServerId {
  return McpServerIdSchema.parse(generateId('mcpServer', timestampMs))
}

/** Whether `value` is an `mcps_` id. */
export function isMcpServerId(value: unknown): value is string {
  return isId(value, 'mcpServer')
}

/**
 * Branded `agent_` id. Any agent id in this package is interchangeable with `string`, but a
 * session or event id is not.
 */
export const AgentIdSchema = z
  .string()
  .refine(isAgentId, { error: 'must be an `agent_` id' })
  .brand<'AgentId'>()

export type AgentId = z.infer<typeof AgentIdSchema>

/** Branded `sesn_` id. */
export const SessionIdSchema = z
  .string()
  .refine(isSessionId, { error: 'must be a `sesn_` id' })
  .brand<'SessionId'>()

export type SessionId = z.infer<typeof SessionIdSchema>

/** Branded `sevt_` id. */
export const EventIdSchema = z
  .string()
  .refine(isEventId, { error: 'must be a `sevt_` id' })
  .brand<'EventId'>()

export type EventId = z.infer<typeof EventIdSchema>

/**
 * Branded `pcred_` id. // extension: Anthropic's Managed Agents API has no provider
 * credentials, so this prefix is openharness' own.
 */
export const ProviderCredentialIdSchema = z
  .string()
  .refine(isProviderCredentialId, { error: 'must be a `pcred_` id' })
  .brand<'ProviderCredentialId'>()

export type ProviderCredentialId = z.infer<typeof ProviderCredentialIdSchema>

/**
 * Branded `mode_` id. // extension: Anthropic's Managed Agents API has no modes, so this
 * prefix is openharness' own.
 */
export const ModeIdSchema = z
  .string()
  .refine(isModeId, { error: 'must be a `mode_` id' })
  .brand<'ModeId'>()

export type ModeId = z.infer<typeof ModeIdSchema>

/**
 * Branded `mcps_` id. // extension: Anthropic's Managed Agents API has no per-user MCP server
 * resource, so this prefix is openharness' own.
 */
export const McpServerIdSchema = z
  .string()
  .refine(isMcpServerId, { error: 'must be an `mcps_` id' })
  .brand<'McpServerId'>()

export type McpServerId = z.infer<typeof McpServerIdSchema>
