import { describe, expect, it } from 'vitest'

import { createTestClock } from './clock'

describe('createTestClock', () => {
  it('starts at the instant it is given and hands out its time as a clock', () => {
    const clock = createTestClock(1000)
    const { now } = clock
    expect(clock.currentMs).toBe(1000)
    // Destructured on purpose: a store receives the function on its own.
    expect(now()).toBe(1000)
  })

  it('moves forward by the milliseconds it is advanced', () => {
    const clock = createTestClock(0)
    clock.advance(30_000)
    expect(clock.currentMs).toBe(30_000)
    clock.advance(1)
    expect(clock.now()).toBe(30_001)
  })

  it('refuses to move backwards or by nonsense', () => {
    const clock = createTestClock(5000)
    expect(() => clock.advance(-1)).toThrow(RangeError)
    expect(() => clock.advance(Number.NaN)).toThrow(RangeError)
    expect(clock.currentMs).toBe(5000)
  })

  it('starts at the wall clock when nothing is given', () => {
    const before = Date.now()
    const clock = createTestClock()
    expect(clock.currentMs).toBeGreaterThanOrEqual(before)
  })
})
