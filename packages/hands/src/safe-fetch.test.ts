import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { type AddressInfo, type Socket } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import {
  SAVE_TIME_LIMITS,
  STREAMING_LIMITS,
  SafeFetchError,
  isSafeFetchError,
  safeFetch,
  safeFetchResult,
  type AddressResolver,
  type SafeFetchRequest,
  type SafeFetchTransport,
} from './safe-fetch'

/**
 * `safeFetch` (epic #245, A3a).
 *
 * Two kinds of test live here, and they prove different halves:
 *
 * - the **logic** — scheme, hostname, address ranges, redirects and their re-checks — runs on
 *   an injected resolver and transport, so a refusal is deterministic and the network is never
 *   touched;
 * - the **transport** — the address the socket is actually opened at, and the three limits —
 *   runs against a real HTTP server on loopback, reached through a resolver the test supplies.
 *   That is the only way to see the pin: the host name resolves to an address only the test's
 *   resolver knows, so a response proves the connection used the checked address rather than a
 *   fresh lookup.
 *
 * A test that needs loopback passes `allowPrivate: true`; nothing else does, and nothing in
 * production does for an Azure endpoint.
 */

/**
 * The tests below reach a loopback server with the **default** transport, so they must not be
 * routed through whatever egress proxy the process was started with: the proxy would swallow
 * `127.0.0.2` and answer for it. The transport's proxy support is exercised by the server's
 * own tests, where the environment is the deployment's.
 */
for (const key of [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
]) {
  delete process.env[key]
}

/** A resolver over a table of hostnames, failing for anything else. */
function resolverFor(table: Record<string, readonly string[]>): AddressResolver {
  return (hostname) => {
    const addresses = table[hostname.toLowerCase()]
    return addresses === undefined
      ? Promise.reject(new Error(`ENOTFOUND ${hostname}`))
      : Promise.resolve(addresses)
  }
}

/** A transport that answers with a canned response and records what it was asked for. */
function fakeTransport(
  answer: (url: string, init: SafeFetchRequest) => Response | Promise<Response>,
): { transport: SafeFetchTransport; calls: string[] } {
  const calls: string[] = []
  const transport: SafeFetchTransport = async (url, init) => {
    calls.push(url)
    return answer(url, init)
  }
  return { transport, calls }
}

/** A public address, so nothing in these tests is refused for the wrong reason. */
const PUBLIC = '93.184.216.34'

/** The servers a test opened. Every one is closed when the test ends, however it ended. */
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

/** A real HTTP server, and the port it listens on. `host` defaults to every loopback address. */
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  host = '0.0.0.0',
  port = 0,
): Promise<number> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('the test server has no port')
  }
  return address.port
}

/**
 * Two servers on **one port**, one per loopback alias, each naming itself in its body.
 *
 * The address a call dialled is then the answer it got: `127.0.0.2` says "two" and
 * `127.0.0.3` says "three", so a response proves which of the two the socket reached.
 */
async function twins(): Promise<{ port: number; url: string }> {
  const port = await serve((_req, res) => res.end('two'), '127.0.0.2')
  await serve((_req, res) => res.end('three'), '127.0.0.3', port)
  return { port, url: `http://race.example:${port}/` }
}

/** A loopback server and the sockets it holds — what proves a request's connection was closed. */
async function serveTracked(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  host = '127.0.0.2',
): Promise<{ port: number; sockets: Set<Socket> }> {
  const server = createServer(handler)
  servers.push(server)
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  return { port: (server.address() as AddressInfo).port, sockets }
}

