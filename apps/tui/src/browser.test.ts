import { describe, expect, it } from 'vitest'

import { openBrowser, type BrowserProcess } from './browser'

const URL = 'http://localhost:3000/device?user_code=ABCD-1234'

/** A spawn that records what it was asked to run. */
function recorder(): {
  spawn: (command: string, args: readonly string[]) => BrowserProcess
  calls: { command: string; args: readonly string[] }[]
} {
  const calls: { command: string; args: readonly string[] }[] = []
  return {
    calls,
    spawn: (command, args) => {
      calls.push({ command, args })
      return { on: () => undefined, unref: () => undefined }
    },
  }
}

/** A spawn that throws, the way `spawn` does for a command it cannot even queue. */
const failingSpawn = (): never => {
  throw new Error('spawn xdg-open ENOENT')
}

describe('openBrowser', () => {
  it('opens with xdg-open on Linux when there is a display', () => {
    const { spawn, calls } = recorder()

    const outcome = openBrowser(URL, {
      env: { DISPLAY: ':0' },
      platform: 'linux',
      spawn,
    })

    expect(outcome).toEqual({ opened: true, command: 'xdg-open' })
    expect(calls).toEqual([{ command: 'xdg-open', args: [URL] }])
  })

  it('accepts a Wayland session without DISPLAY', () => {
    const { spawn, calls } = recorder()

    openBrowser(URL, { env: { WAYLAND_DISPLAY: 'wayland-0' }, platform: 'linux', spawn })

    expect(calls).toHaveLength(1)
  })

  it('opens with open on macOS, no display needed', () => {
    const { spawn, calls } = recorder()

    const outcome = openBrowser(URL, { env: {}, platform: 'darwin', spawn })

    expect(outcome).toEqual({ opened: true, command: 'open' })
    expect(calls).toEqual([{ command: 'open', args: [URL] }])
  })

  it('opens with start on Windows, no display needed', () => {
    const { spawn, calls } = recorder()

    const outcome = openBrowser(URL, { env: {}, platform: 'win32', spawn })

    expect(outcome).toEqual({ opened: true, command: 'cmd' })
    expect(calls).toEqual([{ command: 'cmd', args: ['/c', 'start', '', URL] }])
  })

  it('skips a machine with no display', () => {
    const { spawn, calls } = recorder()

    const outcome = openBrowser(URL, { env: {}, platform: 'linux', spawn })

    expect(outcome).toEqual({ opened: false, reason: 'no-display' })
    expect(calls).toEqual([])
  })

  it('skips CI', () => {
    const { spawn, calls } = recorder()

    for (const value of ['1', 'true', 'TRUE']) {
      expect(
        openBrowser(URL, { env: { CI: value, DISPLAY: ':0' }, platform: 'linux', spawn }),
      ).toEqual({ opened: false, reason: 'ci' })
    }
    expect(calls).toEqual([])
  })

  it('does not count CI=false as CI', () => {
    const { spawn, calls } = recorder()

    const outcome = openBrowser(URL, {
      env: { CI: 'false', DISPLAY: ':0' },
      platform: 'linux',
      spawn,
    })

    expect(outcome.opened).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('skips an SSH session', () => {
    const { spawn, calls } = recorder()

    for (const ssh of [{ SSH_CONNECTION: '1.2.3.4 1 5.6.7.8 22' }, { SSH_TTY: '/dev/pts/0' }]) {
      expect(
        openBrowser(URL, { env: { ...ssh, DISPLAY: ':0' }, platform: 'linux', spawn }),
      ).toEqual({ opened: false, reason: 'ssh' })
    }
    expect(calls).toEqual([])
  })

  it('reports a spawn that throws instead of failing the login', () => {
    const outcome = openBrowser(URL, {
      env: { DISPLAY: ':0' },
      platform: 'linux',
      spawn: failingSpawn,
    })

    expect(outcome).toMatchObject({ opened: false, reason: 'failed' })
    if (!outcome.opened) expect(outcome.detail).toContain('ENOENT')
  })
})
