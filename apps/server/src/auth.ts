import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory'
import { betterAuth, type BetterAuthOptions, type BetterAuthRateLimitStorage } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { bearer, deviceAuthorization } from 'better-auth/plugins'
import type { Kysely } from 'kysely'
import type { PostgresSchema } from '@openharness/session/postgres'

import {
  SOCIAL_PROVIDERS,
  type SocialProviderCredentials,
  type SocialProviderName,
  providerOptions,
} from './auth-profile'
import type { Logger } from './types'

/**
 * Better Auth, configured for this server (epic #65, A1/A2/A3/A7).
 *
 * Better Auth owns `/api/auth/*`: social sign-in with Google, GitHub and Microsoft, the
 * device-authorization flow `oh login` runs, cookie sessions for the web app and bearer
 * tokens for the CLI. This module is the whole of the configuration — one place to read what
 * the server will accept and what it will refuse:
 *
 * - **the tables are ours** (A1): run against the `user`/`session`/`account`/`verification`/
 *   `deviceCode` schema `@openharness/session`'s migrations created. Better Auth's own
 *   migrator is never called; the schema has to match what Better Auth expects, which is why
 *   the migration is generated from the same plugin list this file configures.
 * - **identity is the verified email** (A3): the provider rules live in `auth-profile.ts`, and
 *   {@link refuseUnverifiedUser} is the belt to their braces — a database hook that refuses
 *   any user creation whose email is not marked verified.
 * - **sessions** (A2): opaque tokens, 7-day expiry, sliding once a day, a fresh session
 *   (created within a day) for provider-credential writes, rate limiting on.
 * - **the device flow** (A6) accepts exactly `openharness-cli`, approves at
 *   `${BETTER_AUTH_URL}/#/device` (the web app's hash route), and its codes expire in ten
 *   minutes.
 * - **development login** (A7): email/password with one seeded user, only arranged for by
 *   `createDevLoginUser`, which the boot path calls when `OPENHARNESS_DEV_LOGIN=1` and the
 *   public URL is localhost.
 */

/**
 * The `client_id` the CLI's device flow presents.
 *
 * `@openharness/client` exports the same value (`OPENHARNESS_CLI_CLIENT_ID`) and `oh login`
 * sends it; the server cannot import the client, so this is the second half of the wire
 * contract. A different value is refused by {@link createAuth}'s `validateClient`.
 */
export const OPENHARNESS_CLI_CLIENT_ID = 'openharness-cli'

/** The address the dev user signs in with, as documented (`README.md`, `AGENTS.md`). */
export const DEV_LOGIN_EMAIL = 'dev@localhost'

/**
 * The address the dev user's row actually carries.
 *
 * Better Auth validates every email/password sign-in with zod's `z.email()`, which requires a
 * dotted domain — `dev@localhost` is refused before it reaches the database. The seeded row
 * therefore carries this spelling, and the dev-login-only {@link rewriteDevLoginRequest} maps
 * the documented one onto it as the request enters Better Auth's handler. Nothing else is
 * rewritten, and without `OPENHARNESS_DEV_LOGIN=1` the shim is never installed.
 */
export const DEV_LOGIN_STORED_EMAIL = 'dev@localhost.localdomain'

/** The dev user's password. Local development only, and documented. */
export const DEV_LOGIN_PASSWORD = 'dev'

/** The dev user's display name. */
export const DEV_LOGIN_NAME = 'Dev'

/** A session lives seven days (A2). */
export const SESSION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60

/** A session slides forward at most once a day (A2). */
export const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60

/** A session is *fresh* — good for provider-credential writes — for a day (A2). */
export const SESSION_FRESH_AGE_SECONDS = 24 * 60 * 60

/** Device codes expire in about ten minutes (A6). */
export const DEVICE_CODE_EXPIRES_IN = '10m'

/** How long a device code is polled for before it lapses, in milliseconds. */
export const DEVICE_CODE_EXPIRES_IN_MS = 10 * 60 * 1000

/**
 * Where the device flow sends the reader: the web app's approval route, on the public URL.
 *
 * The web app routes on the URL hash (`#/device?user_code=…`; see its `src/lib/router.ts`
 * and `docs/auth.md`), so the URL is `/` plus the fragment `#/device` — a plain `/device`
 * path would load the app's home screen instead. A trailing slash on `BETTER_AUTH_URL` is
 * dropped so the result is one well-formed URL either way.
 */
export function deviceVerificationUri(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/#/device`
}

