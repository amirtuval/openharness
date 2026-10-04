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

  it('gives the same terminal back on a second call: idempotent, not a no-op', () => {
    const setRawMode = vi.fn()
    const write = vi.fn()
    const targets = { stdin: { isTTY: true, setRawMode }, stdout: { isTTY: true, write } }

    restoreTerminal(targets)
    restoreTerminal(targets)

    // Both calls leave line mode on and ask for the cursor, so a signal landing mid-teardown
    // cannot leave a terminal that stopped echoing (which is why it exists at all).
    expect(setRawMode).toHaveBeenNthCalledWith(1, false)
    expect(setRawMode).toHaveBeenNthCalledWith(2, false)
    for (const call of write.mock.calls) {
      expect(call[0]).toContain('[?25h')
    }
  })
})
