import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import {
  SAVE_TIME_LIMITS,
  STREAMING_LIMITS,
  SafeFetchError,
  isSafeFetchError,
  safeFetch,
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
  const servers: Server[] = []
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    )
  })

  /** A real HTTP server on every loopback address, and the port it listens on. */
  async function listen(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<number> {
    const server = createServer(handler)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('the test server has no port')
    }
    return address.port
  }

  it('opens the socket at the address the resolver returned, not a second lookup', async () => {
    const port = await listen((_req, res) => res.end('pinned'))
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
    const port = await listen((_req, res) => res.end('should not be reached'))
    const url = `http://loopback.example:${port}/`
    await expect(
      safeFetch(url, {}, { resolver: resolverFor({ 'loopback.example': ['127.0.0.1'] }) }),
    ).rejects.toMatchObject({ code: 'blocked_address' })
  })

  it('caps the response body', async () => {
    const port = await listen((_req, res) => {
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
    const port = await listen((_req, res) => res.end('small'))
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
    const port = await listen(() => {
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
    const port = await listen((_req, res) => {
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
})
