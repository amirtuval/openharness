import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { FAKE_SESSION_TOKEN } from '@openharness/client/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Readable } from 'node:stream'

import { isDirectRun, run, type RunOptions } from './index'
import { packageVersion } from './test-support/version'

/**
 * A fresh config directory for the test at hand.
 *
 * Every `run()` here must read *its own* config and credentials, never the developer's real
 * `~/.config/openharness` (the review of #105, P1): a hand-written config.json there flips
 * the server a command talks to, and a mangled credentials.json makes unrelated commands
 * exit 2. The environment `runCaptured` passes always carries this, and a test that wants a
 * directory of its own (the auth describe does) passes `XDG_CONFIG_HOME` and wins.
 */
let configHome: string

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), 'oh-run-config-'))
})

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true })
})

/** Run the CLI with its output captured, without touching the real terminal or real config. */
async function runCaptured(
  argv: readonly string[],
  env: Record<string, string> = {},
  options: RunOptions = {},
) {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

  try {
    const code = await run(argv, { env: { XDG_CONFIG_HOME: configHome, ...env }, ...options })
    return { code, out: stdoutText(stdout), err: stderrText(stderr) }
  } finally {
    stdout.mockRestore()
    stderr.mockRestore()
  }
}

/** A stdin that is not a terminal, the way a pipe or a CI runner looks. */
const PIPED_STDIN = { isTTY: false } as unknown as NodeJS.ReadStream

/** A stdin that answers one line, the way a shell pipe with `echo y |` does. */
function pipedAnswer(answer: string): NodeJS.ReadStream {
  return Readable.from([`${answer}\n`]) as unknown as NodeJS.ReadStream
}

function stdoutText(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((call) => String(call[0])).join('')
}

const stderrText = stdoutText

/**
 * The server the fake-mode tests name by hand.
 *
 * The CLI's default is production since #192, and no test may resolve to it — not even with
 * the dev fake in front of it, where nothing would be sent anyway. Naming the server here is
 * what makes that a property of the suite rather than of the fake; the one test that does
 * want the default says so on its own.
 */
const FAKE_SERVER = 'http://localhost:3000'

