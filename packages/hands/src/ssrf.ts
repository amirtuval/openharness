/**
 * Which addresses and hostnames an outbound request may reach (epic #245, A3a).
 *
 * `safeFetch` resolves a hostname itself and refuses it when **any** address it resolves to is
 * one of the ranges below, before a socket is opened. The ranges are the ones a request must
 * never be sent to on behalf of a user who typed a URL: the loopback interface, the private
 * networks, link-local (which includes the cloud metadata services at `169.254.169.254`),
 * carrier-grade NAT, multicast, the unspecified address, benchmarking and documentation
 * ranges, and the IPv6 equivalents — unique-local, link-local, and the IPv4-mapped,
 * IPv4-compatible, NAT64 and 6to4 forms that carry an IPv4 address inside them.
 *
 * The check is on the **parsed address**, not on the text the resolver returned, so
 * `::ffff:127.0.0.1` and `::1` are refused for the same reason `127.0.0.1` is. An address that
 * cannot be parsed at all is refused too: an unknown form is not a public one.
 */

/** A parsed address: four bytes, or sixteen. */
export interface ParsedAddress {
  readonly family: 4 | 6
  readonly bytes: readonly number[]
}

/**
 * The hostnames the cloud metadata services answer on.
 *
 * The GCP metadata server is reachable as `metadata.google.internal` (and `metadata.goog`),
 * which resolve to a link-local address that {@link isBlockedAddress} refuses anyway — the
 * name check is belt-and-braces for a deployment whose resolver maps it elsewhere.
 */
const METADATA_HOSTNAMES: readonly string[] = ['metadata.google.internal', 'metadata.goog']

/** Whether a hostname names a cloud metadata service. The trailing dot is not significant. */
export function isMetadataHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return METADATA_HOSTNAMES.includes(normalized)
}

/**
 * Parse a dotted-quad IPv4 literal, or `null` when it is not one.
 *
 * Leading zeros are refused rather than read as octal: `0177.0.0.1` means different things to
 * different parsers, and an address whose meaning is ambiguous is not a public one.
 */
export function parseIPv4(value: string): ParsedAddress | null {
  const parts = value.split('.')
  if (parts.length !== 4) {
    return null
  }
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith('0'))) {
      return null
    }
    const byte = Number(part)
    if (byte > 255) {
      return null
    }
    bytes.push(byte)
  }
  return { family: 4, bytes }
}

/**
 * Parse an IPv6 literal into sixteen bytes, or `null` when it is not one.
 *
 * Handles the compressed `::` form, an embedded IPv4 tail (`::ffff:127.0.0.1`), and a zone
 * suffix (`fe80::1%eth0`), whose zone is dropped: a scoped address is link-local anyway.
 */
export function parseIPv6(value: string): ParsedAddress | null {
  const text = value.split('%')[0] ?? ''
  if (text === '' || !text.includes(':')) {
    return null
  }

  let body = text
  let tail: number[] = []
  const lastColon = body.lastIndexOf(':')
  const lastPart = body.slice(lastColon + 1)
  if (lastPart.includes('.')) {
    const embedded = parseIPv4(lastPart)
    if (embedded === null) {
      return null
    }
    const [a = 0, b = 0, c = 0, d = 0] = embedded.bytes
    tail = [(a << 8) | b, (c << 8) | d]
    body = body.slice(0, lastColon)
  }

  const doubleIndex = body.indexOf('::')
  if (doubleIndex !== -1 && body.indexOf('::', doubleIndex + 2) !== -1) {
    return null
  }
  const head = parseHexGroups(doubleIndex === -1 ? body : body.slice(0, doubleIndex))
  const middle = parseHexGroups(doubleIndex === -1 ? '' : body.slice(doubleIndex + 2))
  if (head === null || middle === null) {
    return null
  }
  const given = head.length + middle.length + tail.length
  if (given > 8 || (doubleIndex === -1 && given !== 8) || (doubleIndex !== -1 && given === 8)) {
    return null
  }
  const zeros = 8 - given
  const words = [...head, ...Array.from({ length: zeros }, () => 0), ...middle, ...tail]

  const bytes: number[] = []
  for (const word of words) {
    bytes.push((word >> 8) & 0xff, word & 0xff)
  }
  return { family: 6, bytes }
}

/** Parse `a:b:c` into 16-bit words, or `null`; an empty string is no groups. */
function parseHexGroups(text: string): number[] | null {
  if (text === '') {
    return []
  }
  const words: number[] = []
  for (const part of text.split(':')) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) {
      return null
    }
    words.push(Number.parseInt(part, 16))
  }
  return words
}

