import { createHash } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'

/**
 * The two stub servers the MCP tests drive the real stack against (epic #303, X10): a remote
 * **MCP server** over Streamable HTTP, and the **authorization server** it points at.
 *
 * Both are real HTTP servers on loopback — the client's guarded fetch is exercised for real,
 * with `allowPrivate` on, exactly as a self-hosted deployment reaches one. The MCP server is
 * built from the same official SDK our client uses, so the transport is the spec's, not a
 * fixture; the authorization server is hand-written because it has to answer discovery,
 * registration and PKCE the way a real one does.
 */

/** The tools the stub MCP server offers by default. */
export const STUB_MCP_TOOLS: Tool[] = [
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

/** A stub remote MCP server. */
export interface StubMcpServer {
  /** The Streamable HTTP endpoint changes clients POST to. */
  readonly url: string
  /** Every `authorization` header the server saw, in order. */
  readonly authorizations: string[]
  /** Every `tools/call` the server served, in order — what the loop really sent. */
  readonly calls: { readonly name: string; readonly args: Record<string, unknown> }[]
  /** How many `tools/list` requests the server answered — what a listing cache saves. */
  readonly listings: { count: number }
  /** Require this bearer token; every other request answers 401. `null` accepts any. */
  setRequiredToken(token: string | null): void
  close(): Promise<void>
}

/** Options for {@link startStubMcpServer}. */
export interface StubMcpServerOptions {
  /** The authorization server URL its protected-resource metadata advertises. */
  readonly authorizationServer?: string
  /** The scopes the protected-resource metadata lists. */
  readonly scopes?: readonly string[]
  /** The tools the server lists; {@link STUB_MCP_TOOLS} by default. */
  readonly tools?: readonly Tool[]
  /** A token every request must carry; any is accepted when omitted. */
  readonly requiredToken?: string
  /** Make every initialize fail, to exercise the `status: 'error'` path. */
  readonly failing?: boolean
  /**
   * How the server answers a `tools/call` (epic #303, #312).
   *
   * The default echoes the arguments back as text, which is enough to prove a call reached the
   * server and what it carried. A test of the loop's shaping passes its own: an error, an
   * image, a resource, structured content.
   */
  readonly onCall?: (
    name: string,
    args: Record<string, unknown>,
  ) => CallToolResult | Promise<CallToolResult>
}

/** What a `tools/call` answers with, as the SDK types it. */
export type StubCallToolResult = Awaited<ReturnType<NonNullable<StubMcpServerOptions['onCall']>>>

/** Start a stub MCP server on loopback. */
export async function startStubMcpServer(
  options: StubMcpServerOptions = {},
): Promise<StubMcpServer> {
  const tools = options.tools ?? STUB_MCP_TOOLS
  const authorizations: string[] = []
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const listings = { count: 0 }
  let requiredToken = options.requiredToken ?? null
  const http = createServer((req, res) => {
    const authorization = req.headers['authorization']
    if (typeof authorization === 'string') {
      authorizations.push(authorization)
    }
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500).end()
      }
    })

    async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (
        options.authorizationServer !== undefined &&
        url.pathname.startsWith('/.well-known/oauth-protected-resource')
      ) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            resource: `http://127.0.0.1:${port()}/mcp`,
            authorization_servers: [options.authorizationServer],
            ...(options.scopes === undefined ? {} : { scopes_supported: options.scopes }),
          }),
        )
        return
      }
      if (requiredToken !== null && authorization !== `Bearer ${requiredToken}`) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'invalid_token' }))
        return
      }
      if (options.failing === true) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end('the server is having a bad day')
        return
      }
      // One server and one transport **per request**: in stateless mode a transport handles a
      // single request, so a client that initializes twice — every connection check does —
      // needs a server that has not been initialized before. The transport is closed with the
      // response, which is also what ends the standalone SSE stream a client opens.
      const server = new Server(
        { name: 'stub-mcp', version: '1.0.0' },
        { capabilities: { tools: {} } },
      )
      server.setRequestHandler(ListToolsRequestSchema, () => {
        listings.count += 1
        return { tools: [...tools] }
      })
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name
        const args = request.params.arguments ?? {}
        calls.push({ name, args })
        if (options.onCall !== undefined) {
          return await options.onCall(name, args)
        }
        return {
          content: [{ type: 'text', text: `${name} answered ${JSON.stringify(args)}` }],
        }
      })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await server.connect(transport)
      response.on('close', () => {
        void transport.close()
        void server.close()
      })
      const body = await readJsonBody(request)
      await transport.handleRequest(request, response, body)
    }
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  function port(): number {
    return (http.address() as AddressInfo).port
  }
  return {
    url: `http://127.0.0.1:${port()}/mcp`,
    authorizations,
    calls,
    listings,
    setRequiredToken(token: string | null): void {
      requiredToken = token
    },
    close: () => closeServer(http),
  }
}

/** A stub OAuth 2.1 authorization server. */
export interface StubAuthorizationServer {
  /** The issuer identifier, which is also this server's own origin. */
  readonly issuer: string
  /** The authorization URL a `connect` should produce, once a flow has been simulated. */
  readonly authorizationEndpoint: string
  /** How many dynamic client registrations have been made. */
  readonly registrations: number
  /** The last authorization request the browser made, or `null`. */
  lastAuthorization(): {
    readonly client_id: string
    readonly redirect_uri: string
    readonly state: string
    readonly code_challenge: string
    readonly code_challenge_method: string
    readonly resource: string
    readonly scope: string | null
  } | null
  /** The code the last authorization issued. */
  lastCode(): string | null
  /**
   * Make the token endpoint stop accepting refresh grants, so a refresh fails. A refresh
   * always succeeds until this is called.
   */
  setRefreshWorking(working: boolean): void
  /** Every access token the token endpoint has issued, in order. */
  readonly issuedTokens: string[]
  close(): Promise<void>
}

