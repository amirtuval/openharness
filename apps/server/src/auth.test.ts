import { describe, expect, it } from 'vitest'
import { API_VERSION_PREFIX, ApiErrorBodySchema } from '@openharness/protocol'

import {
  DEV_LOGIN_EMAIL,
  DEV_LOGIN_PASSWORD,
  OPENHARNESS_CLI_CLIENT_ID,
  deviceVerificationUri,
  deviceVerificationUriComplete,
} from './auth'
import { createTestApp, type TestContext } from './test-support'

/**
 * The authentication surface (epic #65, A1/A2/A6/A7): what `/v1` accepts, what Better Auth
 * serves under `/api/auth/*`, and the pieces the CLI's `oh login` walks through.
 *
 * The routes' own behaviour — ownership, credentials — has its own suites; what is here is
 * the front door: every `/v1` route refusing an anonymous caller, cookie and bearer both
 * working, sign-out revoking, the device flow minting a token a bearer request can use, and
 * the rate limiter answering 429 when it is on.
 */

/** Every `/v1` route, as `(method, path)` with a worst-case id, for the 401 sweep. */
const V1_ROUTES: readonly (readonly [string, string])[] = [
  ['GET', `${API_VERSION_PREFIX}/agents`],
  ['POST', `${API_VERSION_PREFIX}/agents`],
  ['GET', `${API_VERSION_PREFIX}/agents/agent_01HZZZZZZZZZZZZZZZZZZZZZZZ`],
  ['POST', `${API_VERSION_PREFIX}/agents/agent_01HZZZZZZZZZZZZZZZZZZZZZZZ`],
  ['GET', `${API_VERSION_PREFIX}/sessions`],
  ['POST', `${API_VERSION_PREFIX}/sessions`],
  ['GET', `${API_VERSION_PREFIX}/sessions/sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ`],
  ['POST', `${API_VERSION_PREFIX}/sessions/sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ/events`],
  ['GET', `${API_VERSION_PREFIX}/sessions/sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ/events`],
  ['GET', `${API_VERSION_PREFIX}/sessions/sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ/events/stream`],
  ['POST', `${API_VERSION_PREFIX}/sessions/sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ/ai-sdk/chat`],
  ['GET', `${API_VERSION_PREFIX}/me`],
  ['GET', `${API_VERSION_PREFIX}/provider-credentials`],
  ['PUT', `${API_VERSION_PREFIX}/provider-credentials/anthropic`],
  ['DELETE', `${API_VERSION_PREFIX}/provider-credentials/anthropic`],
]

describe('the /v1 guard', () => {
  it('answers 401 authentication_error on every route without a session', async () => {
    const test = createTestApp()

    for (const [method, path] of V1_ROUTES) {
      const response = await test.anonymous(path, {
        method,
        ...(method === 'POST' || method === 'PUT'
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ events: [] }),
            }
          : {}),
      })
      expect([path, method, response.status]).toEqual([path, method, 401])
      const body = ApiErrorBodySchema.parse(await response.json())
      expect(body.error.type).toBe('authentication_error')
    }
  })

  it('accepts a cookie session and a bearer token alike', async () => {
    const test = createTestApp()
    const { token } = await test.signIn()

    const cookie = await signInCookie(test)
    const viaCookie = await test.anonymous(`${API_VERSION_PREFIX}/me`, {
      headers: { cookie, origin: 'http://localhost:3000' },
    })
    const viaBearer = await test.request(`${API_VERSION_PREFIX}/me`, {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(viaCookie.status).toBe(200)
    expect(viaBearer.status).toBe(200)
    const cookieUser: unknown = await viaCookie.json()
    const bearerUser: unknown = await viaBearer.json()
    expect(cookieUser).toEqual(bearerUser)
  })

  it('answers the caller from GET /v1/me in the protocol shape', async () => {
    const test = createTestApp()
    const signedIn = await test.signIn()

    const response = await test.request(`${API_VERSION_PREFIX}/me`)
    const body = (await response.json()) as Record<string, unknown>

    expect(body['id']).toBe(signedIn.user.id)
    expect(body['email']).toBe(signedIn.user.email)
    expect(body['created_at']).toBe(new Date(signedIn.user.createdAt).toISOString())
  })

  it('reports the deployment’s sign-in in /v1/auth-config, unauthenticated', async () => {
    const test = createTestApp({
      providers: {
        google: { clientId: 'g', clientSecret: 'gs' },
        microsoft: { clientId: 'm', clientSecret: 'ms', tenantId: 'contoso' },
      },
    })

    const response = await test.anonymous(`${API_VERSION_PREFIX}/auth-config`)

    expect(response.status).toBe(200)
    // Only the providers with credentials, in protocol order; dev login on (A7).
    await expect(response.json()).resolves.toEqual({
      providers: ['google', 'microsoft'],
      dev_login: true,
    })
  })

  it('reports dev_login: false when the dev login is off', async () => {
    const test = createTestApp({ devLogin: false })

    await expect(
      (await test.anonymous(`${API_VERSION_PREFIX}/auth-config`)).json(),
    ).resolves.toEqual({ providers: [], dev_login: false })
  })
})

