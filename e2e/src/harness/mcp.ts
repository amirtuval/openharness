import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A stub remote MCP server for the end-to-end suite (epic #303, X10; #312).
 *
 * `apps/server/src/mcp-tools.test.ts` drives the loop against a stub built from the official
 * SDK; this one is **hand-written JSON-RPC over `node:http`**, because the e2e package does not
 * depend on the SDK — it runs the real server in its own process and talks to it over HTTP, and
 * the only thing it needs on this side is something that answers the four methods a Streamable
 * HTTP MCP client sends. Writing them out is also the honest way to show what the server's
 * client really has to speak: `initialize`, the `initialized` notification, `tools/list` and
 * `tools/call`, each a plain JSON body.
 *
 * Stateless on purpose: every request is answered on its own, which is what the tool's
 * open-a-connection-per-call shape meets.
 */

/** One tool the stub lists. */
export interface StubTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema: Record<string, unknown>
}

/** What a `tools/call` answers with, in MCP's shape. */
export interface StubCallToolResult {
  readonly content: readonly { readonly type: string; readonly text?: string }[]
  readonly isError?: boolean
}

/** A running stub MCP server. */
export interface StubMcpServer {
  /** The Streamable HTTP endpoint to register with openharness. */
  readonly url: string
  /** Every `tools/call` it served, in the order they arrived. */
  readonly calls: { readonly name: string; readonly args: Record<string, unknown> }[]
  /** How many `tools/list` requests it answered. */
  readonly listings: () => number
  close(): Promise<void>
}

/** The tool the stub offers by default: a `search` with one string argument. */
export const STUB_SEARCH_TOOL: StubTool = {
  name: 'search',
  description: 'Search notes',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
}

/** Start the stub on loopback, offering the tools given. */
export async function startStubMcpServer(
  options: {
    readonly tools?: readonly StubTool[]
    readonly onCall?: (name: string, args: Record<string, unknown>) => StubCallToolResult
  } = {},
): Promise<StubMcpServer> {
  const tools = options.tools ?? [STUB_SEARCH_TOOL]
  const calls: { name: string; args: Record<string, unknown> }[] = []
  let listings = 0
  const http = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end()
      }
    })

    async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      const message = (await readBody(request)) as {
        readonly method?: string
        readonly id?: unknown
        readonly params?: { readonly name?: string; readonly arguments?: unknown }
      }
      const id = message.id
      // A notification carries no id and expects no result: answer 202 with nothing.
      if (id === undefined) {
        response.writeHead(202).end()
        return
      }
      const result = (body: unknown): void => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', result: body, id }))
      }
      switch (message.method) {
        case 'initialize':
          result({
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'e2e-stub', version: '1.0.0' },
          })
          return
        case 'tools/list':
          listings += 1
          result({ tools })
          return
        case 'tools/call': {
          const name = String(message.params?.name ?? '')
          const args = (message.params?.arguments ?? {}) as Record<string, unknown>
          calls.push({ name, args })
          result(
            options.onCall?.(name, args) ?? {
              content: [{ type: 'text', text: `${name} answered ${JSON.stringify(args)}` }],
            },
          )
          return
        }
        default:
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32601, message: `no method ${String(message.method)}` },
              id,
            }),
          )
      }
    }
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as AddressInfo
  let closed = false
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    listings: () => listings,
    // Idempotent: a test that stops its server mid-scenario has it torn down again by the
    // file's `afterAll`, and closing a closed server is an error rather than a no-op.
    close: async () => {
      if (closed) {
        return
      }
      closed = true
      await closeServer(http)
    },
  }
}

/** The request body, parsed as JSON. */
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.length === 0 ? {} : JSON.parse(text)
}

/** Close the server, dropping any connection still open. */
async function closeServer(http: HttpServer): Promise<void> {
  http.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}
