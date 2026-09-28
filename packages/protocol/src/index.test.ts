import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME, PlaceholderSchema } from './index'

describe('@openharness/protocol', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@openharness/protocol')
  })

  it('parses the placeholder schema through zod', () => {
    expect(PlaceholderSchema.parse({ placeholder: true })).toEqual({ placeholder: true })
  })
})
