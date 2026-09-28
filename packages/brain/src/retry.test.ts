import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  abortableSleep,
  backoffDelay,
  resolveRetryPolicy,
} from './retry'

describe('resolveRetryPolicy', () => {
  it('defaults every part of the policy', () => {
    const policy = resolveRetryPolicy()

    expect(policy.maxRetries).toBe(DEFAULT_MAX_RETRIES)
    expect(policy.maxRetries).toBe(3)
    expect(policy.baseDelayMs).toBe(DEFAULT_BASE_DELAY_MS)
    expect(policy.maxDelayMs).toBe(DEFAULT_MAX_DELAY_MS)
    expect(policy.sleep).toBe(abortableSleep)
    expect(policy.jitter()).toBeGreaterThanOrEqual(0)
    expect(policy.jitter()).toBeLessThan(1)
  })

  it('keeps what it is given', () => {
    const sleep = (): Promise<void> => Promise.resolve()
    const jitter = (): number => 0
    const policy = resolveRetryPolicy({
      maxRetries: 0,
      baseDelayMs: 1,
      maxDelayMs: 2,
      sleep,
      jitter,
    })

    expect(policy).toEqual({ maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2, sleep, jitter })
  })
})

describe('backoffDelay', () => {
  it('doubles the delay per attempt, half of it fixed', () => {
    const policy = resolveRetryPolicy({ baseDelayMs: 500, jitter: () => 0 })

    expect(backoffDelay(1, policy)).toBe(250)
    expect(backoffDelay(2, policy)).toBe(500)
    expect(backoffDelay(3, policy)).toBe(1_000)
  })

  it('spends the jittered half on the jitter', () => {
    const policy = resolveRetryPolicy({ baseDelayMs: 500, jitter: () => 1 })

    expect(backoffDelay(1, policy)).toBe(500)
    expect(backoffDelay(3, policy)).toBe(2_000)
  })

  it('clamps to the ceiling', () => {
    const half = resolveRetryPolicy({ baseDelayMs: 1_000, maxDelayMs: 1_500, jitter: () => 0.5 })
    const full = resolveRetryPolicy({ baseDelayMs: 1_000, maxDelayMs: 1_500, jitter: () => 1 })

    // 1_000 * 2 ** 3 is 8_000, clamped to 1_500 before the jitter is spent.
    expect(backoffDelay(4, half)).toBe(1_125)
    expect(backoffDelay(4, full)).toBe(1_500)
    expect(backoffDelay(20, full)).toBe(1_500)
  })
})

describe('abortableSleep', () => {
  it('waits for a signal that is already aborted without waiting at all', async () => {
    const controller = new AbortController()
    controller.abort()

    const started = Date.now()
    await abortableSleep(10_000, controller.signal)

    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('gives up as soon as the signal aborts', async () => {
    const controller = new AbortController()
    const sleeping = abortableSleep(10_000, controller.signal)
    setTimeout(() => controller.abort(), 5)

    const started = Date.now()
    await sleeping

    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('resolves after the delay when nothing aborts', async () => {
    const onResolve = vi.fn()
    await abortableSleep(5).then(onResolve)

    expect(onResolve).toHaveBeenCalledTimes(1)
  })

  it('does not wait for a timer nobody needs', async () => {
    const controller = new AbortController()
    const listener = vi.spyOn(controller.signal, 'addEventListener')
    controller.abort()
    await abortableSleep(1_000, controller.signal)

    expect(listener).not.toHaveBeenCalled()
  })
})
