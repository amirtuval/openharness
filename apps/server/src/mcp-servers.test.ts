import { afterAll, describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  MAX_MCP_SERVERS_PER_USER,
  McpServerSchema,
  type McpServer,
  type UserId,
} from '@openharness/protocol'
import { InMemoryMcpServerStore } from '@openharness/session'
import { createVault, envKeyProvider, type Vault } from '@openharness/vault'

import { createMcpFetch } from './mcp/fetch'
import { createMcpServerService } from './mcp/service'
import { startStubMcpServer, type StubMcpServer } from './test-support/mcp'
import { TEST_PUBLIC_URL, TEST_SECRETS_KEY, createTestApp, type TestContext } from './test-support'
import type { Logger } from './types'

/**
 * The remote-MCP-server resource, end to end (epic #303, X10): the `/v1/me/mcp_servers` routes
 * over the real app, the sealing, the URL rules and the connection check against a stub MCP
 * server on loopback — and, last, the resolver the tool loop (#312) consumes.
 */

const BASE = `${API_VERSION_PREFIX}/me/mcp_servers`
const CALLBACK = `${TEST_PUBLIC_URL}/v1/me/mcp_servers/oauth/callback`

/** Two opaque user ids for the resolver tests, which drive the service directly. */
const USER_RESOLVE = 'user-resolve' as UserId
const USER_ENABLED = 'user-enabled' as UserId

/** The throwaway stub servers a test starts; closed when the suite ends. */
const servers: StubMcpServer[] = []

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function stubMcp(
  options: Parameters<typeof startStubMcpServer>[0] = {},
): Promise<StubMcpServer> {
  const server = await startStubMcpServer(options)
  servers.push(server)
  return server
}

/** A logger that keeps every line and detail, for the "never logged" assertion. */
function collectingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = []
  const record = (message: string, detail?: unknown): void => {
    lines.push(detail === undefined ? message : `${message} ${JSON.stringify(detail)}`)
  }
  return { logger: { debug: record, info: record, warn: record, error: record }, lines }
}

/** An app whose MCP routes run over the given store and stub. */
function app(
  options: { store?: InMemoryMcpServerStore; allowPrivateUrls?: boolean } = {},
): TestContext {
  return createTestApp({
    mcpServers: {
      store: options.store ?? new InMemoryMcpServerStore(),
      fetch: createMcpFetch({ allowPrivate: options.allowPrivateUrls ?? true }),
      callbackUrl: CALLBACK,
    },
  })
}

/** The vault the harness builds, so a directly-built service seals with the same key. */
function testVault(): Vault {
  return createVault(envKeyProvider(TEST_SECRETS_KEY))
}

