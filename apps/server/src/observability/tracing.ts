import type { Logger } from '../types'
import type { TraceContext } from './trace-context'

/**
 * OpenTelemetry tracing, exported to Cloud Trace (issue #158).
 *
 * `OPENHARNESS_TRACING=cloud-trace` turns tracing on; anything else (the default, `off`) uses
 * {@link noopTracer}, whose spans record nothing and whose `enabled` is `false` — so a local
 * dev server neither loads the OpenTelemetry SDK nor pays for it. The SDK, the Cloud Trace
 * exporter and the provider are all pulled in by a dynamic `import()` inside
 * {@link initTracing}, so nothing on the module-load path of an untraced server touches them.
 *
 * ### Which exporter, and why
 *
 * Spans go out through `@google-cloud/opentelemetry-cloud-trace-exporter` — Terraform's own
 * `TraceExporter` — rather than OTLP. The exporter publishes over Cloud Trace's gRPC API and
 * authenticates with Application Default Credentials (Workload Identity on GKE), refreshing
 * the OAuth token itself for the lifetime of the connection. OTLP to Cloud Trace's endpoint
 * would need the bearer token in a static header the OTLP exporter cannot refresh, so a
 * long-running pod's traces would stop once the first token expired; the Cloud Trace exporter
 * is what keeps a pod exporting for weeks without a restart. It is deprecated upstream in
 * favour of OTLP, which is the migration to make once the OTLP exporter can refresh its
 * credentials; until then it is the exporter that actually stays connected.
 *
 * ### The seam
 *
 * {@link Tracer} is the app's whole view of tracing, deliberately smaller than OpenTelemetry's
 * API: {@link createApp} and the session-log tracer take this, so a test injects a recorder
 * and asserts on spans without an SDK, and the no-op path is the same code path as the real one.
 */

/** A span attribute value; the scalar types Cloud Trace accepts. */
export type AttributeValue = string | number | boolean

/** How a span relates to the work around it; only the two this server makes. */
export type SpanKind = 'server' | 'internal'

/** A span, as limited as the server needs: attributes, a status, an error, and an end. */
export interface Span extends TraceContext {
  setAttribute(key: string, value: AttributeValue): void
  /** Record the outcome; `false` marks the span failed (`SpanStatusCode.ERROR`). */
  setStatus(ok: boolean): void
  /** Record an exception on the span, for a failed operation. */
  recordError(error: unknown): void
  end(): void
}

/** What `startSpan` takes. */
export interface StartSpanOptions {
  readonly kind?: SpanKind
  readonly attributes?: Readonly<Record<string, AttributeValue>>
  /**
   * The trace to continue, when the request carried one — the load balancer's `traceparent`
   * or `X-Cloud-Trace-Context`. Absent, the span starts a trace of its own.
   */
  readonly parent?: TraceContext | null
}

/** Where the server sends spans. {@link noopTracer} when tracing is off. */
export interface Tracer {
  /** Whether spans are recorded at all. The no-op tracer answers `false`. */
  readonly enabled: boolean
  startSpan(name: string, options?: StartSpanOptions): Span
  /** Flush what has not been exported yet; resolves immediately when tracing is off. */
  shutdown(): Promise<void>
}

/** The span a disabled tracer hands out: its methods do nothing and its ids are empty. */
const NOOP_SPAN: Span = {
  traceId: '',
  spanId: '',
  sampled: false,
  setAttribute: () => {},
  setStatus: () => {},
  recordError: () => {},
  end: () => {},
}

/** Tracing turned off: no SDK, no exporter, no spans — the default. */
export const noopTracer: Tracer = {
  enabled: false,
  startSpan: () => NOOP_SPAN,
  shutdown: () => Promise.resolve(),
}

/** `OPENHARNESS_TRACING`: where spans go. */
export type TracingMode = 'off' | 'cloud-trace'

