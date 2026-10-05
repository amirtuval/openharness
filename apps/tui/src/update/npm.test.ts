import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  installWrapperSource,
  looksLikePermissionError,
  npmCommandFor,
  resolveGlobalRoot,
  spawnDetachedInstall,
  tailOf,
  viewPublishedVersion,
} from './npm'
import { readUpdateState } from './state'

/**
 * These tests drive a **fake npm on `PATH`** — a small shell script — rather than a mock: the
 * spawn path is the thing under test (arguments, exit codes, stderr, the log file the
 * detached installer writes), and a seam in front of `spawn` would test everything except it.
 */
let directory: string
let bin: string
let statePath: string
let logPath: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'oh-update-npm-'))
  bin = join(directory, 'bin')
  mkdirSync(bin)
  statePath = join(directory, 'openharness', 'update-state.json')
  logPath = join(directory, 'openharness', 'update.log')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/**
 * Put a fake `npm` on `PATH`, and answer the environment that finds it.
 *
 * The real `PATH` follows the fake one so the script's own tools (`sleep`) still resolve;
 * the fake's directory is first, so it is the `npm` that gets run.
 */
function fakeNpm(script: string): Record<string, string> {
  const path = join(bin, 'npm')
  writeFileSync(path, `#!/bin/sh\n${script}\n`, 'utf8')
  chmodSync(path, 0o755)
  return { PATH: `${bin}:${process.env['PATH'] ?? ''}` }
}

/** Wait for a file to satisfy `ready`, up to a deadline. */
async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the installer')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Run a probe script in its own node process and wait for it to end. */
async function runProbe(script: string, env: Record<string, string>): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...env },
      stdio: 'ignore',
    })
    child.on('exit', (code) => {
      resolve(code)
    })
  })
}

/** Run the detached installer's script in the foreground, and wait for it. */
async function runInstallWrapper(
  version: string,
  env: Record<string, string>,
): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    const child = spawn(
      process.execPath,
      ['-e', installWrapperSource(), statePath, version, logPath],
      { env: { ...process.env, ...env } },
    )
    child.on('exit', (code) => {
      resolve(code)
    })
  })
}

describe('npmCommandFor', () => {
  it('is npm on PATH everywhere but Windows', () => {
    expect(npmCommandFor('linux')).toEqual({ command: 'npm', shell: false })
    expect(npmCommandFor('darwin')).toEqual({ command: 'npm', shell: false })
  })

  it('is npm.cmd through a shell on Windows, which cannot start a .cmd directly', () => {
    expect(npmCommandFor('win32')).toEqual({ command: 'npm.cmd', shell: true })
  })
})

describe('viewPublishedVersion', () => {
  it('is the version npm prints', async () => {
    const env = fakeNpm('echo "1.4.0"')

    await expect(viewPublishedVersion({ env })).resolves.toEqual({
      ok: true,
      output: '1.4.0',
      detail: '',
    })
  })

  it('takes the first line, since npm may say other things too', async () => {
    const env = fakeNpm('echo ""\necho "2.0.1"')

    expect((await viewPublishedVersion({ env })).output).toBe('2.0.1')
  })

  it("fails with npm's exit code and its own tail", async () => {
    const env = fakeNpm('echo "npm error code E404" >&2\nexit 1')

    const outcome = await viewPublishedVersion({ env })

    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('npm exited with code 1')
    expect(outcome.detail).toContain('E404')
  })

  it('gives up on npm that does not answer, and says so', async () => {
    // The timeout answers on its own, without waiting for the killed child to be reaped.
    const env = fakeNpm('sleep 3')

    const started = Date.now()
    await expect(viewPublishedVersion({ env, timeoutMs: 1000 })).resolves.toMatchObject({
      ok: false,
      detail: 'npm did not answer within 1s',
    })
    expect(Date.now() - started).toBeLessThan(2500)
  })

  it('fails, rather than throwing, when there is no npm to run', async () => {
    const outcome = await viewPublishedVersion({ env: { PATH: join(directory, 'empty') } })

    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('could not run npm')
  })
})

describe('viewPublishedVersion: the background shape', () => {
  it('still answers with unref set', async () => {
    const env = fakeNpm('echo "1.4.0"')

    await expect(viewPublishedVersion({ env, unref: true })).resolves.toMatchObject({
      ok: true,
      output: '1.4.0',
    })
  })

  it('does not hold a finished command open while the lookup runs', async () => {
    // The property the background check depends on — a command that has already printed must
    // not wait for npm — is about how long the *process* lives, so it takes a process to see
    // it. The probe is TypeScript run by node's own type stripping (24 runs `.ts` directly),
    // written outside `src/` so the package's `tsc` never sees it, and it fires the lookup the
    // way `checkForUpdate` does: never awaited, `unref` set.
    const env = fakeNpm('sleep 5\necho "9.9.9"')
    // `process.cwd()` is the package folder here (`yarn test` runs from it); `import.meta.url`
    // is not a file URL under the test runner, so the path is spelled the plain way.
    const modulePath = join(process.cwd(), 'src', 'update', 'npm.ts')
    expect(existsSync(modulePath)).toBe(true)
    const probe = join(directory, 'probe.mts')
    writeFileSync(
      probe,
      [
        `import { viewPublishedVersion } from ${JSON.stringify(modulePath)}`,
        'void viewPublishedVersion({ env: process.env, unref: true, timeoutMs: 15_000 })',
        "console.log('fired')",
        '',
      ].join('\n'),
      'utf8',
    )

    const started = Date.now()
    const code = await runProbe(probe, env)
    const elapsed = Date.now() - started

    expect(code).toBe(0)
    // The fake npm sleeps five seconds; without the unref, this process would wait it out.
    expect(elapsed).toBeLessThan(3000)
  })
})