/** Fake mode, pointed at {@link FAKE_SERVER} rather than at the default. */
const FAKE_ENV = { OPENHARNESS_FAKE: '1', OPENHARNESS_URL: FAKE_SERVER }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('run', () => {
  it('prints the usage on --help', async () => {
    const { code, out, err } = await runCaptured(['--help'])

    expect(code).toBe(0)
    expect(out).toContain('Usage:')
    expect(out).toContain('oh sessions')
    expect(err).toBe('')
  })

  it('prints the version on --version', async () => {
    const { code, out } = await runCaptured(['--version'])

    expect(code).toBe(0)
    expect(out.trim()).toBe(packageVersion())
  })

  it('exits 2 on a flag it does not know, before doing anything', async () => {
    const { code, out, err } = await runCaptured(['--nope'])

    expect(code).toBe(2)
    expect(out).toBe('')
    expect(err).toContain('--nope')
    expect(err).toContain('oh --help')
  })

  it('exits 2 on a command it does not know', async () => {
    const { code, err } = await runCaptured(['chat'])

    expect(code).toBe(2)
    expect(err).toContain('unknown command')
  })

  it('exits 2 when a flag and a subcommand disagree', async () => {
    const { code, err } = await runCaptured(['sessions', '--continue'])

    expect(code).toBe(2)
    expect(err).toContain('--continue')
  })

  it('lists the agents of the dev fake', async () => {
    const { code, out } = await runCaptured(['agents'], FAKE_ENV)

    expect(code).toBe(0)
    expect(out).toContain('Summarizer')
    expect(out).toContain('anthropic/claude-sonnet-5')
  })

  it('lists the sessions of the dev fake', async () => {
    const { code, out } = await runCaptured(['sessions'], FAKE_ENV)

    expect(code).toBe(0)
    expect(out).toContain('sesn_')
    expect(out).toContain('A session with history')
  })

  it('lists the provider keys of the dev fake — none, with how to add one (#210)', async () => {
    const { code, out, err } = await runCaptured(['providers'], FAKE_ENV)

    expect(code).toBe(0)
    expect(err).toBe('')
    expect(out).toContain('No provider keys yet')
    expect(out).toContain('oh providers add')
  })

  it('removes a key from the dev fake without asking, with --yes (#210)', async () => {
    const { code, out } = await runCaptured(
      ['providers', 'remove', 'anthropic', '--yes'],
      FAKE_ENV,
      { stdin: PIPED_STDIN },
    )

    expect(code).toBe(0)
    expect(out).toContain('Removed the Anthropic key.')
  })

  it('asks before removing, and a piped answer nobody wrote is a no (#210)', async () => {
    const { code, out } = await runCaptured(['providers', 'remove', 'anthropic'], FAKE_ENV, {
      // A pipe that closes: the question is asked, and end-of-input answers no.
      stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
    })

    expect(code).toBe(0)
    expect(out).toContain('Not removed.')
  })

  it('says `oh providers add` needs a terminal when stdin is a pipe (#210)', async () => {
    const { code, out, err } = await runCaptured(['providers', 'add'], FAKE_ENV, {
      stdin: PIPED_STDIN,
    })

    expect(code).toBe(2)
    expect(out).toBe('')
    expect(err).toContain('needs a terminal')
    expect(err).toContain('hidden prompt')
  })

  it('says where the settings came from under --debug', async () => {
    // Deliberately no OPENHARNESS_URL: this is the test that watches the default itself.
    const { err } = await runCaptured(['agents', '--debug'], { OPENHARNESS_FAKE: '1' })

    // Nothing pointed it anywhere, so the resolved server is the default — production (#192).
    expect(err).toContain('server https://app.oharness.dev (default)')
  })

  it('points at the server when nothing is listening', async () => {
    const { code, err } = await runCaptured(['agents'], { OPENHARNESS_URL: 'http://127.0.0.1:1' })

    expect(code).toBe(1)
    expect(err).toContain('could not reach the server at http://127.0.0.1:1')
    expect(err).toContain('--server')
    // No stack unless --debug: no `at fn (file:line:col)` frames.
    expect(err).not.toMatch(/^\s+at .+:\d+:\d+/mu)
  })

  it('adds the stack under --debug', async () => {
    const { code, err } = await runCaptured(['agents', '--debug'], {
      OPENHARNESS_URL: 'http://127.0.0.1:1',
    })

    expect(code).toBe(1)
    // The raw error, which the friendly report does not print on its own. (Its stack has no
    // frames here — a fetch failure is raised inside undici — so the header line is the
    // whole of it; `errors.test.ts` covers the frames with an error of our own.)
    expect(err).toContain('TypeError: fetch failed')
  })

  it('exits 2 with a readable message when the config file is broken', async () => {
    const { code, err } = await runCaptured(['agents'], { OPENHARNESS_URL: 'x' })

    expect(code).toBe(2)
    expect(err).toContain('not a URL')
  })

  it('says a chat needs a terminal when stdin is a pipe', async () => {
    const { code, out, err } = await runCaptured(['--agent', 'Summarizer'], FAKE_ENV, {
      stdin: PIPED_STDIN,
    })

    expect(code).toBe(2)
    expect(out).toBe('')
    expect(err).toContain('the chat needs a terminal')
    expect(err).toContain('oh sessions')
  })

  it('no longer takes --api-key: it is an unknown flag (epic #65, A8)', async () => {
    const { code, err } = await runCaptured(['--api-key', 'oh_key'])

    expect(code).toBe(2)
    expect(err).toContain('--api-key')
  })
})

