import { describe, expect, it, vi } from 'vitest'

import {
  PAGE_CURSOR_PREFIX,
  PageCursorSchema,
  PageCursorStringSchema,
  decodePageCursor,
  encodeKeyCursor,
  encodeSeqCursor,
  isPageCursor,
  tryDecodePageCursor,
} from './pagination'

const AGENT_ID = 'agent_01JQZ8R6X9M4V0W7Y2B3C5D6E7'
const SESSION_ID = 'sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E8'
const CREATED_AT = '2026-03-15T10:00:00Z'

const seqCursor = (seq: number) => ({ kind: 'seq', seq }) as const
const keyCursor = (created_at: string, id: string) => ({ kind: 'key', created_at, id }) as const

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
  it('round-trips a sequence position', () => {
    for (const seq of [0, 1, 42, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(decodePageCursor(encodeSeqCursor(seq))).toEqual(seqCursor(seq))
    }
  })

  it('round-trips a keyset position', () => {
    for (const [created_at, id] of [
      [CREATED_AT, AGENT_ID],
      ['2026-03-15T12:00:00+02:00', SESSION_ID],
      ['1970-01-01T00:00:00Z', 'sesn_00000000000000000000000000'],
    ] as const) {
      expect(decodePageCursor(encodeKeyCursor({ created_at, id }))).toEqual(
        keyCursor(created_at, id),
      )
    }
  })

  it('encodes only the position out of a resource handed to it', () => {
    const session: { created_at: string; id: string; title: string; type: string } = {
      id: SESSION_ID,
      type: 'session',
      title: 'README summary',
      created_at: CREATED_AT,
    }
    expect(encodeKeyCursor(session)).toBe(
      encodeKeyCursor({ created_at: CREATED_AT, id: SESSION_ID }),
    )
    expect(decodePageCursor(encodeKeyCursor(session))).toEqual(keyCursor(CREATED_AT, SESSION_ID))
  })

  it('is opaque: it carries the prefix and hides the payload', () => {
    const cursor = encodeSeqCursor(42)
    expect(cursor.startsWith(PAGE_CURSOR_PREFIX)).toBe(true)
    expect(cursor).not.toContain('42')
    expect(cursor).not.toContain('{')
    expect(encodeKeyCursor({ created_at: CREATED_AT, id: AGENT_ID })).not.toContain(AGENT_ID)
  })

  it('is URL-safe', () => {
    for (let seq = 0; seq < 500; seq += 1) {
      expect(encodeSeqCursor(seq)).toMatch(/^page_[A-Za-z0-9_-]+$/)
    }
    for (const id of [AGENT_ID, SESSION_ID, 'a'.repeat(200)]) {
      expect(encodeKeyCursor({ created_at: CREATED_AT, id })).toMatch(/^page_[A-Za-z0-9_-]+$/)
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
      expect(() => encodeSeqCursor(seq), String(seq)).toThrow(RangeError)
    }
    for (const position of [
      { created_at: 'yesterday', id: AGENT_ID },
      { created_at: '2026-03-15', id: AGENT_ID },
      { created_at: CREATED_AT, id: '' },
    ]) {
      expect(() => encodeKeyCursor(position), JSON.stringify(position)).toThrow(RangeError)
    }
  })

  it('writes a fixed spelling for a position', () => {
    // Pinned literals, so a change to the payload or to the base64 alphabet is caught here
    // rather than by the canonical-form check below, which would happily agree with itself.
    expect(encodeSeqCursor(0)).toBe(PAGE_CURSOR_PREFIX + 'eyJraW5kIjoic2VxIiwic2VxIjowfQ')
    expect(encodeKeyCursor({ created_at: CREATED_AT, id: AGENT_ID })).toBe(
      PAGE_CURSOR_PREFIX +
        'eyJraW5kIjoia2V5IiwiY3JlYXRlZF9hdCI6IjIwMjYtMDMtMTVUMTA6MDA6MDBaIiwiaWQiOiJhZ2VudF8wMUpRWjhSNlg5TTRWMFc3WTJCM0M1RDZFNyJ9',
    )
  })

  it('accepts only the canonical spelling of a position', () => {
    for (const cursor of [
      encodeSeqCursor(1),
      encodeKeyCursor({ created_at: CREATED_AT, id: SESSION_ID }),
    ]) {
      expect(tryDecodePageCursor(cursor)).not.toBeNull()
      // Trailing junk and added padding decode to the same payload but are not what we emit,
      // so they must not mean the same page.
      expect(tryDecodePageCursor(`${cursor}####`)).toBeNull()
      expect(tryDecodePageCursor(`${cursor}=`)).toBeNull()
      expect(PageCursorStringSchema.safeParse(`${cursor}####`).success).toBe(false)
    }
  })

  it('refuses a position spelled any way but the canonical one', () => {
    // Not junk: each of these parses to exactly the position its canonical cursor carries.
    // The rule is re-encoding, so a reordered key or an extra space — a spelling the encoder
    // would never write — must not decode to the page the canonical spelling names.
    for (const payload of [
      '{"seq":1,"kind":"seq"}',
      '{"kind": "seq", "seq": 1}',
      `{"created_at":"${CREATED_AT}","id":"${SESSION_ID}","kind":"key"}`,
    ]) {
      expect(tryDecodePageCursor(cursorFor(payload)), payload).toBeNull()
      expect(PageCursorStringSchema.safeParse(cursorFor(payload)).success).toBe(false)
    }
  })

  it('rejects a payload that is not a cursor object', () => {
    for (const payload of [
      '"a string"',
      // Pre-keyset cursors carried a bare `seq`; there is no migration, the format is opaque.
      '{"seq":1}',
      '{"kind":"seq","seq":1.5}',
      // A keyset cursor missing half of its position is not a position.
      `{"kind":"key","created_at":"${CREATED_AT}"}`,
      '{"kind":"offset","offset":3}',
    ]) {
      expect(() => decodePageCursor(cursorFor(payload)), payload).toThrow(RangeError)
    }
  })

  it('has a non-throwing variant', () => {
    expect(tryDecodePageCursor('nope')).toBeNull()
    expect(tryDecodePageCursor(encodeSeqCursor(7))).toEqual(seqCursor(7))
    expect(tryDecodePageCursor(encodeKeyCursor({ created_at: CREATED_AT, id: AGENT_ID }))).toEqual(
      keyCursor(CREATED_AT, AGENT_ID),
    )
  })

  it('decodes without any Node-only global', () => {
    // The package is imported by the web app. Take `Buffer` away and every cursor path still
    // has to work; `crypto.getRandomValues` in ids.ts is a Web API and stays available.
    // `Buffer` is not a name this package can even refer to: without `@types/node` it does
    // not exist in the type system, which is the compile-time half of this rule.
    vi.stubGlobal('Buffer', undefined)
    try {
      // The runtime half is not "the global is gone" — that would only prove the stub landed.
      // It is what any code path that reached for the global would hit: a `Buffer`-using
      // expression, typed as if the global were there, fails under the stub. The round trips
      // below only pass because none of them referenced it.
      const asIfPresent = globalThis as unknown as { Buffer: { from(value: string): unknown } }
      expect(() => asIfPresent.Buffer.from('x')).toThrow(TypeError)
      for (const cursor of [
        encodeSeqCursor(42),
        encodeKeyCursor({ created_at: CREATED_AT, id: SESSION_ID }),
      ]) {
        expect(PageCursorStringSchema.safeParse(cursor).success).toBe(true)
        expect(tryDecodePageCursor(cursor)).not.toBeNull()
      }
      expect(decodePageCursor(encodeSeqCursor(0))).toEqual(seqCursor(0))
      expect(decodePageCursor(encodeKeyCursor({ created_at: CREATED_AT, id: AGENT_ID }))).toEqual(
        keyCursor(CREATED_AT, AGENT_ID),
      )
      expect(tryDecodePageCursor(cursorFor('"a string"'))).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('guards the cursor shape', () => {
    expect(isPageCursor(encodeSeqCursor(1))).toBe(true)
    // The guard is a prefix check only; `page_` alone still decodes to nothing.
    expect(isPageCursor('page_')).toBe(true)
    expect(isPageCursor('3')).toBe(false)
    expect(isPageCursor(7)).toBe(false)
    expect(PageCursorSchema.safeParse(seqCursor(1)).success).toBe(true)
    expect(PageCursorSchema.safeParse(keyCursor(CREATED_AT, AGENT_ID)).success).toBe(true)
    expect(PageCursorSchema.safeParse({ seq: 1 }).success).toBe(false)
    expect(PageCursorSchema.safeParse(seqCursor(1.5)).success).toBe(false)
    expect(PageCursorSchema.safeParse(keyCursor(CREATED_AT, '')).success).toBe(false)
    expect(PageCursorSchema.safeParse({ kind: 'key', created_at: CREATED_AT }).success).toBe(false)
  })
})

describe('PageCursorStringSchema', () => {
  it('accepts an encoded cursor of either kind and rejects anything else', () => {
    expect(PageCursorStringSchema.safeParse(encodeSeqCursor(3)).success).toBe(true)
    expect(
      PageCursorStringSchema.safeParse(encodeKeyCursor({ created_at: CREATED_AT, id: AGENT_ID }))
        .success,
    ).toBe(true)
    expect(PageCursorStringSchema.safeParse('3').success).toBe(false)
    expect(PageCursorStringSchema.safeParse(null).success).toBe(false)
  })

  it('rejects a string that only looks like a cursor', () => {
    expect(PageCursorStringSchema.safeParse('page_').success).toBe(false)
    expect(PageCursorStringSchema.safeParse('page_%%%').success).toBe(false)
  })
})
