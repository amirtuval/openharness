import { ApiError, ResponseValidationError, type FetchLike } from '@openharness/client'
import { z } from 'zod'

/**
 * `GET /v1/auth-config`: which ways of signing in this server offers.
 *
 * The server answers it **unauthenticated**, which is the point — the sign-in page has to
 * know what to draw before there is a session. The interface is agreed with the server issue
 * (#61) and is not part of `@openharness/protocol`, so the client package does not speak it;
 * this module does, with a schema of its own.
 *
 * ```json
 * { "providers": ["google", "github", "microsoft"], "dev_login": true }
 * ```
 *
 * `providers` lists only the social providers whose client id and secret the server has
 * (epic #65, A3), and `dev_login` is the local-only username/password form (A7).
 */

/** The social providers the server can offer (epic #65, A3). */
export const AUTH_PROVIDERS = ['google', 'github', 'microsoft'] as const

export type AuthProvider = (typeof AUTH_PROVIDERS)[number]

/** The route the server answers the config on. */
export const AUTH_CONFIG_PATH = '/v1/auth-config'

/** Whether a name the server sent is one of the providers this app can draw a button for. */
export function isAuthProvider(name: string): name is AuthProvider {
  return (AUTH_PROVIDERS as readonly string[]).includes(name)
}

/**
 * The auth config, as a local schema rather than a protocol one.
 *
 * An unknown provider name is dropped rather than fatal: a newer server may add one this app
 * does not know how to sign in with, and the buttons for the ones it does know still work.
 * The drop is part of the schema — one unknown name must not fail the whole parse — rather
 * than a filter at a call site, so every reader of the config gets the same list.
 */
export const AuthConfigSchema = z.object({
  providers: z.array(z.string()).transform((names) => names.filter(isAuthProvider)),
  dev_login: z.boolean(),
})

export type AuthConfig = z.infer<typeof AuthConfigSchema>

/** What {@link fetchAuthConfig} needs. */
export interface FetchAuthConfigOptions {
  /** Server root; empty means the page's own origin, exactly as for the API client. */
  baseUrl: string
  /** The `fetch` to use; defaults to the global one. */
  fetch?: FetchLike | undefined
  /** Aborts the request. */
  signal?: AbortSignal | undefined
}

/**
 * Read the server's auth config.
 *
 * Unauthenticated and sent with `credentials: 'include'` like every other request, so the
 * same-origin cookie (or its absence) rides along; the answer does not depend on it.
 *
 * @throws ApiError when the server answers a non-2xx status
 * @throws ResponseValidationError when the body is not an auth config
 */
export async function fetchAuthConfig(options: FetchAuthConfigOptions): Promise<AuthConfig> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const response = await fetchImpl(`${stripTrailingSlashes(options.baseUrl)}${AUTH_CONFIG_PATH}`, {
    headers: { accept: 'application/json' },
    credentials: 'include',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  const body = await readJson(response)
  if (!response.ok) {
    throw new ApiError(
      response.status,
      `The server answered ${response.status} for the auth config.`,
    )
  }

  const parsed = AuthConfigSchema.safeParse(body)
  if (!parsed.success) {
    throw new ResponseValidationError(
      response.status,
      `The server answered ${AUTH_CONFIG_PATH} with a body that is not an auth config.`,
      parsed.error.message,
    )
  }
  return parsed.data
}

/** The response body as JSON, or `undefined` when there was none or it was not JSON. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/** A base URL without its trailing slashes: empty stays empty, meaning "this origin". */
function stripTrailingSlashes(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, '')
}
