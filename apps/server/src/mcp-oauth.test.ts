import { afterAll, describe, expect, it } from 'vitest'
import { API_VERSION_PREFIX, type McpServer } from '@openharness/protocol'
import { InMemoryMcpServerStore } from '@openharness/session'
import { createTestClock, type TestClock } from '@openharness/session/testing'
import { createVault, envKeyProvider, type Vault } from '@openharness/vault'

import { createMcpFetch } from './mcp/fetch'
import { createMcpServerService, type McpServerService } from './mcp/service'
import {
  simulateAuthorization,
  startStubAuthorizationServer,
  startStubMcpServer,
  type StubAuthorizationServer,
  type StubMcpServer,
} from './test-support/mcp'
import { TEST_PUBLIC_URL, TEST_SECRETS_KEY, createTestApp, type TestContext } from './test-support'

/**
 * The OAuth 2.1 client end to end (epic #303, X10): discovery (RFC 9728 then RFC 8414), dynamic
 * client registration (RFC 7591), the authorization code + PKCE flow through this server's own
 * callback, token refresh before expiry and on a 401, a failed refresh, and the refusals a
 * misused or expired `state` gets.
 *
 * The callback is a **browser page**, not an API call (#311): `oh` starts the flow by opening
 * the authorization URL in the system browser, which may never have signed in here, so the
 * callback is authenticated by the `state` alone — it completes the flow for the state's user,
 * refuses a session that belongs to somebody else, and answers a page (the app is redirected to
 * its settings screen, the CLI is shown a page it can close). The tests below walk that too.
 *
 * Both ends are real HTTP servers on loopback: the MCP server is built from the official SDK,
 * and the authorization server answers discovery, registration and PKCE the way a real one
 * does, so what is proved is the whole exchange rather than a fixture.
 */

const BASE = `${API_VERSION_PREFIX}/me/mcp_servers`
const CALLBACK = `${TEST_PUBLIC_URL}/v1/me/mcp_servers/oauth/callback`

const stubs: { close(): Promise<void> }[] = []

afterAll(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

/** One test's whole world: the app, a parallel resolver, the store and the two stubs. */
interface Scenario {
  readonly test: TestContext
  readonly service: McpServerService
  readonly store: InMemoryMcpServerStore
  readonly vault: Vault
  readonly clock: TestClock
  readonly mcp: StubMcpServer
  readonly authorization: StubAuthorizationServer
}

/** Build the app, the stubs and a resolver over one store, all on one controllable clock. */
async function makeScenario(
  options: {
    registration?: boolean
    expiresIn?: number
  } = {},
): Promise<Scenario> {
  const clock = createTestClock(Date.UTC(2026, 2, 15, 10, 0, 0))
  const authorization = await startStubAuthorizationServer({
    registration: options.registration ?? true,
    ...(options.expiresIn === undefined ? {} : { expiresIn: options.expiresIn }),
    scopes: ['mcp'],
  })
  const mcp = await startStubMcpServer({
    authorizationServer: authorization.issuer,
    scopes: ['mcp'],
  })
  stubs.push(authorization, mcp)
  const store = new InMemoryMcpServerStore({ now: clock.now })
  const vault = createVault(envKeyProvider(TEST_SECRETS_KEY))
  const fetch = createMcpFetch({ allowPrivate: true })
  const now = (): Date => new Date(clock.currentMs)
  const test = createTestApp({
    mcpServers: { store, fetch, callbackUrl: CALLBACK, now },
  })
  const service = createMcpServerService({ store, vault, fetch, callbackUrl: CALLBACK, now })
  return { test, service, store, vault, clock, mcp, authorization }
}

/** Create an `oauth` server as the default caller. */
async function createOAuthServer(scenario: Scenario, name = 'notes'): Promise<McpServer> {
  const response = await scenario.test.request(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auth: 'oauth', name, url: scenario.mcp.url, enabled: true }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as McpServer
}

/** `POST` to a path as the default caller; `client` becomes the connect body when given. */
async function post(test: TestContext, path: string, client?: 'web' | 'cli'): Promise<Response> {
  return test.request(path, {
    method: 'POST',
    ...(client === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client }) }),
  })
}

