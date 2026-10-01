import type { AuthSession, AuthUser } from './auth'

/**
 * The small shared types the server is written against: the Hono environment, and the
 * logging seam.
 */

/**
 * The Hono environment of every route in this app.
 *
 * `requestId` is set once per request by the middleware in `app.ts` and read back by the
 * error handlers, so an error body and the `request-id` response header always agree.
 *
 * `user`, `session` and `authKind` are set by the `/v1` auth guard (`auth-guard.ts`) before
 * any route runs: every route under `/v1` except `/v1/auth-config` reads its owner from
 * `user.id`, and the credential routes use `session` for the freshness check.
 */
export interface AppEnv {
  Variables: {
    requestId: string
    /** The signed-in user; the id is what agents and sessions are owned by (A4). */
    user: AuthUser
    /** The Better Auth session row behind the request. */
    session: AuthSession['session']
    /** How the caller authenticated — the cookie path is the one CSRF applies to (A2). */
    authKind: 'cookie' | 'bearer'
  }
}

/**
 * Where the server writes what it is doing.
 *
 * A seam rather than `console` directly, so a test can assert on a startup warning and a
 * host can route the server's output wherever it wants. The default is {@link consoleLogger}.
 */
export interface Logger {
  /** The job's own detail: what a periodic task did, line by line. */
  debug(message: string, detail?: unknown): void
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

/** The default {@link Logger}: `console`, one line per call. */
export const consoleLogger: Logger = {
  debug: (message, detail) => {
    write(console.debug, message, detail)
  },
  info: (message, detail) => {
    write(console.log, message, detail)
  },
  warn: (message, detail) => {
    write(console.warn, message, detail)
  },
  error: (message, detail) => {
    write(console.error, message, detail)
  },
}

function write(sink: (message: string) => void, message: string, detail?: unknown): void {
  if (detail === undefined) {
    sink(message)
  } else {
    sink(`${message} ${format(detail)}`)
  }
}

/** A detail value as one log line: an `Error` as its stack, anything else as JSON. */
function format(detail: unknown): string {
  if (detail instanceof Error) {
    return detail.stack ?? `${detail.name}: ${detail.message}`
  }
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

/** A {@link Logger} that throws every call away; the default in tests. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
