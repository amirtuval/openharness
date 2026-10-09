import { describe, expect, it, vi } from 'vitest'

import { clearScreen, restoreTerminal } from './terminal'

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

describe('clearScreen', () => {
  it('wipes the display, the scrollback behind it, and puts the cursor home', () => {
    const write = vi.fn()

    clearScreen({ stdout: { isTTY: true, write } })

    // `2J` is the screen, `3J` the scrollback settled messages live in, `H` the top-left
    // corner — all three, or Ctrl+L would only move the prompt up the screen (#206).
    expect(write).toHaveBeenCalledWith('\u001B[2J\u001B[3J\u001B[H')
  })

  it('writes nothing to a stream that is not a terminal', () => {
    const write = vi.fn()

    clearScreen({ stdout: { isTTY: false, write } })

    expect(write).not.toHaveBeenCalled()
  })
})
