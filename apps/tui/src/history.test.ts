import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { historyFilePath, HISTORY_LIMIT, openHistory, type PromptHistory } from './history'

const SERVER = 'http://localhost:3000'
const OTHER_SERVER = 'https://oh.example.test'
const USER = 'user_ana'
const OTHER_USER = 'user_bob'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'oh-history-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** The file every test in this file writes to. */
function path(): string {
  return join(directory, 'history.json')
}

/** Open the store for one server and user, over the temp directory's file. */
function storeAt(
  options: { readonly server?: string; readonly user?: string; readonly name?: string } = {},
): PromptHistory {
  return openHistory({
    path: join(directory, options.name ?? 'history.json'),
    server: options.server ?? SERVER,
    user: options.user ?? USER,
  })
}

/** What the file holds, as written. */
function fileContents(): string {
  return readFileSync(path(), 'utf8')
}

describe('openHistory', () => {
  it('starts empty when there is no file', () => {
    expect(storeAt().entries()).toEqual([])
  })

  it('remembers what was added, oldest first', () => {
    const history = storeAt()
    history.add('first')
    history.add('second')

    expect(history.entries()).toEqual(['first', 'second'])
    // A second store over the same file sees the same list: it was written, not just held.
    expect(storeAt().entries()).toEqual(['first', 'second'])
  })

  it('drops a line that repeats the one before it', () => {
    const history = storeAt()
    history.add('same')
    history.add('same')
    history.add('other')
    history.add('same')

    expect(history.entries()).toEqual(['same', 'other', 'same'])
  })

  it('never records a line the caller marked as not-to-record', () => {
    const history = storeAt()
    history.add('what is the weather')
    // The hidden-input seam (#206, X7): the API key `oh` will ask for (#207) goes through
    // this same call, and a secret must not reach the file.
    history.add('sk-live-do-not-keep', { record: false })

    expect(history.entries()).toEqual(['what is the weather'])
    expect(fileContents()).not.toContain('sk-live-do-not-keep')
  })

  it('ignores an empty or whitespace-only line', () => {
    const history = storeAt()
    history.add('')
    history.add('   ')
    history.add('kept')

    expect(history.entries()).toEqual(['kept'])
  })

  it('keeps the last HISTORY_LIMIT entries and drops the oldest', () => {
    const history = storeAt()
    for (let index = 0; index < HISTORY_LIMIT + 20; index += 1) {
      history.add(`prompt ${String(index)}`)
    }

    const entries = storeAt().entries()
    expect(entries).toHaveLength(HISTORY_LIMIT)
    expect(entries[0]).toBe('prompt 20')
    expect(entries[entries.length - 1]).toBe(`prompt ${String(HISTORY_LIMIT + 19)}`)
  })
})

describe('openHistory keys', () => {
  it('keeps a list per server', () => {
    storeAt().add('on localhost')
    const other = openHistory({ path: path(), server: OTHER_SERVER, user: USER })
    other.add('on production')

    expect(storeAt().entries()).toEqual(['on localhost'])
    expect(openHistory({ path: path(), server: OTHER_SERVER, user: USER }).entries()).toEqual([
      'on production',
    ])
  })

  it('keeps a list per user on the same server', () => {
    storeAt().add('ana wrote this')
    openHistory({ path: path(), server: SERVER, user: OTHER_USER }).add('bob wrote this')

    // Adding Bob's line left Ana's alone — and Bob does not see it.
    expect(storeAt().entries()).toEqual(['ana wrote this'])
    expect(openHistory({ path: path(), server: SERVER, user: OTHER_USER }).entries()).toEqual([
      'bob wrote this',
    ])
  })
})

describe('openHistory file', () => {
  it('writes it 0600 in a 0700 directory', () => {
    const nested = join(directory, 'openharness')
    openHistory({ path: join(nested, 'history.json'), server: SERVER, user: USER }).add('hi')

    expect(statSync(join(nested, 'history.json')).mode & 0o777).toBe(0o600)
    expect(statSync(nested).mode & 0o777).toBe(0o700)
  })

  it('writes the servers and users in order, so the file is stable between runs', () => {
    openHistory({ path: path(), server: OTHER_SERVER, user: OTHER_USER }).add('one')
    openHistory({ path: path(), server: SERVER, user: OTHER_USER }).add('two')
    storeAt().add('three')

    const parsed = JSON.parse(fileContents()) as { servers: Record<string, object> }
    expect(Object.keys(parsed.servers)).toEqual([SERVER, OTHER_SERVER])
    expect(Object.keys(parsed.servers[SERVER] ?? {})).toEqual([USER, OTHER_USER])
  })

  it('starts empty rather than failing on a file that is not JSON', () => {
    writeFileSync(path(), '{ not json')

    expect(storeAt().entries()).toEqual([])
    // …and the next write replaces it, so the damage does not last.
    storeAt().add('after')
    expect(storeAt().entries()).toEqual(['after'])
  })

  it('ignores a file whose shape is wrong', () => {
    writeFileSync(path(), JSON.stringify({ servers: { [SERVER]: { [USER]: 'not a list' } } }))

    expect(storeAt().entries()).toEqual([])
  })

  it('drops entries that are not strings', () => {
    writeFileSync(
      path(),
      JSON.stringify({ servers: { [SERVER]: { [USER]: ['good', 7, null, 'also good'] } } }),
    )

    expect(storeAt().entries()).toEqual(['good', 'also good'])
  })

  it('keeps working when the file cannot be written', () => {
    // A directory where the file should be: the write fails every time.
    mkdirSync(path())
    const history = storeAt()

    expect(() => {
      history.add('hi')
    }).not.toThrow()
    // The chat is the point: the entry is lost, the prompt is not.
    expect(history.entries()).toEqual(['hi'])
  })
})

describe('historyFilePath', () => {
  it('lives beside the config and credentials files, under the XDG config home', () => {
    expect(historyFilePath({ XDG_CONFIG_HOME: '/tmp/oh-config' })).toBe(
      '/tmp/oh-config/openharness/history.json',
    )
  })

  it('ignores an XDG_CONFIG_HOME that is not absolute', () => {
    expect(historyFilePath({ XDG_CONFIG_HOME: 'relative/path' })).toMatch(
      /\/\.config\/openharness\/history\.json$/u,
    )
  })
})