/** Wait until `predicate` holds, or fail — a closed connection arrives a tick after the FIN. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('safeFetch refusals', () => {
  it('refuses a scheme that is not http or https, before resolving anything', async () => {
    const { transport, calls } = fakeTransport(() => new Response('nope'))
    let resolved = 0
    const resolver: AddressResolver = () => {
      resolved += 1
      return Promise.resolve([PUBLIC])
    }
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/x',
      'data:text/plain,hi',
      'gopher://example.com',
    ]) {
      await expect(safeFetch(url, {}, { resolver, transport })).rejects.toMatchObject({
        code: 'invalid_protocol',
      })
    }
    expect(resolved).toBe(0)
    expect(calls).toEqual([])
  })

  it('refuses a URL that is not a URL at all', async () => {
    await expect(safeFetch('not a url', {}, { resolver: resolverFor({}) })).rejects.toMatchObject({
      code: 'invalid_url',
    })
  })

  it('refuses the cloud metadata hostnames by name', async () => {
    const { transport } = fakeTransport(() => new Response('nope'))
    for (const host of ['metadata.google.internal', 'metadata.goog']) {
      await expect(
        safeFetch(
          `http://${host}/computeMetadata/v1/`,
          {},
          { resolver: resolverFor({}), transport },
        ),
      ).rejects.toMatchObject({ code: 'metadata_host' })
    }
  })

  it('refuses a hostname that resolves to a private address', async () => {
    const { transport, calls } = fakeTransport(() => new Response('nope'))
    const resolver = resolverFor({
      'internal.example': ['10.0.0.5'],
      'loopback.example': ['127.0.0.1'],
      'metadata.example': ['169.254.169.254'],
      'v6.example': ['fd00::1'],
    })
    for (const host of ['internal.example', 'loopback.example', 'metadata.example', 'v6.example']) {
      await expect(
        safeFetch(`https://${host}/`, {}, { resolver, transport }),
      ).rejects.toMatchObject({ code: 'blocked_address' })
    }
    // Nothing was sent: the refusal happens before a socket is opened.
    expect(calls).toEqual([])
  })

  it('refuses a name whose answer mixes a public address with a private one', async () => {
    // A DNS answer that carries both is an attack, not a round-robin: the public entry would
    // pass a check that looked at only the first address.
    const { transport, calls } = fakeTransport(() => new Response('nope'))
    const resolver = resolverFor({ 'mixed.example': [PUBLIC, '10.0.0.5'] })
    await expect(
      safeFetch('https://mixed.example/', {}, { resolver, transport }),
    ).rejects.toMatchObject({ code: 'blocked_address' })
    expect(calls).toEqual([])
  })

  it('reports a resolver failure as a refusal, not a crash', async () => {
    const { transport } = fakeTransport(() => new Response('nope'))
    await expect(
      safeFetch('https://nowhere.example/', {}, { resolver: resolverFor({}), transport }),
    ).rejects.toMatchObject({ code: 'dns_failure' })
  })

  it('refuses a name that resolves to nothing', async () => {
    const { transport } = fakeTransport(() => new Response('nope'))
    await expect(
      safeFetch(
        'https://empty.example/',
        {},
        {
          resolver: () => Promise.resolve([]),
          transport,
        },
      ),
    ).rejects.toMatchObject({ code: 'dns_failure' })
  })

  it('allows a private address only when the caller asks for it', async () => {
    // The one switch A3b's custom-URL setting uses. It is never on for Azure.
    const { transport, calls } = fakeTransport(() => new Response('ok'))
    const options = { resolver: resolverFor({ 'internal.example': ['10.0.0.5'] }), transport }
    await expect(safeFetch('https://internal.example/', {}, options)).rejects.toMatchObject({
      code: 'blocked_address',
    })
    const response = await safeFetch(
      'https://internal.example/',
      {},
      {
        ...options,
        allowPrivate: true,
      },
    )
    expect(response.status).toBe(200)
    expect(calls).toEqual(['https://internal.example/'])
  })

  it('marks a refusal as a SafeFetchError a caller can recognise', async () => {
    try {
      await safeFetch('file:///x', {}, { resolver: resolverFor({}) })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(isSafeFetchError(error)).toBe(true)
      expect(error).toBeInstanceOf(SafeFetchError)
    }
  })
})

describe('safeFetch redirects', () => {
  it('follows a redirect and re-checks the hop it lands on', async () => {
    const { transport, calls } = fakeTransport((url) =>
      url === 'https://public.example/start'
        ? new Response(null, { status: 302, headers: { location: 'https://public.example/end' } })
        : new Response('arrived'),
    )
    const resolver = resolverFor({ 'public.example': [PUBLIC] })
    const response = await safeFetch('https://public.example/start', {}, { resolver, transport })
    expect(await response.text()).toBe('arrived')
    expect(calls).toEqual(['https://public.example/start', 'https://public.example/end'])
  })

  it('answers the address it finally came from beside the response', async () => {
    // What `web_fetch` reports as the page's own URL (#305): the last hop's, not the one the
    // call named — a redirect is a page that says "what you asked for is here".
    const { transport } = fakeTransport((url) =>
      url.endsWith('/start')
        ? new Response(null, { status: 302, headers: { location: '/end' } })
        : new Response('arrived'),
    )
    const resolver = resolverFor({ 'public.example': [PUBLIC] })
    const result = await safeFetchResult(
      'https://public.example/start',
      {},
      {
        resolver,
        transport,
      },
    )
    expect(result.url).toBe('https://public.example/end')
    expect(await result.response.text()).toBe('arrived')
  })

  it('refuses a redirect that points at a private address', async () => {
    // The classic bypass: the first hop is public, so a check done once at the start would
    // follow this one straight into the internal network.
    const { transport, calls } = fakeTransport((url) =>
      url === 'https://public.example/start'
        ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
        : new Response('hidden'),
    )
    const resolver = resolverFor({ 'public.example': [PUBLIC] })
    await expect(
      safeFetch('https://public.example/start', {}, { resolver, transport }),
    ).rejects.toMatchObject({ code: 'blocked_address' })
    expect(calls).toEqual(['https://public.example/start'])
  })

  it('refuses a scheme change on a redirect', async () => {
    const { transport } = fakeTransport(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }),
      ),
    )
    const resolver = resolverFor({ 'public.example': [PUBLIC] })
    await expect(
      safeFetch('https://public.example/', {}, { resolver, transport }),
    ).rejects.toMatchObject({ code: 'invalid_protocol' })
  })

  it('refuses a redirect that carries no Location', async () => {
    const { transport } = fakeTransport(() => new Response(null, { status: 302 }))
    const resolver = resolverFor({ 'public.example': [PUBLIC] })
    await expect(
      safeFetch('https://public.example/', {}, { resolver, transport }),
    ).rejects.toMatchObject({ code: 'invalid_redirect' })
  })

  it('caps the number of hops', async () => {
    let hop = 0
    const { transport } = fakeTransport(() => {
      hop += 1
      return new Response(null, { status: 302, headers: { location: `/hop-${hop}` } })
    })
    const resolver = resolverFor({ 'public.example': [PUBLIC] })
    await expect(
      safeFetch('https://public.example/', {}, { resolver, transport, maxRedirects: 3 }),
    ).rejects.toMatchObject({ code: 'too_many_redirects' })
    // The first request plus the three hops the cap allows.
    expect(hop).toBe(4)
  })

  it('turns a 303 into a GET without the body, keeping 307 as it was', async () => {
    const seen: { url: string; method: string; hasBody: boolean }[] = []
    const transport: SafeFetchTransport = (url, init) => {
      seen.push({
        url,
        method: init.method,
        hasBody: init.body !== undefined && init.body !== null,
      })
      return Promise.resolve(
        url.endsWith('/start')
          ? new Response(null, { status: 303, headers: { location: '/done' } })
          : new Response('ok'),
      )
    }
    const resolver = resolverFor({ 'public.example': [PUBLIC] })
    await safeFetch(
      'https://public.example/start',
      { method: 'POST', body: 'payload' },
      { resolver, transport },
    )
    expect(seen).toEqual([
      { url: 'https://public.example/start', method: 'POST', hasBody: true },
      { url: 'https://public.example/done', method: 'GET', hasBody: false },
    ])
  })
})

describe('safeFetch transport, limits and the pin', () => {
  it('opens the socket at the address the resolver returned, not a second lookup', async () => {
    const port = await serve((_req, res) => res.end('pinned'))
    // `pinned.example` has no DNS record; only this resolver knows where it "is". A response
    // therefore proves the connection went to 127.0.0.2 — the address that was checked —
    // rather than resolving the name again.
    const response = await safeFetch(
      `http://pinned.example:${port}/hello`,
      {},
      {
        allowPrivate: true,
        resolver: resolverFor({ 'pinned.example': ['127.0.0.2'] }),
      },
    )
    expect(await response.text()).toBe('pinned')
  })

  it('refuses a real loopback request when the address is not allowed', async () => {
    const port = await serve((_req, res) => res.end('should not be reached'))
    const url = `http://loopback.example:${port}/`
    await expect(
      safeFetch(url, {}, { resolver: resolverFor({ 'loopback.example': ['127.0.0.1'] }) }),
    ).rejects.toMatchObject({ code: 'blocked_address' })
  })

  it('caps the response body', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(Buffer.alloc(8 * 1024, 0x61))
    })
    const response = await safeFetch(
      `http://big.example:${port}/`,
      {},
      {
        allowPrivate: true,
        resolver: resolverFor({ 'big.example': ['127.0.0.2'] }),
        maxBytes: 1024,
      },
    )
    await expect(response.text()).rejects.toMatchObject({ code: 'too_large' })
  })

  it('reads a body that fits under the cap', async () => {
    const port = await serve((_req, res) => res.end('small'))
    const response = await safeFetch(
      `http://small.example:${port}/`,
      {},
      {
        allowPrivate: true,
        resolver: resolverFor({ 'small.example': ['127.0.0.2'] }),
        maxBytes: 1024,
      },
    )
    expect(await response.text()).toBe('small')
  })

  it('gives up on a call that takes longer than its deadline', async () => {
    const port = await serve(() => {
      // Never answers.
    })
    await expect(
      safeFetch(
        `http://slow.example:${port}/`,
        {},
        {
          allowPrivate: true,
          resolver: resolverFor({ 'slow.example': ['127.0.0.2'] }),
          timeoutMs: 150,
        },
      ),
    ).rejects.toThrow()
  })

  it('gives up on a body that stalls, on the idle timeout', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('first')
      // Never finishes the response.
    })
    const response = await safeFetch(
      `http://stall.example:${port}/`,
      {},
      {
        allowPrivate: true,
        resolver: resolverFor({ 'stall.example': ['127.0.0.2'] }),
        timeoutMs: null,
        idleTimeoutMs: 200,
      },
    )
    await expect(response.text()).rejects.toMatchObject({ code: 'idle_timeout' })
  })

  it('ships a save-time preset tight and a streaming preset uncapped', () => {
    // The two settings the issue names: a save-time check is bounded in size and time, and a
    // model call streams long replies — an idle window rather than a ceiling.
    expect(SAVE_TIME_LIMITS.maxBytes).toBeGreaterThan(0)
    expect(SAVE_TIME_LIMITS.timeoutMs).toBeGreaterThan(0)
    expect(STREAMING_LIMITS.maxBytes).toBeNull()
    expect(STREAMING_LIMITS.timeoutMs).toBeNull()
    expect(STREAMING_LIMITS.idleTimeoutMs).toBeGreaterThan(0)
  })

  it('streams a long body under the streaming preset, then closes the connection', async () => {
    const { port, sockets } = await serveTracked((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let sent = 0
      const timer = setInterval(() => {
        res.write(`data: chunk-${sent}\n\n`)
        sent += 1
        if (sent === 8) {
          clearInterval(timer)
          res.end()
        }
      }, 20)
      res.on('close', () => clearInterval(timer))
    })
    const response = await safeFetch(
      `http://stream.example:${port}/`,
      {},
      {
        ...STREAMING_LIMITS,
        allowPrivate: true,
        resolver: resolverFor({ 'stream.example': ['127.0.0.2'] }),
      },
    )
    // A body that arrives over time is read whole: the idle window is the only bound.
    const text = await response.text()
    expect(text.match(/data: chunk-/g)).toHaveLength(8)
    await waitFor(() => sockets.size === 0)
    expect(sockets.size).toBe(0)
  })
})

describe('safeFetch connections', () => {
  /** The one address every test here resolves `close.example` to. */
  const resolver = resolverFor({ 'close.example': ['127.0.0.2'], 'never.example': ['127.0.0.2'] })

  it('closes the connection when the body has been read', async () => {
    const { port, sockets } = await serveTracked((_req, res) => res.end('done'))
    const response = await safeFetch(
      `http://close.example:${port}/`,
      {},
      { allowPrivate: true, resolver },
    )
    expect(await response.text()).toBe('done')
    await waitFor(() => sockets.size === 0)
    expect(sockets.size).toBe(0)
  })

  it('closes the connection when the body errors', async () => {
    const { port, sockets } = await serveTracked((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(Buffer.alloc(8 * 1024, 0x61))
    })
    const response = await safeFetch(
      `http://close.example:${port}/`,
      {},
      { allowPrivate: true, resolver, maxBytes: 1024 },
    )
    await expect(response.text()).rejects.toMatchObject({ code: 'too_large' })
    await waitFor(() => sockets.size === 0)
    expect(sockets.size).toBe(0)
  })

  it('closes the connection when the body is cancelled', async () => {
    const { port, sockets } = await serveTracked((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('first')
      // Never finishes the response: the socket stays open until the caller lets go.
    })
    const response = await safeFetch(
      `http://close.example:${port}/`,
      {},
      { allowPrivate: true, resolver, timeoutMs: null, idleTimeoutMs: null },
    )
    await response.body?.cancel()
    await waitFor(() => sockets.size === 0)
    expect(sockets.size).toBe(0)
  })
})