/** POST a JSON body to a path. */
async function post(test: TestContext, path: string, body: unknown): Promise<Response> {
  return test.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** Create a server as the default caller and answer it. */
async function create(test: TestContext, body: Record<string, unknown>): Promise<McpServer> {
  const response = await post(test, BASE, { auth: 'none', ...body })
  expect(response.status).toBe(201)
  return (await response.json()) as McpServer
}

describe('MCP servers: CRUD and ownership', () => {
  it('creates a server, checks it on save, and lists it', async () => {
    const stub = await stubMcp()
    const test = app()

    const response = await post(test, BASE, { auth: 'none', name: 'notes', url: stub.url })
    expect(response.status).toBe(201)
    const created = (await response.json()) as McpServer
    // The connection check ran on save: the tools are summarized and their definitions priced.
    expect(McpServerSchema.parse(created)).toEqual(created)
    expect(created).toMatchObject({
      name: 'notes',
      auth: 'none',
      enabled: true,
      status: 'connected',
    })
    expect(created.tools.map((tool) => tool.name)).toEqual(['search', 'ping'])
    expect(created.definition_tokens).toBeGreaterThan(0)
    expect(created.last_tested_at).not.toBeNull()

    const listed = await test.request(BASE)
    expect(listed.status).toBe(200)
    expect(((await listed.json()) as { data: McpServer[] }).data).toEqual([created])

    const one = await test.request(`${BASE}/${created.id}`)
    expect((await one.json()) as McpServer).toEqual(created)
  })

  it('updates a server and refuses a rename onto a name it already has', async () => {
    const stub = await stubMcp()
    const test = app()
    const first = await create(test, { name: 'first', url: stub.url })
    const second = await create(test, { name: 'second', url: stub.url })

    const updated = await post(test, `${BASE}/${second.id}`, { name: 'renamed', enabled: false })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ name: 'renamed', enabled: false })

    const conflict = await post(test, `${BASE}/${second.id}`, { name: first.name })
    expect(conflict.status).toBe(409)
  })

  it('answers 404 for another user on every verb', async () => {
    const stub = await stubMcp()
    const test = app()
    const mine = await create(test, { name: 'notes', url: stub.url })
    const other = await test.signIn('mcp-other@example.com')
    const asOther = (path: string, init: RequestInit = {}): Promise<Response> =>
      test.anonymous(path, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${other.token}` },
      })

    expect((await asOther(`${BASE}/${mine.id}`)).status).toBe(404)
    expect((await asOther(`${BASE}/${mine.id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await asOther(BASE)).status).toBe(200)
    expect(((await (await asOther(BASE)).json()) as { data: unknown[] }).data).toEqual([])

    const otherUpdate = await asOther(`${BASE}/${mine.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(otherUpdate.status).toBe(404)
    const otherTest = await asOther(`${BASE}/${mine.id}/test`, { method: 'POST' })
    expect(otherTest.status).toBe(404)
  })

  it('refuses a duplicate name with 409 and the twenty-first server with 409', async () => {
    const stub = await stubMcp()
    const test = app()
    await create(test, { name: 'notes', url: stub.url })
    const duplicate = await post(test, BASE, { auth: 'none', name: 'notes', url: stub.url })
    expect(duplicate.status).toBe(409)
    expect((await duplicate.json()) as { error: { type: string } }).toMatchObject({
      error: { type: 'conflict_error' },
    })
    for (let index = 1; index < MAX_MCP_SERVERS_PER_USER; index += 1) {
      await create(test, { name: `server-${index}`, url: stub.url })
    }
    const tooMany = await post(test, BASE, { auth: 'none', name: 'one-too-many', url: stub.url })
    expect(tooMany.status).toBe(409)
  })

  it('deletes a server and answers 404 for a second delete', async () => {
    const stub = await stubMcp()
    const test = app()
    const server = await create(test, { name: 'notes', url: stub.url })
    expect((await test.request(`${BASE}/${server.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await test.request(`${BASE}/${server.id}`, { method: 'DELETE' })).status).toBe(404)
  })
})

describe('MCP servers: sealed secrets', () => {
  const SECRET = 'mcp-header-secret-do-not-log-me-4242'

  it('never returns or logs a header value, only its names', async () => {
    const stub = await stubMcp()
    const { logger, lines } = collectingLogger()
    const store = new InMemoryMcpServerStore()
    const test = createTestApp({
      logger,
      mcpServers: { store, fetch: createMcpFetch({ allowPrivate: true }), callbackUrl: CALLBACK },
    })

    const response = await post(test, BASE, {
      auth: 'headers',
      name: 'notes',
      url: stub.url,
      headers: { Authorization: `Bearer ${SECRET}`, 'x-team': 'eng' },
    })
    expect(response.status).toBe(201)
    const created = (await response.json()) as McpServer
    expect(created.header_names).toEqual(['Authorization', 'x-team'])

    // The stub saw the value; no response the API builds may.
    expect(stub.authorizations).toContain(`Bearer ${SECRET}`)
    const listed = await test.request(BASE)
    expect(JSON.stringify(created)).not.toContain(SECRET)
    expect(await listed.text()).not.toContain(SECRET)
    expect(lines.join('\n')).not.toContain(SECRET)

    // The stored row holds a sealed blob, and it is not the plaintext.
    const stored = await store.get(created.id, { ownerId: (await test.currentUser()).id })
    expect(stored?.headers).toBeDefined()
    expect(JSON.stringify(stored?.headers)).not.toContain(SECRET)
  })

  it('replaces a header map on update, and keeps it when the patch omits it', async () => {
    const stub = await stubMcp()
    const store = new InMemoryMcpServerStore()
    const test = createTestApp({
      mcpServers: { store, fetch: createMcpFetch({ allowPrivate: true }), callbackUrl: CALLBACK },
    })
    const created = await create(test, {
      auth: 'headers',
      name: 'notes',
      url: stub.url,
      headers: { Authorization: 'Bearer first' },
    })
    const renamed = await post(test, `${BASE}/${created.id}`, { name: 'renamed' })
    expect((await renamed.json()) as McpServer).toMatchObject({
      name: 'renamed',
      header_names: ['Authorization'],
    })
    const replaced = await post(test, `${BASE}/${created.id}`, {
      headers: { 'x-api-key': 'second', 'x-team': 'eng' },
    })
    expect((await replaced.json()) as McpServer).toMatchObject({
      header_names: ['x-api-key', 'x-team'],
    })
  })
})

