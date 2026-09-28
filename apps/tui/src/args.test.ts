import { describe, expect, it } from 'vitest'
import { parseArgs } from './args'
import { readVersion } from './version'

describe('parseArgs', () => {
  it('recognises --version', () => {
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' })
  })

  it('recognises --help', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' })
  })

  it('falls back to the app', () => {
    expect(parseArgs([])).toEqual({ kind: 'app', args: [] })
  })
})

describe('readVersion', () => {
  it('reads the version from this package.json', () => {
    expect(readVersion()).toBe('0.0.0')
  })
})
