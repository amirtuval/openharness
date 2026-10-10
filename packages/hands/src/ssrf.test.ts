import { describe, expect, it } from 'vitest'

import {
  isBlockedAddress,
  isMetadataHostname,
  isPublicAddress,
  parseIPv4,
  parseIPv6,
  parseIpAddress,
} from './ssrf'

/**
 * The address guard (epic #245, A3a).
 *
 * Every refused range is spelled out as a table, so a range that stops being refused is a
 * named failure rather than a surprise in production. The IPv4-mapped and tunnelled forms are
 * checked too: they are the whole reason the guard parses an address instead of matching its
 * text.
 */
describe('isBlockedAddress', () => {
  it('refuses every IPv4 range a request must not reach', () => {
    const refused: ReadonlyArray<readonly [string, string]> = [
      ['0.0.0.0', 'the unspecified address'],
      ['0.1.2.3', 'the 0.0.0.0/8 "this network" block'],
      ['10.0.0.1', 'private'],
      ['10.255.255.255', 'private, top of the block'],
      ['100.64.0.1', 'carrier-grade NAT'],
      ['100.127.255.255', 'carrier-grade NAT, top of the block'],
      ['127.0.0.1', 'loopback'],
      ['127.255.255.254', 'loopback, top of the block'],
      ['169.254.169.254', 'link-local — the cloud metadata service'],
      ['169.254.0.1', 'link-local'],
      ['172.16.0.1', 'private'],
      ['172.31.255.255', 'private, top of the block'],
      ['192.0.0.1', 'IETF protocol assignments'],
      ['192.0.2.1', 'documentation (TEST-NET-1)'],
      ['192.88.99.1', '6to4 relay anycast'],
      ['192.168.0.1', 'private'],
      ['198.18.0.1', 'benchmarking'],
      ['198.19.255.255', 'benchmarking, top of the block'],
      ['198.51.100.1', 'documentation (TEST-NET-2)'],
      ['203.0.113.1', 'documentation (TEST-NET-3)'],
      ['224.0.0.1', 'multicast'],
      ['239.255.255.255', 'multicast, top of the block'],
      ['240.0.0.1', 'reserved'],
      ['255.255.255.255', 'the broadcast address'],
    ]
    for (const [address, why] of refused) {
      expect(isBlockedAddress(address), `${address} — ${why}`).toBe(true)
      expect(isPublicAddress(address), address).toBe(false)
    }
  })

  it('refuses every IPv6 range a request must not reach', () => {
    const refused: ReadonlyArray<readonly [string, string]> = [
      ['::', 'the unspecified address'],
      ['::1', 'loopback'],
      ['fc00::1', 'unique local'],
      ['fd00::1', 'unique local, the half a deployment actually uses'],
      ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'unique local, top of the block'],
      ['fe80::1', 'link-local'],
      ['febf::1', 'link-local, top of the block'],
      ['ff02::1', 'multicast'],
      ['100::1', 'the discard-only prefix'],
      ['2001:db8::1', 'documentation'],
      ['2001:2::1', 'benchmarking'],
      ['2001:10::1', 'ORCHID'],
      ['2001:20::1', 'ORCHIDv2'],
    ]
    for (const [address, why] of refused) {
      expect(isBlockedAddress(address), `${address} — ${why}`).toBe(true)
      expect(isPublicAddress(address), address).toBe(false)
    }
  })

  it('refuses the IPv4-mapped form of every refused IPv4 address', () => {
    // The whole point of parsing: `::ffff:127.0.0.1` is the loopback wearing a costume, and a
    // text match on `127.` would have missed it.
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1']) {
      expect(isBlockedAddress(`::ffff:${address}`), `::ffff:${address}`).toBe(true)
    }
    // As a URL host would spell it — the hex-group form.
    expect(isBlockedAddress('::ffff:7f00:1')).toBe(true)
  })

  it('refuses the tunnelled IPv4 forms', () => {
    // NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) both carry an IPv4 the routing honours.
    expect(isBlockedAddress('64:ff9b::127.0.0.1')).toBe(true)
    expect(isBlockedAddress('64:ff9b::a00:1')).toBe(true)
    expect(isBlockedAddress('2002:7f00:0001::1')).toBe(true) // 6to4 of 127.0.0.1
    expect(isBlockedAddress('2002:a00:1::1')).toBe(true) // 6to4 of 10.0.0.1
  })

  it('accepts global unicast addresses, mapped ones included', () => {
    const allowed = [
      '8.8.8.8',
      '1.1.1.1',
      '93.184.216.34',
      '2606:4700:4700::1111',
      '2001:4860:4860::8888',
      '::ffff:8.8.8.8',
      '2002:0808:0808::1', // 6to4 of 8.8.8.8 — a public address inside 6to4
    ]
    for (const address of allowed) {
      expect(isPublicAddress(address), address).toBe(true)
      expect(isBlockedAddress(address), address).toBe(false)
    }
  })

  it('refuses anything it cannot parse, and the hex-group IPv4-compatible loopback', () => {
    for (const address of [
      '',
      'nonsense',
      '999.1.1.1',
      '1.2.3',
      '1.2.3.4.5',
      '0177.0.0.1',
      ':::1',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true)
    }
    // `::1` written as its single hex group
    expect(isBlockedAddress('0:0:0:0:0:0:0:1')).toBe(true)
  })

  it('reads a bracketed literal the way a URL carries it', () => {
    expect(isPublicAddress('[2606:4700:4700::1111]')).toBe(true)
    expect(isBlockedAddress('[::1]')).toBe(true)
  })
})

describe('parseIpAddress', () => {
  it('parses IPv4 and reports the family', () => {
    expect(parseIPv4('8.8.8.8')).toEqual({ family: 4, bytes: [8, 8, 8, 8] })
    expect(parseIpAddress('8.8.8.8')?.family).toBe(4)
    expect(parseIPv4('8.8.8')).toBeNull()
    expect(parseIPv4('256.0.0.1')).toBeNull()
  })

  it('parses a compressed IPv6, a trailing :: and an embedded IPv4 tail', () => {
    expect(parseIPv6('::1')?.bytes).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
    expect(parseIPv6('fe80::')?.bytes.slice(0, 2)).toEqual([0xfe, 0x80])
    expect(parseIPv6('fe80::1%eth0')?.bytes.slice(0, 2)).toEqual([0xfe, 0x80])
    expect(parseIPv6('::ffff:127.0.0.1')?.bytes.slice(-4)).toEqual([127, 0, 0, 1])
    expect(parseIpAddress('2606:4700:4700::1111')?.family).toBe(6)
  })

  it('refuses malformed IPv6 spellings', () => {
    for (const value of ['1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', ':::', '1::2::3', 'gggg::1']) {
      expect(parseIPv6(value), value).toBeNull()
    }
  })
})

describe('isMetadataHostname', () => {
  it('recognises the cloud metadata names, however they are spelled', () => {
    for (const host of [
      'metadata.google.internal',
      'METADATA.GOOGLE.INTERNAL',
      'metadata.google.internal.',
      'metadata.goog',
    ]) {
      expect(isMetadataHostname(host), host).toBe(true)
    }
    expect(isMetadataHostname('metadata.google.internal.example.com')).toBe(false)
    expect(isMetadataHostname('example.com')).toBe(false)
    expect(isMetadataHostname('internal')).toBe(false)
  })
})
