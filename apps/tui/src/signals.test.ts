import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { installSignals } from './signals'

describe('installSignals', () => {
  it('routes SIGINT to the interrupt handler', () => {
    const host = new EventEmitter()
    const onInterrupt = vi.fn()
    const onTerminate = vi.fn()

    installSignals(host, { onInterrupt, onTerminate })
    host.emit('SIGINT')

    expect(onInterrupt).toHaveBeenCalledTimes(1)
    expect(onTerminate).not.toHaveBeenCalled()
  })

  it('routes SIGTERM and SIGHUP to the terminate handler', () => {
    const host = new EventEmitter()
    const onTerminate = vi.fn()

    installSignals(host, { onTerminate })
    host.emit('SIGTERM')
    host.emit('SIGHUP')

    expect(onTerminate).toHaveBeenCalledTimes(2)
  })

  it('removes every handler again', () => {
    const host = new EventEmitter()
    const onInterrupt = vi.fn()
    const onTerminate = vi.fn()

    const dispose = installSignals(host, { onInterrupt, onTerminate })
    dispose()

    host.emit('SIGINT')
    host.emit('SIGTERM')
    host.emit('SIGHUP')

    expect(onInterrupt).not.toHaveBeenCalled()
    expect(onTerminate).not.toHaveBeenCalled()
  })

  it('tolerates handlers that were not given', () => {
    const host = new EventEmitter()

    expect(() => {
      installSignals(host, {})
      host.emit('SIGINT')
      host.emit('SIGTERM')
    }).not.toThrow()
  })
})
