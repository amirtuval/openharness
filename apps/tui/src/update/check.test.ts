import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { checkForUpdate } from './index'
import type { UpdateRunner } from './npm'
import { readUpdateState, writeUpdateState } from './state'

/**
 * The background check's decisions: the global-install gate, the throttle, the version
 * comparison, and what it leaves in the state file. The npm seam is faked here, so these are
 * fast — the real spawn is `npm.test.ts`'s job.
 */
let root: string
let statePath: string
let logPath: string

/** A fixed clock, one hour long. */
const NOW = Date.parse('2026-10-05T12:00:00.000Z')
const HOUR = 60 * 60 * 1000

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

/** What a fake npm was asked, and what it answered. */
interface RunnerSpec {
  readonly globalRoot?: string | undefined
  readonly published?: string | undefined
  readonly rootFails?: boolean | undefined
  readonly viewFails?: boolean | undefined
  readonly throws?: boolean | undefined
}

interface Recorder {
  readonly runner: UpdateRunner
  readonly calls: { resolve: number; view: number; install: readonly string[] }
}

/** An npm that answers what the test says, and remembers what it was asked. */
function createRunner(spec: RunnerSpec = {}): Recorder {
  const calls = { resolve: 0, view: 0, install: [] as string[] }
  const runner: UpdateRunner = {
    resolveGlobalRoot() {
      calls.resolve += 1
      if (spec.throws === true) return Promise.reject(new Error('npm is not there'))
      if (spec.rootFails === true)
        return Promise.resolve({ ok: false, output: '', detail: 'no npm' })
      return Promise.resolve({ ok: true, output: spec.globalRoot ?? '', detail: '' })
    },
    viewPublishedVersion() {
      calls.view += 1
      if (spec.throws === true) return Promise.reject(new Error('npm is not there'))
      if (spec.viewFails === true)
        return Promise.resolve({ ok: false, output: '', detail: 'offline' })
      return Promise.resolve({ ok: true, output: spec.published ?? '1.0.0', detail: '' })
    },
    startDetachedInstall(version) {
      calls.install.push(version)
      return true
    },
  }
  return { runner, calls }
}

