import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { UpdateResult } from './state'
import {
  consumeUpdateResult,
  patchUpdateState,
  readUpdateState,
  updateLogPath,
  updateStatePath,
  writeUpdateState,
} from './state'

let directory: string
let statePath: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'oh-update-state-'))
  statePath = join(directory, 'openharness', 'update-state.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** A successful install, as the detached wrapper records it. */
function success(version = '0.4.0'): UpdateResult {
  return { status: 'success', version, at: '2026-10-05T12:00:00.000Z' }
}

/** Write raw text at the state path, creating the directory, the way a broken file looks. */
function seed(contents: string): void {
  mkdirSync(join(directory, 'openharness'), { recursive: true })
  writeFileSync(statePath, contents, 'utf8')
}

describe('paths', () => {
  it('live under the openharness config directory, like the config and credentials files', () => {
    expect(updateStatePath({ XDG_CONFIG_HOME: '/tmp/xdg' })).toBe(
      '/tmp/xdg/openharness/update-state.json',
    )
    expect(updateLogPath({ XDG_CONFIG_HOME: '/tmp/xdg' })).toBe('/tmp/xdg/openharness/update.log')
  })

  it('ignore a relative XDG_CONFIG_HOME, as the config file does', () => {
    expect(updateStatePath({ XDG_CONFIG_HOME: 'relative' })).toMatch(
      /\/\.config\/openharness\/update-state\.json$/,
    )
  })
})

describe('readUpdateState', () => {
  it('is empty when there is no file', () => {
    expect(readUpdateState(statePath)).toEqual({})
  })

  it('reads back what was written', () => {
    writeUpdateState(statePath, {
      lastCheck: '2026-10-05T12:00:00.000Z',
      checking: { at: '2026-10-05T12:00:00.000Z', pid: 4242 },
      globalRoot: '/usr/local/lib/node_modules',
      globalRootNode: '/usr/bin/node',
      result: success(),
    })

    expect(readUpdateState(statePath)).toEqual({
      lastCheck: '2026-10-05T12:00:00.000Z',
      checking: { at: '2026-10-05T12:00:00.000Z', pid: 4242 },
      globalRoot: '/usr/local/lib/node_modules',
      globalRootNode: '/usr/bin/node',
      result: success(),
    })
  })

  it('creates the directory and leaves a readable file behind', () => {
    expect(writeUpdateState(statePath, { lastCheck: '2026-10-05T12:00:00.000Z' })).toBe(true)
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
      lastCheck: '2026-10-05T12:00:00.000Z',
    })
  })

  it('answers empty for a file that cannot be used, never throwing', () => {
    // The state file is a cache: every one of these is "nothing to remember", not an error
    // that may fail the command the user actually typed.
    for (const contents of ['', '{oops', 'null', '"a string"', '[1,2,3]', '42']) {
      seed(contents)
      expect(readUpdateState(statePath), contents).toEqual({})
    }
  })

  it('drops fields of the wrong type, keeping the ones it can use', () => {
    seed(JSON.stringify({ lastCheck: 42, globalRoot: '/g', result: { status: 'nope' } }))

    expect(readUpdateState(statePath)).toEqual({ globalRoot: '/g' })
  })

  it('keeps a check claim, and drops one that names no time (#197)', () => {
    seed(JSON.stringify({ checking: { at: '2026-10-05T12:00:00.000Z', pid: 4242 } }))
    expect(readUpdateState(statePath).checking).toEqual({
      at: '2026-10-05T12:00:00.000Z',
      pid: 4242,
    })

    // The pid is what says the claim still holds; without one it is read as stale rather than
    // as a file that cannot be used.
    seed(JSON.stringify({ checking: { at: '2026-10-05T12:00:00.000Z' } }))
    expect(readUpdateState(statePath).checking).toEqual({ at: '2026-10-05T12:00:00.000Z' })

    for (const checking of [undefined, null, 'now', 42, [], { pid: 1 }, { at: '' }, { at: 42 }]) {
      seed(JSON.stringify({ checking }))
      expect(readUpdateState(statePath), JSON.stringify(checking)).toEqual({})
    }
  })

  it('drops a result that is missing what the notice needs', () => {
    seed(JSON.stringify({ result: { status: 'success' } }))
    expect(readUpdateState(statePath)).toEqual({})

    seed(JSON.stringify({ result: { status: 'success', version: '1.0.0', at: '' } }))
    expect(readUpdateState(statePath)).toEqual({})
  })

  it('keeps a failure with its reason and permission flag', () => {
    const failure: UpdateResult = {
      status: 'failure',
      version: '0.4.0',
      reason: 'npm exited with code 1: EACCES',
      permission: true,
      at: '2026-10-05T12:00:00.000Z',
    }
    seed(JSON.stringify({ result: failure }))

    expect(readUpdateState(statePath).result).toEqual(failure)
  })
})

describe('patchUpdateState', () => {
  it('merges into what is on disk rather than replacing it', () => {
    writeUpdateState(statePath, { lastCheck: '2026-10-05T12:00:00.000Z' })

    patchUpdateState(statePath, { globalRoot: '/usr/local/lib/node_modules' })

    expect(readUpdateState(statePath)).toEqual({
      lastCheck: '2026-10-05T12:00:00.000Z',
      globalRoot: '/usr/local/lib/node_modules',
    })
  })

  it('starts over from a file it cannot read', () => {
    seed('{oops')

    expect(patchUpdateState(statePath, { lastCheck: 'now' })).toEqual({ lastCheck: 'now' })
  })
})

describe('consumeUpdateResult', () => {
  it('hands the result over once and leaves nothing behind', () => {
    writeUpdateState(statePath, { lastCheck: '2026-10-05T12:00:00.000Z', result: success() })

    expect(consumeUpdateResult(statePath)).toEqual(success())
    // The second call is what makes the notice once-only.
    expect(consumeUpdateResult(statePath)).toBeUndefined()
    // The rest of the state survives: the next check's throttle is not reset by reporting.
    expect(readUpdateState(statePath)).toEqual({ lastCheck: '2026-10-05T12:00:00.000Z' })
  })

  it('is undefined when there is no pending result', () => {
    expect(consumeUpdateResult(statePath)).toBeUndefined()
    writeUpdateState(statePath, { lastCheck: 'now' })
    expect(consumeUpdateResult(statePath)).toBeUndefined()
  })
})
