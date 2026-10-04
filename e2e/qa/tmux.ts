import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { expect, type Page, type Response } from '@playwright/test'

import { isRealModel, retryAfterMs, signInDevToken } from './support'

/** The mode bits of a directory, or `null` when it is not there. */
export function modeOf(directory: string): number | null {
  return existsSync(directory) ? statSync(directory).mode & 0o777 : null
}

/** A shell line that runs `oh` against the server under test, with a config home of its own. */
export function ohCommandIn(home: string, ...args: string[]): string {
  return [`XDG_CONFIG_HOME=${home}`, CLI_COMMAND, '--server', CLI_SERVER, ...args].join(' ')
}

/**
 * Run `oh` the way a shell would, and answer what it printed and how it exited.
 *
 * The one-shot commands (`whoami`, `sessions`, a bad argument) write their output and exit, so
 * they read fine from a pipe; the interactive screens go through {@link Terminal} instead.
 */
export function oh(
  args: readonly string[],
  options: { readonly configHome?: string } = {},
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', ['apps/tui/dist/index.js', ...args], {
      cwd: CLI_CWD,
      encoding: 'utf8',
      // The QA run's own config directory, so the developer's stored tokens are never read or
      // written by a scenario.
      env: { ...process.env, XDG_CONFIG_HOME: options.configHome ?? CLI_CONFIG_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { stdout, status: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number }
    return {
      stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      status: failure.status ?? -1,
    }
  }
}

/**
 * A config directory for `oh` that holds nothing: the state a machine that never signed in is
 * in, without touching the session the other scenarios share.
 */
export function scratchConfigHome(label: string): string {
  const home = path.join(CLI_CONFIG_HOME, `scratch-${label}`)
  rmSync(home, { recursive: true, force: true })
  return home
}

/**
 * A real pseudo-terminal for the CLI scenarios.
 *
 * `oh` is an Ink app: it needs a TTY, it writes escape sequences, and what it looks like is
 * half of what is being tested. `tmux` gives it one, `send-keys` types into it and
 * `capture-pane` reads back what is on the screen — the same way a person would look at it.
 */

const SHOT_DIR = process.env.QA_SHOT_DIR ?? 'qa-output'

/** Where the CLI is run from. `apps/tui/dist/index.js` relative to the `e2e` package. */
export const CLI_CWD = process.env.QA_OH_CWD ?? '../'
export const CLI_COMMAND = process.env.QA_OH_CLI ?? 'node apps/tui/dist/index.js'
export const CLI_SERVER = process.env.QA_BASE_URL ?? 'http://localhost:3000'

/**
 * The config directory the QA run's `oh` reads and writes.
 *
 * `oh` stores its session token in `$XDG_CONFIG_HOME/openharness/credentials.json` (0600), and
 * the QA run must not touch the developer's own file: this is a scratch directory beside the
 * screenshots. Every command the specs run names it explicitly, because the tmux server's
 * environment — which a pane inherits — is not this process's.
 */
export const CLI_CONFIG_HOME = process.env.QA_OH_CONFIG_HOME ?? path.resolve(SHOT_DIR, 'oh-config')

/** Where `oh` keeps the token for the server under test. */
export function cliCredentialsPath(): string {
  return path.join(CLI_CONFIG_HOME, 'openharness', 'credentials.json')
}

/** Forget any token a previous QA run left behind, so a login scenario starts signed out. */
export function forgetCliCredentials(): void {
  rmSync(path.dirname(cliCredentialsPath()), { recursive: true, force: true })
}

/**
 * A shell line that runs `oh` against the server under test, with the QA run's own config
 * directory.
 *
 * ```ts
 * terminal.run(ohCommand('login', '--no-browser'))
 * terminal.run(ohCommand('sessions'))
 * ```
 */
export function ohCommand(...args: string[]): string {
  return [`XDG_CONFIG_HOME=${CLI_CONFIG_HOME}`, CLI_COMMAND, '--server', CLI_SERVER, ...args].join(
    ' ',
  )
}

/** The mode bits of the stored credentials, when there are any. */
export function cliCredentialsMode(): number | null {
  const file = cliCredentialsPath()
  return existsSync(file) ? statSync(file).mode & 0o777 : null
}

export class Terminal {
  constructor(
    private readonly name: string,
    private readonly columns = 80,
    private readonly rows = 24,
  ) {}

  /** Start `tmux` with the shell, ready for {@link run}. */
  start(): void {
    this.kill()
    execFileSync(
      'tmux',
      [
        'new-session',
        '-d',
        '-s',
        this.name,
        '-x',
        String(this.columns),
        '-y',
        String(this.rows),
        '-c',
        CLI_CWD,
      ],
      { stdio: 'pipe' },
    )
  }