describe('run: default-model (#114)', () => {
  const fakeEnv = FAKE_ENV

  it('prints the stored default', async () => {
    const { code, out, err } = await runCaptured(['default-model'], fakeEnv)

    expect(code).toBe(0)
    expect(err).toBe('')
    expect(out.trim()).toBe('Default model: anthropic/claude-sonnet-5')
  })

  it('sets the default', async () => {
    const { code, out, err } = await runCaptured(['default-model', 'openai/gpt-4.1-mini'], fakeEnv)

    expect(code).toBe(0)
    expect(err).toBe('')
    expect(out.trim()).toBe('Default model set to openai/gpt-4.1-mini.')
  })

  it('exits 2 on a model id it cannot read', async () => {
    const { code, err } = await runCaptured(['default-model', 'a/b', 'c/d'], fakeEnv)

    expect(code).toBe(2)
    expect(err).toContain('at most one model id')
  })

  it('is the not-signed-in error against a real server', async () => {
    const { code, err } = await runCaptured(['default-model'], {
      OPENHARNESS_URL: 'http://127.0.0.1:1',
    })

    expect(code).toBe(1)
    expect(err).toContain('could not reach the server')
  })
})

describe('run: sessions delete (#114)', () => {
  const fakeEnv = FAKE_ENV

  it('asks and deletes nothing on a piped no', async () => {
    const { code, out, err } = await runCaptured(['sessions', 'delete', 'sesn_missing'], fakeEnv, {
      stdin: pipedAnswer('n'),
    })

    expect(code).toBe(0)
    expect(err).toBe('')
    expect(out).toContain('Delete chat sesn_missing? This cannot be undone [y/N]')
    expect(out).toContain('Not deleted.')
  })

  it('takes a piped yes to the question, and then fails on the id it was given', async () => {
    // The id names nothing in the fresh fake, so the delete itself reports not-found —
    // which is the proof the answer was read and acted on.
    const { code, out, err } = await runCaptured(['sessions', 'delete', 'sesn_missing'], fakeEnv, {
      stdin: pipedAnswer('y'),
    })

    expect(code).toBe(1)
    expect(out).toContain('[y/N]')
    expect(err).toContain('not found')
    expect(err).toContain('oh sessions')
  })

  it('skips the question with --yes', async () => {
    const { code, out, err } = await runCaptured(
      ['sessions', 'delete', 'sesn_missing', '--yes'],
      fakeEnv,
    )

    expect(code).toBe(1)
    expect(out).not.toContain('[y/N]')
    expect(err).toContain('not found')
  })

  it('exits 2 on a delete with no id', async () => {
    const { code, err } = await runCaptured(['sessions', 'delete'], fakeEnv)

    expect(code).toBe(2)
    expect(err).toContain('needs the session id')
  })

  it('still lists with no argument', async () => {
    const { code, out } = await runCaptured(['sessions'], fakeEnv)

    expect(code).toBe(0)
    expect(out).toContain('A session with history')
  })
})

