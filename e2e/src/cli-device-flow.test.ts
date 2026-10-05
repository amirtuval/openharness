import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@openharness/client'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { e2eHarness, waitFor, type ServerProcess } from './harness'

/**
 * `oh login` / `oh logout` in CI (issue #119).
 *
 * `device-flow.test.ts` covers the server's half of A6 over the API; the CLI's half — the
 * built `oh` asking for a code, printing it, polling, writing the token file with the modes
 * it promises, and revoking the session on logout — ran only in the hands-on QA pass, behind
 * `QA_WITH_CLI=1`, which no automatic run turns on. This file is that half, without tmux: the
 * **real built binary** is spawned with an isolated `XDG_CONFIG_HOME`, and the approval the
 * browser would make is made through the same three endpoints the page calls, as a signed-in
 * person (`device-flow.test.ts` shows the flow; the calls are duplicated here rather than
 * shared, because this file's point is what happens across the process boundary).
 *
 * What only this file can prove: the URL and the code on the terminal are the ones the
 * approval endpoint accepts; the token lands in `$XDG_CONFIG_HOME/openharness/credentials.json`
 * with `0600` in a `0700` directory; `oh whoami` reads it and answers; `oh logout` revokes the
 * session **server-side** — the token the file held is refused afterwards — and a denied login
 * or a Ctrl+C mid-poll leaves no token behind.
 *
 * The tmux specs (`qa/w26-auth74-cli-login.spec.ts`, `qa/cli.spec.ts` C12–C14) stay the UX
 * pass: they watch the screens and drive a real browser, which is not what CI is for.
 */

const harness = e2eHarness('cli-device-flow')

/** The URL and code line `oh login --no-browser` prints, exactly. */
const LOGIN_HINT = /Open (\S+) in your browser and enter the code ([A-HJ-NP-Z2-9]{8})\./

/** The line that says the poll has started; nothing is approved when it is printed. */
const WAITING_FOR_APPROVAL = 'Waiting for approval…'

/** One server for the file: a boot is a whole migration run, and four tests can share it. */
let serverPromise: Promise<ServerProcess> | undefined
function server(): Promise<ServerProcess> {
  return (serverPromise ??= harness.server())
}

/** The path of the built `oh`, resolved through the `openharness` package (the npm name). */
function cliEntryPath(): string {
  return fileURLToPath(import.meta.resolve('openharness'))
}

/** A spawned `oh`: what it printed, how it ended, and how to signal it. */
interface CliProcess {
  /** Everything the process has written to stdout and stderr so far, uncut. */
  output(): string
  /** Resolve with how it exited: a code, a signal, or a code after a signal it handled. */
  readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>
  /** Send it a signal. */
  kill(signal?: NodeJS.Signals): void
}

/** Every CLI this file started and has not seen exit — killed in `afterEach`, like the servers. */
const runningClis = new Set<CliProcess>()

/** The temp config homes this file made; removed in `afterAll`. */
const configHomes: string[] = []

/**
 * Spawn the built `oh` with a config home of the run's own.
 *
 * The child's environment starts from the test process's, minus every `OPENHARNESS_*`
 * variable: a leftover in a developer's shell must not change what a test runs — `OPENHARNESS_URL`
 * would point the CLI at another server, and `OPENHARNESS_FAKE` would replace the real client
 * with the fake's scripted flow entirely. `XDG_CONFIG_HOME` is what makes the credentials file
 * a scratch directory's, never a person's.
 */
function startCli(args: readonly string[], configHome: string): CliProcess {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('OPENHARNESS_')) continue
    env[name] = value
  }
  env['XDG_CONFIG_HOME'] = configHome

  const child = spawn(process.execPath, [cliEntryPath(), ...args], {
    env,
    // stdin ignored: `oh login` reads no key, and nothing here runs a chat.
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })

  const cli: CliProcess = {
    output: () => output,
    exit: new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        resolve({ code, signal })
      })
    }),
    kill: (signal = 'SIGINT') => {
      child.kill(signal)
    },
  }
  runningClis.add(cli)
  void cli.exit.then(() => {
    runningClis.delete(cli)
  })
  return cli
}

/** Run `oh` to completion and answer its exit code and everything it printed. */
async function runCli(
  args: readonly string[],
  configHome: string,
): Promise<{
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  output: string
}> {
  const cli = startCli(args, configHome)
  const { code, signal } = await cli.exit
  return { code, signal, output: cli.output() }
}

/** A config home of this run's own, removed with the rest when the file is done. */
function freshConfigHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'oh-e2e-config-'))
  configHomes.push(home)
  return home
}

/** Where the CLI keeps its tokens: `$XDG_CONFIG_HOME/openharness/credentials.json`. */
function credentialsPath(configHome: string): string {
  return join(configHome, 'openharness', 'credentials.json')
}

/** The permission bits of a path — `0o600` for the file, `0o700` for its directory. */
function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

