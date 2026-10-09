import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  looksLikePermissionError,
  npmCommandFor,
  resolveGlobalRoot,
  spawnDetachedCheck,
  tailOf,
  updateWrapperSource,
  viewPublishedVersion,
} from './npm'
import { readUpdateState, writeUpdateState } from './state'

/**
 * These tests drive a **fake npm on `PATH`** — a small shell script — rather than a mock: the
 * spawn path is the thing under test (arguments, exit codes, stderr, the log file the detached
 * check writes), and a seam in front of `spawn` would test everything except it.
 *
 * The detached check (#197) is exercised through the same door, by running its `node -e`
 * program in a real process: the program is a string, so there is nothing smaller than a
 * process to run it in.
 */
let directory: string
let bin: string
let statePath: string
let logPath: string
/**
 * A module directory of this test's own, standing in for `npm root -g`'s answer: it exists on
 * disk, because the check realpaths what it compares.
 */
let moduleRoot: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'oh-update-npm-'))
  bin = join(directory, 'bin')
  mkdirSync(bin)
  moduleRoot = join(directory, 'prefix', 'lib', 'node_modules')
  mkdirSync(moduleRoot, { recursive: true })
  statePath = join(directory, 'openharness', 'update-state.json')
  logPath = join(directory, 'openharness', 'update.log')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** Put an executable script called `name` in the fake bin directory. */
function shim(name: string, script: string): void {
  const path = join(bin, name)
  writeFileSync(path, `#!/bin/sh\n${script}\n`, 'utf8')
  chmodSync(path, 0o755)
}

/**
 * Put a fake `npm` on `PATH`, and answer the environment that finds it.
 *
 * The real `PATH` follows the fake one so the script's own tools (`sleep`) still resolve;
 * the fake's directory is first, so it is the `npm` that gets run.
 */
function fakeNpm(script: string): Record<string, string> {
  shim('npm', script)
  return { PATH: `${bin}:${process.env['PATH'] ?? ''}` }
}

/** Wait for a file to satisfy `ready`, up to a deadline. */
async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the check')
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

/** A pid that is certainly not a process: no such process id. */
const IMPOSSIBLE_PID = 2 ** 31 - 1

/** The pid of a process that has already ended. */
async function deadPid(): Promise<number> {
  return await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    child.on('exit', () => {
      resolve(child.pid ?? IMPOSSIBLE_PID)
    })
  })
}

/** What a protocol fake npm answers, per invocation. */
interface ProtocolOptions {
  /** `npm root -g`: the module directory a global install would live in. */
  readonly root: string
  readonly published?: string | undefined
  readonly rootFails?: boolean | undefined
  readonly viewFails?: boolean | undefined
  /** npm's own words when the install fails; the install succeeds when this is absent. */
  readonly installError?: string | undefined
  /** How long npm takes, for the tests about a check that outlives the process that ran it. */
  readonly delaySeconds?: number | undefined
}

/** A fake npm that speaks the three subcommands the check uses, and remembers every call. */
interface FakeNpm {
  readonly env: Record<string, string>
  /** Every `npm <command> <flag> <argument>` line, in order. */
  readonly calls: () => readonly string[]
  /** Every spec `npm install -g` was given. */
  readonly installs: () => readonly string[]
}