  /** Type a shell command and press Enter. */
  run(command: string): void {
    this.send(command, 'Enter')
  }

  /** Send keys, exactly as `tmux send-keys` reads them (`C-c`, `Enter`, `M-Enter`, …). */
  send(...keys: string[]): void {
    execFileSync('tmux', ['send-keys', '-t', this.name, ...keys], { stdio: 'pipe' })
  }

  /**
   * Type text one character at a time.
   *
   * A chunk with several characters in it is a *paste* to `oh`, which inserts it verbatim —
   * a different code path from typing. Sending them separately is what a keyboard does.
   */
  type(text: string): void {
    for (const character of text) {
      execFileSync('tmux', ['send-keys', '-t', this.name, '-l', character], { stdio: 'pipe' })
      execFileSync('sleep', ['0.012'])
    }
  }

  resize(columns: number, rows: number): void {
    execFileSync(
      'tmux',
      ['resize-window', '-t', this.name, '-x', String(columns), '-y', String(rows)],
      {
        stdio: 'pipe',
      },
    )
  }

  /** What is on the screen; `scrollback` lines above it too, when asked. */
  capture(scrollback = 0): string {
    const args =
      scrollback === 0
        ? ['capture-pane', '-p', '-t', this.name]
        : ['capture-pane', '-p', '-S', `-${String(scrollback)}`, '-t', this.name]
    return execFileSync('tmux', args, { encoding: 'utf8' })
  }

