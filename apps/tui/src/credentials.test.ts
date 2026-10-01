import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { credentialsFilePath, openCredentials, type CredentialStore } from './credentials'

const SERVER = 'http://localhost:3000'
const OTHER_SERVER = 'https://oh.example.test'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'oh-credentials-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** Open the store for a file in the temp directory. */
function storeAt(name = 'credentials.json'): CredentialStore {
  const outcome = openCredentials({ path: join(directory, name) })
  if (!outcome.ok) throw new Error(`expected a store, got: ${outcome.error}`)
  return outcome.store
}

/** The message an open that failed reported. */
function openError(contents: string): string {
  const path = join(directory, 'credentials.json')
  writeFileSync(path, contents)
  const outcome = openCredentials({ path })
  if (outcome.ok) throw new Error('expected a failure')
  return outcome.error
}

/** The parsed file, as a test reads it back. */
function readJson(path: string): { servers: Record<string, string> } {
  return JSON.parse(readFileSync(path, 'utf8')) as { servers: Record<string, string> }
}

/** The file's permission bits, e.g. `0o600`. */
function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

describe('credentialsFilePath', () => {
  it('uses XDG_CONFIG_HOME when it is set', () => {
    expect(credentialsFilePath({ XDG_CONFIG_HOME: '/tmp/xdg' })).toBe(
      '/tmp/xdg/openharness/credentials.json',
    )
  })

  it('ignores a relative XDG_CONFIG_HOME', () => {
    expect(credentialsFilePath({ XDG_CONFIG_HOME: 'xdg' })).toMatch(
      /\/\.config\/openharness\/credentials\.json$/u,
    )
  })

  it('falls back to ~/.config', () => {
    expect(credentialsFilePath({})).toMatch(/\/\.config\/openharness\/credentials\.json$/u)
  })
})

describe('openCredentials', () => {
  it('is fine with no file: nobody has signed in', () => {
    const store = storeAt()
    expect(store.tokenFor(SERVER)).toBeUndefined()
  })

  it('stores a token, creating the file 0600 and the directory 0700', () => {
    const store = storeAt()
    store.save(SERVER, 'oh_session_abc')

    const path = join(directory, 'credentials.json')
    expect(store.tokenFor(SERVER)).toBe('oh_session_abc')
    expect(readJson(path)).toEqual({ servers: { [SERVER]: 'oh_session_abc' } })
    expect(modeOf(path)).toBe(0o600)
    expect(modeOf(directory)).toBe(0o700)
  })

  it('tightens the permissions of an existing, world-readable file', () => {
    const path = join(directory, 'credentials.json')
    writeFileSync(path, '{ "servers": {} }', { mode: 0o644 })
    chmodSync(path, 0o644)

    storeAt().save(SERVER, 'token')

    expect(modeOf(path)).toBe(0o600)
  })

  it('creates missing parent directories', () => {
    const path = join(directory, 'nested', 'deeper', 'credentials.json')
    const outcome = openCredentials({ path })
    if (!outcome.ok) throw new Error(outcome.error)

    outcome.store.save(SERVER, 'token')

    expect(modeOf(path)).toBe(0o600)
    expect(modeOf(join(directory, 'nested', 'deeper'))).toBe(0o700)
  })

  it('leaves no temp file behind', () => {
    storeAt().save(SERVER, 'token')
    expect(readdirSync(directory)).toEqual(['credentials.json'])
  })

  it('replaces the token of a server', () => {
    const store = storeAt()
    store.save(SERVER, 'first')
    store.save(SERVER, 'second')

    expect(store.tokenFor(SERVER)).toBe('second')
    expect(readJson(join(directory, 'credentials.json')).servers).toEqual({ [SERVER]: 'second' })
  })

  it('keeps a token per server, and reads them back in a new store', () => {
    const store = storeAt()
    store.save(SERVER, 'token-one')
    store.save(OTHER_SERVER, 'token-two')

    const reopened = storeAt()
    expect(reopened.tokenFor(SERVER)).toBe('token-one')
    expect(reopened.tokenFor(OTHER_SERVER)).toBe('token-two')
  })

  it('removes one server and leaves the rest', () => {
    const store = storeAt()
    store.save(SERVER, 'token-one')
    store.save(OTHER_SERVER, 'token-two')

    store.remove(SERVER)

    expect(store.tokenFor(SERVER)).toBeUndefined()
    expect(store.tokenFor(OTHER_SERVER)).toBe('token-two')
    expect(readJson(join(directory, 'credentials.json')).servers).toEqual({
      [OTHER_SERVER]: 'token-two',
    })
  })

  it('removes a server that was never signed in: a no-op', () => {
    const store = storeAt()
    store.save(SERVER, 'token')

    store.remove(OTHER_SERVER)

    expect(store.tokenFor(SERVER)).toBe('token')
  })

  it('refuses to store an empty token', () => {
    const store = storeAt()
    expect(() => {
      store.save(SERVER, '  ')
    }).toThrowError(/empty token/u)
  })

  it('names the file when it is not JSON', () => {
    const error = openError('{oops')
    expect(error).toContain('credentials.json')
    expect(error).toContain('invalid JSON')
  })

  it('names the file when it is not an object', () => {
    expect(openError('["servers"]')).toContain('must hold a JSON object')
    expect(openError('null')).toContain('must hold a JSON object')
  })

  it('rejects a key it does not know', () => {
    const error = openError('{ "sessions": {} }')
    expect(error).toContain("'sessions'")
    expect(error).toContain("'servers'")
  })

  it('rejects a token of the wrong type', () => {
    expect(openError(`{ "servers": { "${SERVER}": 5 } }`)).toContain('must be a string')
  })

  it('rejects an empty token in the file', () => {
    expect(openError(`{ "servers": { "${SERVER}": "  " } }`)).toContain('is empty')
  })

  it('reports a file it cannot read, naming the path', () => {
    const path = join(directory, 'as-a-directory')
    mkdirSync(path)

    const outcome = openCredentials({ path })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain(path)
      expect(outcome.error).toContain('could not read')
    }
  })
})
