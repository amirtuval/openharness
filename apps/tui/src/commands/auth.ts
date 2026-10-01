import type { Client, DeviceLoginStart } from '@openharness/client'
import { AuthenticationError, DeviceLoginError } from '@openharness/client'

import type { BrowserOutcome } from '../browser'
import type { CredentialStore } from '../credentials'
import { describeError, notSignedInMessage, type ErrorContext } from '../errors'

/**
 * `oh login` / `oh logout` / `oh whoami` (epic #65, A6).
 *
 * Login is the device flow: ask for a code, send the user to the browser, poll until they
 * approve, then store the session token. Every other command picks that token up from the
 * credentials file and sends it as `Authorization: Bearer`; a 401 is what "not signed in"
 * looks like, and `describeError` turns it into the one line that says what to do.
 */

/** Where the auth commands write, and what they need to talk to a server. */
export interface AuthIo {
  /** One line of output. */
  readonly stdout: (line: string) => void
  /** One line of error output. */
  readonly stderr: (line: string) => void
  /** The server this run is about, for messages and error hints. */
  readonly context: ErrorContext
  /** The server root, as the credentials file keys tokens by it. */
  readonly server: string
  /** The stored tokens: read by `whoami`, written by `login`, cleared by `logout`. */
  readonly store: CredentialStore
  /**
   * A client for this server, carrying `token` when one is given.
   *
   * Login uses both: an anonymous client to start and poll the device flow, and one holding
   * the new token to ask the server who just signed in.
   */
  readonly createApiClient: (token: string | undefined) => Client
}

/** What `oh login` needs on top of {@link AuthIo}. */
export interface LoginIo extends AuthIo {
  /** `--no-browser`: print the URL and the code instead of opening a browser. */
  readonly noBrowser: boolean
  /** Open the sign-in page. Injectable so tests never launch a browser. */
  readonly openBrowser: (url: string) => BrowserOutcome
  /** Ctrl+C: stops the poll, and the login reports itself cancelled. */
  readonly signal?: AbortSignal | undefined
}

/**
 * `oh login` — sign in through the browser.
 *
 * The URL and the user code are printed whether or not a browser opens, because that is the
 * whole fallback story of the device flow: on SSH and in CI there is nothing to open, and
 * the person signs in on whatever machine does have a browser and can reach the URL.
 */
export async function runLogin(io: LoginIo): Promise<number> {
  let start: DeviceLoginStart
  try {
    start = await io.createApiClient(undefined).auth.startDeviceLogin()
  } catch (error) {
    return reportFailure(io, error)
  }

  const url = start.verificationUriComplete ?? start.verificationUri
  const opened = io.noBrowser ? false : io.openBrowser(url).opened
  if (opened) {
    io.stdout(`Opening ${url} in your browser.`)
    io.stdout(`If it does not open, enter the code ${start.userCode} at that URL.`)
  } else {
    io.stdout(`Open ${url} in your browser and enter the code ${start.userCode}.`)
  }
  io.stdout('Waiting for approval…')

  let token: string
  try {
    token = await io.createApiClient(undefined).auth.pollDeviceLogin(start.deviceCode, {
      interval: start.interval,
      signal: io.signal,
    })
  } catch (error) {
    if (io.signal?.aborted === true) {
      io.stderr('oh: login cancelled.')
      return cancelledCode(io.signal)
    }
    return reportFailure(io, error)
  }

  try {
    io.store.save(io.server, token)
  } catch (error) {
    return reportFailure(io, error)
  }

  try {
    const me = await io.createApiClient(token).me()
    io.stdout(`Logged in as ${me.email} on ${io.server}`)
    return 0
  } catch (error) {
    return reportFailure(io, error)
  }
}

/**
 * `oh logout` — revoke the session on the server, then forget the token locally.
 *
 * The local token is removed even when the server cannot be reached: keeping a token the
 * user asked to be rid of only because the network is down is the wrong trade. The command
 * warns instead, and still exits 0 — locally, it did what it was asked.
 */
export async function runLogout(io: AuthIo): Promise<number> {
  const token = io.store.tokenFor(io.server)
  if (token === undefined) {
    io.stderr(`oh: not signed in to ${io.server}.`)
    return 1
  }

  let warning: string | undefined
  try {
    await io.createApiClient(token).auth.signOut()
  } catch (error) {
    // An AuthenticationError means the server has already forgotten the session — the goal
    // state, reached early. Anything else is worth saying out loud.
    if (!(error instanceof AuthenticationError)) {
      const detail = describeError(error, io.context).message.replace(/\.$/u, '')
      warning = `could not revoke the session (${detail}); the token was deleted locally anyway.`
    }
  }

  try {
    io.store.remove(io.server)
  } catch (error) {
    return reportFailure(io, error)
  }

  io.stdout(`Logged out of ${io.server}.`)
  if (warning !== undefined) io.stderr(`oh: ${warning}`)
  return 0
}

/** `oh whoami` — the email the session belongs to, and the server it lives on. */
export async function runWhoami(io: AuthIo): Promise<number> {
  const token = io.store.tokenFor(io.server)
  if (token === undefined) {
    // Say it without a request: no token is the answer whether or not the server is up.
    io.stderr(`oh: ${notSignedInMessage(io.server)}`)
    return 1
  }

  try {
    const me = await io.createApiClient(token).me()
    io.stdout(`Logged in as ${me.email} on ${io.server}`)
    return 0
  } catch (error) {
    return reportFailure(io, error)
  }
}

/** Print a failure the way the rest of the CLI does, and return its exit code. */
function reportFailure(io: AuthIo, error: unknown): number {
  if (error instanceof DeviceLoginError) {
    io.stderr(`oh: ${deviceLoginMessage(error)}`)
    return 1
  }
  const report = describeError(error, io.context)
  io.stderr(`oh: ${report.message}`)
  for (const hint of report.hints) io.stderr(`  ${hint}`)
  if (report.stack !== undefined) io.stderr(report.stack)
  return 1
}

/** The one line a device login that ended without a token gets. */
function deviceLoginMessage(error: DeviceLoginError): string {
  switch (error.code) {
    case 'expired_token':
      return 'the login code expired before it was approved. Run `oh login` again.'
    case 'access_denied':
      return 'the login was denied in the browser.'
    default:
      return error.description === undefined || error.description === ''
        ? `the device login failed (${error.code}).`
        : `the device login failed (${error.code}): ${error.description}`
  }
}

/**
 * The exit code a cancelled login returns.
 *
 * A signal handler aborts with the code it wants (`130` for Ctrl+C, `143` for `SIGTERM`), so
 * the run leaves with the same code a default-terminated process would have.
 */
function cancelledCode(signal: AbortSignal | undefined): number {
  return typeof signal?.reason === 'number' ? signal.reason : 130
}
