import { ApiError, ResponseValidationError } from '@openharness/client'

/** A failure as the UI shows it: one line, then the hints worth acting on. */
export interface ErrorReport {
  /** What went wrong, in one line. */
  readonly message: string
  /** What to try next; empty when the message says enough. */
  readonly hints: readonly string[]
  /** The stack, present only when `--debug` asked for it. */
  readonly stack?: string | undefined
}

/** What {@link describeError} needs to write a useful hint. */
export interface ErrorContext {
  /** The server root the client was pointed at, for the connection-refused hint. */
  readonly server?: string | undefined
  /** Keep the stack trace. */
  readonly debug?: boolean | undefined
}

/**
 * Turn anything thrown into something a person can act on.
 *
 * The two failures worth a hint of their own are the ones a TUI hits first: a key the
 * server will not take, and a server that is not there. Everything else keeps the server's
 * own message, which is the only part that knows what actually happened.
 *
 * Stack traces are for `--debug`: inside a terminal UI they push the conversation off the
 * screen, and the message is what the user needs anyway.
 */
export function describeError(error: unknown, context: ErrorContext = {}): ErrorReport {
  if (error instanceof ApiError) {
    return describeApiError(error, context)
  }

  if (error instanceof ResponseValidationError) {
    return withStack(
      {
        message: 'the server answered with something this client could not read.',
        hints: [
          `check that ${context.server ?? 'the server'} is an openharness server, and that it is the same version as the CLI.`,
        ],
      },
      error,
      context,
    )
  }

  if (isAbort(error)) {
    return { message: 'the request was cancelled.', hints: [] }
  }

  const code = errorCode(error)

  if (code === 'ECONNREFUSED' || isFetchFailure(error)) {
    return withStack(
      {
        message: `could not reach the server at ${context.server ?? 'the configured URL'}.`,
        hints:
          code === 'ENOTFOUND'
            ? ['check the host name in the server URL.']
            : [
                `is a server running there? start it, or point oh at another one with --server <url>.`,
              ],
      },
      error,
      context,
    )
  }

  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    return withStack(
      {
        message: 'the connection to the server dropped.',
        hints: ['check that the server is still running, then try again.'],
      },
      error,
      context,
    )
  }

  const message = error instanceof Error ? error.message : String(error)
  return withStack({ message, hints: [] }, error, context)
}

function describeApiError(error: ApiError, context: ErrorContext): ErrorReport {
  const report = { message: apiErrorMessage(error), hints: apiErrorHints(error, context) }
  return withStack(report, error, context)
}

function apiErrorMessage(error: ApiError): string {
  switch (error.status) {
    case 401:
    case 403:
      return `the server rejected the request (${error.status}): ${error.message}`
    case 404:
      return `not found: ${error.message}`
    case 429:
      return `the server is rate limiting us (429): ${error.message}`
    default:
      return error.status >= 500
        ? `the server failed (${error.status}): ${error.message}`
        : `${error.message} (${error.status})`
  }
}

function apiErrorHints(error: ApiError, context: ErrorContext): readonly string[] {
  switch (error.type) {
    case 'authentication_error':
    case 'permission_error':
      return [
        'check the API key: pass --api-key, set OPENHARNESS_API_KEY, or add "apiKey" to the config file.',
      ]
    case 'not_found_error':
      return ['check the id — `oh sessions` lists the sessions the server has.']
    case 'rate_limit_error':
      return ['wait a moment and try again.']
    default:
      return error.retryable
        ? [
            `the server says this is retryable; if it keeps happening, check ${context.server ?? 'the server'}.`,
          ]
        : []
  }
}

function withStack(
  report: Omit<ErrorReport, 'stack'>,
  error: unknown,
  context: ErrorContext,
): ErrorReport {
  if (context.debug !== true) return report
  const stack = error instanceof Error ? error.stack : undefined
  return stack === undefined ? report : { ...report, stack }
}

/** The `code` of the error or of anything in its `cause` chain, e.g. `ECONNREFUSED`. */
function errorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** `fetch` reports a transport failure as a `TypeError` with "fetch failed" in the message. */
function isFetchFailure(error: unknown): boolean {
  return error instanceof TypeError && /fetch failed|network/iu.test(error.message)
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'AbortError')
  )
}
