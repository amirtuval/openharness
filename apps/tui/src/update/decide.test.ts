import { describe, expect, it } from 'vitest'

import { autoUpdateOffReason, CHECK_INTERVAL_MS, isCheckDue } from './decide'

/** One hour, the interval the throttle is built on. */
const HOUR = 60 * 60 * 1000

/** A fixed point in time, so the tests never depend on the clock they run on. */
const NOW = Date.parse('2026-10-05T12:00:00.000Z')

describe('autoUpdateOffReason', () => {
  it('is on with an empty environment and the config default', () => {
    expect(autoUpdateOffReason({}, true)).toBeUndefined()
  })

  it('is off when OH_NO_AUTO_UPDATE is set', () => {
    expect(autoUpdateOffReason({ OH_NO_AUTO_UPDATE: '1' }, true)).toBe('env')
    expect(autoUpdateOffReason({ OH_NO_AUTO_UPDATE: 'yes' }, true)).toBe('env')
  })

  it('treats a blank or false-looking OH_NO_AUTO_UPDATE as unset', () => {
    // How a shell unsets, or a person opts back in: `0` and `false` are not "on".
    expect(autoUpdateOffReason({ OH_NO_AUTO_UPDATE: '' }, true)).toBeUndefined()
    expect(autoUpdateOffReason({ OH_NO_AUTO_UPDATE: '0' }, true)).toBeUndefined()
    expect(autoUpdateOffReason({ OH_NO_AUTO_UPDATE: 'false' }, true)).toBeUndefined()
    expect(autoUpdateOffReason({ OH_NO_AUTO_UPDATE: '  ' }, true)).toBeUndefined()
  })

  it('is off when the config file sets autoUpdate false', () => {
    expect(autoUpdateOffReason({}, false)).toBe('config')
  })

  it('is off in CI', () => {
    expect(autoUpdateOffReason({ CI: 'true' }, true)).toBe('ci')
    // `CI=false` is a person opting out of being a runner, the same rule `browser.ts` uses.
    expect(autoUpdateOffReason({ CI: 'false' }, true)).toBeUndefined()
    expect(autoUpdateOffReason({ CI: '' }, true)).toBeUndefined()
  })

  it('names the environment first when several switches are on', () => {
    expect(autoUpdateOffReason({ OH_NO_AUTO_UPDATE: '1', CI: '1' }, false)).toBe('env')
    expect(autoUpdateOffReason({ CI: '1' }, false)).toBe('config')
  })
})

describe('isCheckDue', () => {
  it('is due on the first run, with no timestamp at all', () => {
    expect(isCheckDue(NOW, undefined)).toBe(true)
  })

  it('is not due within the hour', () => {
    expect(isCheckDue(NOW, new Date(NOW - 60_000).toISOString())).toBe(false)
    expect(isCheckDue(NOW, new Date(NOW - (HOUR - 1)).toISOString())).toBe(false)
  })

  it('is due once the hour is up', () => {
    expect(isCheckDue(NOW, new Date(NOW - HOUR).toISOString())).toBe(true)
  })

  it('is due again for a timestamp it cannot read', () => {
    expect(isCheckDue(NOW, 'yesterday')).toBe(true)
    expect(isCheckDue(NOW, '')).toBe(true)
  })

  it('waits out a timestamp in the future rather than checking every run', () => {
    // A clock that moved back must not turn the throttle into a check per startup.
    expect(isCheckDue(NOW, new Date(NOW + HOUR).toISOString())).toBe(false)
  })

  it('uses an hour as its interval', () => {
    expect(CHECK_INTERVAL_MS).toBe(HOUR)
  })
})
