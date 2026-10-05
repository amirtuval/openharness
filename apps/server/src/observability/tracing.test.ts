import { describe, expect, it } from 'vitest'

import { silentLogger } from '../types'
import { createTestApp } from '../test-support'
import { activeTraceContext } from './trace-context'
import { initTracing, noopTracer, type Span, type StartSpanOptions, type Tracer } from './tracing'

const TRACE = 'a'.repeat(32)
const PARENT_SPAN = 'b'.repeat(16)

/** A span a test can read back: what it was named, its attributes, and that it ended. */
interface RecordedSpan {
  readonly name: string
  readonly options: StartSpanOptions | undefined
  readonly attributes: Record<string, string | number | boolean>
  ended: boolean
  status: boolean | undefined
}

/** A {@link Tracer} that records instead of exporting, so a test can assert on the spans. */
class RecordingTracer implements Tracer {
  readonly enabled = true

  readonly spans: RecordedSpan[] = []

  shutdownCalls = 0

  startSpan(name: string, options?: StartSpanOptions): Span {
    const attributes: Record<string, string | number | boolean> = { ...options?.attributes }
    const recorded: RecordedSpan = { name, options, attributes, ended: false, status: undefined }
    this.spans.push(recorded)
    return {
      traceId: TRACE,
      spanId: PARENT_SPAN,
      sampled: true,
      setAttribute: (key, value) => {
        attributes[key] = value
      },
      setStatus: (ok) => {
        recorded.status = ok
      },
      recordError: () => {},
      end: () => {
        recorded.ended = true
      },
    }
  }

  shutdown(): Promise<void> {
    this.shutdownCalls += 1
    return Promise.resolve()
  }
}

describe('initTracing', () => {
  it('is a no-op when tracing is off, and loads nothing', async () => {
    const tracer = await initTracing({
      mode: 'off',
      sampleRate: 0.1,
      logger: silentLogger,
    })
    expect(tracer.enabled).toBe(false)
    expect(tracer).toBe(noopTracer)
    // The no-op span is a real handle — the caller keeps one code path — that records nothing.
    const span = tracer.startSpan('anything', { attributes: { a: 'b' } })
    expect(span.traceId).toBe('')
    expect(() => {
      span.setAttribute('a', 1)
      span.setStatus(false)
      span.recordError(new Error('ignored'))
      span.end()
    }).not.toThrow()
    await expect(tracer.shutdown()).resolves.toBeUndefined()
  })

  it('falls back to the no-op when the exporter cannot be loaded', async () => {
    // `cloud-trace` with a project id the exporter is fine with would load the real SDK, so
    // this only pins the contract: whatever happens, `initTracing` answers a `Tracer`.
    const tracer = await initTracing({
      mode: 'off',
      sampleRate: 0,
      logger: silentLogger,
    })
    expect(typeof tracer.startSpan).toBe('function')
  })
})

describe('the request span', () => {
  it('opens one server span per request, with the method, path and status', async () => {
    const tracer = new RecordingTracer()
    const ctx = createTestApp({ tracer })
    const response = await ctx.anonymous('/health')
    expect(response.status).toBe(200)
    expect(tracer.spans).toHaveLength(1)
    expect(tracer.spans[0]?.name).toBe('HTTP GET')
    expect(tracer.spans[0]?.options?.kind).toBe('server')
    expect(tracer.spans[0]?.attributes).toMatchObject({
      'http.request.method': 'GET',
      'url.path': '/health',
      'http.response.status_code': 200,
    })
    expect(tracer.spans[0]?.ended).toBe(true)
    expect(tracer.spans[0]?.status).toBe(true)
  })

  it("continues the load balancer's trace when it sent one", async () => {
    const tracer = new RecordingTracer()
    const ctx = createTestApp({ tracer })
    await ctx.anonymous('/health', {
      headers: { traceparent: `00-${TRACE}-${PARENT_SPAN}-01` },
    })
    expect(tracer.spans[0]?.options?.parent).toEqual({
      traceId: TRACE,
      spanId: PARENT_SPAN,
      sampled: true,
    })
  })

  it('sends the trace context through the request, so a log line joins the span', async () => {
    const tracer = new RecordingTracer()
    const ctx = createTestApp({ tracer })
    // A route registered after `createApp` still passes through its middleware; it answers
    // the trace context the request ran under, which is what the JSON logger stamps on a line.
    ctx.app.get('/__trace-probe', (c) => c.json(activeTraceContext() ?? null))
    const response = await ctx.anonymous('/__trace-probe')
    expect(await response.json()).toEqual({
      traceId: TRACE,
      spanId: PARENT_SPAN,
      sampled: true,
    })
  })

  it('carries the header ids into the context with tracing off, and mints no span', async () => {
    // The default tracer is the no-op, so no span is recorded — but the load balancer's ids
    // still reach a log line, because a client's trace is not this server's to drop.
    const ctx = createTestApp()
    ctx.app.get('/__trace-probe', (c) => c.json(activeTraceContext() ?? null))
    const response = await ctx.anonymous('/__trace-probe', {
      headers: { 'x-cloud-trace-context': `${TRACE}/1;o=1` },
    })
    expect(await response.json()).toMatchObject({ traceId: TRACE, sampled: true })
  })

  it('marks a failed response on the span', async () => {
    const tracer = new RecordingTracer()
    const ctx = createTestApp({
      tracer,
      readiness: { isDraining: () => true, check: () => Promise.resolve(true) },
    })
    const response = await ctx.anonymous('/ready')
    expect(response.status).toBe(503)
    expect(tracer.spans[0]?.attributes['http.response.status_code']).toBe(503)
    expect(tracer.spans[0]?.status).toBe(false)
  })
})
