import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The trace a request belongs to, as far as its logs are concerned (issue #158).
 *
 * A trace context is the pair Cloud Logging joins on: `traceId` names the trace a log line
 * belongs to, `spanId` the operation within it. Two sources produce one, in this order:
 *
 * 1. the load balancer, which injects a `traceparent` (W3C) or `X-Cloud-Trace-Context`
 *    header on every request it proxies — that is what makes a request's logs and its Cloud
 *    Trace spans the *same* trace as the load balancer's own;
 * 2. the OpenTelemetry span this server opens for the request, when tracing is on
 *    (`tracing.ts`), whose ids continue that trace.
 *
 * It is carried in an {@link AsyncLocalStorage}, so the JSON logger (`logging.ts`) can stamp
 * every line written while a request is being served without the call sites passing anything:
 * a log inside a route handler is joined to the trace its request belongs to for free.
 */

/** The ids a log line is tagged with: a trace, and the operation within it. */
export interface TraceContext {
  /** 32 lowercase hex characters, as W3C and Cloud Trace both spell a trace id. */
  readonly traceId: string
  /** 16 lowercase hex characters — the operation within the trace. */
  readonly spanId: string
  /** Whether the sampler kept this trace; `X-Cloud-Trace-Context`'s `;o=1` or `traceparent`'s flag. */
  readonly sampled: boolean
}

const storage = new AsyncLocalStorage<TraceContext>()

/** The trace context of whatever this call is running inside, or `undefined` outside a request. */
export function activeTraceContext(): TraceContext | undefined {
  return storage.getStore()
}

/** Run `fn` with `context` as the active trace context, for everything it awaits. */
export function runWithTraceContext<T>(context: TraceContext, fn: () => T): T {
  return storage.run(context, fn)
}

/** Anything that can answer a header: a `Headers`, or a test's fake. */
export interface HeaderSource {
  get(name: string): string | null
}

/**
 * The trace context a request carries: `traceparent` first, then `X-Cloud-Trace-Context`.
 *
 * Neither header is trusted for anything but the ids — they name a trace, they do not grant
 * one — so a malformed value is simply ignored (`null`) rather than refused: a client that
 * sends garbage gets no trace on its logs, and nothing else changes. Preferring
 * `traceparent` matches the W3C spec's guidance for a proxy that understands both.
 */
export function parseTraceContext(headers: HeaderSource): TraceContext | null {
  return (
    parseTraceparent(headers.get('traceparent')) ??
    parseCloudTraceContext(headers.get('x-cloud-trace-context'))
  )
}

/** `00-<32 hex trace id>-<16 hex span id>-<2 hex flags>`, the W3C `traceparent` header. */
export function parseTraceparent(value: string | null): TraceContext | null {
  if (value === null) {
    return null
  }
  const parts = value.trim().split('-')
  if (parts.length < 4) {
    return null
  }
  const [version, traceId, spanId, flags] = parts
  if (
    version === undefined ||
    traceId === undefined ||
    spanId === undefined ||
    flags === undefined
  ) {
    return null
  }
  if (!isHex(traceId, 32) || !isHex(spanId, 16)) {
    return null
  }
  // All-zero ids are how the spec spells "no trace"; a request carrying one is not in a trace.
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) {
    return null
  }
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 0x1) === 0x1 }
}

/**
 * `<32 hex trace id>/<span id>[;o=<options>]`, Google's `X-Cloud-Trace-Context`.
 *
 * The span id here is a decimal uint64, not hex (the one place the two spellings differ), and
 * `o=1` marks the trace sampled. Unlike `traceparent`, Google's header has no version segment,
 * and it tolerates a missing span id — a client that only knows the trace.
 */
export function parseCloudTraceContext(value: string | null): TraceContext | null {
  if (value === null) {
    return null
  }
  const [ids, ...options] = value.trim().split(';')
  if (ids === undefined) {
    return null
  }
  const [traceId, spanId] = ids.split('/')
  if (traceId === undefined || !isHex(traceId, 32) || /^0+$/.test(traceId)) {
    return null
  }
  return {
    traceId: traceId.toLowerCase(),
    spanId: decimalSpanIdToHex(spanId),
    sampled: options.some((option) => option.trim().toLowerCase() === 'o=1'),
  }
}

/** Whether `value` is exactly `length` lowercase-or-uppercase hex characters. */
function isHex(value: string, length: number): boolean {
  return value.length === length && /^[0-9a-fA-F]+$/.test(value)
}

/**
 * Google's decimal span id as the 16-hex one Cloud Logging and OpenTelemetry use.
 *
 * `X-Cloud-Trace-Context` carries the span id as a decimal string (a uint64); an absent or
 * unparsable one becomes all zeroes, which is the spec's "no span" and what a Cloud Logging
 * entry without a span looks like.
 */
function decimalSpanIdToHex(value: string | undefined): string {
  if (value === undefined || !/^\d+$/.test(value)) {
    return '0000000000000000'
  }
  try {
    return BigInt(value).toString(16).padStart(16, '0').slice(-16)
  } catch {
    return '0000000000000000'
  }
}
