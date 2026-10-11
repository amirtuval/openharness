import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'

import { MCP_CLIENT_NAME, MCP_CLIENT_VERSION, mcpToolDefinition, openMcpClient } from './mcp-client'

/**
 * The MCP client against a real MCP server: a small stub built on the same SDK, listening on
 * loopback over node's HTTP server.
 *
 * The tests here use the platform `fetch` — the client's default — because `safeFetch` and its
 * SSRF guard are the *server's* to inject (the server's tests drive the guarded path). What is
 * asserted is the client's own contract: it initializes, lists whole tool lists (pagination
 * included) as this protocol's definitions, carries the headers the caller gave it, and closes.
 */

interface StubServer {
  readonly url: string
  /** Every `authorization` header the stub saw, in order. */
  readonly authorizations: string[]
  /** Every `x-extra` header the stub saw, in order — the second injected header. */
  readonly extras: string[]
  close(): Promise<void>
}

/** The tool list the stub serves; a second page is exposed when `paged` is set. */
const TOOLS: Tool[] = [
  {
    name: 'search',
    description: 'Search notes',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  { name: 'ping', inputSchema: { type: 'object' } },
]

async function startStubServer(options: { paged?: boolean } = {}): Promise<StubServer> {
  const authorizations: string[] = []
  const extras: string[] = []
  const server = new Server({ name: 'stub-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, (request) => {
    if (options.paged === true && request.params?.cursor === 'page-2') {
      return { tools: [TOOLS[1] as Tool] }
    }
    return options.paged === true
      ? { tools: [TOOLS[0] as Tool], nextCursor: 'page-2' }
      : { tools: TOOLS }
  })
  // A stateful stub: one transport handles the initialize POST, the `initialized` notification
  // and the tool list, keyed by the `mcp-session-id` the client carries. A stateless transport
  // refuses a second request, which is why the SDK's own stateless example builds one per
  // request — noise a test of the client does not need.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => 'stub-session',
  })
  await server.connect(transport)

  const http = createServer((req, res) => {
    const authorization = req.headers['authorization']
    if (typeof authorization === 'string') {
      authorizations.push(authorization)
    }
    const extra = req.headers['x-extra']
    if (typeof extra === 'string') {
      extras.push(extra)
    }
    void readBody(req).then((body) => transport.handleRequest(req, res, body))
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    authorizations,
    extras,
    async close(): Promise<void> {
      await server.close()
      await closeServer(http)
    },
  }
}

/** The request body, parsed as JSON, or `undefined` for a GET. */
async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'DELETE') {
    return undefined
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.length === 0 ? undefined : JSON.parse(text)
}

function closeServer(http: HttpServer): Promise<void> {
  // The client's standalone SSE stream (a GET) keeps the socket open, so drop the connections
  // the client has already closed its side of before waiting for the server to end.
  http.closeAllConnections()
  return new Promise((resolve, reject) =>
    http.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}

describe('openMcpClient', () => {
  const servers: StubServer[] = []
  const sessions: { close(): Promise<void> }[] = []

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()))
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it('initializes and lists the server’s tools as protocol definitions', async () => {
    const server = await startStubServer()
    servers.push(server)
    const session = await openMcpClient({ url: server.url })
    sessions.push(session)
    const tools = await session.listTools()
    expect(tools).toEqual([
      {
        name: 'search',
        description: 'Search notes',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
      { name: 'ping', description: null, input_schema: { type: 'object' } },
    ])
  })

  it('follows pagination to the end of the tool list', async () => {
    const server = await startStubServer({ paged: true })
    servers.push(server)
    const session = await openMcpClient({ url: server.url })
    sessions.push(session)
    expect((await session.listTools()).map((tool) => tool.name)).toEqual(['search', 'ping'])
  })

  it('carries the headers the caller gave it', async () => {
    const server = await startStubServer()
    servers.push(server)
    const session = await openMcpClient({
      url: server.url,
      headers: { Authorization: 'Bearer secret-token', 'x-extra': 'extra-value' },
    })
    sessions.push(session)
    await session.listTools()
    expect(server.authorizations).toContain('Bearer secret-token')
    expect(server.extras).toContain('extra-value')
  })

  it('makes its requests through the fetch it was given', async () => {
    const server = await startStubServer()
    servers.push(server)
    const calls: string[] = []
    const session = await openMcpClient({
      url: server.url,
      fetch: (url, init) => {
        calls.push(String(url))
        return fetch(url, init)
      },
    })
    sessions.push(session)
    await session.listTools()
    // The injected fetch is the only way out: every request went through it.
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((url) => url.startsWith(server.url))).toBe(true)
  })

  it('announces this client in initialize and closes idempotently', async () => {
    const server = await startStubServer()
    servers.push(server)
    const session = await openMcpClient({ url: server.url })
    await expect(session.close()).resolves.toBeUndefined()
  })
})

describe('mcpToolDefinition', () => {
  it('maps a tool, an absent description becoming null', () => {
    expect(mcpToolDefinition({ name: 'ping', inputSchema: { type: 'object' } })).toEqual({
      name: 'ping',
      description: null,
      input_schema: { type: 'object' },
    })
  })
})

describe('client identity', () => {
  it('is openharness', () => {
    expect(MCP_CLIENT_NAME).toBe('openharness')
    expect(MCP_CLIENT_VERSION).toBe('1.0.0')
  })
})
