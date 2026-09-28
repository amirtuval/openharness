import { describe, expect, it, vi } from 'vitest'

import { restoreTerminal } from './terminal'

describe('restoreTerminal', () => {
  it('turns raw mode off on the way out', () => {
    const setRawMode = vi.fn()
    const write = vi.fn()

    restoreTerminal({ stdin: { isTTY: true, setRawMode }, stdout: { isTTY: true, write } })

    expect(setRawMode).toHaveBeenCalledWith(false)
    expect(write).toHaveBeenCalledWith(expect.stringContaining('[?25h'))
  })

  it('does nothing to a stream that is not a terminal', () => {
    const setRawMode = vi.fn()
    const write = vi.fn()

    restoreTerminal({
      stdin: { isTTY: false, setRawMode },
      stdout: { isTTY: false, write },
    })

    expect(setRawMode).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('survives a stdin that refuses to change mode', () => {
    const setRawMode = vi.fn(() => {
      throw new Error('EPERM')
    })

    expect(() => {
      restoreTerminal({ stdin: { isTTY: true, setRawMode } })
    }).not.toThrow()
  })

  it('is safe to call twice', () => {
    const setRawMode = vi.fn()
    const write = vi.fn()
    const targets = { stdin: { isTTY: true, setRawMode }, stdout: { isTTY: true, write } }

    restoreTerminal(targets)
    restoreTerminal(targets)

    expect(setRawMode).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenCalledTimes(2)
  })
})