/**
 * The verification URI with the code filled in — the one `oh login` prints.
 *
 * The query has to live **inside the fragment**, where the web app's `parseRoute` looks for
 * it. The code is `encodeURIComponent`ed, which is exactly what the web app's parser
 * (`new URLSearchParams`) decodes; the codes Better Auth generates are alphanumeric, so this
 * is insurance against a longer or custom alphabet, not a transformation today.
 */
export function deviceVerificationUriComplete(baseUrl: string, userCode: string): string {
  return `${deviceVerificationUri(baseUrl)}?user_code=${encodeURIComponent(userCode)}`
}

/** Everything {@link createAuth} needs that comes from the environment. */
export interface AuthConfig {
  /** `BETTER_AUTH_SECRET`: signs cookies and bearer tokens. Required at boot. */
  readonly secret: string
  /** `BETTER_AUTH_URL`: the public URL, Better Auth's base and the only trusted origin. */
  readonly baseUrl: string
  /** `OPENHARNESS_DEV_LOGIN=1`: enable email/password with the seeded dev user (A7). */
  readonly devLogin: boolean
  /**
   * Whether the auth endpoints are rate-limited (A2). On by default — that is what a
   * deployment runs — and off only in tests, whose sign-ins are far more frequent than a
   * person's and share one process-wide limiter store with every other test.
   */
  readonly rateLimit?: boolean
  /** Which social providers have credentials configured. */
  readonly providers: SocialProviderCredentials
}

/** The database Better Auth runs on: the server's Kysely/Postgres, or its in-memory store. */
export type AuthDatabase =
  | { readonly kind: 'postgres'; readonly db: Kysely<PostgresSchema> }
  | { readonly kind: 'memory'; readonly db: MemoryDB }

/** What {@link createAuth} answers. */
export interface Auth {
  /** The Better Auth instance: `auth.handler` serves `/api/auth/*`, `auth.api` is called. */
  readonly auth: BetterAuthInstance
  /** The configuration it was built from. */
  readonly config: AuthConfig
  /** The names of the social providers that are enabled, in {@link SOCIAL_PROVIDERS} order. */
  readonly enabledProviders: readonly SocialProviderName[]
}

/**
 * The shape of the object `betterAuth()` returns, as this package uses it.
 *
 * Restated rather than inferred from the call, because the inferred type of a
 * fully-plugged-in instance is enormous and appears in `.d.ts` output; the few members below
 * are the whole surface this server touches.
 */
export interface BetterAuthInstance {
  /** The web-standard handler mounted at `/api/auth/*`. */
  handler(request: Request): Promise<Response>
  /** The server-side API: `getSession`, `signOut`, and everything else Better Auth exposes. */
  readonly api: {
    getSession(input: { headers: Headers }): Promise<AuthSession | null>
    signOut(input: { headers: Headers; asResponse: true }): Promise<Response>
  }
  /** The internal context: `internalAdapter` and the password hasher, for seeding. */
  readonly $context: Promise<AuthContext>
}

/** The signed-in user Better Auth answers with: what `GET /v1/me` and ownership need. */
export interface AuthUser {
  readonly id: string
  readonly email: string
  readonly name?: string
  readonly image?: string | null
  readonly emailVerified: boolean
  readonly createdAt: Date | string
  readonly updatedAt: Date | string
}

/** The session Better Auth answers with. */
export interface AuthSession {
  readonly session: {
    readonly id: string
    readonly token: string
    readonly userId: string
    readonly createdAt: Date | string
    readonly updatedAt: Date | string
    readonly expiresAt: Date | string
    readonly ipAddress?: string | null
    readonly userAgent?: string | null
  }
  readonly user: AuthUser
}

/** The slice of Better Auth's context this server uses (seeding the dev user). */
export interface AuthContext {
  readonly internalAdapter: {
    findUserByEmail(email: string): Promise<{ user: AuthUser } | null>
    createUser(input: {
      email: string
      name: string
      emailVerified: boolean
      createdAt: Date
      updatedAt: Date
    }): Promise<AuthUser>
    createAccount(input: {
      userId: string
      providerId: string
      accountId: string
      password: string
      createdAt: Date
      updatedAt: Date
    }): Promise<unknown>
  }
  readonly password: {
    hash(password: string): Promise<string>
  }
}

/**
 * Build the Better Auth instance.
 *
 * @param config the secret, the public URL, the dev-login flag and the provider credentials
 * @param database the Kysely handle to the migrated schema, or the in-memory store
 * @param logger where Better Auth's own log lines go; the server's {@link Logger}
 */
