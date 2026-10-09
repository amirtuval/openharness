import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A stub OpenAI-compatible endpoint on loopback (epic #245, A3b).
 *
 * A custom credential's base URL is a URL the reader typed, so the server guards it with
 * `safeFetch` — and a loopback address is exactly what that guard refuses, **unless** the
 * server's self-host setting (`OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS`) is on. This is the
 * endpoint a test points such a credential at: a real HTTP server on `127.0.0.1` that answers
 * `GET /v1/models` with a model list and `POST /v1/chat/completions` with a streamed reply, so
 * the whole path — the save-time check, the catalogue listing and a model call — runs against
 * something real while nothing leaves the machine.
 *
 * The existing `startProviderStub()` is an HTTPS **egress proxy** for the fixed providers'
 * constant hosts, whose certificate's SANs do not include a custom host; a custom endpoint
 * needs a plain server on the address the flag is about, which is this.
 *
 * Usage:
 *
 * ```ts
 * const stub = await startOpenAICompatibleStub({ models: ['llama3.3'] })
 * const server = await harness.server({
 *   mockModel: false,
 *   env: { OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS: '1', no_proxy: '127.0.0.1', NO_PROXY: '127.0.0.1' },
 * })
 * afterAll(() => stub.stop())
 * ```
 */

/** One request the server under test made to the stub. */
export interface OpenAICompatibleStubRequest {
  readonly method: string
  /** The path and query, e.g. `/v1/models` or `/v1/chat/completions`. */
  readonly path: string
  /** The `Authorization` header, if any — what proves the key (or its absence) reached the call. */
  readonly authorization: string | undefined
  /** The parsed JSON body, for a request that carried one. */
  readonly body: unknown
}

/** A running stub: its base URL, the requests it saw, and its stop. */
export interface OpenAICompatibleStub {
  /** The API root to store as the credential's `base_url`, e.g. `http://127.0.0.1:54321/v1`. */
  readonly baseUrl: string
  /** Every request the server made, in order. */
  readonly requests: readonly OpenAICompatibleStubRequest[]
  /** Stop listening. Idempotent. */
  stop(): Promise<void>
}

/** What {@link startOpenAICompatibleStub} takes. */
export interface OpenAICompatibleStubOptions {
  /** The model ids `GET /v1/models` lists. Defaults to one `llama3.3`. */
  readonly models?: readonly string[]
  /** The text `POST /v1/chat/completions` streams back. Defaults to a fixed sentence. */
  readonly reply?: string
}

/** Start the stub on an ephemeral loopback port. */
export async function startOpenAICompatibleStub(
  options: OpenAICompatibleStubOptions = {},
): Promise<OpenAICompatibleStub> {
  const models = options.models ?? ['llama3.3']
  const reply = options.reply ?? 'Hello from the custom OpenAI-compatible stub'
  const requests: OpenAICompatibleStubRequest[] = []

  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = parseJson(Buffer.concat(chunks).toString('utf8'))
      requests.push({
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        authorization: request.headers.authorization,
        body,
      })
      route(
        request.method ?? 'GET',
        (request.url ?? '/').split('?')[0] ?? '/',
        { models, reply },
        response,
      )
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    get requests(): readonly OpenAICompatibleStubRequest[] {
      return requests
    },
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** Answer one request, by path. */
function route(
  method: string,
  path: string,
  input: { readonly models: readonly string[]; readonly reply: string },
  response: ServerResponse,
): void {
  if (method === 'GET' && path === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'list', data: input.models.map((id) => ({ id })) }))
    return
  }
  if (method === 'POST' && path === '/v1/chat/completions') {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(chatCompletionSse(input.reply))
    return
  }
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: { message: `no stub route for ${method} ${path}` } }))
}

/** A JSON body, or `undefined` when the request carried none or carried something else. */
function parseJson(text: string): unknown {
  if (text.trim() === '') {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** A minimal OpenAI chat-completions SSE body: one chunk of text, then the stop. */
function chatCompletionSse(text: string): string {
  const chunk = (delta: unknown, finish: string | null, usage?: unknown): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-e2e',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'llama3.3',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\n`
  return (
    chunk({ role: 'assistant', content: text }, null) +
    chunk({}, 'stop', { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }) +
    'data: [DONE]\n\n'
  )
}
