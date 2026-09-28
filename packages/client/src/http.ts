import {
  API_KEY_HEADER,
  JSON_CONTENT_TYPE,
  LAST_EVENT_ID_HEADER,
  REQUEST_ID_HEADER,
  SSE_CONTENT_TYPE,
} from '@openharness/protocol'

import { ResponseValidationError, apiErrorFromResponse } from './errors'

/**
 * The HTTP layer: one place that builds a request from a method, a path, a query and a body,
 * and one place that turns a response back into a typed value or an error.
 *
 * Everything above it (the resources, the helpers, the event stream) is written in terms of
 * `request`, so headers, the base URL and error handling exist once.
 */

/**
 * The `fetch` signature this client uses: `(url, init) => Response`.
 *
 * The default is the global `fetch`, and the seam is what makes the client testable — pass a
 * mock in {@link import('./client').ClientOptions} and every request goes through it. In the
 * browser the global must be called as `globalThis.fetch(...)`; the client does that, so a
 * bare `globalThis.fetch` reference is fine to pass in.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * A hook for the things the client tolerates instead of throwing on.
 *
 * Today that is one thing: a stream event this client does not recognize — an event type a
 * newer server added. The client drops it and calls the hook, so an old client keeps working
 * against a new server and the drop is still observable in logs.
 */
export type DebugHook = (message: string, detail?: unknown) => void

/**
 * The slice of a zod schema the client needs.
 *
 * Structural on purpose: it keeps `zod` out of this package's dependencies — the schemas come
 * from `@openharness/protocol`, which owns that dependency — and it lets the resources compose
 * a schema with a check zod cannot express (see `sessions.events.send`'s message parser).
 */
export interface ResponseSchema<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } }
}

/** A query parameter value: a scalar written once, or an array written once per item. */
export type QueryValue = string | number | boolean | readonly (string | number | boolean)[]

/** Query parameters, keyed by their wire name (`types[]`, `event_deltas[]`, ...). */
export type QueryParams = Record<string, QueryValue | undefined>

/** Everything the transport needs to issue one request. */
export interface RequestSpec {
  /** HTTP method; the API only reads and creates. */
  method: 'GET' | 'POST'
  /** Path below the base URL, e.g. `/v1/sessions`. */
  path: string
  /** Query parameters; an array value repeats its key. */
  query?: QueryParams
  /** Request body, serialized as JSON. */
  body?: unknown
  /** Caller's cancellation signal. */
  signal?: AbortSignal
  /**
   * The `seq` of the last stored event the caller saw.
   *
   * Only the event stream sets this: it becomes the `last-event-id` request header, the
   * position the server resumes from.
   */
  lastEventId?: number
}

/** The request layer, as the resources see it. */
export interface Transport {
  /** Hook for tolerated, non-fatal problems. */
  readonly debug: DebugHook

  /** Issue `spec`, then parse the JSON body against `schema`. */
  json<T>(schema: ResponseSchema<T>, spec: RequestSpec): Promise<T>

  /**
   * Issue `spec` as an event-stream request and hand back the response body.
   *
   * A non-2xx answer, or a 2xx that is clearly not an event stream, throws here — before the
   * stream opens — so the caller only has to deal with a live `ReadableStream`.
   */
  openEventStream(spec: RequestSpec): Promise<ReadableStream<Uint8Array>>
}

/** Options {@link createTransport} needs; a subset of the client's own options. */
export interface TransportOptions {
  /** Server root, e.g. `https://api.example.com`; a trailing slash is ignored. */
  baseUrl: string
  /** Value of the `x-api-key` header; omitted when the server needs no auth. */
  apiKey?: string | undefined
  /** `fetch` implementation; defaults to the global. */
  fetch?: FetchLike | undefined
  /** Called for events the client skips rather than throws on. */
  debug?: DebugHook | undefined
}

