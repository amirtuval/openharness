import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { expect, type Page } from '@playwright/test'

import { isRealModel } from './support'

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
 * (`<server>/#/device?user_code=…`), which is what {@link approveInBrowser} opens.
 *
 * The whitespace between the words is deliberate: a pane narrower than the line breaks it
 * across two rows, and `capture-pane` reports that as a newline.
 */
export const CLI_LOGIN_HINT = /Open (\S+) in your browser and enter the code\s+(\S+?)\s*\./
const CLI_LOGGED_IN = /Logged in as (\S+) on (\S+)/

/**
 * Approve a device code the way a person does: open the URL `oh login` printed and press
 * Approve on the page.
 *
 * The page has to be signed in already (the device approval is a signed-in action, A6); the
 * specs hand this the session-carrying page the fixtures built.
 */
export async function approveInBrowser(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await expect(page.getByRole('heading', { name: 'Approve a CLI login' })).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText('Approved')).toBeVisible()
}

/**
 * Run a full `oh login --no-browser`, approved in the browser, and wait for it to finish.
 *
 * @returns the printed URL and the user code, for a spec that wants to assert on them
 */
export async function loginCli(
  terminal: Terminal,
  page: Page,
): Promise<{ url: string; userCode: string }> {
  terminal.run(ohCommand('login', '--no-browser'))
  const hint = await terminal.waitFor(CLI_LOGIN_HINT, 30_000)
  const [, url, userCode] = hint
  if (url === undefined || userCode === undefined) {
    throw new Error(`the login hint was not readable: ${hint[0]}`)
  }
  await approveInBrowser(page, url)
  await terminal.waitFor(CLI_LOGGED_IN, 60_000)
  return { url, userCode }
}

/** The email `oh` reported, once it has signed in. */
export async function loggedInAs(terminal: Terminal): Promise<string> {
  const match = await terminal.waitFor(CLI_LOGGED_IN, 30_000)
  return match[1] ?? ''
}

/**
 * Make sure `oh` has a token for the server under test, signing in through the device flow if
 * it does not.
 *
 * The scenario specs are not about signing in, and a device login takes a browser and a poll:
 * this checks with one cheap `oh whoami` and runs the flow only when the answer is "not signed
 * in" — which is also what makes it correct after a spec has signed out. The token lands in
 * the QA run's own config directory, where every `ohCommand` finds it.
 */
export async function ensureCliSignedIn(page: Page): Promise<void> {
  if (cliIsSignedIn()) {
    return
  }
  // Wide on purpose: the login line names a URL and a code, and a narrow pane wraps it.
  const terminal = new Terminal('oh-qa-login', 120, 24)
  terminal.start()
  try {
    await loginCli(terminal, page)
  } finally {
    terminal.kill()
  }
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
export function escapeRegExp(text: string): string {
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
