import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createSecureContext, TLSSocket } from 'node:tls'
import { fileURLToPath } from 'node:url'

/**
 * A stub model provider, at the one seam a real process has: the network.
 *
 * Some of what a deployment does cannot be tested through a store row. Saving a credential
 * `PUT /v1/provider-credentials/{provider}` — is validated with **one real call to the
 * provider** (`provider-validation.ts`), and the server's own tests inject a fake validator
 * because the process boundary exposes no seam for one. The same boundary leaves the e2e
 * suite two choices for a test that has to save a key successfully: a real key (which CI does
 * not have) or a real endpoint. This file is the endpoint: an HTTP proxy the server under
 * test reaches through the documented **egress-proxy variables** (`catalog/provider-fetch.ts`
 * honors `HTTPS_PROXY` via undici's `EnvHttpProxyAgent`), which terminates the CONNECT tunnel
 * with a fixture certificate and answers the provider's API as on-the-spot JSON.
 *
 * Nothing about the product changes for this: a deployment behind a proxy is a documented
 * deployment (`e2e/AGENTS.md`), and this is one of those — pointed at a loopback proxy that
 * agrees with the test instead of the internet.
 *
 * Usage:
 *
 * ```ts
 * const stub = await startProviderStub()
 * afterAll(() => stub.stop()) // registered by the caller; a file may own several
 * stub.answer('api.anthropic.com', (request) => ({ json: { data: [...] } }))
 *
 * const server = await harness.server({ env: stub.env })
 * // ... the server's provider calls now answer from the stub, and `stub.requests` lists them
 * ```
 *
 * ## What the child is told
 *
 * {@link ProviderStub.env} overrides **every** spelling of the proxy variables
 * (`HTTPS_PROXY`/`https_proxy`/… and the `no_proxy` pair) and `NODE_EXTRA_CA_CERTS`, all four
 * proxy spellings because undici prefers the lowercase ones and a developer's shell or a CI
 * image may set either. `NODE_EXTRA_CA_CERTS` is **replaced**, not appended to (the variable
 * holds one path): the child trusts the fixture CA and nothing else a proxy might have left in
 * the environment, which is correct here because the stub is the child's only outbound path.
 *
 * ## The certificate
 *
 * `fixtures/provider-stub/` holds a throwaway CA and one leaf whose SANs are exactly the
 * provider hostnames the stub may have to impersonate; its README says how they were made and
 * why they protect nothing. A TLS interception is the only way an HTTP proxy can answer an
 * `https://` provider call, and a committed fixture is what keeps the test deterministic and
 * openssl-free at run time.
 */

/** Where the fixtures live, relative to this module. */
const FIXTURES = new URL('../../fixtures/provider-stub/', import.meta.url)

/** One request the server under test made to a stubbed provider. */
export interface StubRequest {
  /** The provider host, from the request's `Host` header (no port). */
  readonly host: string
  /** `GET` for every list call; `POST` for the Model Garden EULA check (#273). */
  readonly method: string
  /** The path **and query**, e.g. `/v1/models?limit=1000` — what an answer branches on. */
  readonly path: string
  /**
   * The request body as text, when the request had one — the Model Garden EULA check (#273)
   * names the publisher model there, so an answerer that has to tell one model from another
   * needs it. An empty string for a request with no body.
   */
  readonly body: string
}

/** What the stub answers one request with. `undefined` means "no answer — use the default". */
export interface StubAnswer {
  /** The HTTP status; `200` by default. */
  readonly status?: number
  /** The JSON body; `{}` by default. */
  readonly json?: unknown
}

/** How a test answers requests for one provider host. */
export type StubAnswerer = (request: StubRequest) => StubAnswer | undefined