describe('safeFetch redirect credentials', () => {
  /** Every header a credential travels in, and a value a leak would be visible as. */
  const CREDENTIALS: Record<string, string> = {
    authorization: 'Bearer secret',
    'api-key': 'azure-secret',
    'x-api-key': 'anthropic-secret',
    'x-goog-api-key': 'google-secret',
    cookie: 'session=secret',
    'proxy-authorization': 'Basic secret',
  }

  const headers = { ...CREDENTIALS, accept: 'text/plain' }

  /** A transport that redirects `/start` to `location` and records every hop's headers. */
  function redirecting(location: string): { transport: SafeFetchTransport; hops: Headers[] } {
    const hops: Headers[] = []
    const transport: SafeFetchTransport = (url, init) => {
      hops.push(init.headers)
      return Promise.resolve(
        url.endsWith('/start')
          ? new Response(null, { status: 302, headers: { location } })
          : new Response('arrived'),
      )
    }
    return { transport, hops }
  }

  const resolver = resolverFor({ 'a.example': [PUBLIC], 'b.example': [PUBLIC] })

  it('keeps every credential header on a same-origin redirect', async () => {
    const { transport, hops } = redirecting('https://a.example/end')
    await safeFetch('https://a.example/start', { headers }, { resolver, transport })
    expect(hops).toHaveLength(2)
    for (const [name, value] of Object.entries(CREDENTIALS)) {
      expect(hops[0]?.get(name)).toBe(value)
      expect(hops[1]?.get(name)).toBe(value)
    }
  })

  it('strips every credential header on a cross-origin redirect, and keeps the rest', async () => {
    const { transport, hops } = redirecting('https://b.example/end')
    await safeFetch('https://a.example/start', { headers }, { resolver, transport })
    expect(hops).toHaveLength(2)
    for (const name of Object.keys(CREDENTIALS)) {
      expect(hops[0]?.get(name)).not.toBeNull()
      expect(hops[1]?.get(name)).toBeNull()
    }
    // Only the credential headers go: the request's own headers still travel.
    expect(hops[1]?.get('accept')).toBe('text/plain')
  })

  it('strips them for a different port, and for a different scheme', async () => {
    for (const location of ['https://a.example:8443/end', 'http://a.example/end']) {
      const { transport, hops } = redirecting(location)
      await safeFetch(
        'https://a.example/start',
        { headers: { authorization: 'Bearer secret' } },
        { resolver, transport },
      )
      expect(hops[1]?.get('authorization')).toBeNull()
    }
  })

  it('does not pick them up again when a later hop returns to the original origin', async () => {
    const hops: Headers[] = []
    const transport: SafeFetchTransport = (url, init) => {
      hops.push(init.headers)
      if (url.endsWith('/start')) {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://b.example/middle' } }),
        )
      }
      if (url.endsWith('/middle')) {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://a.example/end' } }),
        )
      }
      return Promise.resolve(new Response('arrived'))
    }
    await safeFetch(
      'https://a.example/start',
      { headers: { authorization: 'Bearer secret' } },
      { resolver, transport },
    )
    expect(hops).toHaveLength(3)
    expect(hops[2]?.get('authorization')).toBeNull()
  })
})