/** Options for {@link startStubAuthorizationServer}. */
export interface StubAuthorizationServerOptions {
  /** Offer a `registration_endpoint`; `true` by default. `false` models a server without DCR. */
  readonly registration?: boolean
  /** The `expires_in` for issued access tokens; `3600` by default. */
  readonly expiresIn?: number
  /** The scopes the metadata advertises. */
  readonly scopes?: readonly string[]
}

/** Start a stub authorization server on loopback. */
export async function startStubAuthorizationServer(
  options: StubAuthorizationServerOptions = {},
): Promise<StubAuthorizationServer> {
  let registrations = 0
  let refreshWorking = true
  let nextToken = 0
  const issuedTokens: string[] = []
  let authorization: ReturnType<StubAuthorizationServer['lastAuthorization']> = null
  let code: string | null = null
  const http = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500).end()
      }
    })

    async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      const url = new URL(request.url ?? '/', origin())
      if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
        sendJson(response, 200, {
          issuer: origin(),
          authorization_endpoint: `${origin()}/authorize`,
          token_endpoint: `${origin()}/token`,
          ...(options.registration === false
            ? {}
            : { registration_endpoint: `${origin()}/register` }),
          ...(options.scopes === undefined ? {} : { scopes_supported: options.scopes }),
          code_challenge_methods_supported: ['S256'],
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/register') {
        registrations += 1
        await readJsonBody(request)
        sendJson(response, 201, { client_id: 'stub-client', client_secret: 'stub-secret' })
        return
      }
      if (request.method === 'GET' && url.pathname === '/authorize') {
        authorization = {
          client_id: url.searchParams.get('client_id') ?? '',
          redirect_uri: url.searchParams.get('redirect_uri') ?? '',
          state: url.searchParams.get('state') ?? '',
          code_challenge: url.searchParams.get('code_challenge') ?? '',
          code_challenge_method: url.searchParams.get('code_challenge_method') ?? '',
          resource: url.searchParams.get('resource') ?? '',
          scope: url.searchParams.get('scope'),
        }
        code = 'stub-code'
        const redirect = new URL(authorization.redirect_uri)
        redirect.searchParams.set('code', code)
        redirect.searchParams.set('state', authorization.state)
        response.writeHead(302, { location: redirect.href })
        response.end()
        return
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        const body = new URLSearchParams(Buffer.from(await readRawBody(request)).toString('utf8'))
        const grant = body.get('grant_type')
        if (grant === 'authorization_code') {
          if (body.get('code') !== code || code === null) {
            sendJson(response, 400, { error: 'invalid_grant', error_description: 'unknown code' })
            return
          }
          const verifier = body.get('code_verifier') ?? ''
          if (s256(verifier) !== authorization?.code_challenge) {
            sendJson(response, 400, {
              error: 'invalid_grant',
              error_description: 'PKCE verification failed',
            })
            return
          }
          code = null
          sendJson(response, 200, tokenBody())
          return
        }
        if (grant === 'refresh_token') {
          if (!refreshWorking) {
            sendJson(response, 400, {
              error: 'invalid_grant',
              error_description: 'the refresh token was revoked',
            })
            return
          }
          sendJson(response, 200, tokenBody())
          return
        }
        sendJson(response, 400, { error: 'unsupported_grant_type' })
        return
      }
      response.writeHead(404).end()
    }

    function tokenBody(): Record<string, unknown> {
      nextToken += 1
      const access = `access-${nextToken}`
      issuedTokens.push(access)
      return {
        access_token: access,
        token_type: 'Bearer',
        refresh_token: `refresh-${nextToken}`,
        ...(options.expiresIn === undefined ? {} : { expires_in: options.expiresIn }),
        scope: 'mcp',
      }
    }
    function origin(): string {
      return `http://127.0.0.1:${port()}`
    }
    function port(): number {
      return (http.address() as AddressInfo).port
    }
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = () => (http.address() as AddressInfo).port
  const issuer = `http://127.0.0.1:${port()}`
  return {
    issuer,
    authorizationEndpoint: `${issuer}/authorize`,
    get registrations(): number {
      return registrations
    },
    lastAuthorization: () => authorization,
    lastCode: () => code,
    setRefreshWorking: (working: boolean) => {
      refreshWorking = working
    },
    issuedTokens,
    close: () => closeServer(http),
  }
}

/** Simulate the user's browser visiting an authorization URL and answer the `code`/`state`. */
export async function simulateAuthorization(
  authorizationUrl: string,
): Promise<{ code: string; state: string }> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' })
  const location = response.headers.get('location')
  if (location === null) {
    throw new Error(`the authorization server did not redirect (status ${response.status})`)
  }
  const redirect = new URL(location)
  const code = redirect.searchParams.get('code')
  const state = redirect.searchParams.get('state')
  if (code === null || state === null) {
    throw new Error('the authorization redirect carried no code or state')
  }
  return { code, state }
}

/** A JSON response. */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** The request body, parsed as JSON, or `undefined` for a body-less method. */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const text = Buffer.from(await readRawBody(request)).toString('utf8')
  return text.length === 0 ? undefined : JSON.parse(text)
}

/** The raw request body. */
async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  if (request.method === 'GET' || request.method === 'DELETE') {
    return Buffer.alloc(0)
  }
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** `base64url(sha256(value))` — the PKCE `S256` transform. */
function s256(value: string): string {
  return createHash('sha256')
    .update(value)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Close an HTTP server, dropping lingering connections. */
async function closeServer(http: HttpServer): Promise<void> {
  // A client's standalone SSE stream keeps the socket open; drop the connections it has already
  // let go of before waiting for the server to end.
  http.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}
