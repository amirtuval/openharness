import { describe, expect, it } from 'vitest'

import {
  API_KEY_HEADER,
  API_VERSION_PREFIX,
  DEFAULT_PARTITION_COUNT,
  LAST_EVENT_ID_HEADER,
  partitionOf,
} from './constants'
import { newSessionId } from './ids'

describe('API constants', () => {
  it('matches the Anthropic header and route spellings', () => {
    expect(API_VERSION_PREFIX).toBe('/v1')
    expect(API_KEY_HEADER).toBe('x-api-key')
    expect(LAST_EVENT_ID_HEADER).toBe('last-event-id')
    expect(DEFAULT_PARTITION_COUNT).toBe(64)
  })
})

describe('partitionOf', () => {
  it('is stable: the same session always lands in the same partition', () => {
    const id = newSessionId()
    const first = partitionOf(id)
    for (let i = 0; i < 100; i += 1) {
      expect(partitionOf(id)).toBe(first)
    }
  })

  it('always returns a partition in range', () => {
    for (let i = 0; i < 1000; i += 1) {
      const partition = partitionOf(newSessionId())
      expect(Number.isInteger(partition)).toBe(true)
      expect(partition).toBeGreaterThanOrEqual(0)
      expect(partition).toBeLessThan(DEFAULT_PARTITION_COUNT)
    }
  })

  it('honours a custom partition count', () => {
    const id = 'sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7'
    expect(partitionOf(id, 1)).toBe(0)
    expect(partitionOf(id, 7)).toBeLessThan(7)
    expect(partitionOf(id, 64)).toBe(partitionOf(id, 128) % 64)
  })

  it('spreads sessions roughly evenly over the partitions', () => {
    const partitions = 64
    const sessions = 20_000
    const counts = new Array<number>(partitions).fill(0)
    for (let i = 0; i < sessions; i += 1) {
      const partition = partitionOf(newSessionId(), partitions)
      counts[partition] = (counts[partition] ?? 0) + 1
    }
    const expected = sessions / partitions
    // 20k samples over 64 bins: the standard deviation is ~17, so ±30% is about 5σ. A
    // failure here means the hash clusters, not that the run was unlucky.
    for (const [partition, count] of counts.entries()) {
      expect(count, `partition ${partition}`).toBeGreaterThan(expected * 0.7)
      expect(count, `partition ${partition}`).toBeLessThan(expected * 1.3)
    }
    expect(counts.reduce((total, count) => total + count, 0)).toBe(sessions)
  })

  it('does not reduce to the ULID time prefix', () => {
    // Sessions created in the same millisecond must still spread out, so the hash cannot
    // depend on the (identical) 10-character time prefix alone.
    const partitions = new Set(
      Array.from({ length: 256 }, () => partitionOf(newSessionId(1770000000000))),
    )
    expect(partitions.size).toBeGreaterThan(48)
  })

  it('mixes low-entropy ids instead of counting through the partitions', () => {
    // `sesn_0`, `sesn_1`, … have almost no entropy, and a hash that only multiplies the last
    // byte maps them to partitions in a near-cyclic pattern: every step between neighbours is
    // one of a handful of values, so partitions follow id order even though the bin counts
    // look even. The finalizer in `partitionOf` avalanches the low bits; this measures it.
    const stepSizes = new Set<number>()
    let previous: number | null = null
    for (let i = 0; i < 256; i += 1) {
      const partition = partitionOf(`sesn_${i}`)
      if (previous !== null) {
        stepSizes.add((((partition - previous) % 64) + 64) % 64)
      }
      previous = partition
    }
    // Measured: 64 distinct steps with the finalizer, 26 without.
    expect(stepSizes.size).toBeGreaterThan(48)
  })

  it('rejects a partition count that cannot partition', () => {
    expect(() => partitionOf('sesn_x', 0)).toThrow(RangeError)
    expect(() => partitionOf('sesn_x', -1)).toThrow(RangeError)
    expect(() => partitionOf('sesn_x', 1.5)).toThrow(RangeError)
  })
})
