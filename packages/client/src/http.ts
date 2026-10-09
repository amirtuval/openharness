import {
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
 *
 * Authentication is the two ways the API accepts (epic #65, A2): every request is sent with
 * `credentials: 'include'`, so a browser carries the web app's session cookie, and a client
 * built with a `token` — the CLI — sends `Authorization: Bearer <token>`. A 401 comes back as
 * an {@link import('./errors').AuthenticationError}.
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
  /** HTTP method. The API reads, creates, replaces and deletes. */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
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

/** A response as it came off the wire, before any interpretation. */
export interface RawResponse {
  /** HTTP status of the answer. */
  readonly status: number
  /** The `statusText` the server gave, when it gave one. */
  readonly statusText: string
  /** The JSON body, or `undefined` when there was none or it was not JSON. */
  readonly body: unknown
  /** The `request-id` header, when the server set one. */
  readonly requestId: string | undefined
}

/** The request layer, as the resources see it. */
export interface Transport {
  /** Hook for tolerated, non-fatal problems. */
  readonly debug: DebugHook

  /** Issue `spec`, then parse the JSON body against `schema`. */
  json<T>(schema: ResponseSchema<T>, spec: RequestSpec): Promise<T>

  /**
   * Issue `spec` and hand back the status and the parsed body as they are, non-2xx included.
   *
   * For the endpoints that do not speak the protocol's error envelope — Better Auth's device
   * flow answers its polling errors as `{ error, error_description }` on a 400 — where the
   * caller has to read the body to tell `authorization_pending` from a real failure.
   */
  rawJson(spec: RequestSpec): Promise<RawResponse>

  /**
   * Issue `spec` for its effect alone. The body is ignored; a non-2xx still throws.
   *
   * For a `DELETE` that answers `204` with no body, where there is nothing to parse.
   */
  noContent(spec: RequestSpec): Promise<void>

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
  /**
   * Session token, sent as `Authorization: Bearer <token>` on every request — the CLI's way
   * in (epic #65, A2). Omitted for the web app, whose session rides the cookie that
   * `credentials: 'include'` attaches.
   */
  token?: string | undefined
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

  /** Issue the request as written; the caller decides what a non-2xx status means. */
  async function fetchResponse(spec: RequestSpec, accept: string): Promise<Response> {
    const url = baseUrl + spec.path + queryString(spec.query)
    return fetchImpl(url, {
      method: spec.method,
      // The web app's session is a cookie: sending it is opt-in on every request, and the SSE
      // stream opts in the same way (the whole reason the stream is `fetch` and not
      // `EventSource`). With no cookie around — the CLI — the header is simply absent.
      credentials: 'include',
      headers: requestHeaders(options.token, spec, accept),
      ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    })
  }

  async function send(spec: RequestSpec, accept: string): Promise<Response> {
    const response = await fetchResponse(spec, accept)
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

    async rawJson(spec: RequestSpec): Promise<RawResponse> {
      // Deliberately not `send`: this is for endpoints whose non-2xx bodies are part of their
      // contract (the device flow's polling errors), so the status decides, not the promise.
      const response = await fetchResponse(spec, JSON_CONTENT_TYPE)
      return {
        status: response.status,
        statusText: response.statusText,
        body: await readJson(response),
        requestId: response.headers.get(REQUEST_ID_HEADER) ?? undefined,
      }
    },

    async noContent(spec: RequestSpec): Promise<void> {
      const response = await send(spec, JSON_CONTENT_TYPE)
      // Drain whatever came with the 2xx (the API answers `204`), so an idle keep-alive
      // connection is not left mid-response.
      await response.text()
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
  token: string | undefined,
  spec: RequestSpec,
  accept: string,
): Record<string, string> {
  const headers: Record<string, string> = { accept }
  if (spec.body !== undefined) {
    headers['content-type'] = JSON_CONTENT_TYPE
  }
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`
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