describe('resolveGlobalRoot', () => {
  it('is the directory npm root -g prints', async () => {
    const env = fakeNpm('echo "/usr/local/lib/modules-here"')

    await expect(resolveGlobalRoot({ env })).resolves.toMatchObject({
      ok: true,
      output: '/usr/local/lib/modules-here',
    })
  })
})

describe('looksLikePermissionError', () => {
  it('recognizes the ways npm reports a prefix it cannot write', () => {
    expect(looksLikePermissionError('npm error code EACCES')).toBe(true)
    expect(looksLikePermissionError('npm ERR! EPERM: operation not permitted')).toBe(true)
    expect(looksLikePermissionError('mkdir: permission denied')).toBe(true)
  })

  it('is not fooled by an unrelated failure', () => {
    expect(looksLikePermissionError('npm error code E404')).toBe(false)
    expect(looksLikePermissionError('')).toBe(false)
  })
})

describe('tailOf', () => {
  it('keeps the end of the output, flattened onto one line', () => {
    expect(tailOf('a\n\n  b  \nc\n')).toBe('a b c')
  })

  it('keeps only the last few lines, and only so many characters', () => {
    expect(tailOf('1\n2\n3\n4\n5')).toBe('3 4 5')
    expect(tailOf('x'.repeat(500)).length).toBe(300)
  })
})

describe('the detached installer', () => {
  it('records a successful install for the next run to report', async () => {
    const env = fakeNpm('echo "added 1 package in 2s" >&2')

    await runInstallWrapper('1.4.0', env)

    const result = readUpdateState(statePath).result
    expect(result).toMatchObject({ status: 'success', version: '1.4.0' })
    expect(result?.at).toMatch(/^\d{4}-/)
    // The output was redirected to the log file, not the terminal.
    expect(readFileSync(logPath, 'utf8')).toContain('added 1 package')
  })

  it('records the failure, with the sudo/prefix case flagged', async () => {
    const env = fakeNpm(
      'echo "npm error code EACCES" >&2\n' +
        'echo "npm error syscall mkdir" >&2\n' +
        'echo "npm error path /usr/local/lib/modules-here/openharness" >&2\n' +
        'exit 1',
    )

    await runInstallWrapper('1.4.0', env)

    const result = readUpdateState(statePath).result
    expect(result).toMatchObject({ status: 'failure', version: '1.4.0', permission: true })
    expect(result?.reason).toContain('npm exited with code 1')
    expect(result?.reason).toContain('EACCES')
  })

  it('flags nothing when the failure is not about permissions', async () => {
    const env = fakeNpm('echo "npm error code E404" >&2\nexit 1')

    await runInstallWrapper('9.9.9', env)

    expect(readUpdateState(statePath).result).toMatchObject({
      status: 'failure',
      version: '9.9.9',
    })
    expect(readUpdateState(statePath).result?.permission).toBeUndefined()
  })

  it('keeps the state the CLI wrote before spawning it', async () => {
    const env = fakeNpm('exit 0')
    mkdirSync(join(directory, 'openharness'), { recursive: true })
    writeFileSync(
      statePath,
      `${JSON.stringify({ lastCheck: '2026-10-05T12:00:00.000Z' })}\n`,
      'utf8',
    )

    await runInstallWrapper('1.4.0', env)

    const state = readUpdateState(statePath)
    expect(state.lastCheck).toBe('2026-10-05T12:00:00.000Z')
    expect(state.result?.status).toBe('success')
  })

  it('survives a state file it cannot parse', async () => {
    const env = fakeNpm('exit 0')
    mkdirSync(join(directory, 'openharness'), { recursive: true })
    writeFileSync(statePath, '{oops', 'utf8')

    await runInstallWrapper('1.4.0', env)

    expect(readUpdateState(statePath).result?.status).toBe('success')
  })

  it('is started detached, so a run can carry on while it installs', async () => {
    const env = fakeNpm('echo "added 1 package" >&2')

    expect(spawnDetachedInstall('1.4.0', { statePath, logPath }, { env })).toBe(true)

    // Nobody waits for it — that is the point — so the test polls for what it left behind.
    await expect(waitFor(() => readUpdateState(statePath).result)).resolves.toMatchObject({
      status: 'success',
      version: '1.4.0',
    })
  })
})
