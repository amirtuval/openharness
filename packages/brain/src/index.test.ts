import { describe, expect, it } from 'vitest'
import { DEPENDENCIES, PACKAGE_NAME } from './index'

describe('@openharness/brain', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@openharness/brain')
  })

  it('reaches protocol, session and hands through their built output', () => {
    expect(DEPENDENCIES).toEqual([
      '@openharness/protocol',
      '@openharness/session',
      '@openharness/hands',
    ])
  })
})
