import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME, PROTOCOL_DEPENDENCY } from './index'

describe('@openharness/hands', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@openharness/hands')
  })

  it('reaches protocol through its built output', () => {
    expect(PROTOCOL_DEPENDENCY).toBe('@openharness/protocol')
  })
})
