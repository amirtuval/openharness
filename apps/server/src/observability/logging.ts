import { consoleLogger, type Logger } from '../types'
import { activeTraceContext } from './trace-context'

/**
 * Structured JSON logging for Cloud Logging (issue #158).
 *
 * With `OPENHARNESS_LOG_FORMAT=json` the server writes one JSON object per line to stdout, in
 * the shape Google Cloud Logging reads without a parser of its own:
 *
 * ```json
 * {"severity":"INFO","message":"…","time":"2026-…Z",
 *  "logging.googleapis.com/trace":"projects/<project>/traces/<traceId>",
 *  "logging.googleapis.com/spanId":"<spanId>","…structured fields…"}
 * ```
 *
 * `severity` is Cloud Logging's vocabulary (`DEBUG`/`INFO`/`WARNING`/`ERROR`) rather than the
 * `Logger` method names, `time` is RFC 3339, and the two `logging.googleapis.com/*` keys are
 * what join a line to the trace it belongs to: the ids come from the request's trace context
 * ({@link activeTraceContext}), so a log written while a request is served lands in the same
 * trace as its Cloud Trace spans.
 *
 * A `detail` object is merged into the line, so the fields a call site passes (`session_id`,
 * `path`, …) are top-level keys Cloud Logging indexes. Dev keeps the readable one-line format:
 * `main.ts` builds this logger only when the format says `json`.
 *
 * **Nothing sensitive is ever written.** {@link redact} drops the value of any field whose
 * name says it holds a credential — `Authorization`, `Cookie`, `*_SECRET`, `*_TOKEN`,
 * `*_API_KEY`, passwords — before the line is serialized, because the alternative (a token in
 * the log) is a credential leak the log cannot take back. It is a guard on top of the brain's
 * own `redactSecret`, not a replacement for it.
 */

/** What a redacted value is replaced with; greppable on purpose. */
export const REDACTED = '[REDACTED]'

/**
 * The {@link Logger} `OPENHARNESS_LOG_FORMAT` asks for: the Cloud Logging JSON one for `json`,
 * and the readable console one otherwise (dev, docker compose and the tests).
 *
 * @param format the configured format
 * @param projectId the project a trace id is qualified with, when one is known
 */
export function loggerFor(format: 'text' | 'json', projectId?: string): Logger {
  return format === 'json' ? jsonLogger({ projectId }) : consoleLogger
}

/**
 * Field names whose value never reaches the log, matched on the normalized name.
 *
 * Normalization lowercases the name and drops every non-alphanumeric character, so `api_key`,
 * `apiKey`, `x-api-key` and `APIKEY` are one name. A name is sensitive when it *is* a marker,
 * starts with one or ends with one — never when it merely contains one, so `input_tokens` and
 * `output_tokens` (the model usage counters) are logged while `access_token` is not.
 */
const SENSITIVE_MARKERS = [
  'authorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'secret',
  'secrets',
  'secretskey',
  'token',
  'apikey',
  'apisecret',
  'credential',
  'credentials',
  'privatekey',
  'bearer',
] as const

/** Whether a field name says its value is a credential. */
export function isSensitiveKey(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  return SENSITIVE_MARKERS.some(
    (marker) =>
      normalized === marker || normalized.startsWith(marker) || normalized.endsWith(marker),
  )
}

/**
 * A value with every sensitive field redacted, ready to serialize.
 *
 * Objects are walked (arrays and nested objects included), an `Error` becomes its name,
 * message and stack, and a cyclic value is cut rather than allowed to throw out of a log call
 * — a logger must never be the thing that breaks a request.
 */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (value instanceof Error) {
    return redactError(value)
  }
  if (seen.has(value)) {
    return '[Circular]'
  }
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen))
  }
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(entry, seen)
  }
  return out
}

/** An `Error` as the fields a log line wants, with its stack. */
export function redactError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  }
}

/**
 * A `detail` value as the top-level fields of a log line.
 *
 * An object is spread into the line, so its keys are Cloud Logging's; anything else (a string,
 * a number, an array) has no keys to spread and goes under `detail`; an `Error` goes under
 * `error`, so its stack is not confused with the line's own `message`.
 */
export function detailFields(detail: unknown): Record<string, unknown> {
  if (detail === undefined) {
    return {}
  }
  if (detail instanceof Error) {
    return { error: redactError(detail) }
  }
  if (typeof detail === 'object' && detail !== null && !Array.isArray(detail)) {
    return redact(detail) as Record<string, unknown>
  }
  return { detail: redact(detail) }
}

/** Cloud Logging's severity names, by {@link Logger} method. */
const SEVERITY = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
} as const

/** How {@link jsonLogger} is built; every field is optional and every one is for a test. */
export interface JsonLoggerOptions {
  /**
   * The GCP project a trace id belongs to, from `GOOGLE_CLOUD_PROJECT` when the environment
   * sets it. Absent, the trace field is the bare trace id and Cloud Logging resolves it
   * against the log entry's own project — which is the same project the pod runs in.
   */
  readonly projectId?: string
  /** Where a line goes; defaults to stdout, one line per write. */
  readonly write?: (line: string) => void
  /** The clock, for a test that wants a fixed `time`. */
  readonly now?: () => Date
}

/**
 * A {@link Logger} that writes Cloud Logging's JSON, one object per line.
 *
 * @param options the project id, the sink and the clock; see {@link JsonLoggerOptions}
 */
export function jsonLogger(options: JsonLoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(line))
  const now = options.now ?? (() => new Date())
  const emit = (severity: string, message: string, detail?: unknown): void => {
    const line: Record<string, unknown> = {
      severity,
      message,
      time: now().toISOString(),
      ...traceFields(options.projectId),
      ...detailFields(detail),
    }
    write(`${safeStringify(line)}\n`)
  }
  return {
    debug: (message, detail) => emit(SEVERITY.debug, message, detail),
    info: (message, detail) => emit(SEVERITY.info, message, detail),
    warn: (message, detail) => emit(SEVERITY.warn, message, detail),
    error: (message, detail) => emit(SEVERITY.error, message, detail),
  }
}

/** The two `logging.googleapis.com/*` keys for the active trace, or nothing outside a trace. */
function traceFields(projectId: string | undefined): Record<string, unknown> {
  const context = activeTraceContext()
  if (context === undefined) {
    return {}
  }
  const fields: Record<string, unknown> = {
    'logging.googleapis.com/trace':
      projectId === undefined || projectId === ''
        ? context.traceId
        : `projects/${projectId}/traces/${context.traceId}`,
  }
  // An all-zero span id is the "no span" spelling (`X-Cloud-Trace-Context` without one);
  // tagging a line with it would point at an operation that does not exist.
  if (!/^0+$/.test(context.spanId)) {
    fields['logging.googleapis.com/spanId'] = context.spanId
  }
  return fields
}

/** `JSON.stringify` that cannot throw out of a log call. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ severity: 'ERROR', message: 'a log line could not be serialized' })
  }
}