/** Build the transport a client uses for every request. */
export function createTransport(options: TransportOptions): Transport {
  const baseUrl = stripTrailingSlashes(options.baseUrl)
  const fetchImpl = resolveFetch(options.fetch)
  const debug: DebugHook = options.debug ?? (() => {})

  async function send(spec: RequestSpec, accept: string): Promise<Response> {
    const url = baseUrl + spec.path + queryString(spec.query)
    const response = await fetchImpl(url, {
      method: spec.method,
      headers: requestHeaders(options.apiKey, spec, accept),
      ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    })
    if (!response.ok) {
      // The error envelope is JSON; a proxy may answer with something else, which the
      // factory tolerates. Reading the body can itself fail — then there is nothing to
      // report but the status.
      const body = await readJson(response)
      throw apiErrorFromResponse(response.status, body, {
        statusText: response.statusText,
        requestId: response.headers.get(REQUEST_ID_HEADER) ?? undefined,
      })
    }
    return response
  }

  return {
    debug,

    async json<T>(schema: ResponseSchema<T>, spec: RequestSpec): Promise<T> {
      const response = await send(spec, JSON_CONTENT_TYPE)
      const body = await readJson(response)
      return parseBody(schema, body, response.status)
    },

    async openEventStream(spec: RequestSpec): Promise<ReadableStream<Uint8Array>> {
      const response = await send(spec, SSE_CONTENT_TYPE)
      const contentType = response.headers.get('content-type')
      if (contentType !== null && !contentType.toLowerCase().includes(SSE_CONTENT_TYPE)) {
        throw new ResponseValidationError(
          response.status,
          `The server answered with "${contentType}" instead of an event stream.`,
        )
      }
      if (response.body === null) {
        throw new ResponseValidationError(
          response.status,
          'The server opened an event stream with an empty body.',
        )
      }
      return response.body
    },
  }
}

/** Parse a response body against a schema, or throw {@link ResponseValidationError}. */
function parseBody<T>(schema: ResponseSchema<T>, body: unknown, status: number): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new ResponseValidationError(
      status,
      'The server returned a response that does not match the protocol.',
      parsed.error.message,
    )
  }
  return parsed.data
}

/** The headers every request carries, plus the ones only the event stream uses. */
function requestHeaders(
  apiKey: string | undefined,
  spec: RequestSpec,
  accept: string,
): Record<string, string> {
  const headers: Record<string, string> = { accept }
  if (spec.body !== undefined) {
    headers['content-type'] = JSON_CONTENT_TYPE
  }
  if (apiKey !== undefined) {
    headers[API_KEY_HEADER] = apiKey
  }
  if (spec.lastEventId !== undefined) {
    headers[LAST_EVENT_ID_HEADER] = String(spec.lastEventId)
  }
  return headers
}

/**
 * Write query parameters the way the protocol spells them: `types[]=a&types[]=b`.
 *
 * The key is written verbatim — the array spelling lives in the key, and the keys are
 * constants in this package, never caller input — while values are percent-encoded. A
 * `URLSearchParams` would encode the brackets too; both spellings mean the same thing to a
 * server, and the literal one is what the protocol's documentation shows.
 */
function queryString(query: QueryParams | undefined): string {
  if (query === undefined) {
    return ''
  }
  const parts: string[] = []
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue
    }
    for (const item of queryValues(value)) {
      parts.push(`${key}=${encodeURIComponent(String(item))}`)
    }
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`
}

/** A query value as the list of strings to write, one `key=value` pair each. */
function queryValues(value: QueryValue): readonly (string | number | boolean)[] {
  return isQueryArray(value) ? value : [value]
}

/** `Array.isArray` as a type guard, so the narrowed element type survives. */
function isQueryArray(value: QueryValue): value is readonly (string | number | boolean)[] {
  return Array.isArray(value)
}

/** The body as parsed JSON, or `undefined` when the response had no body to parse. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text === '') {
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Strip trailing slashes so a base URL and a path can be concatenated as they are. */
function stripTrailingSlashes(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * The `fetch` to call: the caller's, or the global one, bound to `globalThis`.
 *
 * Browsers refuse a `fetch` called with the wrong receiver ("Illegal invocation"), and the
 * global is a plain function value here, so the default goes through a wrapper rather than
 * passing `globalThis.fetch` around.
 */
function resolveFetch(fetchImpl: FetchLike | undefined): FetchLike {
  if (fetchImpl !== undefined) {
    return fetchImpl
  }
  return (input, init) => globalThis.fetch(input, init)
}