/** The callback URL for one `code`/`state` pair, as the provider's redirect spells it. */
function callbackUrl(code: string, state: string): string {
  return `${BASE}/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
}

/**
 * Run the whole browser round trip: start the flow, visit the authorization URL, and answer
 * the callback with the code the provider sent.
 *
 * `anonymous` fires the callback with no session at all — what `oh`'s system browser does — and
 * `client` says where the flow was started.
 */
async function completeFlow(
  scenario: Scenario,
  serverId: string,
  options: { readonly client?: 'web' | 'cli'; readonly anonymous?: boolean } = {},
): Promise<{ response: Response; code: string; state: string }> {
  const started = await post(scenario.test, `${BASE}/${serverId}/connect`, options.client)
  expect(started.status).toBe(200)
  const { authorization_url } = (await started.json()) as { authorization_url: string }
  const { code, state } = await simulateAuthorization(authorization_url)
  const response =
    options.anonymous === true
      ? await scenario.test.anonymous(callbackUrl(code, state))
      : await scenario.test.request(callbackUrl(code, state))
  return { response, code, state }
}

/** The HTML body of a callback page, as a string, asserting it is one. */
async function pageBody(response: Response): Promise<string> {
  expect(response.headers.get('content-type')).toContain('text/html')
  expect(response.headers.get('cache-control')).toBe('no-store')
  return response.text()
}

describe('MCP OAuth: the authorization code flow', () => {
  it('discovers, registers, authorizes with PKCE and lists tools', async () => {
    const scenario = await makeScenario()
    const created = await createOAuthServer(scenario)
    // A fresh OAuth server is not connected until the flow completes.
    expect(created).toMatchObject({ auth: 'oauth', status: 'needs_reconnect' })

    const started = await post(scenario.test, `${BASE}/${created.id}/connect`)
    expect(started.status).toBe(200)
    const { authorization_url } = (await started.json()) as { authorization_url: string }
    const url = new URL(authorization_url)
    expect(url.origin + url.pathname).toBe(`${scenario.authorization.issuer}/authorize`)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('stub-client')
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('resource')).toBe(scenario.mcp.url)
    expect(scenario.authorization.registrations).toBe(1)

    const { code, state } = await simulateAuthorization(authorization_url)
    const callback = await scenario.test.request(callbackUrl(code, state))
    expect(callback.status).toBe(302)
    // Back to the app, naming the server that was connected.
    const location = callback.headers.get('location') ?? ''
    expect(location).toContain(`mcp_connected=${created.id}`)

    const after = await scenario.test.request(`${BASE}/${created.id}`)
    const connected = (await after.json()) as McpServer
    expect(connected.status).toBe('connected')
    expect(connected.tools.map((tool) => tool.name)).toEqual(['search', 'ping'])
    // The server sent the bearer token the token endpoint issued.
    expect(scenario.mcp.authorizations).toContain('Bearer access-1')
    // The tokens are stored sealed, never in the resource.
    const stored = await scenario.store.get(created.id, {
      ownerId: (await scenario.test.currentUser()).id,
    })
    expect(stored?.tokens).toBeDefined()
    expect(JSON.stringify(stored?.tokens)).not.toContain('access-1')
  })

  it('completes the flow for a browser with no session at all', async () => {
    const scenario = await makeScenario()
    const created = await createOAuthServer(scenario)

    // No cookie, no bearer token: exactly what the system browser `oh` opens has. The state is
    // the authentication, and the flow is completed for the user it was minted for (#311).
    const { response } = await completeFlow(scenario, created.id, { anonymous: true })
    expect(response.status).toBe(302)
    const after = await scenario.test.request(`${BASE}/${created.id}`)
    expect((await after.json()) as McpServer).toMatchObject({ status: 'connected' })
  })

  it('answers a CLI-started flow with a page rather than a redirect', async () => {
    const scenario = await makeScenario()
    const created = await createOAuthServer(scenario)

    const { response } = await completeFlow(scenario, created.id, {
      client: 'cli',
      anonymous: true,
    })
    expect(response.status).toBe(200)
    const body = await pageBody(response)
    // The CLI is waiting on its own terminal, so the browser is told it may close the tab.
    expect(body).toContain('Connected notes.')
    expect(body).toContain('You can close this tab and return to openharness.')
  })

  it('refuses a state presented by another user’s session', async () => {
    const scenario = await makeScenario()
    const second = await createOAuthServer(scenario, 'second')
    const started = await post(scenario.test, `${BASE}/${second.id}/connect`)
    const { authorization_url } = (await started.json()) as { authorization_url: string }
    const other = await simulateAuthorization(authorization_url)

    // The state belongs to the default user; the browser presents somebody else's session — a
    // confused flow. It is refused rather than completed for the wrong person, and the tokens
    // are not sealed anywhere.
    const otherUser = await scenario.test.signIn('mcp-oauth-other@example.com')
    const misuse = await scenario.test.anonymous(callbackUrl(other.code, other.state), {
      headers: { authorization: `Bearer ${otherUser.token}` },
    })
    expect(misuse.status).toBe(400)
    expect(await pageBody(misuse)).toContain('started by another user')
    const after = await scenario.test.request(`${BASE}/${second.id}`)
    expect((await after.json()) as McpServer).toMatchObject({ status: 'needs_reconnect' })
  })

  it('refuses a used, unknown or expired state with a readable page', async () => {
    const scenario = await makeScenario()
    const created = await createOAuthServer(scenario)
    const { response, code, state } = await completeFlow(scenario, created.id)
    expect(response.status).toBe(302)

    // Replaying the same callback finds the state already consumed.
    const replay = await scenario.test.request(callbackUrl(code, state))
    expect(replay.status).toBe(400)
    expect(await pageBody(replay)).toContain('unknown, expired or already used')

    const unknown = await scenario.test.request(callbackUrl(code, 'not-a-real-state'))
    expect(unknown.status).toBe(400)
    expect(await pageBody(unknown)).toContain('unknown, expired or already used')

    const started = await post(scenario.test, `${BASE}/${created.id}/connect`)
    const { authorization_url } = (await started.json()) as { authorization_url: string }
    const fresh = await simulateAuthorization(authorization_url)
    // Ten minutes is the state's life; a minute more and it is gone.
    scenario.clock.advance(11 * 60_000)
    const expired = await scenario.test.request(callbackUrl(fresh.code, fresh.state))
    expect(expired.status).toBe(400)
    expect(await pageBody(expired)).toContain('unknown, expired or already used')
  })

  it('renders the authorization server’s refusal as an escaped page', async () => {
    const scenario = await makeScenario()
    // Everything echoed into the page is escaped: an `error_description` is the authorization
    // server's text, and a page is a page (#311).
    const refused = await scenario.test.anonymous(
      `${BASE}/oauth/callback?error=access_denied` +
        `&error_description=${encodeURIComponent('<script>alert(1)</script> denied')}`,
    )
    expect(refused.status).toBe(400)
    const body = await pageBody(refused)
    expect(body).toContain('access_denied')
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt; denied')
    expect(body).not.toContain('<script>')
  })

  it('keeps the exemption to the callback’s own GET', async () => {
    const scenario = await makeScenario()
    // The auth guard is skipped for exactly one method and path, so anything else on that path
    // is still refused a session like every other route.
    expect(
      (await scenario.test.anonymous(`${BASE}/oauth/callback`, { method: 'POST' })).status,
    ).toBe(401)
    expect((await scenario.test.anonymous(BASE)).status).toBe(401)
  })

  it('refuses a connect body that names a client it does not have', async () => {
    const scenario = await makeScenario()
    const created = await createOAuthServer(scenario)
    const response = await scenario.test.request(`${BASE}/${created.id}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client: 'mobile' }),
    })
    expect(response.status).toBe(400)
  })

  it('answers 422 when the authorization server offers no dynamic registration', async () => {
    const scenario = await makeScenario({ registration: false })
    const created = await createOAuthServer(scenario)
    const started = await post(scenario.test, `${BASE}/${created.id}/connect`)
    expect(started.status).toBe(422)
    const body = (await started.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe('mcp_connection_error')
    expect(body.error.message).toContain('dynamic client registration')
  })

  it('refuses to connect a server that does not use OAuth', async () => {
    const scenario = await makeScenario()
    const created = await createOAuthServer(scenario)
    const response = await scenario.test.request(`${BASE}/${created.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auth: 'none' }),
    })
    expect(response.status).toBe(200)
    expect((await post(scenario.test, `${BASE}/${created.id}/connect`)).status).toBe(400)
  })
})

describe('MCP OAuth: refresh', () => {
  it('refreshes a token before it expires and uses the new one', async () => {
    const scenario = await makeScenario({ expiresIn: 1 })
    const created = await createOAuthServer(scenario)
    await completeFlow(scenario, created.id)
    // The token the flow minted expires within the second, so the next resolution refreshes and
    // the token endpoint issues a new one — never the expired token minted by the flow.
    const issued = scenario.authorization.issuedTokens.length
    const resolved = await scenario.service.resolve(
      (await scenario.test.currentUser()).id,
      created.id,
    )
    expect(resolved?.headers.Authorization).not.toBe('Bearer access-1')
    expect(scenario.authorization.issuedTokens.length).toBeGreaterThan(issued)
  })

  it('refreshes once on a 401 and reports the server connected', async () => {
    const scenario = await makeScenario()
    const created = await createOAuthServer(scenario)
    await completeFlow(scenario, created.id)
    // The access token the flow minted looks live, but the server now wants a different one:
    // the check gets a 401, refreshes once, and succeeds with the new token.
    scenario.mcp.setRequiredToken('access-2')
    const tested = await post(scenario.test, `${BASE}/${created.id}/test`)
    expect(tested.status).toBe(200)
    expect((await tested.json()) as McpServer).toMatchObject({ status: 'connected' })
    expect(scenario.authorization.issuedTokens).toContain('access-2')
  })

  it('marks the server needs_reconnect when a refresh fails', async () => {
    const scenario = await makeScenario({ expiresIn: 1 })
    const created = await createOAuthServer(scenario)
    await completeFlow(scenario, created.id)
    scenario.authorization.setRefreshWorking(false)

    expect(
      await scenario.service.resolve((await scenario.test.currentUser()).id, created.id, {
        forceRefresh: true,
      }),
    ).toBeNull()
    const after = await scenario.test.request(`${BASE}/${created.id}`)
    expect((await after.json()) as McpServer).toMatchObject({ status: 'needs_reconnect' })
  })
})

describe('MCP OAuth: disconnect', () => {
  it('drops the tokens and lands the server on needs_reconnect', async () => {
    const scenario = await makeScenario()
    const created = await createOAuthServer(scenario)
    await completeFlow(scenario, created.id)

    const disconnected = await post(scenario.test, `${BASE}/${created.id}/disconnect`)
    expect(disconnected.status).toBe(200)
    expect((await disconnected.json()) as McpServer).toMatchObject({ status: 'needs_reconnect' })
    const stored = await scenario.store.get(created.id, {
      ownerId: (await scenario.test.currentUser()).id,
    })
    expect(stored?.tokens).toBeUndefined()
    expect(
      await scenario.service.resolve((await scenario.test.currentUser()).id, created.id),
    ).toBeNull()
  })
})