describe('run: auth', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'oh-run-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  /** The environment pointing the CLI at the dev fake and a throwaway config directory. */
  function fakeEnv(): Record<string, string> {
    return { ...FAKE_ENV, XDG_CONFIG_HOME: directory }
  }

  /** The credentials file, as the CLI wrote it. */
  function storedTokens(): Record<string, string> {
    const path = join(directory, 'openharness', 'credentials.json')
    return (JSON.parse(readFileSync(path, 'utf8')) as { servers: Record<string, string> }).servers
  }

  it('`oh login --no-browser` prints the URL and code and stores the token', async () => {
    const { code, out, err } = await runCaptured(['login', '--no-browser'], fakeEnv())

    expect(code).toBe(0)
    expect(err).toBe('')
    expect(out).toContain('http://localhost:3000/#/device?user_code=FAKE-CODE')
    expect(out).toContain('FAKE-CODE')
    expect(out).toContain('Logged in as ada@example.com on http://localhost:3000')
    expect(storedTokens()).toEqual({ 'http://localhost:3000': FAKE_SESSION_TOKEN })
  })

  it('`oh whoami` prints the signed-in user after a login', async () => {
    await runCaptured(['login', '--no-browser'], fakeEnv())

    const { code, out } = await runCaptured(['whoami'], fakeEnv())

    expect(code).toBe(0)
    expect(out.trim()).toBe('Logged in as ada@example.com on http://localhost:3000')
  })

  it('`oh whoami` is the not-signed-in error, exit 1, without a token', async () => {
    const { code, out, err } = await runCaptured(['whoami'], {
      OPENHARNESS_URL: 'http://127.0.0.1:1',
      XDG_CONFIG_HOME: directory,
    })

    expect(code).toBe(1)
    expect(out).toBe('')
    expect(err).toContain('not signed in to http://127.0.0.1:1. Run `oh login`.')
  })

  it('`oh logout` forgets the token, and whoami says so afterwards', async () => {
    await runCaptured(['login', '--no-browser'], fakeEnv())

    const loggedOut = await runCaptured(['logout'], fakeEnv())
    expect(loggedOut.code).toBe(0)
    expect(loggedOut.out).toContain('Logged out of http://localhost:3000.')
    expect(storedTokens()).toEqual({})

    const after = await runCaptured(['whoami'], fakeEnv())
    expect(after.code).toBe(1)
    expect(after.err).toContain('not signed in')
  })

  it('keeps tokens per server: --server selects the identity', async () => {
    await runCaptured(['login', '--no-browser', '--server', 'http://one.test'], fakeEnv())
    await runCaptured(['login', '--no-browser'], fakeEnv())

    expect(storedTokens()).toEqual({
      'http://one.test': FAKE_SESSION_TOKEN,
      'http://localhost:3000': FAKE_SESSION_TOKEN,
    })

    await runCaptured(['logout', '--server', 'http://one.test'], fakeEnv())

    expect(storedTokens()).toEqual({ 'http://localhost:3000': FAKE_SESSION_TOKEN })
  })

  it('exits 2, naming the file, when the credentials file cannot be used', async () => {
    const path = join(directory, 'openharness')
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'credentials.json'), '{oops')

    const { code, err } = await runCaptured(['whoami'], fakeEnv())

    expect(code).toBe(2)
    expect(err).toContain('credentials.json')
    expect(err).toContain('invalid JSON')
  })

  it('exits 2, naming it, when the config file still sets apiKey', async () => {
    const path = join(directory, 'openharness')
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'config.json'), '{ "server": "http://x.test", "apiKey": "k" }')

    const { code, err } = await runCaptured(['agents'], fakeEnv())

    expect(code).toBe(2)
    expect(err).toContain("'apiKey'")
  })
})

