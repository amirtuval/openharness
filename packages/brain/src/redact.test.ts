import { describe, expect, it } from 'vitest'

import { REDACTED_PLACEHOLDER, redactSecret } from './redact'

describe('redactSecret', () => {
  const key = 'sk-live-0123456789abcdef'

  it('replaces the whole key, keeping the rest of the message', () => {
    expect(redactSecret(`Incorrect API key provided: ${key}.`, key)).toBe(
      `Incorrect API key provided: ${REDACTED_PLACEHOLDER}.`,
    )
  })

  it('replaces every occurrence, not just the first', () => {
    expect(redactSecret(`${key} was rejected; ${key} is wrong.`, key)).toBe(
      `${REDACTED_PLACEHOLDER} was rejected; ${REDACTED_PLACEHOLDER} is wrong.`,
    )
  })

  it('replaces a key the provider echoed with its first or last four characters cut off', () => {
    // The reason the trimmed variants are scrubbed at all: a provider that quotes part of the
    // key is still quoting the key, and the log must not hold any of it.
    expect(redactSecret(`key ${key.slice(4)} is over its limit`, key)).toBe(
      `key ${REDACTED_PLACEHOLDER} is over its limit`,
    )
    expect(redactSecret(`key …${key.slice(0, -4)} is over its limit`, key)).toBe(
      `key …${REDACTED_PLACEHOLDER} is over its limit`,
    )
  })

  it('redacts a trimmed key that appears alongside the whole one', () => {
    expect(redactSecret(`${key} (${key.slice(4)})`, key)).not.toContain(key.slice(4))
  })

  it('leaves text alone when there is no secret, or nothing to match', () => {
    expect(redactSecret('Overloaded.', undefined)).toBe('Overloaded.')
    expect(redactSecret('Overloaded.', key)).toBe('Overloaded.')
  })

  it('ignores a secret too short to search for', () => {
    // Below the minimum, a fragment of the secret would match ordinary words; a key that
    // short is not one a provider would echo.
    expect(redactSecret('the abc of it', 'abc')).toBe('the abc of it')
    expect(redactSecret('the abcd of it', 'abcd')).toBe('the abcd of it')
  })

  it('matches exactly: case and surroundings are not bent', () => {
    expect(redactSecret(`Key ${key.toUpperCase()} here`, key)).toBe(`Key ${key.toUpperCase()} here`)
  })
})