/** Run the check for a layout, returning what it was asked to install. */
async function check(options: {
  scriptPath: string
  runningVersion?: string
  spec?: RunnerSpec
  lastCheck?: string
  globalRootNode?: string
}): Promise<Recorder> {
  const { runner, calls } = createRunner(options.spec)
  if (options.lastCheck !== undefined || options.globalRootNode !== undefined) {
    writeUpdateState(statePath, {
      ...(options.lastCheck === undefined ? {} : { lastCheck: options.lastCheck }),
      ...(options.globalRootNode === undefined
        ? {}
        : { globalRoot: options.spec?.globalRoot, globalRootNode: options.globalRootNode }),
    })
  }

  await checkForUpdate({
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

describe('checkForUpdate: the global-install gate', () => {
  it('does nothing at all for a checkout, without asking npm anything', async () => {
    const { calls } = await check({ scriptPath: checkout(), spec: { published: '2.0.0' } })

    expect(calls).toEqual({ resolve: 0, view: 0, install: [] })
    expect(readUpdateState(statePath)).toEqual({})
  })

  it("does nothing for a package that is not npm's global one", async () => {
    const { scriptPath } = globalInstall()
    const elsewhere = join(root, 'elsewhere', 'node_modules')
    mkdirSync(elsewhere, { recursive: true })

    const { calls } = await check({
      scriptPath,
      spec: { globalRoot: elsewhere, published: '2.0.0' },
    })

    expect(calls.resolve).toBe(1)
    expect(calls.view).toBe(0)
    expect(calls.install).toEqual([])
    // It still learned where npm puts global packages, which is reusable.
    expect(readUpdateState(statePath).globalRoot).toBe(elsewhere)
  })
})

describe('checkForUpdate: the version decision', () => {
  it('starts a detached install when npm has a newer version', async () => {
    const { scriptPath, moduleRoot } = globalInstall()

    const { calls } = await check({
      scriptPath,
      runningVersion: '1.0.0',
      spec: { globalRoot: moduleRoot, published: '1.4.0' },
    })

    expect(calls.install).toEqual(['1.4.0'])
    expect(readUpdateState(statePath).lastCheck).toBe(new Date(NOW).toISOString())
  })

  it('does nothing when the running version is the published one', async () => {
    const { scriptPath, moduleRoot } = globalInstall()

    const { calls } = await check({
      scriptPath,
      runningVersion: '1.4.0',
      spec: { globalRoot: moduleRoot, published: '1.4.0' },
    })

    expect(calls.view).toBe(1)
    expect(calls.install).toEqual([])
  })

  it('does nothing when npm prints something that is not a version', async () => {
    const { scriptPath, moduleRoot } = globalInstall()

    const { calls } = await check({
      scriptPath,
      spec: { globalRoot: moduleRoot, published: 'latest' },
    })

    expect(calls.install).toEqual([])
  })

  it('does nothing when the lookup failed', async () => {
    const { scriptPath, moduleRoot } = globalInstall()

    const { calls } = await check({
      scriptPath,
      spec: { globalRoot: moduleRoot, viewFails: true },
    })

    expect(calls.view).toBe(1)
    expect(calls.install).toEqual([])
  })
})

describe('checkForUpdate: the throttle', () => {
  it("records the check before making it, so a failure still counts as this hour's", async () => {
    const { scriptPath, moduleRoot } = globalInstall()

    await check({ scriptPath, spec: { globalRoot: moduleRoot, viewFails: true } })

    expect(readUpdateState(statePath).lastCheck).toBe(new Date(NOW).toISOString())
  })

  it('does not check again within the hour', async () => {
    const { scriptPath, moduleRoot } = globalInstall()

    const { calls } = await check({
      scriptPath,
      spec: { globalRoot: moduleRoot, published: '2.0.0' },
      lastCheck: new Date(NOW - HOUR + 1).toISOString(),
      globalRootNode: process.execPath,
    })

    expect(calls.view).toBe(0)
    expect(calls.install).toEqual([])
    // The cached global root meant no npm at all was spawned before the throttle was read.
    expect(calls.resolve).toBe(0)
  })

  it('checks again once the hour is up', async () => {
    const { scriptPath, moduleRoot } = globalInstall()

    const { calls } = await check({
      scriptPath,
      spec: { globalRoot: moduleRoot, published: '2.0.0' },
      lastCheck: new Date(NOW - HOUR).toISOString(),
      globalRootNode: process.execPath,
    })

    expect(calls.view).toBe(1)
    expect(calls.install).toEqual(['2.0.0'])
  })
})

describe('checkForUpdate: the cached global root', () => {
  it('asks npm root -g once and reuses the answer', async () => {
    const { scriptPath, moduleRoot } = globalInstall()
    const spec = { globalRoot: moduleRoot, published: '1.0.0' }

    const first = await check({ scriptPath, spec })
    expect(first.calls.resolve).toBe(1)

    const second = await check({ scriptPath, spec })
    expect(second.calls.resolve).toBe(0)
  })

  it('resolves it again when the node running oh is not the one it cached', async () => {
    const { scriptPath, moduleRoot } = globalInstall()

    const { calls } = await check({
      scriptPath,
      spec: { globalRoot: moduleRoot, published: '1.0.0' },
      lastCheck: new Date(NOW).toISOString(),
      globalRootNode: '/some/other/node',
    })

    expect(calls.resolve).toBe(1)
  })
})

describe('checkForUpdate: it never breaks the command', () => {
  it('swallows a runner that throws', async () => {
    const { scriptPath } = globalInstall()

    const { calls } = await check({ scriptPath, spec: { throws: true } })

    expect(calls.install).toEqual([])
    expect(readUpdateState(statePath).globalRoot).toBeUndefined()
  })

  it('swallows npm root -g failing', async () => {
    const { scriptPath } = globalInstall()

    const { calls } = await check({ scriptPath, spec: { rootFails: true } })

    expect(calls.view).toBe(0)
    expect(readUpdateState(statePath).globalRoot).toBeUndefined()
  })
})