describe('safeFetch redirect policy', () => {
  const resolver = resolverFor({ 'public.example': [PUBLIC] })

  it('refuses a redirect under either provider preset, without following it', async () => {
    const { transport, calls } = fakeTransport(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://public.example/elsewhere' },
        }),
    )
    for (const limits of [SAVE_TIME_LIMITS, STREAMING_LIMITS]) {
      await expect(
        safeFetch('https://public.example/', {}, { ...limits, resolver, transport }),
      ).rejects.toMatchObject({ code: 'too_many_redirects' })
    }
    // One first hop each, and neither preset followed the Location.
    expect(calls).toEqual(['https://public.example/', 'https://public.example/'])
  })

  it('still follows a redirect when the caller asks for the default policy', async () => {
    const { transport, calls } = fakeTransport((url) =>
      url.endsWith('/start')
        ? new Response(null, { status: 302, headers: { location: '/end' } })
        : new Response('arrived'),
    )
    const response = await safeFetch('https://public.example/start', {}, { resolver, transport })
    expect(await response.text()).toBe('arrived')
    expect(calls).toEqual(['https://public.example/start', 'https://public.example/end'])
  })

  it('refuses a redirect that would have to resend a streamed body', async () => {
    const { transport } = fakeTransport(
      () => new Response(null, { status: 307, headers: { location: '/end' } }),
    )
    await expect(
      safeFetch(
        'https://public.example/start',
        { method: 'POST', body: new ReadableStream() },
        { resolver, transport },
      ),
    ).rejects.toMatchObject({ code: 'invalid_redirect' })
  })

  it('resends a body that can be sent twice', async () => {
    const seen: unknown[] = []
    const transport: SafeFetchTransport = (url, init) => {
      seen.push(init.body)
      return Promise.resolve(
        url.endsWith('/start')
          ? new Response(null, { status: 307, headers: { location: '/end' } })
          : new Response('arrived'),
      )
    }
    await safeFetch(
      'https://public.example/start',
      { method: 'POST', body: 'payload' },
      { resolver, transport },
    )
    expect(seen).toEqual(['payload', 'payload'])
  })
})

