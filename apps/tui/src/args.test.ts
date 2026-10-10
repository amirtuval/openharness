import { describe, expect, it } from 'vitest'

import { parseArgs } from './args'
import { packageVersion } from './test-support/version'
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

    const model = commandOf(['--model', 'openai/gpt-4.1-mini'])
    expect(model).toMatchObject({ kind: 'chat', options: { model: 'openai/gpt-4.1-mini' } })

    const server = commandOf(['--server', 'http://example.test'])
    expect(server).toMatchObject({ kind: 'chat', options: { server: 'http://example.test' } })
  })

  it('reads --mode, and refuses it beside --model (#245, M6)', () => {
    expect(commandOf(['--mode', 'smart'])).toMatchObject({
      kind: 'chat',
      options: { mode: 'smart' },
    })
    expect(errorOf(['--model', 'openai/gpt-4.1-mini', '--mode', 'smart'])).toMatch(
      /either --model or --mode/u,
    )
    expect(errorOf(['--mode', ''])).toMatch(/--mode needs a mode name/u)
  })

  it('recognises `oh modes` (#245, M6)', () => {
    expect(commandOf(['modes'])).toEqual({
      kind: 'modes',
      options: { server: undefined, debug: false },
    })
    expect(errorOf(['modes', 'extra'])).toMatch(/takes no arguments/u)
    expect(errorOf(['modes', '--mode', 'smart'])).toMatch(/does not take --mode <name>/u)
  })

  it('rejects the removed --api-key: `oh login` is the way in', () => {
    const error = errorOf(['--api-key', 'oh_key'])
    expect(error).toContain('--api-key')
    expect(error).toContain('oh --help')
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
      options: { debug: false, server: undefined },
    })
    expect(commandOf(['agents'])).toMatchObject({ kind: 'agents' })
  })

  it('recognises the auth commands', () => {
    expect(commandOf(['login'])).toEqual({
      kind: 'login',
      options: { debug: false, server: undefined, noBrowser: false },
    })
    expect(commandOf(['login', '--no-browser'])).toMatchObject({
      kind: 'login',
      options: { noBrowser: true },
    })
    expect(commandOf(['logout'])).toMatchObject({ kind: 'logout' })
    expect(commandOf(['whoami'])).toMatchObject({ kind: 'whoami' })
    expect(commandOf(['update'])).toMatchObject({ kind: 'update', options: { debug: false } })
    expect(commandOf(['update', '--server', 'http://x.test'])).toMatchObject({
      kind: 'update',
      options: { server: 'http://x.test' },
    })
  })

  it('rejects chat flags on `oh update`, which takes none of them', () => {
    expect(errorOf(['update', '-c'])).toContain('--continue')
    expect(errorOf(['update', '--model', 'openai/gpt-4.1-mini'])).toContain('--model')
  })

  it('rejects an argument to `oh update`', () => {
    expect(errorOf(['update', '1.2.3'])).toContain('takes no arguments')
  })

  it('rejects --no-browser without `oh login`', () => {
    expect(errorOf(['--no-browser'])).toContain('--no-browser only makes sense with `oh login`')
    expect(errorOf(['sessions', '--no-browser'])).toContain('--no-browser')
    expect(errorOf(['whoami', '--no-browser'])).toContain('--no-browser')
  })

  it('rejects an empty --model', () => {
    expect(errorOf(['--model', ''])).toContain('--model needs a model id')
  })

  it('rejects a --model with no value', () => {
    expect(errorOf(['--model'])).toContain('missing')
  })

  it('rejects chat flags on the auth commands', () => {
    expect(errorOf(['login', '-c'])).toContain('--continue')
    expect(errorOf(['logout', '-s', 'sesn_1'])).toContain('--session <id>')
    expect(errorOf(['whoami', '--agent', 'Summarizer'])).toContain('--agent <id|name>')
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

  it('rejects an argument after a command that takes none', () => {
    expect(errorOf(['agents', 'extra'])).toContain('takes no arguments')
    expect(errorOf(['sessions', 'extra'])).toContain('unknown `oh sessions` argument')
  })

  it('reads `oh sessions delete <id>` and its --yes', () => {
    expect(commandOf(['sessions', 'delete', 'sesn_1'])).toEqual({
      kind: 'sessions-delete',
      id: 'sesn_1',
      yes: false,
      options: { debug: false, server: undefined },
    })
    expect(commandOf(['sessions', 'delete', 'sesn_1', '--yes'])).toMatchObject({
      kind: 'sessions-delete',
      id: 'sesn_1',
      yes: true,
    })
  })

  it('rejects a `sessions delete` with no id, or with more arguments than one', () => {
    expect(errorOf(['sessions', 'delete'])).toContain('needs the session id')
    expect(errorOf(['sessions', 'delete', 'sesn_1', 'sesn_2'])).toContain('takes one session id')
  })

  it('rejects --yes anywhere but `sessions delete`', () => {
    expect(errorOf(['sessions', '--yes'])).toContain('--yes')
    expect(errorOf(['agents', '--yes'])).toContain('--yes')
    expect(errorOf(['--yes'])).toContain('--yes')
    expect(errorOf(['login', '--yes'])).toContain('--yes')
    expect(errorOf(['providers', '--yes'])).toContain('--yes')
    expect(errorOf(['providers', 'list', '--yes'])).toContain('--yes')
    expect(errorOf(['providers', 'add', '--yes'])).toContain('--yes')
  })

  it('recognises `oh providers` in all three shapes (#210)', () => {
    // A bare `oh providers` is the listing, the way a bare `oh sessions` is.
    expect(commandOf(['providers'])).toEqual({
      kind: 'providers',
      options: { debug: false, server: undefined },
    })
    expect(commandOf(['providers', 'list'])).toEqual({
      kind: 'providers',
      options: { debug: false, server: undefined },
    })

    expect(commandOf(['providers', 'add'])).toEqual({
      kind: 'providers-add',
      provider: undefined,
      options: { debug: false, server: undefined },
    })
    expect(commandOf(['providers', 'add', 'anthropic'])).toMatchObject({
      kind: 'providers-add',
      provider: 'anthropic',
    })

    expect(commandOf(['providers', 'remove', 'anthropic'])).toEqual({
      kind: 'providers-remove',
      provider: 'anthropic',
      yes: false,
      options: { debug: false, server: undefined },
    })
    expect(commandOf(['providers', 'remove', 'anthropic', '--yes'])).toMatchObject({
      kind: 'providers-remove',
      provider: 'anthropic',
      yes: true,
    })
  })

  it('rejects a `providers` line that names nothing', () => {
    expect(errorOf(['providers', 'list', 'extra'])).toContain('takes no arguments')
    expect(errorOf(['providers', 'add', 'anthropic', 'openai'])).toContain('at most one provider')
    expect(errorOf(['providers', 'add', ''])).toContain('needs a provider name')
    expect(errorOf(['providers', 'remove'])).toContain('needs the provider')
    expect(errorOf(['providers', 'remove', 'a', 'b'])).toContain('takes one provider')
    expect(errorOf(['providers', 'connect'])).toContain('unknown `oh providers` argument')
  })

  it('rejects the chat flags on every `providers` shape', () => {
    expect(errorOf(['providers', '-c'])).toContain('--continue')
    expect(errorOf(['providers', 'list', '--model', 'x/y'])).toContain('--model')
    expect(errorOf(['providers', 'add', 'anthropic', '-s', 'sesn_1'])).toContain('--session <id>')
    expect(errorOf(['providers', 'remove', 'anthropic', '--agent', 'a'])).toContain('--agent')
  })

  it('rejects the chat flags on `sessions delete`', () => {
    expect(errorOf(['sessions', 'delete', 'sesn_1', '-c'])).toContain('--continue')
    expect(errorOf(['sessions', 'delete', 'sesn_1', '--model', 'x/y'])).toContain('--model')
  })

  it('reads `oh default-model` with and without a model id', () => {
    expect(commandOf(['default-model'])).toEqual({
      kind: 'default-model',
      model: undefined,
      options: { debug: false, server: undefined },
    })
    expect(commandOf(['default-model', 'anthropic/claude-sonnet-5'])).toMatchObject({
      kind: 'default-model',
      model: 'anthropic/claude-sonnet-5',
    })
  })

  it('rejects a `default-model` line it cannot read', () => {
    expect(errorOf(['default-model', ' '])).toContain('needs a model id')
    expect(errorOf(['default-model', 'a/b', 'c/d'])).toContain('at most one model id')
    expect(errorOf(['default-model', '--model', 'a/b'])).toContain('--model <provider/model>')
  })

  it('reads `oh settings` and each of its flags (#282)', () => {
    // No flags is a read: the patch is empty, and nothing is written.
    expect(commandOf(['settings'])).toEqual({
      kind: 'settings',
      patch: {},
      options: { debug: false, server: undefined },
    })
    expect(commandOf(['settings', '--threshold', '0.5'])).toMatchObject({
      kind: 'settings',
      patch: { threshold: 0.5 },
    })
    expect(commandOf(['settings', '--summary-model', 'same-as-chat'])).toMatchObject({
      patch: { summaryModel: 'same-as-chat' },
    })
    expect(commandOf(['settings', '--summary-passes', '5'])).toMatchObject({
      patch: { summaryPasses: 5 },
    })
    // All three at once, and `default` is how a nullable control is cleared.
    expect(
      commandOf([
        'settings',
        '--threshold',
        'default',
        '--summary-model',
        'openai/gpt-5-mini',
        '--summary-passes',
        'default',
      ]),
    ).toMatchObject({
      kind: 'settings',
      patch: { threshold: null, summaryModel: 'openai/gpt-5-mini', summaryPasses: null },
    })
  })

  it('rejects a `settings` line it cannot read (#282)', () => {
    expect(errorOf(['settings', '0.5'])).toContain('takes no arguments')
    expect(errorOf(['settings', '--threshold', '5'])).toContain('between 0.3 and 0.95')
    expect(errorOf(['settings', '--threshold', ' '])).toContain('needs a share')
    expect(errorOf(['settings', '--summary-model', ' '])).toContain('needs a model id')
    expect(errorOf(['settings', '--summary-passes', '0'])).toContain('between 1 and 10')
    expect(errorOf(['settings', '--summary-passes', '2.5'])).toContain('whole number')
    expect(errorOf(['settings', '--model', 'openai/gpt-5-mini'])).toContain(
      '--model <provider/model>',
    )
  })

  it('rejects the settings flags everywhere but `oh settings` (#282)', () => {
    expect(errorOf(['--threshold', '0.5'])).toContain('only makes sense with `oh settings`')
    expect(errorOf(['sessions', '--summary-model', 'same-as-chat'])).toContain(
      '--summary-model <id>',
    )
    expect(errorOf(['default-model', '--summary-passes', '3'])).toContain('--summary-passes <n>')
  })

  it('rejects --session with --continue', () => {
    expect(errorOf(['--session', 'sesn_1', '--continue'])).toContain(
      'either --session <id> or --continue',
    )
  })

  it('rejects chat-only flags on the listings', () => {
    expect(errorOf(['sessions', '--agent', 'Summarizer'])).toContain('--agent <id|name>')
    expect(errorOf(['sessions', '--model', 'openai/gpt-4.1-mini'])).toContain(
      '--model <provider/model>',
    )
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
    expect(readVersion()).toBe(packageVersion())
  })
})
