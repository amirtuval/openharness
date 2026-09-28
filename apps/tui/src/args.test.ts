import { describe, expect, it } from 'vitest'

import { parseArgs } from './args'
import { readVersion } from './version'

/** The parsed command, failing the test with the error message when there is not one. */
function commandOf(argv: readonly string[]) {
  const outcome = parseArgs(argv)
  if (!outcome.ok) throw new Error(`expected a command, got: ${outcome.error}`)
  return outcome.command
}

/** The message a command line fails with. */
function errorOf(argv: readonly string[]): string {
  const outcome = parseArgs(argv)
  if (outcome.ok) throw new Error(`expected an error, got: ${outcome.command.kind}`)
  return outcome.error
}

describe('parseArgs', () => {
  it('takes no arguments as a new chat', () => {
    expect(commandOf([])).toMatchObject({
      kind: 'chat',
      options: { debug: false, continue: false },
    })
  })

  it('reads the chat flags, long and short', () => {
    const session = commandOf(['--session', 'sesn_1'])
    expect(session).toMatchObject({ kind: 'chat', options: { session: 'sesn_1', continue: false } })

    const shortSession = commandOf(['-s', 'sesn_1'])
    expect(shortSession).toMatchObject({ kind: 'chat', options: { session: 'sesn_1' } })

    const continued = commandOf(['-c'])
    expect(continued).toMatchObject({ kind: 'chat', options: { continue: true } })

    const agent = commandOf(['--agent', 'Summarizer'])
    expect(agent).toMatchObject({ kind: 'chat', options: { agent: 'Summarizer' } })

    const server = commandOf(['--server', 'http://example.test', '--api-key', 'oh_key'])
    expect(server).toMatchObject({
      kind: 'chat',
      options: { server: 'http://example.test', apiKey: 'oh_key' },
    })
  })

  it('reads --session=<id> and -s<id> too', () => {
    expect(commandOf(['--session=sesn_2'])).toMatchObject({
      kind: 'chat',
      options: { session: 'sesn_2' },
    })
    expect(commandOf(['-ssesn_3'])).toMatchObject({
      kind: 'chat',
      options: { session: 'sesn_3' },
    })
  })

  it('recognises the listings', () => {
    expect(commandOf(['sessions'])).toEqual({
      kind: 'sessions',
      options: { debug: false, server: undefined, apiKey: undefined },
    })
    expect(commandOf(['agents'])).toMatchObject({ kind: 'agents' })
  })

  it('recognises --version and --help, short too', () => {
    expect(commandOf(['--version'])).toEqual({ kind: 'version' })
    expect(commandOf(['-v'])).toEqual({ kind: 'version' })
    expect(commandOf(['--help'])).toEqual({ kind: 'help' })
    expect(commandOf(['-h'])).toEqual({ kind: 'help' })
  })

  it('lets --help win over a command', () => {
    expect(commandOf(['sessions', '--help'])).toEqual({ kind: 'help' })
  })

  it('rejects an unknown flag with something to read', () => {
    const error = errorOf(['--nope'])
    expect(error).toContain('--nope')
    expect(error).toContain('oh --help')
  })

  it('rejects a flag that needs a value and did not get one', () => {
    expect(errorOf(['--session'])).toContain('--session')
  })

  it('rejects an unknown command', () => {
    const error = errorOf(['chat'])
    expect(error).toContain("unknown command 'chat'")
    expect(error).toContain('sessions, agents')
  })

  it('rejects arguments after a listing command', () => {
    expect(errorOf(['sessions', 'extra'])).toContain('takes no arguments')
  })

  it('rejects --session with --continue', () => {
    expect(errorOf(['--session', 'sesn_1', '--continue'])).toContain(
      'either --session <id> or --continue',
    )
  })

  it('rejects chat-only flags on the listings', () => {
    expect(errorOf(['sessions', '--agent', 'Summarizer'])).toContain('--agent <id|name>')
    expect(errorOf(['agents', '-c'])).toContain('--continue')
    expect(errorOf(['agents', '-s', 'sesn_1'])).toContain('--session <id>')
  })

  it('takes --debug anywhere', () => {
    expect(commandOf(['--debug'])).toMatchObject({ kind: 'chat', options: { debug: true } })
    expect(commandOf(['agents', '--debug'])).toMatchObject({
      kind: 'agents',
      options: { debug: true },
    })
  })
})

describe('readVersion', () => {
  it('reads the version from this package.json', () => {
    expect(readVersion()).toBe('0.0.0')
  })
})