export function createAuth(config: AuthConfig, database: AuthDatabase, logger: Logger): Auth {
  const enabledProviders = SOCIAL_PROVIDERS.filter(
    (provider) => config.providers[provider] !== undefined,
  )
  const socialProviders: NonNullable<BetterAuthOptions['socialProviders']> = providerOptions(
    config.providers,
  )
  const options: BetterAuthOptions = {
    secret: config.secret,
    baseURL: config.baseUrl,
    basePath: '/api/auth',
    database: databaseOptions(database),
    socialProviders,
    // A3, belt to the provider rules' braces: no user whose email is not verified is ever
    // created, whatever path got this far.
    databaseHooks: {
      user: {
        create: {
          before: refuseUnverifiedUser,
        },
      },
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      freshAge: SESSION_FRESH_AGE_SECONDS,
    },
    // A2: the auth endpoints are rate-limited. Better Auth's default rules are what run
    // (globally 100 per 10 s, and 3 per 10 s on the sign-in paths — the brute-force case),
    // against counters this instance owns.
    rateLimit: {
      enabled: config.rateLimit ?? true,
      customStorage: createInstanceRateLimitStorage(),
    },
    // The public URL is the only origin Better Auth trusts. The web app is served from it
    // (or talks to it through `OPENHARNESS_CORS_ORIGINS`, which is the /v1 CORS knob).
    trustedOrigins: [config.baseUrl],
    // The plugin list the session migrations were generated from — see
    // `packages/session/migrations/0011_better_auth.sql`. A plugin added here without
    // regenerating that migration is a schema mismatch Better Auth will notice.
    plugins: [
      deviceAuthorization({
        validateClient: (clientId) => clientId === OPENHARNESS_CLI_CLIENT_ID,
        // The web app's approval route (agreed with #62), on the public URL.
        verificationUri: deviceVerificationUri(config.baseUrl),
        expiresIn: DEVICE_CODE_EXPIRES_IN,
      }),
      bearer(),
    ],
    // Better Auth builds `verification_uri_complete` by `URL.searchParams.set`-ing
    // `user_code` onto the configured URI (see `buildVerificationUris` in its
    // `device-authorization` routes) — which writes the query into the URL's *search*
    // component, **before** the `#`. The web app reads the route and its query from the
    // hash, so the code would be invisible to it: this after-hook rewrites the field with
    // the query inside the fragment, where `parseRoute` looks. Every other field is left
    // exactly as Better Auth built it.
    hooks: {
      after: createAuthMiddleware((ctx) => {
        const returned = ctx.path === '/device/code' ? ctx.context.returned : undefined
        // An error response — a refused client id, a rate limit — or any other path has no
        // `user_code`: only the code document is rewritten.
        if (typeof returned === 'object' && returned !== null) {
          const body = returned as Record<string, unknown>
          if (typeof body.user_code === 'string') {
            body.verification_uri_complete = deviceVerificationUriComplete(
              config.baseUrl,
              body.user_code,
            )
          }
        }
        // A middleware answers a promise; this one changes the returned object in place and
        // has nothing of its own to return.
        return Promise.resolve()
      }),
    },
    // Better Auth's log lines go through the server's logger, so a test can capture them —
    // and so a leaked credential would show up in the same stream everything else uses.
    logger: {
      log: (level, message, ...args) => {
        const detail = args.length === 0 ? undefined : args
        if (level === 'error') {
          logger.error(`auth: ${message}`, detail)
        } else if (level === 'warn') {
          logger.warn(`auth: ${message}`, detail)
        } else {
          logger.debug(`auth: ${message}`, detail)
        }
      },
    },
    ...(config.devLogin
      ? {
          emailAndPassword: {
            enabled: true,
            // A7: the dev user is seeded, and nobody signs up for a password account: with
            // sign-up disabled the only credentials that work are the documented ones.
            disableSignUp: true,
          },
        }
      : {}),
  }
  const instance: BetterAuthInstance = buildInstance(options)
  return {
    auth: instance,
    config,
    enabledProviders,
  }
}

/**
 * The `user.create.before` hook: refuse to create a user whose email is not verified (A3).
 *
 * The provider rules already refuse an unverified social profile, and dev login seeds a
 * verified row; this is the last gate, so a path added later cannot quietly create an account
 * on an address nobody proved.
 */
export function refuseUnverifiedUser(user: { emailVerified?: boolean }): Promise<boolean> {
  // A database hook's answer may be a promise; this one has nothing to wait for.
  return Promise.resolve(user.emailVerified === true)
}

