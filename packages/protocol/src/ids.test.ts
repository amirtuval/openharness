import { describe, expect, it } from 'vitest'

import {
  AgentIdSchema,
  EventIdSchema,
  ID_PREFIXES,
  ModeIdSchema,
  ProviderCredentialIdSchema,
  SessionIdSchema,
  ULID_LENGTH,
  generateId,
  isAgentId,
  isEventId,
  isId,
  isModeId,
  isProviderCredentialId,
  isSessionId,
  isUlid,
  newAgentId,
  newEventId,
  newModeId,
  newProviderCredentialId,
  newSessionId,
  parseId,
  tryParseId,
  ulid,
} from './ids'

const SAMPLE_ULID = '01JQZ8R6X9M4V0W7Y2B3C5D6E7'

describe('ulid', () => {
  it('is 26 Crockford base32 characters', () => {
    expect(ulid()).toHaveLength(ULID_LENGTH)
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('is deterministic when given a timestamp and randomness', () => {
    const random = new Uint8Array(10).fill(7)
    expect(ulid(1770000000000, random)).toBe(ulid(1770000000000, random))
    expect(ulid(1770000000000, random)).not.toBe(ulid(1770000000001, random))
  })

  it('sorts by timestamp', () => {
    const random = new Uint8Array(10).fill(7)
    expect(ulid(1000, random) < ulid(2000, random)).toBe(true)
  })

  it('encodes the ends of the timestamp range', () => {
    const random = new Uint8Array(10).fill(0)
    expect(ulid(0, random).slice(0, 10)).toBe('0000000000')
    expect(ulid(2 ** 48 - 1, random).slice(0, 10)).toBe('7ZZZZZZZZZ')
  })

  it('rejects an out-of-range timestamp and wrong-sized randomness', () => {
    expect(() => ulid(-1)).toThrow(RangeError)
    expect(() => ulid(2 ** 48)).toThrow(RangeError)
    expect(() => ulid(0, new Uint8Array(9))).toThrow(RangeError)
  })

  it('is unique across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => ulid()))
    expect(ids.size).toBe(1000)
  })
})

describe('isUlid', () => {
  it('accepts generated ULIDs', () => {
    expect(isUlid(ulid())).toBe(true)
  })

  it('rejects the wrong length, alphabet and type', () => {
    expect(isUlid(SAMPLE_ULID.slice(0, 25))).toBe(false)
    expect(isUlid(SAMPLE_ULID + 'Z')).toBe(false)
    // `I`, `L`, `O` and `U` are not in the Crockford alphabet.
    expect(isUlid('0'.repeat(25) + 'I')).toBe(false)
    expect(isUlid('0'.repeat(25) + 'O')).toBe(false)
    expect(isUlid(42)).toBe(false)
  })

  it('rejects a time prefix past the 48-bit maximum', () => {
    // The first character carries bits 45-49; `7` is the largest a 48-bit timestamp allows,
    // so `8` and above encode an instant `ulid()` itself would refuse to produce.
    expect(isUlid('7' + 'Z'.repeat(25))).toBe(true)
    expect(isUlid('8' + '0'.repeat(25))).toBe(false)
    expect(() => parseId('agent_8' + '0'.repeat(25))).toThrow(RangeError)
    expect(AgentIdSchema.safeParse('agent_8' + '0'.repeat(25)).success).toBe(false)
    expect(() => ulid(2 ** 48)).toThrow(RangeError)
  })
})

describe('id generation', () => {
  it('prefixes the ULID with the id kind', () => {
    expect(newAgentId()).toMatch(/^agent_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(newSessionId()).toMatch(/^sesn_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(newEventId()).toMatch(/^sevt_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(newProviderCredentialId()).toMatch(/^pcred_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(newModeId()).toMatch(/^mode_[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('orders by the timestamp it was given, whatever the prefix', () => {
    const earlier = parseId(newAgentId(1770000000000)).ulid
    const later = parseId(newEventId(1770000001000)).ulid
    expect(earlier.slice(0, 10) < later.slice(0, 10)).toBe(true)
  })

  it('generates every kind through the generic entry point', () => {
    for (const [type, prefix] of Object.entries(ID_PREFIXES)) {
      expect(generateId(type as keyof typeof ID_PREFIXES).startsWith(prefix)).toBe(true)
    }
  })

  it('parses what it generates', () => {
    const id = newEventId()
    expect(parseId(id)).toEqual({ type: 'event', prefix: 'sevt_', ulid: id.slice(5) })
  })
})

describe('parseId', () => {
  it('round-trips every prefix', () => {
    expect(parseId(`${ID_PREFIXES.agent}${SAMPLE_ULID}`).type).toBe('agent')
    expect(parseId(`${ID_PREFIXES.session}${SAMPLE_ULID}`).type).toBe('session')
    expect(parseId(`${ID_PREFIXES.event}${SAMPLE_ULID}`).type).toBe('event')
    expect(parseId(`${ID_PREFIXES.providerCredential}${SAMPLE_ULID}`).type).toBe(
      'providerCredential',
    )
    expect(parseId(`${ID_PREFIXES.mode}${SAMPLE_ULID}`).type).toBe('mode')
  })

  it('rejects an unknown prefix, a missing prefix and a malformed ULID', () => {
    expect(() => parseId(`objc_${SAMPLE_ULID}`)).toThrow(RangeError)
    expect(() => parseId(SAMPLE_ULID)).toThrow(RangeError)
    expect(() => parseId('sesn_not-a-ulid')).toThrow(RangeError)
    expect(() => parseId('sesn_')).toThrow(RangeError)
  })

  it('returns null from the non-throwing variant', () => {
    expect(tryParseId('nope')).toBeNull()
    expect(tryParseId(newSessionId())?.type).toBe('session')
  })

  it('strips the right prefix off the prefixes that share a stem (`sevt_`/`sesn_`)', () => {
    // The two prefixes both start with `se`, so a parser that matched loosely — or stripped a
    // fixed four characters — would answer the wrong kind for one of them.
    const event = newEventId()
    const session = newSessionId()

    expect(parseId(event)).toMatchObject({
      type: 'event',
      prefix: ID_PREFIXES.event,
      ulid: event.slice(ID_PREFIXES.event.length),
    })
    expect(parseId(session)).toMatchObject({
      type: 'session',
      prefix: ID_PREFIXES.session,
      ulid: session.slice(ID_PREFIXES.session.length),
    })
    expect(parseId(event).ulid).toHaveLength(ULID_LENGTH)
  })
})

describe('id guards', () => {
  it('accept the matching kind only', () => {
    expect(isId(newAgentId(), 'agent')).toBe(true)
    expect(isId(newAgentId(), 'session')).toBe(false)
    expect(isAgentId(newSessionId())).toBe(false)
    expect(isSessionId(newSessionId())).toBe(true)
    expect(isEventId(newEventId())).toBe(true)
    expect(isProviderCredentialId(newProviderCredentialId())).toBe(true)
    expect(isProviderCredentialId(newAgentId())).toBe(false)
    expect(isAgentId(newProviderCredentialId())).toBe(false)
    expect(isModeId(newModeId())).toBe(true)
    expect(isModeId(newAgentId())).toBe(false)
    expect(isAgentId(newModeId())).toBe(false)
    expect(isId('agent_', undefined)).toBe(false)
  })
})

describe('id schemas', () => {
  it('accept ids of their own kind, unchanged', () => {
    // Written by hand rather than generated by the schema's own constructor: the schema has to
    // accept the canonical shape on its own terms, and it must not normalise what it accepts.
    const agent = `${ID_PREFIXES.agent}${SAMPLE_ULID}`
    const session = `${ID_PREFIXES.session}${SAMPLE_ULID}`
    const event = `${ID_PREFIXES.event}${SAMPLE_ULID}`
    const credential = `${ID_PREFIXES.providerCredential}${SAMPLE_ULID}`
    const mode = `${ID_PREFIXES.mode}${SAMPLE_ULID}`

    expect(AgentIdSchema.parse(agent)).toBe(agent)
    expect(SessionIdSchema.parse(session)).toBe(session)
    expect(EventIdSchema.parse(event)).toBe(event)
    expect(ProviderCredentialIdSchema.parse(credential)).toBe(credential)
    expect(ModeIdSchema.parse(mode)).toBe(mode)
  })

  it('reject ids of another kind', () => {
    expect(AgentIdSchema.safeParse(newSessionId()).success).toBe(false)
    expect(SessionIdSchema.safeParse(newEventId()).success).toBe(false)
    expect(EventIdSchema.safeParse('sevt_short').success).toBe(false)
    expect(ProviderCredentialIdSchema.safeParse(newAgentId()).success).toBe(false)
    expect(
      ProviderCredentialIdSchema.safeParse(`${ID_PREFIXES.providerCredential}nope`).success,
    ).toBe(false)
    expect(ModeIdSchema.safeParse(newAgentId()).success).toBe(false)
    expect(ModeIdSchema.safeParse(`${ID_PREFIXES.mode}nope`).success).toBe(false)
  })
})
