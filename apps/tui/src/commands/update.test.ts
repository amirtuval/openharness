import { describe, expect, it } from 'vitest'

import { PERMISSION_HINT } from '../update/npm'
import { runUpdate, type InstallOutcome, type NpmPort, type ViewOutcome } from './update'

/**
 * `oh update` (issue #157): the foreground path. The npm calls are a fake port here — what is
 * being tested is the command's behaviour around them (what it prints, what it exits with, and
 * the one precondition it refuses on).
 */

/** A recorder for the two streams the command writes to. */
function streams() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
  }
}

/** An npm that answers what the test says, and remembers what it was asked to install. */
function fakeNpm(options: { view: ViewOutcome; install?: InstallOutcome }): {
  readonly npm: NpmPort
  readonly installed: string[]
} {
  const installed: string[] = []
  return {
    installed,
    npm: {
      view() {
        return Promise.resolve(options.view)
      },
      install(version) {
        installed.push(version)
        return Promise.resolve(options.install ?? { ok: true })
      },
    },
  }
}

/** Run the command with the given pieces, returning its exit code and output. */
async function run(
  overrides: {
    runningVersion?: string
    isGlobalInstall?: boolean
    view?: ViewOutcome
    install?: InstallOutcome
  } = {},
) {
  const recorded = streams()
  const { npm, installed } = fakeNpm({
    view: overrides.view ?? { ok: true, version: '1.4.0' },
    install: overrides.install,
  })

  const code = await runUpdate({
    stdout: recorded.stdout,
    stderr: recorded.stderr,
    runningVersion: overrides.runningVersion ?? '1.0.0',
    isGlobalInstall: overrides.isGlobalInstall ?? true,
    npm,
  })

  return { code, ...recorded, installed }
}

describe('runUpdate', () => {
  it('installs a newer version and says so, exit 0', async () => {
    const { code, out, err, installed } = await run({ runningVersion: '1.0.0' })

    expect(code).toBe(0)
    expect(err).toEqual([])
    expect(installed).toEqual(['1.4.0'])
    expect(out).toEqual([
      'Checking npm for a newer openharness…',
      'Updating to v1.4.0…',
      'oh updated to v1.4.0.',
    ])
  })

  it('says it is up to date and installs nothing, exit 0', async () => {
    const { code, out, installed } = await run({
      runningVersion: '1.4.0',
      view: { ok: true, version: '1.4.0' },
    })

    expect(code).toBe(0)
    expect(installed).toEqual([])
    expect(out).toEqual(['Checking npm for a newer openharness…', 'oh is up to date (v1.4.0).'])
  })

  it('exits 1 when npm cannot be asked', async () => {
    const { code, err, installed } = await run({
      view: { ok: false, detail: 'npm did not answer within 15s' },
    })

    expect(code).toBe(1)
    expect(err.join('\n')).toContain('could not check for updates')
    expect(err.join('\n')).toContain('npm did not answer within 15s')
    expect(installed).toEqual([])
  })

  it('exits 1 when the install fails, and repeats the command that would fix it', async () => {
    const { code, err } = await run({
      install: { ok: false, detail: 'npm exited with code 1: 404', permission: false },
    })

    expect(code).toBe(1)
    expect(err.join('\n')).toContain('could not update itself: npm exited with code 1: 404')
    expect(err.join('\n')).toContain('run npm i -g @openh/cli')
    expect(err.join('\n')).not.toContain(PERMISSION_HINT)
  })

  it('adds the sudo/prefix hint when npm could not write to its prefix', async () => {
    const { code, err } = await run({
      install: { ok: false, detail: 'npm exited with code 1: EACCES', permission: true },
    })

    expect(code).toBe(1)
    expect(err).toContain(PERMISSION_HINT)
    expect(PERMISSION_HINT).toContain('sudo')
  })

  it('refuses, exit 2, when this oh is not a global install', async () => {
    const { code, out, err, installed } = await run({ isGlobalInstall: false })

    expect(code).toBe(2)
    expect(out).toEqual([])
    expect(err.join('\n')).toContain('not a global npm install')
    expect(err.join('\n')).toContain('npm i -g @openh/cli')
    // Nothing was asked of npm: the refusal is the whole command.
    expect(installed).toEqual([])
  })

  it('refuses before it looks anything up', async () => {
    // The port would hand back a version, but a refusal must not depend on it.
    const { code, out } = await run({ isGlobalInstall: false })

    expect(code).toBe(2)
    expect(out).toEqual([])
  })
})
