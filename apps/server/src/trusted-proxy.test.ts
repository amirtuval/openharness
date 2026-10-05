import { connect } from 'node:net'

import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from '@openharness/session'

import { DEV_LOGIN_EMAIL, DEV_LOGIN_PASSWORD } from './auth'
import { startServer } from './main'
import { silentLogger } from './types'
import {
  createScriptedModel,
  createTestApp,
  resolveTestSessionCredential,
  testConfig,
  type TestContext,
} from './test-support'

/**
 * The client IP behind a proxy (#151): which `x-forwarded-for` entry becomes the rate-limit
 * bucket and the session record, and — the QA bug this closes — that a client can never
 * choose either.
 *
 * The buckets are observed through Better Auth's sign-in limiter (three per ten seconds on
 * the sign-in path): the fourth request that lands in one bucket gets a 429, so "same
 * bucket" and "different bucket" are HTTP facts here. The session record is read back
 * through `auth.api.getSession`.
 */

/** A sign-in attempt to `/api/auth/sign-in/email`, optionally claiming a forwarding chain. */
function signIn(test: TestContext, forwardedFor?: string): Promise<Response> {
  return test.anonymous('/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
    },
    body: JSON.stringify({ email: DEV_LOGIN_EMAIL, password: DEV_LOGIN_PASSWORD }),
  })
}

/** The status of one sign-in attempt, with the body drained so the socket is reusable. */
async function statusOf(test: TestContext, forwardedFor: string): Promise<number> {
  const response = await signIn(test, forwardedFor)
  await response.arrayBuffer()
  return response.status
}

