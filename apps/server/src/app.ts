import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { cors } from 'hono/cors'
import {
  ANTHROPIC_VERSION_HEADER,
  API_KEY_HEADER,
  API_VERSION_PREFIX,
  LAST_EVENT_ID_HEADER,
  REQUEST_ID_HEADER,
  ulid,
} from '@openharness/protocol'
import { AgentNotFoundError, SessionNotFoundError, type SessionStore } from '@openharness/session'

import { consoleLogger, type AppEnv, type Logger } from './types'
import { authenticationError, errorResponse, httpErrorResponse, HttpError } from './http/errors'
import { registerAgentRoutes } from './routes/agents'
import { registerAiSdkRoutes } from './routes/ai-sdk'
import type { RouteDeps } from './routes/deps'
import { registerEventRoutes } from './routes/events'
import { registerSessionRoutes } from './routes/sessions'
import type { SessionScheduler } from './scheduler'
import { serveWebAsset } from './static'

/**
 * The openharness HTTP app.
 *
 * One Hono app, built from a store and a scheduler, with every route the protocol defines
 * (see `docs/api.md`). Nothing here is global state: `createApp` can be called as often as a
 * test wants, each time against a fresh `InMemorySessionStore`.
 *
 * ## What the app guarantees
 *
 * - **Every response carries a `request-id`**, and an error body repeats it in `request_id`.
 * - **Every failure is the protocol's envelope** — `{ type: 'error', error: { type, message } }`
 *   with the status the error type maps to — and no stack trace ever leaves the process.
 * - **`/v1/*` requires the API key** when one is configured; `/health` never does.
 * - **Auth is the only thing checked before the route**; everything else is validated by the
 *   protocol's schemas, which is what turns a malformed request into a 400 and not a 500.
 */
export interface AppOptions {
  /** The session log every route reads and writes. */
  readonly store: SessionStore
  /** Who runs a brain when the API says a session needs one. */
  readonly scheduler: SessionScheduler
  /**
   * The API key `/v1/*` requires, sent as `x-api-key`.
   *
   * Omitted (or empty) leaves the API open — which is what a single-binary deployment behind
   * its own front door wants, and what local development gets.
   */
  readonly apiKey?: string
  /**
   * A directory of built web assets to serve at `/`, e.g. `apps/web/dist`.
   *
   * A GET outside `/v1` that names no file in it gets `index.html`: the web app routes on the
   * URL hash, so the server only has to hand out the shell.
   */
  readonly webDir?: string
  /**
   * Origins allowed to call the API from a browser, from `OPENHARNESS_CORS_ORIGINS`.
   *
   * Empty or omitted means no CORS headers at all — the API is same-origin or server-side
   * until someone says otherwise.
   */
  readonly corsOrigins?: readonly string[]
  /** The SSE keepalive interval in milliseconds; defaults to {@link SSE_KEEPALIVE_MS}. */
  readonly sseKeepaliveMs?: number
  /** Where the app logs unexpected failures; defaults to the console. */
  readonly logger?: Logger
}

/**
 * Build the app.
 *
 * @param options the store, the scheduler and the deployment's knobs; see {@link AppOptions}
 */
export function createApp(options: AppOptions): Hono<AppEnv> {
  const logger = options.logger ?? consoleLogger
  const app = new Hono<AppEnv>()

  // The request id is minted first and attached last, so it is on every response — including
  // the ones a route streamed, and the ones an error handler built.
  app.use('*', async (c, next) => {
    const requestId = `req_${ulid()}`
    c.set('requestId', requestId)
    await next()
    c.header(REQUEST_ID_HEADER, requestId)
  })

  const corsOrigins = options.corsOrigins ?? []
  if (corsOrigins.length > 0) {
    app.use(
      '*',
      cors({
        origin: [...corsOrigins],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: [
          API_KEY_HEADER,
          ANTHROPIC_VERSION_HEADER,
          'content-type',
          LAST_EVENT_ID_HEADER,
        ],
        exposeHeaders: [REQUEST_ID_HEADER],
        maxAge: 600,
      }),
    )
  }

  app.get('/health', (c) => c.json({ status: 'ok' }))

  const apiKey = options.apiKey
  if (apiKey !== undefined && apiKey.length > 0) {
    const authenticate = async (c: Context<AppEnv>, next: Next) => {
      const provided = c.req.header(API_KEY_HEADER)
      if (provided === undefined || !matchesApiKey(provided, apiKey)) {
        throw authenticationError('a valid x-api-key header is required')
      }
      await next()
    }
    app.use(API_VERSION_PREFIX, authenticate)
    app.use(`${API_VERSION_PREFIX}/*`, authenticate)
  }

  const deps: RouteDeps = {
    store: options.store,
    scheduler: options.scheduler,
    ...(options.sseKeepaliveMs === undefined ? {} : { sseKeepaliveMs: options.sseKeepaliveMs }),
  }
  registerAgentRoutes(app, deps)
  registerSessionRoutes(app, deps)
  registerEventRoutes(app, deps)
  registerAiSdkRoutes(app, deps)

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return httpErrorResponse(c, error)
    }
    if (error instanceof SessionNotFoundError || error instanceof AgentNotFoundError) {
      return errorResponse(c, 'not_found_error', error.message)
    }
    if (error instanceof RangeError) {
      // A cursor this endpoint cannot decode, or an id the store refused: the request is at
      // fault, and the message says which part of it was wrong.
      return errorResponse(c, 'invalid_request_error', error.message)
    }
    // Everything else is this server's problem, and the client is told nothing about it: an
    // unchecked error is where a stack trace or a query string would leak out.
    logger.error('unhandled error', error)
    return errorResponse(c, 'api_error', 'an unexpected error occurred')
  })

  app.notFound(async (c) => {
    if (options.webDir !== undefined && c.req.method === 'GET' && !isApiPath(c.req.path)) {
      const asset = await serveWebAsset(options.webDir, c.req.path)
      if (asset !== null) {
        return asset
      }
    }
    return errorResponse(c, 'not_found_error', `no route for ${c.req.method} ${c.req.path}`)
  })

  return app
}

/** Whether a path is part of the API, and so never served the web app's shell. */
export function isApiPath(path: string): boolean {
  return path === API_VERSION_PREFIX || path.startsWith(`${API_VERSION_PREFIX}/`)
}

/**
 * Compare a presented key with the configured one without leaking it through timing.
 *
 * Both sides are hashed first: `timingSafeEqual` needs equal-length buffers, and comparing
 * lengths directly is the leak this is meant to avoid.
 */
function matchesApiKey(provided: string, expected: string): boolean {
  const presented = createHash('sha256').update(provided, 'utf8').digest()
  const configured = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(presented, configured)
}
