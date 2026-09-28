import { afterEach, describe, expect, it, vi } from 'vitest'

import { run, type RunOptions } from './index'

/** Run the CLI with its output captured, without touching the real terminal. */
async function runCaptured(
  argv: readonly string[],
  env: Record<string, string> = {},
  options: RunOptions = {},
) {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

  try {
    const code = await run(argv, { env, ...options })
    return { code, out: stdoutText(stdout), err: stderrText(stderr) }
  } finally {
    stdout.mockRestore()
    stderr.mockRestore()
  }
}

/** A stdin that is not a terminal, the way a pipe or a CI runner looks. */
const PIPED_STDIN = { isTTY: false } as unknown as NodeJS.ReadStream

function stdoutText(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((call) => String(call[0])).join('')
}

const stderrText = stdoutText

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
    expect(out.trim()).toBe('0.0.0')
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
    const { code, out } = await runCaptured(['agents'], { OPENHARNESS_FAKE: '1' })

    expect(code).toBe(0)
    expect(out).toContain('Summarizer')
    expect(out).toContain('anthropic/claude-sonnet-5')
  })

  it('lists the sessions of the dev fake', async () => {
    const { code, out } = await runCaptured(['sessions'], { OPENHARNESS_FAKE: '1' })

    expect(code).toBe(0)
    expect(out).toContain('sesn_')
    expect(out).toContain('A session with history')
  })

  it('says where the settings came from under --debug', async () => {
    const { err } = await runCaptured(['agents', '--debug'], { OPENHARNESS_FAKE: '1' })

    expect(err).toContain('server http://localhost:3000 (default)')
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
    const { code, out, err } = await runCaptured(
      ['--agent', 'Summarizer'],
      { OPENHARNESS_FAKE: '1' },
      {
        stdin: PIPED_STDIN,
      },
    )

    expect(code).toBe(2)
    expect(out).toBe('')
    expect(err).toContain('the chat needs a terminal')
    expect(err).toContain('oh sessions')
  })
})