  /** Wait until the screen matches, and answer the match. */
  async waitFor(match: RegExp, timeoutMs = 30_000): Promise<RegExpMatchArray> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = match.exec(this.capture())
      if (found !== null) return found
      if (Date.now() > deadline) {
        throw new Error(`the terminal never matched ${String(match)}; it shows:\n${this.capture()}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  /** Wait until the status line says `idle` rather than `running`. */
  async waitForIdle(timeoutMs = 60_000): Promise<void> {
    await this.waitFor(/\bidle\b/, timeoutMs)
  }

  /**
   * Wait until the screen satisfies `predicate`, and answer the screen it did.
   *
   * {@link waitFor} matches a regexp, which is not enough to say "something *new* arrived":
   * the mock's replies are recognisable by their text, a real model's are not.
   */
  async waitUntil(predicate: (screen: string) => boolean, timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const screen = this.capture()
      if (predicate(screen)) return screen
      if (Date.now() > deadline) {
        throw new Error(`the terminal never matched the predicate; it shows:\n${screen}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  /**
   * Wait until the shell prompt is the last thing on screen.
   *
   * `oh` prints its resume hint as it unmounts, which is *before* the process is gone and the
   * shell is ready: a command typed the moment the hint appears can land in a dying app.
   */
  async waitForShellPrompt(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const lines = this.capture()
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line !== '')
      if ((lines[lines.length - 1] ?? '').endsWith('$')) return
      if (Date.now() > deadline) {
        throw new Error(`the shell prompt never came back; the screen shows:\n${this.capture()}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }

  /**
   * A screenshot of what the terminal shows.
   *
   * There is no screen to photograph, so the captured pane is rendered as monospace text on a
   * dark page in the browser and *that* is screenshotted — the same bytes `tmux` reported,
   * in a file the report can embed.
   */
  async screenshot(page: Page, name: string, scrollback = 0): Promise<void> {
    const text = this.capture(scrollback)
    await page.setViewportSize({ width: this.columns * 8 + 24, height: 120 })
    await page.setContent(
      [
        '<html><body style="margin:0;background:#111827;height:auto">',
        `<pre id="pane" style="margin:0;padding:12px;color:#e5e7eb;background:#111827;font:13px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap">`,
        escapeHtml(text),
        '</pre></body></html>',
      ].join(''),
    )
    // Trim to what is actually written: a terminal capture is mostly blank rows, and the
    // report does not need them.
    const height = await page
      .locator('#pane')
      .evaluate((element) => Math.ceil(element.getBoundingClientRect().height + 24))
    await page.setViewportSize({ width: this.columns * 8 + 24, height })
    await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), animations: 'disabled' })
  }

  kill(): void {
    try {
      execFileSync('tmux', ['kill-session', '-t', this.name], { stdio: 'pipe' })
    } catch {
      // there was nothing to kill
    }
  }
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

// --- signing the CLI in ---------------------------------------------------------------------

/**
 * The line `oh login --no-browser` prints: the URL to open, and the code it shows.
 *
 * `apps/tui/src/commands/auth.ts` writes it when no browser was opened — with `--no-browser`,
 * or on a machine with no display. The URL is the web app's approval route
 * (`<server>/#/device?user_code=…`), which is what {@link openDevicePage} opens.
 *
 * The whitespace between the words is deliberate: a pane narrower than the line breaks it
 * across two rows, and `capture-pane` reports that as a newline.
 */
export const CLI_LOGIN_HINT = /Open (\S+) in your browser and enter the code\s+(\S+?)\s*\./
const CLI_LOGGED_IN = /Logged in as (\S+) on (\S+)/

/**
 * How long a device page keeps being reloaded while its verify stays rate-limited.
 *
 * The window it may be waiting on is the code's lifetime (ten minutes), so this cannot
 * always cover it — see {@link openDevicePage} for why that wait is not this helper's to
 * make in full.
 */
const DEVICE_WAIT_BUDGET_MS = 120_000

/**
 * Open the device-approval page for a code, waiting out a rate-limited verify.
 *
 * The page's first call is `GET /api/auth/device` — the verify that claims the code for the
 * signed-in reader — and the device-authorization plugin limits exactly that endpoint to
 * **five requests per ten minutes** (the window is the code's lifetime, `DEVICE_CODE_EXPIRES_IN`).
 * The scenarios that are about the device page (W26a/d/e, W27b, C12) spend that budget, so a
 * repeat run against a stack whose counters are still warm can meet a 429 for the sixth.
 * This makes that a wait rather than a failure: the server names the remaining window in
 * `X-Retry-After` on the page's own refusal, this waits it out and reloads — the same
 * pattern the sign-in helpers use for their limit. A refusal that names too long a wait for
 * a scenario's timeout fails with a message saying so; nothing here can shorten the window.
 *
 * Any other state the page settles into — the code is not one the server issued, a code
 * that lapsed, an approval already decided — is handed back for the caller to assert on.
 *
 * The page has to be signed in already (the device approval is a signed-in action, A6); the
 * specs hand this the session-carrying page the fixtures built.
 */
export async function openDevicePage(page: Page, url: string): Promise<void> {
  const deadline = Date.now() + DEVICE_WAIT_BUDGET_MS
  /** The wait the last refusal named, or `null` when the last load was not refused. */
  let retryMs: number | null
  const noteRefusal = (response: Response): void => {
    if (response.status() !== 429 || !response.url().includes('/api/auth/device')) {
      return
    }
    retryMs = retryAfterMs(response.headers())
  }
  page.on('response', noteRefusal)
  try {
    for (;;) {
      retryMs = null
      await page.goto(url)
      // The page has settled when it offers a decision, shows a failure (the rate limit's own
      // or a code the server refused), or reports one already made — everything but the
      // "Checking the code…" moment.
      const settled = page
        .getByRole('button', { name: /^(Approve|Deny)$/ })
        .or(page.getByRole('alert'))
        .or(page.getByText(/^(Approved|Denied)$/))
      await expect(settled.first()).toBeVisible({ timeout: 15_000 })
      const refusal = page.getByRole('alert').filter({ hasText: /Too many requests/i })
      if (!(await refusal.isVisible().catch(() => false))) {
        return
      }
      const waitMs = retryMs ?? 11_000
      if (Date.now() + waitMs > deadline) {
        throw new Error(
          `the device page stayed rate-limited: the server asks for ${String(Math.ceil(waitMs / 1000))} more ` +
            'seconds and its `/device` window is the code lifetime (ten minutes). Restart the QA stack ' +
            '(`docker compose up --build -d`) to reset its counters, or wait the window out, then run again.',
        )
      }
      await page.waitForTimeout(waitMs)
    }
  } finally {
    page.off('response', noteRefusal)
  }
}

/** The email `oh` reported, once it has signed in. */
export async function loggedInAs(terminal: Terminal): Promise<string> {
  const match = await terminal.waitFor(CLI_LOGGED_IN, 30_000)
  return match[1] ?? ''
}

/**
 * Write the token for a server exactly where `oh login` writes it: `{ "servers": { … } }` in
 * `$XDG_CONFIG_HOME/openharness/credentials.json`, file `0600`, directory `0700`.
 */
function storeCliToken(server: string, token: string): void {
  const file = cliCredentialsPath()
  const directory = path.dirname(file)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  let servers: Record<string, string> = {}
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        servers?: Record<string, string>
      }
      servers = parsed.servers ?? {}
    } catch {
      // A file even `oh` could not read is replaced rather than layered onto.
    }
  }
  servers[server] = token
  writeFileSync(file, `${JSON.stringify({ servers }, null, 2)}\n`, { mode: 0o600 })
  // `writeFileSync`'s mode only applies when the file is created; an existing one is fixed here.
  chmodSync(file, 0o600)
  chmodSync(directory, 0o700)
}

/**
 * Make sure `oh` has a token for the server under test — **without** another device login.
 *
 * The scenario specs are not about signing in; they just need a signed-in CLI. The device
 * flow's verify endpoint (`GET /api/auth/device`) allows **five requests per ten minutes**,
 * and one full CLI pass runs more device logins than that — the scenarios that are about the
 * flow (W26a/d/e, W27b, C12) spend the budget by themselves. Every additional login — the
 * ones this helper would otherwise run after each scenario that signed out — would be
 * refused until the window passed, and no scenario's timeout has room to wait ten minutes.
 * The token therefore comes from the dev login (A7), the same door the browser fixture
 * uses, and is stored exactly where `oh login` stores one; the device flow itself stays
 * covered where it is the point (C12, W26a/d/e, W27b).
 *
 * This checks with one cheap `oh whoami` and signs in only when the answer is "not signed
 * in" — which is also what makes it correct after a spec has signed out.
 */
export async function ensureCliSignedIn(page: Page): Promise<void> {
  if (cliIsSignedIn()) {
    return
  }
  const token = await signInDevToken(page.context().request, CLI_SERVER)
  storeCliToken(CLI_SERVER, token)
}

/** Whether `oh` holds a token the server still accepts — asked with a real request. */
function cliIsSignedIn(): boolean {
  try {
    execFileSync('node', ['apps/tui/dist/index.js', 'whoami', '--server', CLI_SERVER], {
      cwd: CLI_CWD,
      encoding: 'utf8',
      env: { ...process.env, XDG_CONFIG_HOME: CLI_CONFIG_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}

/** The label every line of an agent message starts with (`components/message-view.tsx`). */
export const AGENT_LINE = 'agent › '

/** How many times `needle` occurs in a pane capture. */
export function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/**
 * Whether any agent message on the screen has text in it yet.
 *
 * The cursor a streaming message ends with is drawn as soon as the reply is announced, before
 * the first token arrives, so an `agent ›` line on its own only says a reply has *started*.
 * Interrupting at that point is interrupting nothing.
 */
export function replyHasText(screen: string): boolean {
  return screen.split('\n').some((line) => {
    const at = line.indexOf(AGENT_LINE)
    if (at === -1) return false
    return (
      line
        .slice(at + AGENT_LINE.length)
        .replaceAll('▌', '')
        .trim().length > 0
    )
  })
}

/**
 * The `error: …` lines of a pane capture, if any.
 *
 * Anchored at the start of a line on purpose: `oh` writes an error as a line of its own above
 * the status line (`components/notice-view.tsx`, `apps/tui/src/app.tsx`), while the words
 * "error:" can turn up anywhere in a reply, a prompt or a command line — matching those would
 * make the assertion below about the conversation rather than about the app.
 */
export function errorNoticeLines(screen: string): string[] {
  return screen.split('\n').filter((line) => line.trimStart().startsWith('error:'))
}

/**
 * Fail if the pane is showing an error notice.
 *
 * The CLI half of `expectNoErrorBanner` (`support.ts`): a failure `oh` reports inline — a
 * failed turn, or a read it could not make sense of ("the server answered with something this
 * client could not read") — is exactly what a scenario checking only for the text it expected
 * would not notice. Scenarios that provoke an error on purpose (C9, C11) do not call this.
 */
export function expectNoErrorNotice(screen: string): void {
  expect(errorNoticeLines(screen), 'the CLI is showing an error notice').toEqual([])
}

/** `text` with everything a regexp would read as syntax escaped. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Send a line to the chat and wait for the agent's answer to it to start arriving.
 *
 * The mock echoes its prompt, so the specs written for passes 1 and 2 wait for
 * `agent › <the prompt>` — which is both "the reply started" and, at least for a short
 * prompt, roughly "the reply is here". A real provider answers in its own words, so there is
 * nothing in the reply to match: the wait is for one more agent line on the screen than there
 * was before, which is the same event without the wording.
 *
 * `slow` marks a prompt the mock answers at length rather than echoing. Its reply is the
 * counted-off `part 1/40 part 2/40 …`, so the prompt is not in it to be matched.
 */
export async function sendAndAwaitAnswer(
  terminal: Terminal,
  text: string,
  options: { readonly slow?: boolean } = {},
): Promise<void> {
  const before = occurrences(terminal.capture(), AGENT_LINE)
  terminal.type(text)
  terminal.send('Enter')
  if (isRealModel) {
    await terminal.waitUntil((screen) => occurrences(screen, AGENT_LINE) > before, 60_000)
    return
  }
  const firstLine = (text.split('\n')[0] ?? '').trim()
  const expected = options.slow === true ? 'part 1/40' : escapeRegExp(firstLine)
  await terminal.waitFor(new RegExp(`agent › ${expected}`), 60_000)
}
