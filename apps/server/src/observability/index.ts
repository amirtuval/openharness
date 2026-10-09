/**
 * Observability (issue #158): the pieces that make a deployment's logs, traces and the alerts
 * over them useful — nothing a route imports.
 *
 * - `logging.ts` — the Cloud Logging JSON logger, and the redaction that keeps a credential
 *   out of a line.
 * - `trace-context.ts` — the trace a request belongs to, carried in an `AsyncLocalStorage` so
 *   logs and spans agree on the ids.
 * - `tracing.ts` — the `Tracer` seam, the no-op, and the OpenTelemetry → Cloud Trace
 *   implementation loaded lazily.
 * - `session-traces.ts` — the session log as spans, and the store wrapper that feeds it.
 */

export {
  REDACTED,
  detailFields,
  isSensitiveKey,
  jsonLogger,
  loggerFor,
  redact,
  redactError,
  type JsonLoggerOptions,
} from './logging'
export {
  activeTraceContext,
  parseCloudTraceContext,
  parseTraceContext,
  parseTraceparent,
  runWithTraceContext,
  type HeaderSource,
  type TraceContext,
} from './trace-context'
export {
  initTracing,
  noopTracer,
  type AttributeValue,
  type Span,
  type SpanKind,
  type StartSpanOptions,
  type Tracer,
  type TracingMode,
  type TracingOptions,
} from './tracing'
export { SessionTraces, withSessionTraces } from './session-traces'
