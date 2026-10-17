import { describe, expect, it } from 'vitest'

import { DEFAULT_STALL_MS, stallState } from './stall'

/**
 * The stall rule (#378, P4): a running turn with nothing arriving is not the same as a model
 * thinking, and the screen has to be able to say so.
 */
describe('stallState', () => {
  const now = 1_000_000

  it('says nothing while events are arriving', () => {
    expect(stallState({ status: 'running', lastEventAt: now - 1_000, now })).toBe('ok')
    expect(stallState({ status: 'running', lastEventAt: now, now })).toBe('ok')
  })

  it('stalls a running turn once the quiet window has passed', () => {
    expect(stallState({ status: 'running', lastEventAt: now - DEFAULT_STALL_MS + 1, now })).toBe(
      'ok',
    )
    expect(stallState({ status: 'running', lastEventAt: now - DEFAULT_STALL_MS, now })).toBe(
      'stalled',
    )
    expect(stallState({ status: 'running', lastEventAt: now - 60_000, now })).toBe('stalled')
  })

  it('never stalls an idle turn, however old the last event is', () => {
    expect(stallState({ status: 'idle', lastEventAt: now - 60_000, now })).toBe('ok')
  })

  it('says nothing before the first event, so a resumed view has no false positive', () => {
    expect(stallState({ status: 'running', lastEventAt: null, now })).toBe('ok')
    expect(stallState({ status: 'running', lastEventAt: undefined, now })).toBe('ok')
  })

  it('lets a real reconnect outrank the clock', () => {
    // The client knows the connection is gone; "Reconnecting…" is the more precise statement,
    // and it appears at once rather than after the quiet window.
    expect(stallState({ status: 'running', lastEventAt: now, now, reconnecting: true })).toBe(
      'reconnecting',
    )
    expect(stallState({ status: 'idle', lastEventAt: now - 60_000, now, reconnecting: true })).toBe(
      'reconnecting',
    )
  })

  it('takes a shorter or longer window from the caller', () => {
    expect(
      stallState({ status: 'running', lastEventAt: now - 5_000, now, thresholdMs: 4_000 }),
    ).toBe('stalled')
    expect(
      stallState({ status: 'running', lastEventAt: now - 5_000, now, thresholdMs: 10_000 }),
    ).toBe('ok')
  })
})