describe('run: auto-update (#157)', () => {
  /** The state file the updater reads, under this test's own config home. */
  function statePath(): string {
    return join(configHome, 'openharness', 'update-state.json')
  }

  /** Leave an install outcome behind, the way the detached child would. */
  function seedResult(result: unknown): void {
    mkdirSync(join(configHome, 'openharness'), { recursive: true })
    writeFileSync(statePath(), `${JSON.stringify({ result })}\n`, 'utf8')
  }

  it('documents the command and its off switch in --help', async () => {
    const { out } = await runCaptured(['--help'])

    expect(out).toContain('oh update')
    expect(out).toContain('OH_NO_AUTO_UPDATE')
    expect(out).toContain('autoUpdate')
  })

  it('prints the pending outcome once, and never again', async () => {
    seedResult({ status: 'success', version: '0.4.0', at: '2026-10-05T12:00:00.000Z' })

    const first = await runCaptured(['agents'], FAKE_ENV)
    expect(first.code).toBe(0)
    expect(first.out).toContain('oh updated to v0.4.0')

    const second = await runCaptured(['agents'], FAKE_ENV)
    expect(second.code).toBe(0)
    expect(second.out).not.toContain('oh updated')
  })

  it('prints a failed install once, on stderr, with the sudo hint', async () => {
    seedResult({
      status: 'failure',
      version: '0.4.0',
      reason: 'npm exited with code 1: EACCES',
      permission: true,
      at: '2026-10-05T12:00:00.000Z',
    })

    const { code, out, err } = await runCaptured(['agents'], FAKE_ENV)

    expect(code).toBe(0)
    expect(out).not.toContain('could not update')
    expect(err).toContain('oh could not update itself: npm exited with code 1: EACCES')
    expect(err).toContain('run npm i -g @openh/cli')
    expect(err).toContain('sudo')
  })

  it('keeps --version and --help to their one output, even with a notice pending', async () => {
    seedResult({ status: 'success', version: '0.4.0', at: '2026-10-05T12:00:00.000Z' })

    const version = await runCaptured(['--version'])
    expect(version.out.trim()).toBe(packageVersion())

    const help = await runCaptured(['--help'])
    expect(help.out).not.toContain('oh updated')
    // The notice is still pending for the next command that is not one of those two.
    const after = await runCaptured(['agents'], FAKE_ENV)
    expect(after.out).toContain('oh updated to v0.4.0')
  })

  it('hands the updater the command, the environment and the config setting', async () => {
    const seen: { command: unknown; configAutoUpdate: unknown; scriptPath: unknown }[] = []
    const autoUpdate = (context: {
      command: unknown
      configAutoUpdate: unknown
      scriptPath: unknown
    }): void => {
      seen.push(context)
    }

    await runCaptured(['agents'], FAKE_ENV, { autoUpdate })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ command: 'agents', configAutoUpdate: true })

    await runCaptured(['default-model'], FAKE_ENV, { autoUpdate })
    expect(seen[1]).toMatchObject({ command: 'default-model' })

    await runCaptured(['update'], FAKE_ENV, { autoUpdate })
    expect(seen[2]).toMatchObject({ command: 'update' })
  })

  it('never hands --version or --help to the updater', async () => {
    let calls = 0
    const autoUpdate = (): void => {
      calls += 1
    }

    await runCaptured(['--version'], {}, { autoUpdate })
    await runCaptured(['--help'], {}, { autoUpdate })

    expect(calls).toBe(0)
  })

  it('carries autoUpdate false from the config file into the updater', async () => {
    mkdirSync(join(configHome, 'openharness'), { recursive: true })
    writeFileSync(join(configHome, 'openharness', 'config.json'), '{"autoUpdate": false}', 'utf8')

    const seen: unknown[] = []
    await runCaptured(['agents'], FAKE_ENV, {
      autoUpdate: (context) => {
        seen.push(context.configAutoUpdate)
      },
    })

    expect(seen).toEqual([false])
  })

  it('`oh update` refuses, exit 2, when this is not a global install', async () => {
    // The default updater is left in place here: under the test runner `process.argv[1]` is
    // not a global `oh`, so the command must refuse without spawning npm at all.
    const { code, out, err } = await runCaptured(['update'], {}, { autoUpdate: () => {} })

    expect(code).toBe(2)
    expect(out).toBe('')
    expect(err).toContain('not a global npm install')
  })
})

describe('isDirectRun (#152)', () => {
  it('is true for the exact entry path, in both spellings', () => {
    expect(isDirectRun('/somewhere/index.js', pathToFileURL('/somewhere/index.js').href)).toBe(true)
    expect(isDirectRun(undefined)).toBe(false)
  })

  it('is the entry point when argv names the npm `bin` symlink', () => {
    // What `npm i -g` produces: `<prefix>/bin/oh` → `…/@openh/cli/dist/index.js`. Node
    // resolves the entry to its real path, so `import.meta.url` is the target while
    // `process.argv[1]` keeps the symlink — a string comparison alone would say "not the
    // entry point" and the installed `oh` would silently do nothing.
    const home = mkdtempSync(join(tmpdir(), 'oh-direct-run-'))
    try {
      const real = join(home, 'index.js')
      writeFileSync(real, '// the built bundle, standing in\n')
      const link = join(home, 'oh')
      symlinkSync(real, link)

      expect(isDirectRun(link, pathToFileURL(real).href)).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('is false when another file is the entry point', () => {
    expect(isDirectRun('/somewhere/else.js', pathToFileURL('/somewhere/index.js').href)).toBe(false)
    // A path that is not there cannot be anybody's entry point.
    expect(isDirectRun('/nowhere/at/all.js', pathToFileURL('/somewhere/index.js').href)).toBe(false)
  })
})