function protocolNpm(options: ProtocolOptions): FakeNpm {
  const callsPath = join(directory, 'npm-calls')
  const installsPath = join(directory, 'npm-installs')
  /** What a lookup that fails looks like: nothing on stdout, an exit code, npm's words. */
  const answer = (fails: boolean | undefined, value: string): string =>
    fails === true ? `echo "npm error code ENOTFOUND" >&2\nexit 1` : `echo '${value}'`

  const lines = [`echo "$1 $2 $3" >> '${callsPath}'`]
  if (options.delaySeconds !== undefined) lines.push(`sleep ${options.delaySeconds}`)
  lines.push(
    'case "$1 $2" in',
    '  "root -g")',
    answer(options.rootFails, options.root),
    '    ;;',
    // `npm view @openh/cli version` — the case matches on the two words before the argument.
    '  "view @openh/cli")',
    answer(options.viewFails, options.published ?? '1.0.0'),
    '    ;;',
    '  "install -g")',
    `    echo "$3" >> '${installsPath}'`,
    options.installError === undefined
      ? `    echo "added 1 package in 2s" >&2`
      : `    echo '${options.installError}' >&2\n    exit 1`,
    '    ;;',
    'esac',
    'exit 0',
  )
  shim('npm', lines.join('\n'))

  const readLines = (path: string): readonly string[] => {
    try {
      return readFileSync(path, 'utf8')
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
    } catch {
      return []
    }
  }

  return {
    env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` },
    calls: () => readLines(callsPath),
    installs: () => readLines(installsPath),
  }
}

/** Run the detached check's program in the foreground, and wait for it. */
async function runCheckWrapper(check: {
  moduleDirectory: string
  runningVersion: string
  env: Record<string, string>
}): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        updateWrapperSource(),
        statePath,
        logPath,
        check.moduleDirectory,
        check.runningVersion,
      ],
      { env: { ...process.env, ...check.env } },
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

describe('the detached check (#197)', () => {
  /** A module directory that is a shape npm could name, for the global-install half. */
  it('installs a newer version, and records it for the next run to report', async () => {
    const npm = protocolNpm({ root: moduleRoot, published: '1.4.0' })

    await runCheckWrapper({ moduleDirectory: moduleRoot, runningVersion: '1.0.0', env: npm.env })

    expect(npm.installs()).toEqual(['@openh/cli@1.4.0'])
    const result = readUpdateState(statePath).result
    expect(result).toMatchObject({ status: 'success', version: '1.4.0' })
    expect(result?.at).toMatch(/^\d{4}-/)
    // The install's output was redirected to the log file, not the terminal.
    expect(readFileSync(logPath, 'utf8')).toContain('added 1 package')
  })

  it('records the check when the lookup answered, update or not', async () => {
    const npm = protocolNpm({ root: moduleRoot, published: '1.0.0' })

    await runCheckWrapper({ moduleDirectory: moduleRoot, runningVersion: '1.0.0', env: npm.env })

    expect(npm.installs()).toEqual([])
    expect(readUpdateState(statePath).lastCheck).toMatch(/^\d{4}-/)
  })

  it('leaves the hour unspent when the lookup did not answer', async () => {
    // The bug #197 is about, one level down: a lookup that fails has to be tried again rather
    // than counted as this hour's check.
    const npm = protocolNpm({ root: moduleRoot, viewFails: true })

    await runCheckWrapper({ moduleDirectory: moduleRoot, runningVersion: '1.0.0', env: npm.env })

    expect(npm.installs()).toEqual([])
    expect(readUpdateState(statePath).lastCheck).toBeUndefined()
  })

  it('checks npm root -g once, and remembers it beside the node that answered', async () => {
    const npm = protocolNpm({ root: moduleRoot, published: '1.0.0' })

    await runCheckWrapper({ moduleDirectory: moduleRoot, runningVersion: '1.0.0', env: npm.env })

    const state = readUpdateState(statePath)
    expect(state.globalRoot).toBe(moduleRoot)
    expect(state.globalRootNode).toBe(process.execPath)
    expect(npm.calls().filter((call) => call.startsWith('root '))).toHaveLength(1)

    await runCheckWrapper({ moduleDirectory: moduleRoot, runningVersion: '1.0.0', env: npm.env })

    expect(npm.calls().filter((call) => call.startsWith('root '))).toHaveLength(1)
  })

  it('asks npm nothing more when this oh is not the global install', async () => {
    // The other half of the check the CLI cannot do without npm: the module directory this oh
    // runs from is not the one npm names, so there is nothing here for an update to replace.
    const npm = protocolNpm({ root: join('/elsewhere', 'node_modules'), published: '9.9.9' })

    await runCheckWrapper({ moduleDirectory: moduleRoot, runningVersion: '1.0.0', env: npm.env })

    expect(npm.calls().some((call) => call.startsWith('view '))).toBe(false)
    expect(npm.installs()).toEqual([])
    expect(readUpdateState(statePath)).toMatchObject({
      globalRoot: join('/elsewhere', 'node_modules'),
    })
  })

  it('records a failed install, with the sudo/prefix case flagged', async () => {
    const npm = protocolNpm({
      root: moduleRoot,
      published: '9.9.9',
      installError: 'npm error code EACCES npm error syscall mkdir',
    })

    await runCheckWrapper({ moduleDirectory: moduleRoot, runningVersion: '1.0.0', env: npm.env })

    const state = readUpdateState(statePath)
    expect(state.result).toMatchObject({ status: 'failure', version: '9.9.9', permission: true })
    expect(state.result?.reason).toContain('npm exited with code 1')
    expect(state.result?.reason).toContain('EACCES')
    // The hour was spent: the lookup answered, so only the install failed.
    expect(state.lastCheck).toMatch(/^\d{4}-/)
  })

  it('flags nothing when the failure is not about permissions', async () => {
    const npm = protocolNpm({
      root: moduleRoot,
      published: '9.9.9',
      installError: 'npm error code E404',
    })

    await runCheckWrapper({ moduleDirectory: moduleRoot, runningVersion: '1.0.0', env: npm.env })

    expect(readUpdateState(statePath).result).toMatchObject({ status: 'failure', version: '9.9.9' })
    expect(readUpdateState(statePath).result?.permission).toBeUndefined()
  })

  it('keeps the rest of the state the CLI wrote before spawning it', async () => {
    const npm = protocolNpm({ root: moduleRoot, published: '1.4.0' })
    // What `oh update` leaves there: the global root it resolved, for this node. The check
    // writes its own fields into the same file, and may not take that away.
    writeUpdateState(statePath, { globalRoot: moduleRoot, globalRootNode: process.execPath })

    await runCheckWrapper({ moduleDirectory: moduleRoot, runningVersion: '1.0.0', env: npm.env })

    const state = readUpdateState(statePath)
    expect(state.globalRoot).toBe(moduleRoot)
    expect(state.globalRootNode).toBe(process.execPath)
    expect(state.lastCheck).toMatch(/^\d{4}-/)
    expect(state.result?.status).toBe('success')
  })

  it('survives a state file it cannot parse', async () => {
    const npm = protocolNpm({ root: moduleRoot, published: '1.4.0' })
    mkdirSync(join(directory, 'openharness'), { recursive: true })
    writeFileSync(statePath, '{oops', 'utf8')

    await runCheckWrapper({ moduleDirectory: moduleRoot, runningVersion: '1.0.0', env: npm.env })

    expect(readUpdateState(statePath).result?.status).toBe('success')
  })
})

describe('the detached check: the version it installs (#197)', () => {
  /**
   * The pairs `semver.ts` is checked against in `semver.test.ts`, driven here through the
   * wrapper's own copy of the comparator. The copy exists because the bundle is one file, so
   * the drift it could suffer is exactly what this table is for.
   */
  const pairs: readonly { running: string; published: string; installs: boolean }[] = [
    { running: '1.2.3', published: '1.2.4', installs: true },
    { running: '1.2.3', published: '1.2.3', installs: false },
    { running: '1.2.4', published: '1.2.3', installs: false },
    { running: '0.4.0-next.3', published: '0.4.0', installs: true },
    { running: '0.4.0-next.3', published: '0.4.0-next.4', installs: true },
    { running: '0.4.0', published: '0.4.0-next.3', installs: false },
    { running: '1.0.0-alpha.10', published: '1.0.0-alpha.2', installs: false },
    { running: '1.0.0-alpha.2', published: '1.0.0-alpha.10', installs: true },
    { running: '1.0.0-1', published: '1.0.0-alpha', installs: true },
    { running: '1.0.0-alpha', published: '1.0.0-1', installs: false },
    { running: '1.0.0-alpha', published: '1.0.0-alpha.1', installs: true },
    { running: '1.0.0-alpha.1', published: '1.0.0-alpha', installs: false },
    { running: '1.0.0', published: '1.0.1-alpha', installs: true },
    { running: '1.0.0', published: 'v1.0.1', installs: true },
    { running: '1.2.4', published: '1.2.4+build.1', installs: false },
    { running: '1.0.0', published: 'latest', installs: false },
    { running: 'latest', published: '1.0.0', installs: false },
  ]

  for (const pair of pairs) {
    it(`${pair.installs ? 'installs' : 'leaves alone'} ${pair.published} over ${pair.running}`, async () => {
      const npm = protocolNpm({ root: moduleRoot, published: pair.published })

      await runCheckWrapper({
        moduleDirectory: moduleRoot,
        runningVersion: pair.running,
        env: npm.env,
      })

      expect(npm.installs()).toEqual(pair.installs ? [`@openh/cli@${pair.published}`] : [])
    })
  }
})

describe('the detached check: the claim (#197)', () => {
  /** What the CLI leaves behind when it starts a check. */
  function seedClaim(claim: unknown): void {
    mkdirSync(join(directory, 'openharness'), { recursive: true })
    writeFileSync(statePath, `${JSON.stringify({ checking: claim })}\n`, 'utf8')
  }

  it('stands down when another process is already checking', async () => {
    const npm = protocolNpm({ root: moduleRoot, published: '9.9.9' })
    // This process is the live one: another `oh` started a moment ago, and it is still going.
    seedClaim({ at: new Date().toISOString(), pid: process.pid })

    await runCheckWrapper({ moduleDirectory: moduleRoot, runningVersion: '1.0.0', env: npm.env })

    expect(npm.calls()).toEqual([])
    expect(readUpdateState(statePath)).toMatchObject({ checking: { pid: process.pid } })
  })

  it('checks anyway when the claim names a process that is gone', async () => {
    // What a killed or crashed check leaves: a claim nobody holds, which must not cost the
    // next run its lookup.
    const npm = protocolNpm({ root: moduleRoot, published: '9.9.9' })
    seedClaim({ at: new Date().toISOString(), pid: await deadPid() })

    await runCheckWrapper({ moduleDirectory: moduleRoot, runningVersion: '1.0.0', env: npm.env })

    expect(npm.installs()).toEqual(['@openh/cli@9.9.9'])
  })

  it('checks anyway when the claim is too old to be believed', async () => {
    const npm = protocolNpm({ root: moduleRoot, published: '9.9.9' })
    seedClaim({ at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), pid: process.pid })

    await runCheckWrapper({ moduleDirectory: moduleRoot, runningVersion: '1.0.0', env: npm.env })

    expect(npm.installs()).toEqual(['@openh/cli@9.9.9'])
  })

  it('checks anyway when the claim names nothing', async () => {
    const npm = protocolNpm({ root: moduleRoot, published: '9.9.9' })
    seedClaim({ at: 'yesterday' })

    await runCheckWrapper({ moduleDirectory: moduleRoot, runningVersion: '1.0.0', env: npm.env })

    expect(npm.installs()).toEqual(['@openh/cli@9.9.9'])
  })

  it('drops its claim once the check is over', async () => {
    const npm = protocolNpm({ root: moduleRoot, published: '9.9.9' })
    seedClaim({ at: new Date().toISOString(), pid: await deadPid() })

    await runCheckWrapper({ moduleDirectory: moduleRoot, runningVersion: '1.0.0', env: npm.env })

    expect(readUpdateState(statePath).checking).toBeUndefined()
  })

  it('drops its claim even when the lookup did not answer', async () => {
    const npm = protocolNpm({ root: moduleRoot, viewFails: true })
    seedClaim({ at: new Date().toISOString(), pid: await deadPid() })

    await runCheckWrapper({ moduleDirectory: moduleRoot, runningVersion: '1.0.0', env: npm.env })

    expect(readUpdateState(statePath).checking).toBeUndefined()
    expect(readUpdateState(statePath).lastCheck).toBeUndefined()
  })
})

describe('spawnDetachedCheck (#197)', () => {
  it('starts the check in a process of its own, and answers its pid at once', async () => {
    const npm = protocolNpm({ root: moduleRoot, published: '1.4.0' })

    const pid = spawnDetachedCheck(
      { statePath, logPath, moduleDirectory: moduleRoot, runningVersion: '1.0.0' },
      { env: npm.env },
    )

    expect(typeof pid).toBe('number')
    // Nobody waits for it — that is the point, and the CLI is not the only process it has to
    // outlive — so the test polls for what it left behind.
    await expect(waitFor(() => readUpdateState(statePath).result)).resolves.toMatchObject({
      status: 'success',
      version: '1.4.0',
    })
    expect(npm.installs()).toEqual(['@openh/cli@1.4.0'])
  })

  it('does not hold the process that spawned it open', async () => {
    // The property the whole redesign is for (#197): a command that prints and stops gives its
    // process back in milliseconds, and the check carries on without it — so the thing to
    // measure is a process's own lifetime. The probe is TypeScript run by node's own type
    // stripping (24 runs `.ts` directly), written outside `src/` so the package's `tsc` never
    // sees it. It imports `npm.ts` alone: that module is a leaf, so node resolves it without a
    // bundler, and `spawnDetachedCheck` is the whole of what a foreground run does with npm.
    const npm = protocolNpm({ root: moduleRoot, published: '1.4.0', delaySeconds: 2 })
    const modulePath = join(process.cwd(), 'src', 'update', 'npm.ts')
    const probe = join(directory, 'probe.mts')
    writeFileSync(
      probe,
      [
        `import { spawnDetachedCheck } from ${JSON.stringify(modulePath)}`,
        'spawnDetachedCheck({',
        `  statePath: ${JSON.stringify(statePath)},`,
        `  logPath: ${JSON.stringify(logPath)},`,
        `  moduleDirectory: ${JSON.stringify(moduleRoot)},`,
        `  runningVersion: '1.0.0',`,
        '}, { env: process.env })',
        "console.log('fired')",
        '',
      ].join('\n'),
      'utf8',
    )

    const started = Date.now()
    const code = await runProbe(probe, npm.env)
    const elapsed = Date.now() - started

    expect(code).toBe(0)
    // The fake npm sleeps two seconds. A child that were not detached — or whose pipes were
    // still attached, as they were before #197 — would hold this process open for them.
    expect(elapsed).toBeLessThan(1500)
    // …and the check ran anyway, after the process that started it was gone.
    await expect(waitFor(() => readUpdateState(statePath).result)).resolves.toMatchObject({
      status: 'success',
      version: '1.4.0',
    })
    expect(npm.installs()).toEqual(['@openh/cli@1.4.0'])
  })
})
