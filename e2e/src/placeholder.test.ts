import { PACKAGE_NAME } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

/**
 * Placeholder cross-package test: it runs from the e2e package and consumes a workspace
 * package through its built output, which is what the real cross-package tests will do.
 */
describe('e2e skeleton', () => {
  it('consumes a workspace package through its built exports', () => {
    expect(PACKAGE_NAME).toBe('@openharness/protocol')
  })
})
