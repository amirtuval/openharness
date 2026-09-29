import { execFileSync } from 'node:child_process'
import path from 'node:path'

import type { Page } from '@playwright/test'

/**
 * A real pseudo-terminal for the CLI scenarios.
 *
 * `oh` is an Ink app: it needs a TTY, it writes escape sequences, and what it looks like is
 * half of what is being tested. `tmux` gives it one, `send-keys` types into it and
 * `capture-pane` reads back what is on the screen — the same way a person would look at it.
 */

const SHOT_DIR = process.env.QA_SHOT_DIR ?? '../docs/qa/v1-chat'

/** Where the CLI is run from. `apps/tui/dist/index.js` relative to the `e2e` package. */
export const CLI_CWD = process.env.QA_OH_CWD ?? '../'
export const CLI_COMMAND = process.env.QA_OH_CLI ?? 'node apps/tui/dist/index.js'
export const CLI_SERVER = process.env.QA_BASE_URL ?? 'http://localhost:3000'

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
