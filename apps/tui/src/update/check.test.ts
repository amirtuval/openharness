import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DetachedCheck, UpdateRunner } from './npm'
import { checkForUpdate } from './index'
import { readUpdateState, writeUpdateState, type UpdateCheck } from './state'

/**
 * The decision a run makes about updating: the global-install gate, the throttle, the claim,
 * and the spawn it leaves behind (#157, #197).
 *
 * The npm seam is faked here — the check spawns a detached child rather than running npm, and
 * the fake stands in for the spawn — so these are fast. What the child then does with npm is
 * `npm.test.ts`'s job, driven through a real process.
 */
let root: string
let statePath: string
let logPath: string

/** A fixed clock, one hour long. */
const NOW = Date.parse('2026-10-05T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
/** The pid the fake spawner claims a child got: this process, so the claim is a live one. */
const CHILD_PID = process.pid

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oh-update-check-'))
  statePath = join(root, 'config', 'update-state.json')
  logPath = join(root, 'config', 'update.log')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A global install on disk, and the paths that describe it. */
function globalInstall(): { scriptPath: string; moduleRoot: string } {
  const moduleRoot = join(root, 'prefix', 'node_modules')
  const bundle = join(moduleRoot, '@openh', 'cli', 'dist', 'index.js')
  mkdirSync(join(moduleRoot, '@openh', 'cli', 'dist'), { recursive: true })
  writeFileSync(bundle, '// the built bundle, standing in\n')
  return { scriptPath: bundle, moduleRoot }
}

/** The built checkout's bundle, which is not anybody's global install. */
function checkout(): string {
  const bundle = join(root, 'apps', 'tui', 'dist', 'index.js')
  mkdirSync(join(root, 'apps', 'tui', 'dist'), { recursive: true })
  writeFileSync(bundle, '// built from a checkout\n')
  return bundle
}

/** What a fake npm run was asked, and what it answered. */
interface RunnerSpec {
  readonly globalRoot?: string | undefined
  readonly rootFails?: boolean | undefined
  /** The pid the fake spawner reports, or `undefined` for a child that could not start. */
  readonly pid?: number | undefined
}

interface Recorder {
  readonly runner: UpdateRunner
  readonly calls: { resolve: number; spawns: DetachedCheck[] }
}

/** An npm that answers what the test says, and remembers what it was asked. */
function createRunner(spec: RunnerSpec = {}): Recorder {
  const calls = { resolve: 0, spawns: [] as DetachedCheck[] }
  const runner: UpdateRunner = {
    resolveGlobalRoot() {
      calls.resolve += 1
      if (spec.rootFails === true)
        return Promise.resolve({ ok: false, output: '', detail: 'no npm' })
      return Promise.resolve({ ok: true, output: spec.globalRoot ?? '', detail: '' })
    },
    startDetachedCheck(check) {
      calls.spawns.push(check)
      return 'pid' in spec ? spec.pid : CHILD_PID
    },
  }
  return { runner, calls }
}

/** Run the check for a layout, returning what it was asked to do. */
function check(options: {
  scriptPath: string
  runningVersion?: string
  spec?: RunnerSpec
  lastCheck?: string
  globalRootNode?: string
  globalRoot?: string
  checking?: UpdateCheck
}): Recorder {
  const { runner, calls } = createRunner(options.spec)
  const seeded: {
    lastCheck?: string
    checking?: UpdateCheck
    globalRoot?: string
    globalRootNode?: string
  } = {}
  if (options.lastCheck !== undefined) seeded.lastCheck = options.lastCheck
  if (options.checking !== undefined) seeded.checking = options.checking
  if (options.globalRoot !== undefined) {
    seeded.globalRoot = options.globalRoot
    seeded.globalRootNode = options.globalRootNode ?? process.execPath
  }
  if (Object.keys(seeded).length > 0) writeUpdateState(statePath, seeded)

  checkForUpdate({
    env: {},
    statePath,
    logPath,
    runningVersion: options.runningVersion ?? '1.0.0',
    scriptPath: options.scriptPath,
    runner,
    now: () => NOW,
  })

  return { runner, calls }
}

/** The claim the check leaves behind, for reading the state file's own shape. */
function claim(): UpdateCheck | undefined {
  return readUpdateState(statePath).checking
}

describe('checkForUpdate: the global-install gate', () => {
  it('does nothing at all for a checkout, without spawning anything', () => {
    const { calls } = check({ scriptPath: checkout() })

    expect(calls).toEqual({ resolve: 0, spawns: [] })
    expect(readUpdateState(statePath)).toEqual({})
  })

  it("does nothing for a package that is not npm's global one, once that is known", () => {
    const { scriptPath } = globalInstall()
    const elsewhere = join(root, 'elsewhere', 'node_modules')
    mkdirSync(elsewhere, { recursive: true })

    const { calls } = check({
      scriptPath,
      // A previous check cached npm's answer — the same node, so it still holds.
      globalRoot: elsewhere,
    })

    expect(calls.spawns).toEqual([])
  })

  it('leaves the global-install question to the child when npm has not been asked yet', () => {
    // Nothing cached: only the child can ask npm where its global root is, and it caches the
    // answer there, so this is the one spawn a package that is *not* the global install costs.
    const { scriptPath, moduleRoot } = globalInstall()

    const { calls } = check({ scriptPath })

    expect(calls.resolve).toBe(0)
    expect(calls.spawns).toEqual([
      {
        statePath,
        logPath,
        moduleDirectory: moduleRoot,
        runningVersion: '1.0.0',
      },
    ])
  })

  it('hands the child the module directory, not the whole bundle path', () => {
    const { scriptPath, moduleRoot } = globalInstall()

    const { calls } = check({ scriptPath })

    expect(calls.spawns[0]?.moduleDirectory).toBe(moduleRoot)
  })
})

describe('checkForUpdate: the spawn and the claim', () => {
  it('claims the check under the pid of the child it started', () => {
    const { scriptPath } = globalInstall()

    check({ scriptPath })

    expect(claim()).toEqual({ at: new Date(NOW).toISOString(), pid: CHILD_PID })
  })

  it('claims nothing when no child could be started', () => {
    // A spawn that failed holds nobody back: the next run spawns its own.
    const { scriptPath } = globalInstall()

    check({ scriptPath, spec: { pid: undefined } })

    expect(claim()).toBeUndefined()
  })

  it('leaves the claim alone, and spawns nothing, while a check is in progress', () => {
    const { scriptPath } = globalInstall()
    const inProgress = { at: new Date(NOW - 1_000).toISOString(), pid: process.pid }

    const { calls } = check({ scriptPath, checking: inProgress })

    expect(calls.spawns).toEqual([])
    expect(claim()).toEqual(inProgress)
  })

  it("checks again when the claim's process is gone", () => {
    // A check that was killed, or a machine that went down mid-check: the claim is not a
    // reason to skip an hour.
    const { scriptPath } = globalInstall()

    const { calls } = check({
      scriptPath,
      checking: { at: new Date(NOW - 1_000).toISOString(), pid: 2 ** 31 - 1 },
    })

    expect(calls.spawns).toHaveLength(1)
  })
})

describe('checkForUpdate: the throttle', () => {
  it('does not check again within the hour', () => {
    const { scriptPath } = globalInstall()

    const { calls } = check({
      scriptPath,
      lastCheck: new Date(NOW - HOUR + 1).toISOString(),
    })

    expect(calls.spawns).toEqual([])
  })

  it('checks again once the hour is up', () => {
    const { scriptPath } = globalInstall()

    const { calls } = check({ scriptPath, lastCheck: new Date(NOW - HOUR).toISOString() })

    expect(calls.spawns).toHaveLength(1)
  })

  it('reads the throttle before the claim, so a spent hour never reaches the state write', () => {
    const { scriptPath } = globalInstall()

    check({ scriptPath, lastCheck: new Date(NOW).toISOString() })

    // Nothing was claimed and nothing was spawned: the hour was already spent, so this run
    // did not so much as touch the state file.
    expect(claim()).toBeUndefined()
    expect(readUpdateState(statePath).lastCheck).toBe(new Date(NOW).toISOString())
  })
})

describe('checkForUpdate: it never breaks the command', () => {
  it('swallows a runner that throws', () => {
    const { scriptPath } = globalInstall()
    const runner: UpdateRunner = {
      resolveGlobalRoot() {
        throw new Error('npm is not there')
      },
      startDetachedCheck() {
        throw new Error('no spawn either')
      },
    }

    expect(() => {
      checkForUpdate({
        env: {},
        statePath,
        logPath,
        runningVersion: '1.0.0',
        scriptPath,
        runner,
        now: () => NOW,
      })
    }).not.toThrow()
  })

  it('swallows a state file it cannot write', () => {
    const { scriptPath } = globalInstall()
    // A state path under a file, so neither the read nor the write can work.
    const blocked = join(root, 'not-a-directory', 'update-state.json')
    writeFileSync(join(root, 'not-a-directory'), 'in the way\n', 'utf8')

    expect(() => {
      checkForUpdate({
        env: {},
        statePath: blocked,
        logPath,
        runningVersion: '1.0.0',
        scriptPath,
        runner: createRunner().runner,
        now: () => NOW,
      })
    }).not.toThrow()
  })
})