describe('MCP servers: URL rules', () => {
  it('refuses a private address when the self-host setting is off, storing nothing', async () => {
    const stub = await stubMcp()
    const test = app({ allowPrivateUrls: false })
    const response = await post(test, BASE, { auth: 'none', name: 'notes', url: stub.url })
    expect(response.status).toBe(400)
    expect((await response.json()) as { error: { type: string } }).toMatchObject({
      error: { type: 'invalid_request_error' },
    })
    expect(((await (await test.request(BASE)).json()) as { data: unknown[] }).data).toEqual([])
  })

  it('refuses a URL that is not an absolute http(s) URL', async () => {
    const test = app()
    expect((await post(test, BASE, { auth: 'none', name: 'notes', url: '/mcp' })).status).toBe(400)
    expect(
      (await post(test, BASE, { auth: 'none', name: 'notes', url: 'ftp://mcp.example.com' }))
        .status,
    ).toBe(400)
  })

  it('refuses a metadata hostname by name', async () => {
    const test = app({ allowPrivateUrls: false })
    const response = await post(test, BASE, {
      auth: 'none',
      name: 'notes',
      url: 'http://metadata.google.internal/computeMetadata/v1',
    })
    expect(response.status).toBe(400)
  })

  it('refuses a malformed path id with 400', async () => {
    const test = app()
    expect((await test.request(`${BASE}/not-an-id`)).status).toBe(400)
  })
})

describe('MCP servers: the connection check', () => {
  it('stores a server it cannot reach, in status error, and reports it on demand', async () => {
    const stub = await stubMcp({ failing: true })
    const test = app()
    const response = await post(test, BASE, { auth: 'none', name: 'notes', url: stub.url })
    // A server that is down is stored, not refused: a chat is never blocked by one (epic #303).
    expect(response.status).toBe(201)
    const created = (await response.json()) as McpServer
    expect(created.status).toBe('error')
    expect(created.last_error).toContain('bad day')

    const tested = await post(test, `${BASE}/${created.id}/test`, undefined)
    expect(tested.status).toBe(200)
    expect((await tested.json()) as McpServer).toMatchObject({ status: 'error' })
  })

  it('reports an authenticated server as error when its token is refused, without echoing it', async () => {
    const stub = await stubMcp()
    stub.setRequiredToken('the-right-token')
    const test = app()
    const created = await create(test, {
      auth: 'headers',
      name: 'notes',
      url: stub.url,
      headers: { Authorization: 'Bearer the-wrong-token' },
    })
    expect(created.status).toBe('error')
    // The server's own refusal reaches the reader, and the token this server sent does not.
    expect(created.last_error).toContain('invalid_token')
    expect(created.last_error).not.toContain('the-wrong-token')
  })
})

describe('MCP servers: resolve, for the tool loop (#312)', () => {
  it('answers the URL and the opened headers for none and headers auth', async () => {
    const stub = await stubMcp()
    const store = new InMemoryMcpServerStore()
    const service = createMcpServerService({
      store,
      vault: testVault(),
      fetch: createMcpFetch({ allowPrivate: true }),
      callbackUrl: CALLBACK,
    })
    const user = USER_RESOLVE

    const none = await service.create(user, { auth: 'none', name: 'none', url: stub.url })
    expect(await service.resolve(user, none.id)).toMatchObject({ url: stub.url, headers: {} })

    const headers = await service.create(user, {
      auth: 'headers',
      name: 'headers',
      url: stub.url,
      headers: { Authorization: 'Bearer resolved-secret' },
    })
    expect(await service.resolve(user, headers.id)).toMatchObject({
      url: stub.url,
      headers: { Authorization: 'Bearer resolved-secret' },
    })

    // Another user gets nothing, and an unknown id is null.
    expect(await service.resolve('someone-else', none.id)).toBeNull()
  })

  it('lists only the enabled servers that resolve', async () => {
    const stub = await stubMcp()
    const store = new InMemoryMcpServerStore()
    const service = createMcpServerService({
      store,
      vault: testVault(),
      fetch: createMcpFetch({ allowPrivate: true }),
      callbackUrl: CALLBACK,
    })
    const user = USER_ENABLED
    const on = await service.create(user, { auth: 'none', name: 'on', url: stub.url })
    await service.create(user, { auth: 'none', name: 'off', url: stub.url, enabled: false })
    const resolved = await service.listEnabled(user)
    expect(resolved.map((entry) => entry.server.id)).toEqual([on.id])
  })
})
