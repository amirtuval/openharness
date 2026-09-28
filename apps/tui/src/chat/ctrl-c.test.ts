import { describe, expect, it } from 'vitest'

import { CTRL_C_WINDOW_MS, decideCtrlC } from './ctrl-c'

describe('decideCtrlC', () => {
  it('interrupts a running turn', () => {
    expect(decideCtrlC({ running: true, now: 1000, armedAt: null })).toEqual({
      action: 'interrupt',
      armedAt: null,
    })
  })

  it('interrupting also disarms a pending exit', () => {
    expect(decideCtrlC({ running: true, now: 5000, armedAt: 4000 }).armedAt).toBeNull()
  })

  it('arms on the first idle press', () => {
    expect(decideCtrlC({ running: false, now: 1000, armedAt: null })).toEqual({
      action: 'arm',
      armedAt: 1000,
    })
  })

  it('exits on the second idle press inside the window', () => {
    expect(decideCtrlC({ running: false, now: 1000 + CTRL_C_WINDOW_MS, armedAt: 1000 })).toEqual({
      action: 'exit',
      armedAt: null,
    })
  })

  it('re-arms when the second press came too late', () => {
    expect(decideCtrlC({ running: false, now: 9000, armedAt: 1000 })).toEqual({
      action: 'arm',
      armedAt: 9000,
    })
  })

  it('honours a custom window', () => {
    expect(decideCtrlC({ running: false, now: 1200, armedAt: 1000, windowMs: 100 }).action).toBe(
      'arm',
    )
    expect(decideCtrlC({ running: false, now: 1050, armedAt: 1000, windowMs: 100 }).action).toBe(
      'exit',
    )
  })
})