/** A running provider stub: its environment, its request log, and its stop. */
export interface ProviderStub {
  /**
   * The environment to start a server under test with —
   * `harness.server({ env: stub.env })`.
   */
  readonly env: Readonly<Record<string, string>>
  /** Every provider request the server under test has made, in order. */
  readonly requests: readonly StubRequest[]
  /** Answer this host's requests from now on. One answerer per host; the last one wins. */
  answer(host: string, answerer: StubAnswerer): void
  /** Stop listening. Idempotent. */
  stop(): Promise<void>
}

/** The status a provider host with no answerer is refused with (the catalog falls back). */
const UNSTUBBED_STATUS = 404

/**
 * Start a stub provider on a loopback port.
 *
 * The proxy speaks plain HTTP for the one thing it is for — the CONNECT a provider call makes
 * — and the tunnel is then served as a TLS server (the fixture leaf) on top of a plain HTTP
 * server that runs {@link ProviderStub.answer}'s handler. Requests to a host nothing answered
 * get {@link UNSTUBBED_STATUS}: a catalog that dials one is a visible `fallback` (C3), never
 * a hang.
 */
export async function startProviderStub(): Promise<ProviderStub> {
  const answerers = new Map<string, StubAnswerer>()
  const requests: StubRequest[] = []
  const secureContext = createSecureContext({
    key: readFileSync(new URL('server.key', FIXTURES)),
    cert: readFileSync(new URL('server.pem', FIXTURES)),
  })

  // The HTTP server under the TLS layer: the decrypted tunnel sockets are handed to it as
  // connections, so its handlers see ordinary HTTP requests. The body is read to its end
  // before the answerer runs, so one that branches on it — the EULA check's publisher model —
  // sees the whole thing.
  const inner = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const stubRequest: StubRequest = {
        host: hostOf(request.headers.host),
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(stubRequest)
      const answer = answerers.get(stubRequest.host)?.(stubRequest) ?? {
        status: UNSTUBBED_STATUS,
        json: { error: `the provider stub has no answer for ${stubRequest.host}` },
      }
      response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(answer.json ?? {}))
    })
  })

  // The proxy itself: CONNECT tunnels the provider calls, nothing else.
  const proxy = createServer((_request, response) => {
    response.writeHead(405, { allow: 'CONNECT' })
    response.end()
  })
  proxy.on('connect', (request, clientSocket, head) => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    // The TLS half of the tunnel, with the fixture leaf. An error on it (a client that gave
    // up mid-handshake) tears the socket down; the test is not about that socket.
    const tlsSocket = new TLSSocket(clientSocket, { isServer: true, secureContext })
    tlsSocket.on('error', () => clientSocket.destroy())
    if (head.length > 0) {
      tlsSocket.unshift(head)
    }
    inner.emit('connection', tlsSocket)
  })
  // A tunnel socket that dies mid-flight must not take the stub down with it.
  proxy.on('clientError', (_error, socket) => socket.destroy())

  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(0, '127.0.0.1', resolve)
  })
  const address = proxy.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const url = `http://127.0.0.1:${port}`

  return {
    env: {
      // Both spellings, because undici prefers the lowercase pair and either may be set in
      // the environment the harness copies (`http_proxy ?? HTTP_PROXY`, in
      // `EnvHttpProxyAgent`) — an inherited one would silently win.
      http_proxy: url,
      HTTP_PROXY: url,
      https_proxy: url,
      HTTPS_PROXY: url,
      no_proxy: '',
      NO_PROXY: '',
      NODE_EXTRA_CA_CERTS: fileURLToPath(new URL('ca.pem', FIXTURES)),
    },
    get requests(): readonly StubRequest[] {
      return requests
    },
    answer: (host, answerer) => {
      answerers.set(host, answerer)
    },
    stop: async () => {
      inner.close()
      await new Promise<void>((resolve) => {
        proxy.close(() => resolve())
      })
    },
  }
}

/** The `Host` header without its port, which is how the provider is named in a request. */
function hostOf(header: string | undefined): string {
  return (header ?? '').replace(/:\d+$/u, '')
}
