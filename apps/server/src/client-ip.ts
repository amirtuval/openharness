/**
 * The client IP behind a proxy (#151, deployment epic #148).
 *
 * The server is deployed behind Google's global external HTTPS load balancer, and Better Auth
 * keys its rate-limit counters — and the `ipAddress` it records on a session — by client IP.
 * So "which address is the client's?" is a question several things ask, and this module is the
 * one place that answers it.
 *
 * `x-forwarded-for` is a list proxies *append* to: as the request reaches this server it holds,
 * left to right, whatever the client sent (if anything), then one entry per proxy that
 * forwarded the request. The leftmost entries are therefore the client's to write, and nothing
 * may be trusted from them; only the entries appended by proxies this deployment runs can be
 * trusted, and only as far as the deployment says those proxies exist
 * (`OPENHARNESS_TRUSTED_PROXY_HOPS`).
 *
 * Google's load balancer appends `<client-ip>, <lb-ip>` to the chain — the real client
 * address, then its own — so behind GCLB the trusted hop count is 1 and the client's address
 * is the **second entry from the right**. Behind two chained proxies it is the third from the
 * right, and so on: `trustedProxyHops + 1` entries from the right is the first address no
 * proxy in the chain wrote from a peer it had already authenticated.
 *
 * Everything here is deliberately boring: a pure function over the request's headers and the
 * connection, no state, and nothing that throws. A caller that gets `null` knows only that no
 * trustworthy address could be resolved — which is not an error, it is a fact a rate limiter
 * can key a shared fallback bucket by.
 */

/** The header the resolved client IP is handed to Better Auth on; the only one it reads. */
export const CLIENT_IP_HEADER = 'x-openharness-client-ip'

/** The forwarding header proxies append to. Named, so the one reader and its comment agree. */
export const FORWARDED_FOR_HEADER = 'x-forwarded-for'

/** What {@link resolveClientIp} reads: the request's headers and the connection under it. */
export interface ClientIpInput {
  /** The `x-forwarded-for` header as it arrived, or `null`/undefined when there is none. */
  readonly forwardedFor?: string | null
  /**
   * The address the connection came from — the socket's `remoteAddress` — when the server has
   * one. `null` in-process (a test's `app.request`), where there is no socket at all.
   */
  readonly socketAddress?: string | null
  /**
   * `OPENHARNESS_TRUSTED_PROXY_HOPS`: how many proxies this deployment runs in front of the
   * server, each of which appends one entry to `x-forwarded-for`. `0` means forwarding
   * headers are not trusted at all.
   */
  readonly trustedProxyHops: number
}

/**
 * The client's IP, or `null` when nothing trustworthy could be resolved.
 *
 * The rule, in full:
 *
 * - With `trustedProxyHops` 0 the forwarding header is not read at all — a client is free to
 *   send one — and the socket address is the answer.
 * - With `trustedProxyHops` N > 0 the entry N + 1 from the right of `x-forwarded-for` is the
 *   first one a trusted proxy wrote from a peer it knew; entries further left came in with the
 *   request and are ignored, whatever they contain. With GCLB (one proxy) that entry is
 *   `<client-ip>` in `<client-ip>, <lb-ip>`.
 * - The chosen entry is used only when it really is an IPv4 or IPv6 literal; otherwise the
 *   socket address answers instead. A header field a client can fill must never be able to
 *   mint a rate-limit bucket — or to escape into the shared one — by sending junk: whatever is
 *   sent, the answer is either a real address from the trusted chain or the connection's own.
 */
export function resolveClientIp(input: ClientIpInput): string | null {
  const forwardedFor = input.forwardedFor?.trim()
  if (input.trustedProxyHops > 0 && forwardedFor !== undefined && forwardedFor !== '') {
    const entries = forwardedFor
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    // `trustedProxyHops + 1` entries from the right, i.e. index `length - 1 - hops`. A chain
    // with fewer entries than that has no trusted entry: the client wrote all of it.
    const trusted = entries[entries.length - 1 - input.trustedProxyHops]
    if (trusted !== undefined && isIpLiteral(trusted)) {
      return trusted
    }
  }
  const socketAddress = input.socketAddress?.trim()
  return socketAddress !== undefined && isIpLiteral(socketAddress) ? socketAddress : null
}

/**
 * A copy of `request` carrying the resolved client IP on {@link CLIENT_IP_HEADER}.
 *
 * The header is this server's to write: whatever a client put there is replaced — or removed
 * when `clientIp` is `null`, so a hand-set value cannot survive as the rate-limit key. Only
 * the header changes; method, URL, headers and body are the request's.
 */
export function withClientIpHeader(request: Request, clientIp: string | null): Request {
  const headers = new Headers(request.headers)
  if (clientIp === null) {
    headers.delete(CLIENT_IP_HEADER)
  } else {
    headers.set(CLIENT_IP_HEADER, clientIp)
  }
  return new Request(request, { headers })
}

/**
 * Whether a string is an IPv4 or IPv6 literal — enough to keep junk out of a rate-limit key,
 * not a full grammar.
 *
 * IPv4 is checked octet by octet. IPv6 is checked structurally: hex groups of at most four
 * digits, at most one `::`, and the group counts a compressed and an uncompressed address
 * each allow (a dotted-quad tail, as in `::ffff:192.0.2.1`, counts as one group). Anything
 * else — a hostname, an address with a port or a zone, a value carrying a separator a key
 * could be built from — is refused. Consumers validate again (Better Auth runs its own
 * address check and normalizes what it accepts), so this only has to be right about the
 * dangerous direction: never call something an address that is not one.
 */
export function isIpLiteral(value: string): boolean {
  if (isIpv4(value)) {
    return true
  }
  return isIpv6(value)
}

/** A dotted quad with every octet in range. */
function isIpv4(value: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return false
  }
  return value.split('.').every((octet) => Number(octet) <= 255)
}

/** An IPv6 literal, structurally checked (see {@link isIpLiteral}). */
function isIpv6(value: string): boolean {
  if (!value.includes(':') || !/^[0-9a-fA-F:.]+$/.test(value)) {
    return false
  }
  const parts = value.split('::')
  if (parts.length > 2) {
    // Two `::` cannot both stand for zero groups.
    return false
  }
  const head = parts[0] ?? ''
  const tail = parts.length === 2 ? (parts[1] ?? '') : undefined
  if (head.startsWith(':') || tail?.endsWith(':') === true) {
    // A lone leading/trailing colon is `:::`, which the split above would misread.
    return false
  }
  const groups = [
    ...(head === '' ? [] : head.split(':')),
    ...(tail ? (tail === '' ? [] : tail.split(':')) : []),
  ]
  if (groups.length === 0 || groups.some((group) => group === '')) {
    return false
  }
  if (!groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group) || isIpv4(group))) {
    return false
  }
  return tail === undefined ? groups.length === 8 : groups.length <= 7
}