describe('safeFetch pinning, per call', () => {
  it('dials this call’s address after an earlier call to the same origin pinned another', async () => {
    // One hostname, one origin, two answers: 127.0.0.2 ("two") and then 127.0.0.3 ("three").
    // A dispatcher — and so a connection pool — shared across calls would answer the second
    // request down the first call's socket, which was opened to 127.0.0.2: the pause gives
    // that socket time to be back in a shared pool, which is exactly when it would be reused.
    const { url } = await twins()
    const options = (address: string) => ({
      allowPrivate: true,
      resolver: resolverFor({ 'race.example': [address] }),
    })
    const first = await safeFetch(url, {}, options('127.0.0.2'))
    expect(await first.text()).toBe('two')
    await new Promise((resolve) => setTimeout(resolve, 25))
    const second = await safeFetch(url, {}, options('127.0.0.3'))
    expect(await second.text()).toBe('three')
  })

  it('gives two concurrent calls to one hostname their own checked address', async () => {
    const { url } = await twins()
    // The resolver parks both calls inside the guard, so both answers are pinned before
    // either connects — the window in which a module-global map let one call overwrite the
    // other's pin.
    const pending: ((addresses: readonly string[]) => void)[] = []
    const resolver: AddressResolver = (hostname) =>
      hostname.toLowerCase() === 'race.example'
        ? new Promise((resolve) => pending.push(resolve))
        : Promise.reject(new Error(`ENOTFOUND ${hostname}`))

    const first = safeFetch(url, {}, { allowPrivate: true, resolver })
    const second = safeFetch(url, {}, { allowPrivate: true, resolver })
    await waitFor(() => pending.length === 2)
    pending[0]?.(['127.0.0.2'])
    pending[1]?.(['127.0.0.3'])

    const [a, b] = await Promise.all([first, second])
    expect(await a.text()).toBe('two')
    expect(await b.text()).toBe('three')
  })

  it('refuses a private answer under a concurrent call that allows private addresses', async () => {
    // The same hostname at the same time, one call with `allowPrivate` and one without: the
    // option is per call, so the call that did not ask for it is refused rather than inheriting
    // the other call's pinned address.
    const { url } = await twins()
    const refusing = safeFetch(
      url,
      {},
      {
        resolver: resolverFor({ 'race.example': ['127.0.0.3'] }),
      },
    )
    const allowed = safeFetch(
      url,
      {},
      {
        allowPrivate: true,
        resolver: resolverFor({ 'race.example': ['127.0.0.2'] }),
      },
    )
    await expect(refusing).rejects.toMatchObject({ code: 'blocked_address' })
    expect(await (await allowed).text()).toBe('two')
  })

  it('keeps no pin once a call has finished', async () => {
    // A pin is per call by construction — the dispatcher is built for the one hop and closed
    // with its body — so nothing a call pinned survives for the next one, however many
    // hostnames have been through the guard in between.
    const { transport } = fakeTransport(() => new Response('ok'))
    for (let i = 0; i < 100; i += 1) {
      await safeFetch(
        `https://seen-${i}.example/`,
        {},
        {
          resolver: () => Promise.resolve([PUBLIC]),
          transport,
        },
      )
    }
    const { url } = await twins()
    const response = await safeFetch(
      url,
      {},
      {
        allowPrivate: true,
        resolver: resolverFor({ 'race.example': ['127.0.0.3'] }),
      },
    )
    expect(await response.text()).toBe('three')
  })
})
