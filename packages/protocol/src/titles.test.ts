import { describe, expect, it } from 'vitest'

import { SESSION_TITLE_MAX_LENGTH } from './resources/session'
import { deriveSessionTitle } from './titles'

/**
 * The derivation on its own: the first non-empty line, collapsed and trimmed, cut to the
 * protocol's limit.
 *
 * Moved here with the function (epic #340): the server names a chat from its first message and
 * the brain names a child session from its task's description, so the rule is asserted once,
 * where both read it.
 */

describe('deriveSessionTitle', () => {
  it('takes the first non-empty line of the text', () => {
    expect(deriveSessionTitle('Fix the SSE reload bug\n\nIt never replays previews')).toBe(
      'Fix the SSE reload bug',
    )
    expect(deriveSessionTitle('\n\n   \nSecond line is the first with text')).toBe(
      'Second line is the first with text',
    )
  })

  it('collapses whitespace and trims the ends', () => {
    expect(deriveSessionTitle('   Fix\t\t the   reload \t bug   ')).toBe('Fix the reload bug')
    expect(deriveSessionTitle('one\r\ntwo\rthree')).toBe('one')
  })

  it('truncates a long line to the protocol maximum, ending it with an ellipsis', () => {
    const long = 'word '.repeat(300).trim()
    const title = deriveSessionTitle(long)
    expect(title).not.toBeNull()
    expect(title?.length).toBe(SESSION_TITLE_MAX_LENGTH)
    expect(title?.endsWith('…')).toBe(true)
    expect(long.startsWith(title?.slice(0, -1) ?? '')).toBe(true)
  })

  it('leaves a line of exactly the maximum alone', () => {
    const exact = 'x'.repeat(SESSION_TITLE_MAX_LENGTH)
    expect(deriveSessionTitle(exact)).toBe(exact)
    expect(deriveSessionTitle(`${exact} and one more word`)).toHaveLength(SESSION_TITLE_MAX_LENGTH)
  })

  it('does not cut a surrogate pair in half', () => {
    // Each 🌊 is two UTF-16 units, so a cut at an odd position would leave half of one behind.
    const waves = '🌊'.repeat(SESSION_TITLE_MAX_LENGTH)
    const title = deriveSessionTitle(waves) ?? ''
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_LENGTH)
    // The character before the ellipsis is not a high surrogate waiting for its other half.
    expect(/[\uD800-\uDBFF]$/.test(title.slice(0, -1))).toBe(false)
  })

  it('answers null when there is nothing to name a session after', () => {
    expect(deriveSessionTitle('')).toBeNull()
    expect(deriveSessionTitle('   \n\t\n ')).toBeNull()
  })
})
