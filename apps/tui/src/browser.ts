import { spawn } from 'node:child_process'

/**
 * Opening the sign-in page, the way `oh login` does it (epic #65, A6).
 *
 * The device flow does not need a browser — the URL and the code are printed either way —
 * so a browser is a courtesy, and one that must not fire where there is nothing to open it
 * on: a machine with no display, a CI runner, an SSH session. {@link openBrowser} checks
 * before spawning, and the platform command is `xdg-open` / `open` / `start`.
 */

/** Why a browser was not opened. */
export type BrowserSkipReason = 'no-display' | 'ci' | 'ssh' | 'failed'

/** What came of trying to open the sign-in page. */
export type BrowserOutcome =
  | { readonly opened: true; readonly command: string }
  | {
      readonly opened: false
      readonly reason: BrowserSkipReason
      /** The failure, when {@link BrowserOutcome} is a `'failed'` one. */
      readonly detail?: string | undefined
    }

/** The part of a spawned process this needs. */
export interface BrowserProcess {
  on(event: 'error', listener: (error: Error) => void): unknown
  unref(): void
}

/** How a browser is launched; injectable so tests never start a real one. */
export type BrowserSpawn = (command: string, args: readonly string[]) => BrowserProcess

/** Everything {@link openBrowser} reads, with the seams tests need. */
export interface OpenBrowserOptions {
  /** The environment deciding whether a browser makes sense; defaults to `process.env`. */
  readonly env?: Record<string, string | undefined> | undefined
  /** The platform picking the command; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform | undefined
  /** How to launch the command; defaults to `node:child_process`'s `spawn`. */
  readonly spawn?: BrowserSpawn | undefined
}

/**
 * Open `url` in the default browser, unless there is no browser to open it in.
 *
 * Skipped — with the reason reported — in CI, under SSH, and on a platform that needs a
 * display when `DISPLAY` and `WAYLAND_DISPLAY` are both absent. Everything else spawns the
 * platform's opener detached, so the CLI is not held up by it; a command that is not there
 * does not fail the login either, because the caller always prints the URL and the code as
 * the fallback.
 *
 * @param url the page to open
 * @param options the environment, the platform, and the spawn seam
 */
export function openBrowser(url: string, options: OpenBrowserOptions = {}): BrowserOutcome {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform

  const skip = skipReason(env, platform)
  if (skip !== undefined) return { opened: false, reason: skip }

  const [command, args] = browserCommand(url, platform)
  try {
    const child = (options.spawn ?? defaultSpawn)(command, args)
    // A missing opener (no xdg-open in a slim container) surfaces here, asynchronously. It is
    // not a failure worth waiting for: the printed URL is the fallback either way.
    child.on('error', () => {})
    child.unref()
    return { opened: true, command }
  } catch (error) {
    return {
      opened: false,
      reason: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Why not to open a browser here, or `undefined` when it makes sense. */
function skipReason(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): BrowserSkipReason | undefined {
  if (isCi(env['CI'])) return 'ci'
  if (hasValue(env['SSH_CONNECTION']) || hasValue(env['SSH_TTY']) || hasValue(env['SSH_CLIENT'])) {
    return 'ssh'
  }
  if (needsDisplay(platform) && !hasValue(env['DISPLAY']) && !hasValue(env['WAYLAND_DISPLAY'])) {
    return 'no-display'
  }
  return undefined
}

/** The platform's "open this URL" command, and its arguments. */
function browserCommand(
  url: string,
  platform: NodeJS.Platform,
): readonly [string, readonly string[]] {
  switch (platform) {
    case 'darwin':
      return ['open', [url]]
    case 'win32':
      // `start` reads its first argument as the window title, so give it an empty one.
      return ['cmd', ['/c', 'start', '', url]]
    default:
      return ['xdg-open', [url]]
  }
}

/** The real spawn: detached, nothing to read, and not waited on. */
const defaultSpawn: BrowserSpawn = (command, args) =>
  spawn(command, [...args], { detached: true, stdio: 'ignore' })

/** A desktop session only exists where one of these says so. */
function needsDisplay(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin' && platform !== 'win32'
}

/** Set and not blank: an empty variable is how a shell unsets one. */
function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== ''
}

/** CI runners set `CI`; `CI=false` (a person opting out) is not one. */
function isCi(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return (
    normalized !== undefined && normalized !== '' && normalized !== 'false' && normalized !== '0'
  )
}