/**
 * Seed the one dev-login user (`OPENHARNESS_DEV_LOGIN=1`, A7), idempotently.
 *
 * Created through Better Auth's own internals — the password hash has to be the one
 * `sign-in/email` verifies — rather than through `sign-up/email`, which `disableSignUp`
 * refuses on purpose. Runs on every boot and does nothing when the user exists.
 */
export async function createDevLoginUser(auth: Auth): Promise<void> {
  const context = await auth.auth.$context
  const existing = await context.internalAdapter.findUserByEmail(DEV_LOGIN_STORED_EMAIL)
  if (existing !== null) {
    return
  }
  const now = new Date()
  const user = await context.internalAdapter.createUser({
    email: DEV_LOGIN_STORED_EMAIL,
    name: DEV_LOGIN_NAME,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  })
  await context.internalAdapter.createAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: await context.password.hash(DEV_LOGIN_PASSWORD),
    createdAt: now,
    updatedAt: now,
  })
}

/**
 * The dev-login request shim: map the documented `dev@localhost` onto the address the dev
 * user is stored under.
 *
 * Only with `OPENHANESS_DEV_LOGIN` on, only for `POST /api/auth/sign-in/email`, and only for
 * the exact dev address — every other request (and every request in a normal deployment) is
 * handed to Better Auth untouched. See {@link DEV_LOGIN_STORED_EMAIL} for why it exists.
 */
export async function rewriteDevLoginRequest(
  request: Request,
  devLogin: boolean,
): Promise<Request> {
  if (!devLogin || request.method !== 'POST' || !isEmailSignInPath(request.url)) {
    return request
  }
  const raw = await request.clone().text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return request
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    (body as { email?: unknown }).email !== DEV_LOGIN_EMAIL
  ) {
    return request
  }
  const headers = new Headers(request.headers)
  headers.delete('content-length')
  headers.set('content-type', 'application/json')
  return new Request(request.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, email: DEV_LOGIN_STORED_EMAIL }),
  })
}

/** Whether a URL is `/api/auth/sign-in/email` — ignoring a query string. */
function isEmailSignInPath(url: string): boolean {
  return new URL(url).pathname === '/api/auth/sign-in/email'
}

/**
 * The rate-limit counters, scoped to one Better Auth instance.
 *
 * Better Auth's built-in in-memory storage is process-global: two instances in one process —
 * a test harness, an embedded host running several servers — would share sign-in counters,
 * and a test process signs in far more often than a person ever does. A process per instance
 * is the deployment either way, so per-instance counters are the same limit; the rule the
 * storage is handed still is Better Auth's (3 sign-ins per 10 seconds, and so on).
 */
function createInstanceRateLimitStorage(): BetterAuthRateLimitStorage {
  const counters = new Map<string, { readonly count: number; readonly lastRequest: number }>()
  return {
    consume(key, rule) {
      const now = Date.now()
      const windowMs = rule.window * 1000
      const entry = counters.get(key)
      if (entry === undefined || now - entry.lastRequest >= windowMs) {
        counters.set(key, { count: 1, lastRequest: now })
        return Promise.resolve({ allowed: true, retryAfter: null })
      }
      if (entry.count >= rule.max) {
        return Promise.resolve({
          allowed: false,
          retryAfter: Math.ceil((entry.lastRequest + windowMs - now) / 1000),
        })
      }
      counters.set(key, { count: entry.count + 1, lastRequest: now })
      return Promise.resolve({ allowed: true, retryAfter: null })
    },
  }
}

/**
 * `betterAuth(options)`, typed down to the surface this server uses.
 *
 * A fully-plugged-in instance's inferred type is enormous — it appears in every consumer's
 * `.d.ts` if it leaks — so the one cast lives here, at the boundary, and the rest of the
 * package reads {@link BetterAuthInstance}.
 */
function buildInstance(options: BetterAuthOptions): BetterAuthInstance {
  return betterAuth(options) as unknown as BetterAuthInstance
}

/**
 * The `database` option: the Kysely instance, or Better Auth's in-memory adapter.
 *
 * Typed as a local union rather than `BetterAuthOptions['database']`, whose members
 * (`Database`, `Dialect`, `Kysely<any>`, …) are `any`-laden; the value is the same, but the
 * narrow type keeps a lint rule that cannot see through Better Auth's option type quiet.
 */
type AuthDatabaseOption =
  | { readonly db: Kysely<PostgresSchema>; readonly type: 'postgres' }
  | ReturnType<typeof memoryAdapter>

function databaseOptions(database: AuthDatabase): AuthDatabaseOption {
  if (database.kind === 'postgres') {
    return { db: database.db, type: 'postgres' }
  }
  return memoryAdapter(database.db)
}