describe('sign-out', () => {
  it('revokes the bearer token it is presented with', async () => {
    const test = createTestApp()
    const { token } = await test.signIn()

    const before = await test.request(`${API_VERSION_PREFIX}/me`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(before.status).toBe(200)

    const out = await test.anonymous('/api/auth/sign-out', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(out.status).toBe(200)

    const after = await test.request(`${API_VERSION_PREFIX}/me`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(after.status).toBe(401)
  })
})

describe('the device flow (A6)', () => {
  it('mints a token the CLI can use as a bearer, once a signed-in user approves', async () => {
    const test = createTestApp()

    // 1. The CLI asks for a device code, identifying itself as `openharness-cli`.
    const codeResponse = await test.anonymous('/api/auth/device/code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: OPENHARNESS_CLI_CLIENT_ID, scope: 'openid profile email' }),
    })
    expect(codeResponse.status).toBe(200)
    const code = (await codeResponse.json()) as {
      device_code: string
      user_code: string
      verification_uri: string
      verification_uri_complete: string
      interval: number
      expires_in: number
    }
    // The web app's approval page is a hash route (agreed with #62): the query — the code —
    // has to land inside the fragment, or the app never sees it.
    expect(code.verification_uri).toBe('http://localhost:3000/#/device')
    expect(code.verification_uri_complete).toBe(
      `http://localhost:3000/#/device?user_code=${code.user_code}`,
    )
    expect(code.expires_in).toBe(600)
    expect(code.interval).toBeGreaterThan(0)

    // 2. The user signs in and opens the verification page, which claims the code.
    const { token: userToken } = await test.signIn()
    const claim = await test.anonymous(`/api/auth/device?user_code=${code.user_code}`, {
      headers: { authorization: `Bearer ${userToken}` },
    })
    expect(claim.status).toBe(200)
    await expect(claim.json()).resolves.toMatchObject({ status: 'pending' })

    // 3. They approve it, as the signed-in user.
    const approve = await test.anonymous('/api/auth/device/approve', {
      method: 'POST',
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userCode: code.user_code }),
    })
    expect(approve.status).toBe(200)

    // 4. The CLI polls and gets the session token.
    const poll = await test.anonymous('/api/auth/device/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.device_code,
        client_id: OPENHARNESS_CLI_CLIENT_ID,
      }),
    })
    expect(poll.status).toBe(200)
    const { access_token: accessToken } = (await poll.json()) as { access_token: string }

    // 5. That token is a session token: it authenticates /v1 as the approving user.
    const me = await test.request(`${API_VERSION_PREFIX}/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(me.status).toBe(200)
    const user = (await me.json()) as { id: string }
    expect(user.id).toBe((await test.currentUser()).id)
  })

  it('refuses a client id that is not the CLI’s', async () => {
    const test = createTestApp()

    const response = await test.anonymous('/api/auth/device/code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'somebody-else', scope: 'openid' }),
    })

    expect(response.status).toBe(400)
    // The client documents `invalid_client` as one of the device flow's refusal codes, and
    // `pollDeviceLogin` turns it into a `DeviceLoginError`.
    const body = (await response.json()) as { error?: string }
    expect(body.error).toBe('invalid_client')
  })

  it('refuses a poll for a code nobody approved', async () => {
    const test = createTestApp()
    const codeResponse = await test.anonymous('/api/auth/device/code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: OPENHARNESS_CLI_CLIENT_ID, scope: 'openid' }),
    })
    const code = (await codeResponse.json()) as { device_code: string }

    const poll = await test.anonymous('/api/auth/device/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.device_code,
        client_id: OPENHARNESS_CLI_CLIENT_ID,
      }),
    })

    expect(poll.status).toBe(400)
    const body = (await poll.json()) as { error?: string }
    expect(body.error).toBe('authorization_pending')
  })
})

describe('the device-flow verification URIs (A6)', () => {
  it('keep the user code inside the fragment, encoded as the web app parses it', () => {
    // A code with characters an alphanumeric generator would never produce, to pin the
    // encoding contract: the web app reads the hash and parses it with `URLSearchParams`.
    const complete = deviceVerificationUriComplete('http://localhost:3000/', 'AB CD&E')

    expect(deviceVerificationUri('http://localhost:3000/')).toBe('http://localhost:3000/#/device')
    expect(complete).toBe('http://localhost:3000/#/device?user_code=AB%20CD%26E')

    const [path, search] = new URL(complete).hash.slice(1).split('?')
    expect(path).toBe('/device')
    expect(new URLSearchParams(search).get('user_code')).toBe('AB CD&E')
  })
})

describe('dev login (A7)', () => {
  it('signs the documented dev user in', async () => {
    const test = createTestApp()

    const response = await test.anonymous('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEV_LOGIN_EMAIL, password: DEV_LOGIN_PASSWORD }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { user?: { email?: string } }
    expect(body.user?.email).toBe('dev@localhost.localdomain')
  })

  it('is off — and the dev user does not exist — when the flag is not set', async () => {
    const test = createTestApp({ devLogin: false })

    const response = await test.anonymous('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEV_LOGIN_EMAIL, password: DEV_LOGIN_PASSWORD }),
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { message?: string }
    expect(body.message).toMatch(/not enabled/i)
  })

  it('has no sign-up: the only password account that can exist is the seeded one', async () => {
    const test = createTestApp()

    const response = await test.anonymous('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'someone@example.com', password: 'hunter22222', name: 'N' }),
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { code?: string }
    expect(body.code).toBe('EMAIL_PASSWORD_SIGN_UP_DISABLED')
  })
})

describe('rate limiting (A2)', () => {
  it('refuses the fourth sign-in in the window', async () => {
    // The limiter store is per instance; this one asks for it explicitly. Better Auth's
    // default rule for the sign-in paths is three per ten seconds.
    const test = createTestApp({ rateLimit: true })
    const attempt = async (): Promise<number> => {
      const response = await test.anonymous('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: DEV_LOGIN_EMAIL, password: DEV_LOGIN_PASSWORD }),
      })
      await response.arrayBuffer()
      return response.status
    }

    const statuses = [await attempt(), await attempt(), await attempt(), await attempt()]

    expect(statuses.slice(0, 3).every((status) => status !== 429)).toBe(true)
    expect(statuses[3]).toBe(429)
  })

  it('is off in the default test app, so suites can sign in freely', async () => {
    const test = createTestApp()

    for (let index = 0; index < 4; index += 1) {
      const response = await test.anonymous('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: DEV_LOGIN_EMAIL, password: DEV_LOGIN_PASSWORD }),
      })
      expect(response.status).toBe(200)
      await response.arrayBuffer()
    }
  })
})

/** Sign in over the dev login and answer the session cookie a browser would hold. */
async function signInCookie(test: TestContext): Promise<string> {
  const response = await test.anonymous('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: DEV_LOGIN_EMAIL, password: DEV_LOGIN_PASSWORD }),
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie === null) {
    throw new Error('the sign-in answered no cookie')
  }
  return setCookie.split(';')[0] ?? ''
}