/** The client IP Better Auth recorded on the session a sign-in answered with. */
async function sessionIp(test: TestContext, response: Response): Promise<string | null> {
  const { token } = (await response.json()) as { token: string }
  const session = await test.auth.auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${token}` }),
  })
  return session?.session.ipAddress ?? null
}

const GCLB_IP = '130.211.0.1'

describe('rate-limit buckets behind a proxy (#151)', () => {
  it('gives a client no way to choose its bucket with the default of no trusted hops', async () => {
    // A client that sends `x-forwarded-for` itself gets it into the request; with no trusted
    // proxy that header says nothing, so every attempt below lands in the same bucket — and
    // the fourth is refused, whatever new address it claims.
    const test = createTestApp({ rateLimit: true })

    const statuses = [
      await statusOf(test, '198.51.100.1'),
      await statusOf(test, '198.51.100.2'),
      await statusOf(test, '198.51.100.3'),
      await statusOf(test, '198.51.100.4'),
    ]

    expect(statuses.slice(0, 3).every((status) => status !== 429)).toBe(true)
    expect(statuses[3]).toBe(429)
  })

  it('keys by the client entry of a GCLB chain when one hop is trusted', async () => {
    // The QA bug: behind the load balancer everyone shared one bucket. With one trusted hop
    // the chain `<client-ip>, <lb-ip>` keys by `<client-ip>` — entry 2 from the right — so
    // one user's failed sign-ins cannot block another's (A has exhausted its bucket when B
    // signs in).
    const test = createTestApp({ rateLimit: true, trustedProxyHops: 1 })

    const clientA = '203.0.113.7'
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await statusOf(test, `${clientA}, ${GCLB_IP}`)).not.toBe(429)
    }
    // A's fourth, now with a forged entry the client prepended: still A's bucket, because
    // entries left of the trusted chain are the client's to write and are not read.
    expect(await statusOf(test, `10.9.9.9, ${clientA}, ${GCLB_IP}`)).toBe(429)
    // B, behind the same load balancer, is unaffected by anything A did.
    expect(await statusOf(test, `198.51.100.9, ${GCLB_IP}`)).not.toBe(429)
  })

  it('ignores a trusted entry that is not an address', async () => {
    // Garbage where the client would sit must not become a key — otherwise a client mints a
    // fresh bucket per request — and it must not share a legitimate client's bucket either.
    const test = createTestApp({ rateLimit: true, trustedProxyHops: 1 })

    for (const junk of ['not-an-ip', 'evil|bucket', '198.51.100.1:443']) {
      expect(await statusOf(test, `${junk}, ${GCLB_IP}`)).not.toBe(429)
    }
    // Three different garbage values, one bucket: the fourth request is refused, so no fresh
    // bucket was minted by any of them.
    expect(await statusOf(test, `still-not-an-ip, ${GCLB_IP}`)).toBe(429)
    // And a real client behind the load balancer is untouched by any of it.
    expect(await statusOf(test, `203.0.113.7, ${GCLB_IP}`)).not.toBe(429)
  })
})

describe('the recorded session IP behind a proxy (#151)', () => {
  it('records the client entry of a GCLB chain as the session’s address', async () => {
    const test = createTestApp({ trustedProxyHops: 1 })

    const response = await signIn(test, `203.0.113.7, ${GCLB_IP}`)

    expect(response.status).toBe(200)
    await expect(sessionIp(test, response)).resolves.toBe('203.0.113.7')
  })

  it('does not record a spoofed address when no proxy is trusted', async () => {
    const test = createTestApp()

    const response = await signIn(test, '203.0.113.7')

    expect(response.status).toBe(200)
    // Nothing to trust and no socket in-process: the header a client sent is not the answer.
    await expect(sessionIp(test, response)).resolves.not.toBe('203.0.113.7')
  })
})

describe('the socket address when no proxy is trusted (#151)', () => {
  it('keys by the connection’s own address, whatever the header says', async () => {
    const started = await startServer({
      config: { ...testConfig(), port: 0 },
      store: new InMemorySessionStore(),
      model: createScriptedModel().factory,
      resolveCredential: resolveTestSessionCredential,
      logger: silentLogger,
    })
    try {
      // Three attempts from a loopback *alias* (a different address from the plain
      // 127.0.0.1 a header-less request would fall back to), each claiming a different
      // client address; with no trusted proxy none of that is read.
      for (const spoof of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
        expect(await signInFrom(started.port, '127.0.0.2', spoof), spoof).not.toBe(429)
      }
      // The fourth from the same socket is refused, whatever it now claims: the bucket is
      // the alias.
      expect(await signInFrom(started.port, '127.0.0.2', '198.51.100.4')).toBe(429)
      // And the plain loopback address is a *different* bucket — which is what proves the
      // key came from the socket and not from Better Auth's test-process fallback.
      expect(await signInFrom(started.port, '127.0.0.1', '198.51.100.5')).not.toBe(429)
    } finally {
      await started.shutdown()
    }
  })
})

/**
 * A sign-in attempt over a socket this test opened from `localAddress`, answered with the
 * HTTP status.
 *
 * `app.request` has no connection, so the one thing only a real listener can show — that
 * with no trusted proxy the *connection's* address is the client IP — needs a real socket,
 * and picking the source address needs one too: `fetch` cannot bind one, and neither
 * `localAddress` on an undici agent nor a loopback destination survived this machine's
 * network layer. The request is one hand-written HTTP/1.1 POST on a `connection: close`
 * socket, which is all the status assertion needs.
 */
function signInFrom(port: number, localAddress: string, forwardedFor: string): Promise<number> {
  const body = JSON.stringify({ email: DEV_LOGIN_EMAIL, password: DEV_LOGIN_PASSWORD })
  const request =
    'POST /api/auth/sign-in/email HTTP/1.1\r\n' +
    `host: 127.0.0.1:${port}\r\n` +
    'content-type: application/json\r\n' +
    `content-length: ${Buffer.byteLength(body)}\r\n` +
    `x-forwarded-for: ${forwardedFor}\r\n` +
    'connection: close\r\n\r\n' +
    body
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port, localAddress })
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    socket.on('end', () => {
      const received = Buffer.concat(chunks).toString('utf8')
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1]))
    })
    socket.on('error', reject)
    socket.on('connect', () => {
      socket.write(request)
    })
  })
}