/** What {@link initTracing} takes. */
export interface TracingOptions {
  readonly mode: TracingMode
  /** `OPENHARNESS_TRACE_SAMPLE_RATE`: the fraction of root traces kept, 0..1. */
  readonly sampleRate: number
  /** The GCP project to export to; the exporter infers it from ADC when this is absent. */
  readonly projectId?: string | undefined
  /** The `service.name` resource attribute; defaults to `openharness`. */
  readonly serviceName?: string
  readonly logger: Logger
}

/**
 * Build the tracer the configuration asks for.
 *
 * `off` answers {@link noopTracer} without importing anything. `cloud-trace` loads the SDK and
 * the Cloud Trace exporter, registers a `NodeTracerProvider` whose sampler keeps
 * `sampleRate` of root traces (a child always follows its parent's decision, so a sampled
 * request's whole trace is kept), and answers a {@link Tracer} over it. The exporter's own
 * `TraceExporter` authenticates with ADC — Workload Identity on GKE.
 *
 * A failure to load the SDK is logged and answered with {@link noopTracer}: a server that
 * cannot trace is still a server, and a missing exporter must not stop it booting.
 */
export async function initTracing(options: TracingOptions): Promise<Tracer> {
  if (options.mode === 'off') {
    return noopTracer
  }
  try {
    return await cloudTraceTracer(options)
  } catch (error) {
    options.logger.error(
      'tracing could not be initialized; continuing without it',
      error instanceof Error ? error : { error },
    )
    return noopTracer
  }
}

/** Load the SDK and build a tracer exporting to Cloud Trace. */
async function cloudTraceTracer(options: TracingOptions): Promise<Tracer> {
  const [
    { NodeTracerProvider },
    { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler },
    { resourceFromAttributes },
    { TraceExporter },
    { SpanKind: OtelSpanKind, SpanStatusCode, TraceFlags, context, trace },
  ] = await Promise.all([
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/sdk-trace-base'),
    import('@opentelemetry/resources'),
    import('@google-cloud/opentelemetry-cloud-trace-exporter'),
    import('@opentelemetry/api'),
  ])

  const exporter = new TraceExporter(
    options.projectId === undefined ? {} : { projectId: options.projectId },
  )
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': options.serviceName ?? 'openharness',
    }),
    // Sampling is decided at the root and inherited below it, so a kept request keeps its
    // whole trace — its turn and model-request spans included — at `sampleRate` of requests.
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(options.sampleRate) }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  })
  provider.register()
  const otelTracer = provider.getTracer('openharness')
  options.logger.info(
    `tracing: Cloud Trace (sample rate ${options.sampleRate}${options.projectId === undefined ? '' : `, project ${options.projectId}`})`,
  )

  return {
    enabled: true,
    startSpan: (name, startOptions = {}) => {
      const parent = startOptions.parent ?? null
      // A remote parent only when it names a real span; `X-Cloud-Trace-Context` is allowed to
      // carry a trace without one, and an all-zero span id is not a valid OTel parent.
      const parentContext =
        parent !== null && !/^0+$/.test(parent.spanId)
          ? trace.setSpanContext(context.active(), {
              traceId: parent.traceId,
              spanId: parent.spanId,
              traceFlags: parent.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
              isRemote: true,
            })
          : context.active()
      const span = otelTracer.startSpan(
        name,
        {
          kind: startOptions.kind === 'server' ? OtelSpanKind.SERVER : OtelSpanKind.INTERNAL,
          attributes: { ...startOptions.attributes },
        },
        parentContext,
      )
      const ids = span.spanContext()
      return {
        traceId: ids.traceId,
        spanId: ids.spanId,
        sampled: (ids.traceFlags & TraceFlags.SAMPLED) !== 0,
        setAttribute: (key, value) => {
          span.setAttribute(key, value)
        },
        setStatus: (ok) => {
          span.setStatus({ code: ok ? SpanStatusCode.OK : SpanStatusCode.ERROR })
        },
        recordError: (error) => {
          span.recordException(error instanceof Error ? error : new Error(String(error)))
        },
        end: () => {
          span.end()
        },
      }
    },
    shutdown: () => provider.shutdown(),
  }
}
