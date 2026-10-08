import { Hono } from 'hono'
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
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
import { FORWARDED_FOR_HEADER, resolveClientIp, withClientIpHeader } from './client-ip'
import { emptyRegistry, type ModelRegistry } from './catalog/registry'
import { DefaultModelPicker } from './default-model'
import { createSessionRevocations } from './session-watch'
import { parseTraceContext, runWithTraceContext } from './observability/trace-context'
import { noopTracer, type Tracer } from './observability/tracing'
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
 *   surface and the two probes — `/health`, liveness, and `/ready`, readiness (#151) — stay
 *   open.
 * - **Nothing a shared cache may hold is left cacheable** (#151): dynamic and error responses
 *   are `no-store`, static files carry the class `static.ts` gives them. See {@link NO_STORE}.
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
   * provider fetch and the bundled models.dev snapshot registry; a test injects its own seams.
   */
  readonly catalog: RouteDeps['catalog']
  /**
   * Where the automatic default's registry fallback reads model ids (epic #116, U4). The
   * bundled models.dev snapshot in production — `main.ts` passes the same one the
   * catalogue was built with — and `emptyRegistry` (no fallback) otherwise.
   */
  readonly registry?: ModelRegistry
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
   * `OPENHARNESS_TRUSTED_PROXY_HOPS` (#151): how many proxies sit in front of this server,
   * each of which appends one entry to `x-forwarded-for`. `0` (the default) trusts no
   * forwarding header at all — a client is free to send one — and uses the connection's
   * address as the client IP; with GCLB in front, `1`.
   *
   * The app resolves the client IP once, from the trusted entry of the chain (see
   * `client-ip.ts` for exactly which entry and why), and hands it to Better Auth on the one
   * header Better Auth reads for rate limiting and session records — so a client can neither
   * choose its rate-limit bucket nor land in someone else's.
   */
  readonly trustedProxyHops?: number
  /**
   * What `GET /ready` answers (#151). Defaults to {@link alwaysReady} — no draining, a store
   * that answers trivially — which is the in-memory store's truth. `main.ts` passes the real
   * one: the store's own `select 1` and the shutdown drain.
   */
  readonly readiness?: Readiness
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
  /**
   * Where spans go (issue #158): {@link initTracing}'s Cloud Trace tracer in a deployment,
   * {@link noopTracer} (the default) everywhere else. The app opens one server span per
   * request, continuing the trace the load balancer's headers name when it sent one, and
   * every JSON log line written while the request is served is tagged with that trace.
   */
  readonly tracer?: Tracer
  /** Where the app logs unexpected failures; defaults to the console. */
  readonly logger?: Logger
}

/**
 * What `GET /ready` asks (#151): can this instance take traffic right now?
 *
 * A readiness answer is two questions, and both have to be "yes": the process is not on its
 * way out (`isDraining`), and the store it depends on answers (`check`). The store question
 * is where a deployment's database shows up: an instance whose Postgres is gone must leave
 * the load balancer's rotation before it starts failing requests.
 */
export interface Readiness {
  /** Whether the process is draining for shutdown; a draining instance is not ready. */
  isDraining(): boolean
  /**
   * Whether the store answers a trivial query right now. Answers `false` for a store that
   * cannot answer **promptly** (the Postgres check carries its own deadline, about 2 s);
   * never throws — a failed check is the answer, not an error.
   */
  check(): Promise<boolean>
}

/**
 * The readiness of an app built without a database behind it: the in-memory store answers
 * trivially, and nothing is draining unless the host says so. `main.ts` passes the real one.
 */
export const alwaysReady: Readiness = {
  isDraining: () => false,
  check: () => Promise.resolve(true),
}

/**
 * The `Cache-Control` every route class answers with (#151, deployment epic #148).
 *
 * The deployment runs Cloud CDN in front of this origin with `cacheMode: USE_ORIGIN_HEADERS`,
 * so what a response says about caching is the CDN's whole policy. Two rules cover everything
 * this app serves:
 *
 * - **Dynamic responses are `no-store`**: everything under `/v1` (session-scoped by
 *   definition), Better Auth's own surface (`/api/auth/*`, user-specific and cookie-built —
 *   the value also carries `Vary: Cookie`), the probes, the `/device` redirect, and **any**
 *   response with a status outside 2xx on **any** path — an error body, a redirect or a
 *   partially-user-specific response must never be stored by a shared cache, whatever route
 *   produced it.
 * - **Static files decide for themselves** (`static.ts`): the hashed assets are immutable,
 *   the shell revalidates, other root files get an hour. They are not user-specific, so they
 *   are the responses a cache is for.
 */
const NO_STORE = 'no-store'

/** Where responses are dynamic: the API, Better Auth, the probes, the device redirect. */
function wantsNoStore(path: string): boolean {
  return isApiPath(path) || path === '/health' || path === '/ready' || path === '/device'
}

/** Whether the path is Better Auth's own surface, which the app mounts and nothing else. */
function isAuthPath(path: string): boolean {
  return path === '/api/auth' || path.startsWith('/api/auth/')
}

/**
 * The connection's remote address, when the app runs on a listener that has one.
 *
 * `getConnInfo` reads the adapter's `incoming` socket; in-process (`app.request`, which is
 * what a test does) there is no socket and it throws — nothing to resolve, which the caller
 * answers `null` for.
 */
function socketAddress(c: Context<AppEnv>): string | null {
  try {
    return getConnInfo(c).remote.address ?? null
  } catch {
    return null
  }
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
  const trustedProxyHops = options.trustedProxyHops ?? 0
  const readiness = options.readiness ?? alwaysReady
  const tracer = options.tracer ?? noopTracer

  // The trace a request belongs to (#158), outermost so the span covers everything below it.
  // The context is the load balancer's `traceparent` / `X-Cloud-Trace-Context` when it sent
  // one — continued, when tracing is on, by the server span opened here — and it is put in an
  // `AsyncLocalStorage` for the whole request, so every JSON log line written while the
  // request is served carries the trace and span ids that join it to that trace. With tracing
  // off there is no span, but the header's ids still reach the logs: a client's trace is not
  // this server's to drop.
  app.use('*', async (c, next) => {
    const incoming = parseTraceContext(c.req.raw.headers)
    const span = tracer.enabled
      ? tracer.startSpan(`HTTP ${c.req.method}`, {
          kind: 'server',
          parent: incoming,
          attributes: {
            'http.request.method': c.req.method,
            'url.path': c.req.path,
          },
        })
      : null
    const context = span ?? incoming
    const serve = async (): Promise<void> => {
      try {
        await next()
      } finally {
        if (span !== null) {
          span.setAttribute('http.response.status_code', c.res.status)
          span.setStatus(c.res.status < 500)
          span.end()
        }
      }
    }
    if (context === null) {
      await serve()
      return
    }
    await runWithTraceContext(context, serve)
  })

  // The request id is minted first and attached last, so it is on every response — including
  // the ones a route streamed, and the ones an error handler built.
  app.use('*', async (c, next) => {
    const requestId = `req_${ulid()}`
    c.set('requestId', requestId)
    await next()
    c.header(REQUEST_ID_HEADER, requestId)
  })

  // The CDN contract (#151): attached last for the same reason the request id is — a response
  // built by a route, a stream or an error handler is the one that gets the header. See
  // {@link NO_STORE} for the two rules; this middleware never touches a 2xx static file, which
  // carries the class `static.ts` gave it.
  app.use('*', async (c, next) => {
    await next()
    if (wantsNoStore(c.req.path) || c.res.status >= 300) {
      c.header('cache-control', NO_STORE)
    }
    if (isAuthPath(c.req.path)) {
      // Auth responses are built from the request's cookie, so anything that ever looked at
      // them without honouring `no-store` still gets told what they vary by. (`cors()` below
      // appends `Vary: Origin` the same way when the API is called cross-origin.)
      c.header('vary', 'cookie', { append: true })
    }
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

  // Liveness (#151): "this process is alive", nothing else — deliberately. It keeps answering
  // 200 while the server drains, because a process that is finishing its turns is alive, not
  // stuck; taking it out of rotation is `/ready`'s job.
  app.get('/health', (c) => c.json({ status: 'ok' }))

  // Readiness (#151): "send me traffic". 200 only while the store answers and this instance
  // is not draining; 503 the moment a shutdown begins, so a load balancer stops sending new
  // requests while the turns in flight finish. No session (a probe cannot sign in) and no
  // logging (a probe would fill the log).
  app.get('/ready', async (c) => {
    const ready = !readiness.isDraining() && (await readiness.check())
    return c.json({ status: ready ? 'ok' : 'unavailable' }, ready ? 200 : 503)
  })

  // Better Auth owns `/api/auth/*`: sign-in, sign-out, the device flow, and the session
  // lookups the guard makes. The request passes through the dev-login shim, which maps the
  // documented `dev@localhost` onto the seeded address when — and only when — dev login is
  // on (see `auth.ts`), and then through the IP shim: the client's address, resolved from
  // the trusted end of `x-forwarded-for` (or the socket, with no trusted proxy), is stamped
  // on the one header Better Auth reads for rate limiting and session records (#151). The
  // client's own forwarding headers — and any value it put on our header — are never what
  // Better Auth sees.
  app.all('/api/auth/*', async (c) => {
    const request = await rewriteDevLoginRequest(c.req.raw, options.auth.devLogin)
    const clientIp = resolveClientIp({
      forwardedFor: request.headers.get(FORWARDED_FOR_HEADER),
      socketAddress: socketAddress(c),
      trustedProxyHops,
    })
    return options.auth.instance.handler(withClientIpHeader(request, clientIp))
  })

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
    // The automatic default model (epic #116, U4) is built here, per app: the record of who
    // the server has picked for lives as long as this app does (see `default-model.ts`).
    defaultModel: new DefaultModelPicker({
      store: options.store,
      catalog: options.catalog,
      registry: options.registry ?? emptyRegistry,
      logger,
    }),
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
    // unchecked error is where a stack trace or a query string would leak out. The line keeps
    // the request's own coordinates (#158) so a failure is findable in Cloud Logging by path
    // and status, and joined to the trace it happened in.
    logger.error('unhandled error', {
      error,
      method: c.req.method,
      path: c.req.path,
      status: 500,
      request_id: c.get('requestId'),
    })
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
    // The web app's files are served to `HEAD` exactly as to `GET` (#196): a link checker, an
    // uptime probe, `curl -I` or Cloud CDN revalidating a cached entry asks the same question
    // with `HEAD`, and the `404 no-store` it used to get — for a file the `GET` beside it
    // serves — is what kept the CDN from caching one. Hono routes a `HEAD` through the `GET`
    // handlers and drops the body of what comes back, but `c.req.method` is still `HEAD` here,
    // so the gate has to name it; `serveWebAsset` answers it without a body.
    const reads = c.req.method === 'GET' || c.req.method === 'HEAD'
    if (options.webDir !== undefined && reads && !isApiPath(c.req.path)) {
      const asset = await serveWebAsset(options.webDir, c.req.path, c.req.method)
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
