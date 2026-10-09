import { describe, expect, it } from 'vitest'

import { CLIENT_IP_HEADER, resolveClientIp, withClientIpHeader } from './client-ip'

/**
 * Which client IP the server settles on behind a proxy (#151): the entry exactly
 * `trustedProxyHops + 1` from the right of `x-forwarded-for`, the socket address otherwise,
 * and never a value a client could have chosen.
 */

describe('resolveClientIp (#151)', () => {
  it('does not read the forwarding header at all with no trusted hops', () => {
    // The header is the client's to write on a direct connection; the connection's own
    // address is the only fact a client cannot forge.
    expect(
      resolveClientIp({
        forwardedFor: '203.0.113.7',
        socketAddress: '198.51.100.4',
        trustedProxyHops: 0,
      }),
    ).toBe('198.51.100.4')
  })

  it('uses the socket address when there is no forwarding header to trust', () => {
    expect(
      resolveClientIp({ forwardedFor: null, socketAddress: '198.51.100.4', trustedProxyHops: 1 }),
    ).toBe('198.51.100.4')
  })

  it('picks the second entry from the right with one trusted hop (the GCLB shape)', () => {
    // Google's load balancer appends `<client-ip>, <lb-ip>`; the client is entry 2 from the
    // right, i.e. what the load balancer saw in front of it — not what arrived in front of
    // that, which the client wrote.
    expect(
      resolveClientIp({
        forwardedFor: '203.0.113.7, 130.211.0.1',
        socketAddress: '10.0.0.9',
        trustedProxyHops: 1,
      }),
    ).toBe('203.0.113.7')
  })

  it('ignores entries to the left of the trusted chain, whatever they say', () => {
    // A client that sends its own `x-forwarded-for` gets its text prepended to the chain the
    // load balancer appends; the trusted entry is still the second from the right.
    expect(
      resolveClientIp({
        forwardedFor: '10.9.9.9, 203.0.113.7, 130.211.0.1',
        socketAddress: '10.0.0.9',
        trustedProxyHops: 1,
      }),
    ).toBe('203.0.113.7')
  })

  it('counts further hops from the right', () => {
    expect(
      resolveClientIp({
        forwardedFor: '203.0.113.7, 10.0.0.1, 10.0.0.2, 10.0.0.3',
        socketAddress: '10.0.0.9',
        trustedProxyHops: 3,
      }),
    ).toBe('203.0.113.7')
  })

  it('tolerates whitespace and empty entries', () => {
    expect(
      resolveClientIp({
        forwardedFor: '  203.0.113.7 ,, 130.211.0.1 ',
        socketAddress: null,
        trustedProxyHops: 1,
      }),
    ).toBe('203.0.113.7')
  })

  it('accepts IPv6 and IPv4-mapped literals', () => {
    expect(
      resolveClientIp({
        forwardedFor: '2001:db8::7, 130.211.0.1',
        socketAddress: null,
        trustedProxyHops: 1,
      }),
    ).toBe('2001:db8::7')
    expect(
      resolveClientIp({
        forwardedFor: '::ffff:203.0.113.7, 130.211.0.1',
        socketAddress: null,
        trustedProxyHops: 1,
      }),
    ).toBe('::ffff:203.0.113.7')
  })

  it('refuses the trusted entry when it is not an address, and answers the socket instead', () => {
    // The dangerous direction: a chosen entry that is not an IP literal must never become a
    // rate-limit key (or let its sender pick a fresh bucket), and a chain with too few
    // entries has no entry a trusted proxy could have written, so nothing is trusted.
    const cases = [
      'not-an-ip, 130.211.0.1', // junk where a client would sit
      '203.0.113.7', // one entry: the client wrote all of it
      '203.0.113.7:8080, 130.211.0.1', // an address with a port is not an address here
      'evil|bucket, 130.211.0.1', // a value that could collide in a key
      '256.1.1.1, 130.211.0.1', // octet out of range
      '1::2::3, 130.211.0.1', // two compressions: not IPv6
      ', 130.211.0.1', // empty where the client would sit
    ]
    for (const forwardedFor of cases) {
      expect(
        resolveClientIp({ forwardedFor, socketAddress: '198.51.100.4', trustedProxyHops: 1 }),
        forwardedFor,
      ).toBe('198.51.100.4')
    }
  })

  it('answers null when there is neither a trustworthy entry nor a socket', () => {
    // In-process there is no connection to fall back to; the caller gets "no answer", which
    // is what a shared fallback bucket is keyed by.
    expect(resolveClientIp({ trustedProxyHops: 0 })).toBeNull()
    expect(
      resolveClientIp({ forwardedFor: 'not-an-ip, 130.211.0.1', trustedProxyHops: 1 }),
    ).toBeNull()
  })

  it('refuses a socket address that is not an IP literal', () => {
    expect(
      resolveClientIp({ forwardedFor: null, socketAddress: 'a hostname', trustedProxyHops: 0 }),
    ).toBeNull()
  })
})

describe('withClientIpHeader (#151)', () => {
  it('stamps the resolved address on the header Better Auth reads', async () => {
    const request = new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email":"dev@localhost"}',
    })

    const stamped = withClientIpHeader(request, '203.0.113.7')

    expect(stamped.headers.get(CLIENT_IP_HEADER)).toBe('203.0.113.7')
    // Method, URL and body are the request's; only the header was added.
    expect(stamped.method).toBe('POST')
    expect(stamped.url).toBe('http://localhost/api/auth/sign-in/email')
    await expect(stamped.text()).resolves.toBe('{"email":"dev@localhost"}')
  })

  it('replaces a value a client put there', () => {
    const request = new Request('http://localhost/api/auth/session', {
      headers: { [CLIENT_IP_HEADER]: '10.9.9.9' },
    })

    const stamped = withClientIpHeader(request, '203.0.113.7')

    expect(stamped.headers.get(CLIENT_IP_HEADER)).toBe('203.0.113.7')
  })

  it('removes the header when nothing could be resolved', () => {
    const request = new Request('http://localhost/api/auth/session', {
      headers: { [CLIENT_IP_HEADER]: '10.9.9.9' },
    })

    expect(withClientIpHeader(request, null).headers.get(CLIENT_IP_HEADER)).toBeNull()
  })
})
