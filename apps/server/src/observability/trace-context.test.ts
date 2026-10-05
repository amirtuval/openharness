import { describe, expect, it } from 'vitest'

import {
  activeTraceContext,
  parseCloudTraceContext,
  parseTraceContext,
  parseTraceparent,
  runWithTraceContext,
  type TraceContext,
} from './trace-context'

const TRACE = 'a'.repeat(32)
const SPAN = 'b'.repeat(16)

/** A header bag, the way `Headers` answers. */
function headers(entries: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: (name) => lower.get(name.toLowerCase()) ?? null }
}

describe('parseTraceparent', () => {
  it('reads the W3C header, with its sampled flag', () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      sampled: true,
    })
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-00`)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      sampled: false,
    })
  })

  it('ignores a value it cannot read rather than refusing the request', () => {
    expect(parseTraceparent(null)).toBeNull()
    expect(parseTraceparent('')).toBeNull()
    expect(parseTraceparent('not-a-traceparent')).toBeNull()
    // Too short, non-hex, and the spec's all-zero "no trace".
    expect(parseTraceparent(`00-${'a'.repeat(31)}-${SPAN}-01`)).toBeNull()
    expect(parseTraceparent(`00-${'z'.repeat(32)}-${SPAN}-01`)).toBeNull()
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN}-01`)).toBeNull()
  })

  it('tolerates a trailing segment a future version might add', () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01-extra`)).toMatchObject({ traceId: TRACE })
  })
})

describe('parseCloudTraceContext', () => {
  it("reads Google's header, converting the decimal span id to hex", () => {
    expect(parseCloudTraceContext(`${TRACE}/1;o=1`)).toEqual({
      traceId: TRACE,
      spanId: '0000000000000001',
      sampled: true,
    })
    expect(parseCloudTraceContext(`${TRACE}/1234567890`)).toEqual({
      traceId: TRACE,
      // 1234567890 = 0x499602d2
      spanId: '00000000499602d2',
      sampled: false,
    })
  })

  it('accepts a trace without a span id, and rejects a bad one', () => {
    expect(parseCloudTraceContext(TRACE)).toMatchObject({
      traceId: TRACE,
      spanId: '0000000000000000',
    })
    expect(parseCloudTraceContext(null)).toBeNull()
    expect(parseCloudTraceContext('short;o=1')).toBeNull()
    expect(parseCloudTraceContext(`${'0'.repeat(32)}/1`)).toBeNull()
  })
})

describe('parseTraceContext', () => {
  it('prefers traceparent, and falls back to X-Cloud-Trace-Context', () => {
    expect(parseTraceContext(headers({ traceparent: `00-${TRACE}-${SPAN}-01` }))).toMatchObject({
      traceId: TRACE,
      spanId: SPAN,
    })
    expect(parseTraceContext(headers({ 'X-Cloud-Trace-Context': `${TRACE}/5;o=1` }))).toMatchObject(
      { traceId: TRACE, sampled: true },
    )
    expect(
      parseTraceContext(
        headers({
          traceparent: `00-${TRACE}-${SPAN}-00`,
          'x-cloud-trace-context': `${'c'.repeat(32)}/5`,
        }),
      ),
    ).toMatchObject({ traceId: TRACE })
    expect(parseTraceContext(headers({}))).toBeNull()
  })
})

describe('the async context', () => {
  it('is the active context inside `runWithTraceContext`, and nothing outside', async () => {
    const context: TraceContext = { traceId: TRACE, spanId: SPAN, sampled: true }
    expect(activeTraceContext()).toBeUndefined()
    const seen = await runWithTraceContext(context, async () => {
      await Promise.resolve()
      // It survives an await, which is the whole reason it is an AsyncLocalStorage.
      return activeTraceContext()
    })
    expect(seen).toEqual(context)
    expect(activeTraceContext()).toBeUndefined()
  })
})
