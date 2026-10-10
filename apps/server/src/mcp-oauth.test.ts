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

/** `POST` an empty body to a path as the default caller. */
async function post(test: TestContext, path: string): Promise<Response> {
  return test.request(path, { method: 'POST' })
}

/**
 * Run the whole browser round trip: start the flow, visit the authorization URL, and answer
 * the callback with the code the provider sent.
 */
async function completeFlow(
  scenario: Scenario,
  serverId: string,
): Promise<{ response: Response; code: string; state: string }> {
  const started = await post(scenario.test, `${BASE}/${serverId}/connect`)
  expect(started.status).toBe(200)
  const { authorization_url } = (await started.json()) as { authorization_url: string }
  const { code, state } = await simulateAuthorization(authorization_url)
  const response = await scenario.test.request(
    `${BASE}/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  )
  return { response, code, state }
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
    const callback = await scenario.test.request(
      `${BASE}/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    )
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

  it('refuses a used, unknown or another user’s state', async () => {
    const scenario = await makeScenario()
    const created = await createOAuthServer(scenario)
    const { response, code, state } = await completeFlow(scenario, created.id)
    expect(response.status).toBe(302)

    // Replaying the same callback finds the state already consumed.
    const replay = await scenario.test.request(
      `${BASE}/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    )
    expect(replay.status).toBe(400)

    const unknown = await scenario.test.request(
      `${BASE}/oauth/callback?code=${encodeURIComponent(code)}&state=not-a-real-state`,
    )
    expect(unknown.status).toBe(400)

    // A state started by one user, presented by another, is refused rather than completed.
    const second = await createOAuthServer(scenario, 'second')
    const started = await post(scenario.test, `${BASE}/${second.id}/connect`)
    const { authorization_url } = (await started.json()) as { authorization_url: string }
    const other = await simulateAuthorization(authorization_url)
    const otherUser = await scenario.test.signIn('mcp-oauth-other@example.com')
    const misuse = await scenario.test.anonymous(
      `${BASE}/oauth/callback?code=${encodeURIComponent(other.code)}&state=${encodeURIComponent(other.state)}`,
      { headers: { authorization: `Bearer ${otherUser.token}` } },
    )
    expect(misuse.status).toBe(400)
  })

  it('refuses an expired state', async () => {
    const scenario = await makeScenario()
    const created = await createOAuthServer(scenario)
    const started = await post(scenario.test, `${BASE}/${created.id}/connect`)
    const { authorization_url } = (await started.json()) as { authorization_url: string }
    const { code, state } = await simulateAuthorization(authorization_url)
    // Ten minutes is the state's life; a minute more and it is gone.
    scenario.clock.advance(11 * 60_000)
    const callback = await scenario.test.request(
      `${BASE}/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    )
    expect(callback.status).toBe(400)
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
