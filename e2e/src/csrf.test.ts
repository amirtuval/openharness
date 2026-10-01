import { ApiErrorBodySchema } from '@openharness/protocol'
import { DEV_LOGIN_EMAIL, DEV_LOGIN_PASSWORD } from '@openharness/server'
import { describe, expect, it } from 'vitest'

import { e2eHarness, type ServerProcess } from './harness'

/**
 * The CSRF rules a deployment enforces (issue #79).
 *
 * The servers in this suite run with `NODE_ENV=production` (see `harness/server.ts`), which
 * is the only mode in which these rules exist: Better Auth skips its entire origin check when
 * `NODE_ENV=test`, and vitest sets that, so a suite running the server under vitest's own
 * environment would pass with the check absent (or with a misconfigured `trustedOrigins`).
 * Starting the server in production mode and signing in with the `Origin` a real client sends
 * is the fix; this file is what proves the rules are on.
 *
 * Two distinct checks answer here:
 *
 * - **Better Auth's**, on `/api/auth/*`: a sign-in POST from a foreign origin is refused
 *   (`INVALID_ORIGIN`, 403), and so is a cookieless one that carries Fetch-Metadata headers —
 *   Node's own `fetch` sends `sec-fetch-mode: cors` — without an `Origin`
 *   (`MISSING_OR_NULL_ORIGIN`, 403; issue #79's report). The server's own URL is the one
 *   trusted origin (`trustedOrigins: [BETTER_AUTH_URL]`), and a sign-in that sends it
 *   succeeds. Refusing the cookieless POST is correct CSRF behaviour — the fix is the test
 *   coverage and the docs, never a disabled check.
 * - **ours**, on `/v1` (`auth-guard.ts`): a cookie-authenticated write without a trusted
 *   `Origin` is the protocol's 403 `permission_error`, in production mode exactly as before —
 *   the two checks are independent and neither replaces the other.
 */

const harness = e2eHarness('csrf')

/** POST the dev-login sign-in with exactly these headers, and answer the raw response. */
function signInAttempt(server: ServerProcess, headers: Record<string, string>): Promise<Response> {
  return fetch(`${server.baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ email: DEV_LOGIN_EMAIL, password: DEV_LOGIN_PASSWORD }),
  })
}

/** POST an agent as the cookie holder, with exactly these extra headers. */
function createAgentAttempt(
  server: ServerProcess,
  cookie: string,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(`${server.baseUrl}/v1/agents`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ name: 'CSRF agent', model: { id: 'anthropic/claude-sonnet-5' } }),
  })
}

describe('the origin check a deployment enforces (#79)', () => {
  it('refuses a sign-in POST from a foreign Origin', async () => {
    const server = await harness.server()

    const refused = await signInAttempt(server, { origin: 'https://evil.example' })

    expect(refused.status).toBe(403)
    const body = (await refused.json()) as { code?: string }
    expect(body.code).toBe('INVALID_ORIGIN')
  })

  it('refuses a cookieless sign-in with Fetch-Metadata headers and no Origin', async () => {
    // Exactly the shape #79 reported: Node's `fetch` sends `sec-fetch-mode: cors` on every
    // request, and any Fetch-Metadata header makes Better Auth force the origin check — with
    // no `Origin` to validate, that is a refusal. Correct CSRF behaviour, kept.
    const server = await harness.server()

    const refused = await signInAttempt(server, { 'sec-fetch-mode': 'cors' })

    expect(refused.status).toBe(403)
    const body = (await refused.json()) as { code?: string }
    expect(body.code).toBe('MISSING_OR_NULL_ORIGIN')
  })

  it('signs in when the Origin is the server’s own URL, and the session authenticates /v1', async () => {
    const server = await harness.server()

    const response = await signInAttempt(server, { origin: server.baseUrl })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { token?: string }
    expect(typeof body.token).toBe('string')

    const me = await fetch(`${server.baseUrl}/v1/me`, {
      headers: { authorization: `Bearer ${body.token}` },
    })
    expect(me.status).toBe(200)
  })

  it('keeps the /v1 cookie-write rule: no Origin is refused, the trusted one is accepted', async () => {
    // Our own guard's rule, not Better Auth's — in production mode both exist, and this is
    // what says they stay independent.
    const server = await harness.server()
    const signedIn = await signInAttempt(server, { origin: server.baseUrl })
    const setCookie = signedIn.headers.get('set-cookie')
    expect(signedIn.status).toBe(200)
    if (setCookie === null) {
      throw new Error('the sign-in answered no cookie')
    }
    const cookie = setCookie.split(';')[0] ?? ''

    // Without an Origin: refused, in the protocol's envelope.
    const refused = await createAgentAttempt(server, cookie, {})
    expect(refused.status).toBe(403)
    const envelope = ApiErrorBodySchema.parse(await refused.json())
    expect(envelope.error.type).toBe('permission_error')

    // With the trusted Origin — what the web app's own page sends — the write goes through.
    const accepted = await createAgentAttempt(server, cookie, { origin: server.baseUrl })
    expect(accepted.status).toBe(201)
    const agent = (await accepted.json()) as { name: string }
    expect(agent.name).toBe('CSRF agent')
  })
})
