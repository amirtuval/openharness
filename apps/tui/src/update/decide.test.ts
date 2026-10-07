import { spawn } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import {
  autoUpdateOffReason,
  CHECK_CLAIM_TTL_MS,
  CHECK_INTERVAL_MS,
  isCheckDue,
  isCheckInProgress,
  processIsAlive,
} from './decide'
import type { UpdateCheck } from './state'

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

describe('isCheckInProgress (#197)', () => {
  /** A check claimed `ageMs` ago by `pid`. */
  function claim(ageMs: number, pid: number | undefined): UpdateCheck {
    return { at: new Date(NOW - ageMs).toISOString(), ...(pid === undefined ? {} : { pid }) }
  }

  it('is false when nothing is claimed', () => {
    expect(isCheckInProgress(NOW, undefined)).toBe(false)
  })

  it('is true for a claim whose process is still running', () => {
    expect(isCheckInProgress(NOW, claim(1_000, 4242), () => true)).toBe(true)
  })

  it('is false for a claim whose process is gone', () => {
    // A check that was killed: nothing is running it, so the next run checks again rather
    // than waiting the claim out.
    expect(isCheckInProgress(NOW, claim(1_000, 4242), () => false)).toBe(false)
  })

  it('is false for a claim that names no process', () => {
    expect(isCheckInProgress(NOW, claim(1_000, undefined), () => true)).toBe(false)
  })

  it('is false for a claim it cannot read', () => {
    expect(isCheckInProgress(NOW, { at: 'yesterday', pid: 1 }, () => true)).toBe(false)
  })

  it('is false for a claim older than its TTL, however alive the pid looks', () => {
    // The backstop for a recycled pid: a claim this old is not a check that is still running.
    expect(isCheckInProgress(NOW, claim(CHECK_CLAIM_TTL_MS, 4242), () => true)).toBe(false)
    expect(isCheckInProgress(NOW, claim(CHECK_CLAIM_TTL_MS - 1, 4242), () => true)).toBe(true)
  })

  it('reads a claim from a clock that moved back as a live one', () => {
    // A timestamp in the future is not stale, so the answer is whatever the process table
    // says — the conservative direction, in both cases.
    expect(
      isCheckInProgress(NOW, { at: new Date(NOW + HOUR).toISOString(), pid: 4242 }, () => true),
    ).toBe(true)
    expect(
      isCheckInProgress(NOW, { at: new Date(NOW + HOUR).toISOString(), pid: 4242 }, () => false),
    ).toBe(false)
  })

  it('asks the process table by default', () => {
    expect(isCheckInProgress(NOW, claim(1_000, process.pid))).toBe(true)
  })
})

describe('processIsAlive (#197)', () => {
  /** A pid that is certainly not a process: no such process id. */
  const IMPOSSIBLE_PID = 2 ** 31 - 1

  it('is true for this process', () => {
    expect(processIsAlive(process.pid)).toBe(true)
  })

  it('is false for a pid that is gone', async () => {
    const pid = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
      child.on('exit', () => {
        resolve(child.pid ?? IMPOSSIBLE_PID)
      })
    })

    expect(processIsAlive(pid)).toBe(false)
  })

  it('is false for something that is not a pid at all', () => {
    expect(processIsAlive(0)).toBe(false)
    expect(processIsAlive(-1)).toBe(false)
    expect(processIsAlive(1.5)).toBe(false)
    expect(processIsAlive(Number.NaN)).toBe(false)
  })
})
