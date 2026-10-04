import { Hono } from 'hono'
import {
  ANTHROPIC_VERSION_HEADER,
  API_VERSION_PREFIX,
  LAST_EVENT_ID_HEADER,
  REQUEST_ID_HEADER,
  ulid,
} from '@openharness/protocol'
import { cors } from 'hono/cors'
import { AgentNotFoundError, SessionNotFoundError, type SessionStore } from '@openharness/session'

import { consoleLogger, type AppEnv, type Logger } from './types'
import { createAuthGuard } from './auth-guard'
import { rewriteDevLoginRequest, type BetterAuthInstance } from './auth'
import { createSessionRevocations } from './session-watch'
import { errorResponse, httpErrorResponse, HttpError } from './http/errors'
import { registerAgentRoutes } from './routes/agents'
import { registerAiSdkRoutes } from './routes/ai-sdk'
import type { AuthDeps, RouteDeps } from './routes/deps'
import { registerEventRoutes } from './routes/events'
import { registerMeRoutes } from './routes/me'
import { registerModelRoutes } from './routes/models'
import {
  registerProviderCredentialRoutes,
  type ProviderCredentialDeps,
} from './routes/provider-credentials'
import { registerSessionRoutes } from './routes/sessions'
import type { SessionScheduler } from './scheduler'
import { serveWebAsset } from './static'

/**
 * The openharness HTTP app.
 *
 * One Hono app, built from a store, a scheduler and an auth instance, with every route the
 * protocol defines (see `docs/api.md`). Nothing here is global state: `createApp` can be
 * called as often as a test wants, each time against a fresh `InMemorySessionStore`.
 *
 * ## What the app guarantees
 *
 * - **Every response carries a `request-id`**, and an error body repeats it in `request_id`.
 * - **Every failure is the protocol's envelope** — `{ type: 'error', error: { type, message } }`
 *   with the status the error type maps to — and no stack trace ever leaves the process.
 * - **`/v1/*` requires a session** (epic #65, A2): a Better Auth cookie or a bearer token,
 *   otherwise 401 `authentication_error`. `/v1/auth-config` is the one route ahead of the
 *   guard, because the web app reads it before sign-in; `/api/auth/*` is Better Auth's own
 *   surface and `/health` stays open.
 * - **Auth is the only thing checked before the route**; everything else is validated by the
 *   protocol's schemas, which is what turns a malformed request into a 400 and not a 500.
 * - **A long-lived response outlives its session only until the session is revoked or expires**
 *   (A2; issue #76): the SSE stream and the AI SDK adapter's stream re-check their session on
 *   a timer, and a revocation notification — published by the sign-out path and, on Postgres,
 *   by a trigger on the session table — closes them promptly on every instance.
 */
export interface AppOptions {
  /** The session log every route reads and writes. */
  readonly store: SessionStore
  /** Who runs a brain when the API says a session needs one. */
  readonly scheduler: SessionScheduler
  /**
   * The Better Auth instance, mounted at `/api/auth/*`, and the guard that authenticates
   * `/v1` with it.
   */
  readonly auth: {
    readonly instance: BetterAuthInstance
    /** The providers whose credentials are configured; `/v1/auth-config` lists them. */
    readonly enabledProviders: AuthDeps['enabledProviders']
    /** Whether dev login is on; `/v1/auth-config` reports it and the shim is installed. */
    readonly devLogin: boolean
    /**
     * The origins a cookie-authenticated write may come from (CSRF, A2). `BETTER_AUTH_URL`'s
     * origin is what the server passes.
     */
    readonly trustedOrigins: readonly string[]
  }
  /** Where sealed provider credentials live, and how a saved key is validated (A5). */
  readonly credentialRoutes: ProviderCredentialDeps
  /**
   * The model catalogue (epic #92): what `GET /v1/models` answers, and the per-provider cache
   * entry the credential PUT/DELETE routes drop (C4). `main.ts` builds it with the real
   * provider fetch and the bundled `@mastra/core` registry; a test injects its own seams.
   */
  readonly catalog: RouteDeps['catalog']
  /**
   * A directory of built web assets to serve at `/`, e.g. `apps/web/dist`.
   *
   * A GET outside the API that names no file in it gets `index.html`: the web app routes on
   * the URL hash, so the server only has to hand out the shell. With a web app served, the
   * plain `/device` path (the one an older link may carry) redirects to the hash route
   * `/#/device`, keeping its query — see the route near `notFound`.
   */
  readonly webDir?: string
  /**
   * Origins allowed to call the API from a browser, from `OPENHARNESS_CORS_ORIGINS`.
   *
   * Empty or omitted means no CORS headers at all — the API is same-origin or server-side
   * until someone says otherwise. The web app signs in with a cookie, so when this is used
   * the allowed origins are exactly the ones whose cookies the browser will send.
   */
  readonly corsOrigins?: readonly string[]
  /** The SSE keepalive interval in milliseconds; defaults to {@link SSE_KEEPALIVE_MS}. */
  readonly sseKeepaliveMs?: number
  /**
   * How often an open stream re-validates its auth session (A2/#76), in milliseconds;
   * defaults to {@link DEFAULT_SESSION_RECHECK_MS}. Tests shorten it.
   */
  readonly sessionRecheckMs?: number
  /** Where the app logs unexpected failures; defaults to the console. */
  readonly logger?: Logger
}