/** Parse an address literal in either family, or `null`. Brackets around a literal are ignored. */
export function parseIpAddress(value: string): ParsedAddress | null {
  const text = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  return text.includes(':') ? parseIPv6(text) : parseIPv4(text)
}

/**
 * Whether an address is outside every range a request must not reach.
 *
 * `true` means "a global unicast address, safe to connect to". An address that does not parse
 * is not safe: `false`.
 */
export function isPublicAddress(address: string): boolean {
  const parsed = parseIpAddress(address)
  if (parsed === null) {
    return false
  }
  return parsed.family === 4 ? !isBlockedIPv4(parsed.bytes) : !isBlockedIPv6(parsed.bytes)
}

/** Whether an address is in a range a request must not reach — the negation of {@link isPublicAddress}. */
export function isBlockedAddress(address: string): boolean {
  return !isPublicAddress(address)
}

/** The IPv4 ranges a request must not reach. */
function isBlockedIPv4(bytes: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = bytes
  return (
    a === 0 || // 0.0.0.0/8 — "this network", the unspecified address among them
    a === 10 || // 10.0.0.0/8 — private
    (a === 100 && (b & 0xc0) === 64) || // 100.64.0.0/10 — carrier-grade NAT
    a === 127 || // 127.0.0.0/8 — loopback
    (a === 169 && b === 254) || // 169.254.0.0/16 — link-local, the cloud metadata service
    (a === 172 && (b & 0xf0) === 16) || // 172.16.0.0/12 — private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0.0/24, 192.0.2.0/24 — protocol/test
    (a === 192 && b === 88 && c === 99) || // 192.88.99.0/24 — 6to4 relay anycast
    (a === 192 && b === 168) || // 192.168.0.0/16 — private
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 — benchmarking
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 — documentation
    (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 — documentation
    (a & 0xf0) === 224 || // 224.0.0.0/4 — multicast
    (a & 0xf0) === 240 // 240.0.0.0/4 — reserved, the broadcast address included
  )
}

/**
 * The IPv6 ranges a request must not reach.
 *
 * An address that carries an IPv4 inside it — `::ffff:0:0/96` (mapped), `::/96` (compatible),
 * `64:ff9b::/96` (NAT64) and `2002::/16` (6to4) — is judged by that IPv4: a mapped public
 * address is public, and a mapped loopback one is refused exactly as the loopback is.
 */
function isBlockedIPv6(bytes: readonly number[]): boolean {
  const embedded = embeddedIPv4(bytes)
  if (embedded !== null) {
    return isBlockedIPv4(embedded)
  }
  const [b0 = 0, b1 = 0] = bytes
  return (
    bytes.every((byte) => byte === 0) || // :: — unspecified
    (b0 & 0xfe) === 0xfc || // fc00::/7 — unique local
    (b0 === 0xfe && (b1 & 0xc0) === 0x80) || // fe80::/10 — link-local
    b0 === 0xff || // ff00::/8 — multicast
    isReservedIPv6(bytes)
  )
}

/** The four IPv4 bytes an IPv6 address carries, or `null` when it carries none. */
function embeddedIPv4(bytes: readonly number[]): number[] | null {
  const at = (offset: number): number[] => [
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  ]
  const zero = (until: number): boolean => bytes.slice(0, until).every((byte) => byte === 0)
  // `::ffff:a.b.c.d` — IPv4-mapped
  if (zero(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return at(12)
  }
  // `::a.b.c.d` — IPv4-compatible, which includes `::` and `::1`
  if (zero(12)) {
    return at(12)
  }
  // `64:ff9b::a.b.c.d` — NAT64's well-known prefix
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return at(12)
  }
  // `2002:a.b.c.d::` — 6to4
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return at(2)
  }
  return null
}

/** Documentation, benchmarking, ORCHID, IETF-reserved blocks and `100::/64`. */
function isReservedIPv6(bytes: readonly number[]): boolean {
  const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = bytes
  if (b0 === 0x20 && b1 === 0x01) {
    // 2001:db8::/32 documentation, 2001:2::/48 benchmarking, 2001:10::/28 and 2001:20::/28 ORCHID
    if (b2 === 0x0d && b3 === 0xb8) return true
    if (b2 === 0x00 && (b3 === 0x02 || b3 === 0x10 || b3 === 0x20)) return true
  }
  // 100::/64 — the discard-only prefix
  return b0 === 0x01 && b1 === 0x00 && bytes.slice(2, 8).every((byte) => byte === 0)
}
