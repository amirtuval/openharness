import { describe, expect, it, vi } from 'vitest'

import {
  PAGE_CURSOR_PREFIX,
  PageCursorSchema,
  PageCursorStringSchema,
  decodePageCursor,
  encodePageCursor,
  isPageCursor,
  tryDecodePageCursor,
} from './pagination'

/**
 * Build a cursor around an arbitrary payload — the hostile input the encoder would never
 * produce. Deliberately not the package's own encoder: this has to stay able to spell
 * something the encoder cannot.
 */
function cursorFor(payload: string): string {
  const bytes = new TextEncoder().encode(payload)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return PAGE_CURSOR_PREFIX + btoa(binary).replaceAll('+', '-').replaceAll('/', '_')
}

describe('page cursors', () => {
  it('round-trips the sequence number', () => {
    for (const seq of [0, 1, 42, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(decodePageCursor(encodePageCursor({ seq }))).toEqual({ seq })
    }
  })

  it('is opaque: it carries the prefix and hides the payload', () => {
    const cursor = encodePageCursor({ seq: 42 })
    expect(cursor.startsWith(PAGE_CURSOR_PREFIX)).toBe(true)
    expect(cursor).not.toContain('42')
    expect(cursor).not.toContain('{')
  })

  it('is URL-safe', () => {
    for (let seq = 0; seq < 500; seq += 1) {
      expect(encodePageCursor({ seq })).toMatch(/^page_[A-Za-z0-9_-]+$/)
    }
  })

  it('rejects a cursor that was not produced here', () => {
    expect(() => decodePageCursor('page_not-base64!')).toThrow(RangeError)
    expect(() => decodePageCursor(cursorFor('{}'))).toThrow(RangeError)
    expect(() => decodePageCursor('nonsense')).toThrow(RangeError)
    expect(() => decodePageCursor('page_')).toThrow(RangeError)
  })

  it('refuses to encode a position that would not decode again', () => {
    // The server writes `next_page` and the client sends it back through
    // `PageCursorStringSchema`; a cursor that cannot be decoded must never be emitted.
    for (const seq of [-1, -0.5, 1.5, NaN, Infinity]) {
      expect(() => encodePageCursor({ seq }), String(seq)).toThrow(RangeError)
    }
    expect(encodePageCursor({ seq: 0 })).toBe(PAGE_CURSOR_PREFIX + 'eyJzZXEiOjB9')
  })

  it('accepts only the canonical spelling of a position', () => {
    const canonical = encodePageCursor({ seq: 1 })
    expect(tryDecodePageCursor(canonical)).toEqual({ seq: 1 })
    // Trailing junk and added padding decode to the same payload but are not what we emit,
    // so they must not mean the same page.
    expect(tryDecodePageCursor(`${canonical}####`)).toBeNull()
    expect(tryDecodePageCursor(`${canonical}=`)).toBeNull()
    expect(PageCursorStringSchema.safeParse(`${canonical}####`).success).toBe(false)
  })

  it('rejects a payload that is not a cursor object', () => {
    const cursor = cursorFor('"a string"')
    expect(() => decodePageCursor(cursor)).toThrow(RangeError)
    const fractional = cursorFor('{"seq":1.5}')
    expect(() => decodePageCursor(fractional)).toThrow(RangeError)
  })

  it('decodes without any Node-only global', () => {
    // The package is imported by the web app. Take `Buffer` away and every cursor path still
    // has to work; `crypto.getRandomValues` in ids.ts is a Web API and stays available.
    vi.stubGlobal('Buffer', undefined)
    try {
      // `Buffer` is not a name this package can even refer to: without `@types/node` it does
      // not exist in the type system, which is the compile-time half of this test.
      const globals = globalThis as { Buffer?: unknown }
      expect(globals.Buffer).toBeUndefined()
      const cursor = encodePageCursor({ seq: 42 })
      expect(PageCursorStringSchema.safeParse(cursor).success).toBe(true)
      expect(decodePageCursor(cursor)).toEqual({ seq: 42 })
      expect(tryDecodePageCursor(cursorFor('"a string"'))).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('has a non-throwing variant', () => {
    expect(tryDecodePageCursor('nope')).toBeNull()
    expect(tryDecodePageCursor(encodePageCursor({ seq: 7 }))).toEqual({ seq: 7 })
  })

  it('guards the cursor shape', () => {
    expect(isPageCursor(encodePageCursor({ seq: 1 }))).toBe(true)
    // The guard is a prefix check only; `page_` alone still decodes to nothing.
    expect(isPageCursor('page_')).toBe(true)
    expect(isPageCursor('3')).toBe(false)
    expect(isPageCursor(7)).toBe(false)
    expect(PageCursorSchema.safeParse({ seq: 1 }).success).toBe(true)
    expect(PageCursorSchema.safeParse({ seq: 1.5 }).success).toBe(false)
  })
})

describe('PageCursorStringSchema', () => {
  it('accepts an encoded cursor and rejects anything else', () => {
    expect(PageCursorStringSchema.safeParse(encodePageCursor({ seq: 3 })).success).toBe(true)
    expect(PageCursorStringSchema.safeParse('3').success).toBe(false)
    expect(PageCursorStringSchema.safeParse(null).success).toBe(false)
  })

  it('rejects a string that only looks like a cursor', () => {
    expect(PageCursorStringSchema.safeParse('page_').success).toBe(false)
    expect(PageCursorStringSchema.safeParse('page_%%%').success).toBe(false)
  })
})