/** The token `oh` stored for `serverUrl`. Read from the file; never printed by an assertion. */
function storedToken(configHome: string, serverUrl: string): string | undefined {
  const file = credentialsPath(configHome)
  if (!existsSync(file)) {
    return undefined
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { servers?: Record<string, string> }
  return parsed.servers?.[serverUrl]
}

/**
 * Start `oh login --no-browser` and answer the URL and the code it printed.
 *
 * Resolves once the poll has started (`Waiting for approval…`), so a caller that decides the
 * code knows the CLI is waiting on an answer, not still starting up.
 */
async function startLogin(
  target: ServerProcess,
  configHome: string,
): Promise<{ readonly cli: CliProcess; readonly url: string; readonly userCode: string }> {
  const cli = startCli(['login', '--no-browser', '--server', target.baseUrl], configHome)
  const parsed = await waitFor(
    'oh login to print its URL and code and start polling',
    () => {
      const match = LOGIN_HINT.exec(cli.output())
      if (match === null || !cli.output().includes(WAITING_FOR_APPROVAL)) {
        return undefined
      }
      return { url: match[1] ?? '', userCode: match[2] ?? '' }
    },
    { describe: () => cli.output() },
  )
  return { cli, ...parsed }
}

/**
 * The approval page's two calls, made the way a person's browser makes them: verify (which
 * claims the code for the signed-in person and answers it back) and then decide.
 */
async function decideThroughApi(
  target: ServerProcess,
  token: string,
  userCode: string,
  decision: 'approve' | 'deny',
): Promise<{ readonly verified: Response; readonly decided: Response }> {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const verified = await fetch(
    `${target.baseUrl}/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
    { headers },
  )
  const decided = await fetch(`${target.baseUrl}/api/auth/device/${decision}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ userCode }),
  })
  return { verified, decided }
}

afterEach(() => {
  for (const cli of runningClis) {
    cli.kill('SIGKILL')
  }
  runningClis.clear()
})

afterAll(() => {
  for (const home of configHomes) {
    rmSync(home, { recursive: true, force: true })
  }
  configHomes.length = 0
})

describe('the oh CLI device flow (#119)', () => {
  it('prints the URL and code the approval endpoint accepts, and stores the session 0600', async () => {
    const running = await server()
    const dev = await harness.user(running)
    const configHome = freshConfigHome()

    const login = await startLogin(running, configHome)

    // The URL is the web app's approval route with the code inside the fragment — the shape
    // the page's router reads — and the code on the terminal is the one the endpoint accepts:
    // verify claims it for the signed-in person and answers it back.
    expect(login.url).toBe(`${running.baseUrl}/#/device?user_code=${login.userCode}`)
    const { verified, decided } = await decideThroughApi(
      running,
      dev.token,
      login.userCode,
      'approve',
    )
    expect(verified.status).toBe(200)
    expect(await verified.json()).toMatchObject({
      user_code: login.userCode,
      status: 'pending',
    })
    expect(decided.status).toBe(200)

    // The CLI was polling; it signs itself in and says who it is.
    const { code } = await login.cli.exit
    expect(code).toBe(0)
    expect(login.cli.output()).toContain(`Logged in as ${dev.user.email} on ${running.baseUrl}`)

    // The token landed where the CLI promises: 0600 in a 0700 directory, keyed by the server.
    const file = credentialsPath(configHome)
    expect(existsSync(file)).toBe(true)
    expect(modeOf(file)).toBe(0o600)
    expect(modeOf(join(configHome, 'openharness'))).toBe(0o700)
    const token = storedToken(configHome, running.baseUrl)
    expect(typeof token).toBe('string')

    // The stored token is a live session, and `oh whoami` — the command that reads it back —
    // agrees with what the login printed.
    const me = await createClient({ baseUrl: running.baseUrl, token }).me()
    expect(me.email).toBe(dev.user.email)

    const whoami = await runCli(['whoami', '--server', running.baseUrl], configHome)
    expect(whoami.code).toBe(0)
    expect(whoami.output).toContain(`Logged in as ${dev.user.email} on ${running.baseUrl}`)
  })

  it('oh logout revokes the session on the server and forgets the token', async () => {
    const running = await server()
    const dev = await harness.user(running)
    const configHome = freshConfigHome()

    const login = await startLogin(running, configHome)
    await decideThroughApi(running, dev.token, login.userCode, 'approve')
    const { code } = await login.cli.exit
    expect(code).toBe(0)
    const token = storedToken(configHome, running.baseUrl)
    expect(typeof token).toBe('string')

    const logout = await runCli(['logout', '--server', running.baseUrl], configHome)
    expect(logout.code).toBe(0)
    expect(logout.output).toContain(`Logged out of ${running.baseUrl}.`)

    // Revoked server-side, not merely forgotten: the token the file held is refused with the
    // protocol's 401 envelope — which is the whole point of `oh logout` for a stolen laptop.
    const refused = await fetch(`${running.baseUrl}/v1/me`, {
      headers: { authorization: `Bearer ${token ?? ''}` },
    })
    expect(refused.status).toBe(401)

    // And forgotten locally: no token for the server, and the commands that need one say how
    // to get one back.
    expect(storedToken(configHome, running.baseUrl)).toBeUndefined()
    const whoami = await runCli(['whoami', '--server', running.baseUrl], configHome)
    expect(whoami.code).toBe(1)
    expect(whoami.output).toContain(`not signed in to ${running.baseUrl}. Run \`oh login\`.`)
  })

  it('reports a denied login, exits non-zero, and writes no token', async () => {
    const running = await server()
    const dev = await harness.user(running)
    const configHome = freshConfigHome()

    const login = await startLogin(running, configHome)
    const { decided } = await decideThroughApi(running, dev.token, login.userCode, 'deny')
    expect(decided.status).toBe(200)

    const { code } = await login.cli.exit
    expect(code).not.toBe(0)
    expect(login.cli.output()).toContain('the login was denied in the browser.')
    expect(existsSync(credentialsPath(configHome))).toBe(false)
  })

  it('cancels on SIGINT during the poll and writes no token', async () => {
    const running = await server()
    const configHome = freshConfigHome()

    const login = await startLogin(running, configHome)

    // Nobody approves: the CLI is mid-poll (nothing has been decided), and Ctrl+C arrives as
    // the SIGINT a terminal sends.
    login.cli.kill('SIGINT')
    const { code, signal } = await login.cli.exit
    expect(signal).toBeNull()
    expect(code).toBe(130)
    expect(login.cli.output()).toContain('oh: login cancelled.')
    expect(existsSync(credentialsPath(configHome))).toBe(false)
  })
})