/**
 * Build the app.
 *
 * @param options the store, the scheduler, auth and the deployment's knobs; see
 *   {@link AppOptions}
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
        // The web app's session cookie crosses origins when the API is on another one: the
        // browser only sends (and stores) it when the server says so explicitly.
        credentials: true,
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: [
          'authorization',
          'content-type',
          ANTHROPIC_VERSION_HEADER,
          LAST_EVENT_ID_HEADER,
        ],
        exposeHeaders: [REQUEST_ID_HEADER],
        maxAge: 600,
      }),
    )
  }

  app.get('/health', (c) => c.json({ status: 'ok' }))

  // Better Auth owns `/api/auth/*`: sign-in, sign-out, the device flow, and the session
  // lookups the guard makes. The request passes through the dev-login shim, which maps the
  // documented `dev@localhost` onto the seeded address when — and only when — dev login is
  // on (see `auth.ts`).
  app.all('/api/auth/*', async (c) =>
    options.auth.instance.handler(await rewriteDevLoginRequest(c.req.raw, options.auth.devLogin)),
  )

  // The two halves of "a revoked or expired session ends its open responses" (A2/#76): the
  // registry of who is streaming under which session — swept by the store's revocation
  // notifications — and the re-validation the streams run on their own timer.
  const revocations = createSessionRevocations({ store: options.store, logger })
  const revalidateSession = async (headers: Headers): Promise<boolean> =>
    (await options.auth.instance.api.getSession({ headers })) !== null

  const deps: RouteDeps = {
    store: options.store,
    scheduler: options.scheduler,
    auth: { enabledProviders: options.auth.enabledProviders, devLogin: options.auth.devLogin },
    credentialRoutes: options.credentialRoutes,
    catalog: options.catalog,
    revocations,
    revalidateSession,
    ...(options.sseKeepaliveMs === undefined ? {} : { sseKeepaliveMs: options.sseKeepaliveMs }),
    ...(options.sessionRecheckMs === undefined
      ? {}
      : { sessionRecheckMs: options.sessionRecheckMs }),
  }

  // `/v1/auth-config` is registered before the guard, and is the only `/v1` route that is:
  // the web app reads it before anyone signs in (#62). Registration order is dispatch order
  // in Hono, so the guard below never runs for it.
  app.get(`${API_VERSION_PREFIX}/auth-config`, (c) =>
    c.json({ providers: deps.auth.enabledProviders, dev_login: deps.auth.devLogin }),
  )

  // A2: everything else under /v1 — the SSE stream and the AI SDK adapter included — needs a
  // session, and a cookie-authenticated write needs a trusted Origin.
  const guard = createAuthGuard({
    auth: options.auth.instance,
    trustedOrigins: options.auth.trustedOrigins,
  })
  app.use(API_VERSION_PREFIX, guard)
  app.use(`${API_VERSION_PREFIX}/*`, guard)

  registerMeRoutes(app, deps)
  registerAgentRoutes(app, deps)
  registerSessionRoutes(app, deps)
  registerEventRoutes(app, deps)
  registerAiSdkRoutes(app, deps)
  registerProviderCredentialRoutes(app, deps)
  registerModelRoutes(app, deps)

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

  // The web app's device-approval page is a hash route (`#/device?user_code=…`). When the
  // web app is served from this origin, a request for the plain path — an older link, or the
  // URL someone typed from memory — is sent on to that route with its query, instead of
  // quietly loading the shell on the home screen. Without a web app there is nothing at `/`
  // to send the reader to, so `/device` is not served at all (it 404s like any other
  // unknown path).
  if (options.webDir !== undefined) {
    app.get('/device', (c) => c.redirect(`/#/device${new URL(c.req.url).search}`, 302))
  }

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

/**
 * Whether a path belongs to the API, and so is never served the web app's shell.
 *
 * `/v1` is the protocol and `/api/auth` is Better Auth's surface; both answer JSON (or a
 * redirect) and neither has a page the shell could route to.
 */
export function isApiPath(path: string): boolean {
  return (
    path === API_VERSION_PREFIX ||
    path.startsWith(`${API_VERSION_PREFIX}/`) ||
    path === '/api' ||
    path.startsWith('/api/')
  )
}
