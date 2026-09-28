import type { StreamEvent } from '@openharness/protocol'

import type { FetchLike } from '../http'
import { sleep } from '../internal/async'

/**
 * Test-only helpers: a `fetch` that answers from a script, responses built by hand, and the
 * collectors the streaming tests need.
 *
 * Nothing here is exported from the package's entry points — it exists so the test files do
 * not each grow their own half of it.
 */

/** One request a {@link MockFetch} saw. */
export interface RecordedRequest {
  /** The full URL, query string included. */
  readonly url: string
  /** The `init` the client passed, when it passed one. */
  readonly init: RequestInit | undefined
  /** The `RequestInit.headers` as a `Headers` object, for readable assertions. */
  readonly headers: Headers
}

/** A `fetch` that records what it was asked for and answers from a handler. */
export interface MockFetch {
  /** The function to hand to `createClient({ fetch })`. */
  readonly fetch: FetchLike
  /** Every request, in order. */
  readonly requests: RecordedRequest[]
  /** The URL of request `index`, failing loudly when there was no such request. */
  urlOf(index: number): string
}

/**
 * Build a mock `fetch`.
 *
 * @param handler called with the recorded request and its 0-based index
 */
export function createMockFetch(
  handler: (request: RecordedRequest, call: number) => Response | Promise<Response>,
): MockFetch {
  const requests: RecordedRequest[] = []
  const mock: MockFetch = {
    fetch: async (input, init) => {
      const request: RecordedRequest = {
        url: input,
        init,
        headers: new Headers(init?.headers),
      }
      requests.push(request)
      return handler(request, requests.length - 1)
    },
    requests,
    urlOf(index) {
      const request = requests[index]
      if (request === undefined) {
        throw new Error(`no request at index ${index}; the mock saw ${requests.length}`)
      }
      return request.url
    },
  }
  return mock
}

/**
 * A JSON response, the way the server writes one.
 *
 * The body goes through a byte stream rather than `new Response(string, …)`: that is what the
 * wire does, and it is the only form that also works in the jsdom test run, where `Buffer` is
 * deliberately missing and undici's string path needs it.
 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(streamBody([JSON.stringify(body)]), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * A non-2xx response carrying the protocol's error envelope.
 *
 * @param status the HTTP status
 * @param type the `error.type` string
 * @param message the `error.message`
 * @param requestId written as `request_id` when given
 */
export function errorResponse(
  status: number,
  type: string,
  message: string,
  requestId?: string,
): Response {
  return jsonResponse(
    {
      type: 'error',
      error: { type, message },
      ...(requestId === undefined ? {} : { request_id: requestId }),
    },
    status,
  )
}

/**
 * An event-stream response whose body arrives in `chunks`.
 *
 * The chunks are the test's: splitting one `data:` line across two of them, or putting a
 * keepalive comment between messages, is how the parser's edge cases are exercised.
 *
 * @param chunks the body pieces, in order
 * @param options `delayMs` between chunks; `failWith` errors the body after the last chunk
 */
export function sseResponse(
  chunks: readonly string[],
  options: { delayMs?: number; failWith?: Error } = {},
): Response {
  return new Response(streamBody(chunks, options), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** A response body delivering `chunks`, then closing — or failing, when asked to. */
function streamBody(
  chunks: readonly string[],
  options: { delayMs?: number; failWith?: Error } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = chunks[index]
      if (chunk === undefined) {
        if (options.failWith !== undefined) {
          controller.error(options.failWith)
        } else {
          controller.close()
        }
        return
      }
      index += 1
      if ((options.delayMs ?? 0) > 0) {
        await sleep(options.delayMs ?? 0)
      }
      try {
        controller.enqueue(encoder.encode(chunk))
      } catch {
        // The consumer cancelled the stream while this pull was waiting.
      }
    },
  })
}

/**
 * Serialize events the way the server writes them, ready to be split into chunks.
 *
 * Stored events get `id: <seq>`, previews do not — the protocol's own spelling.
 *
 * @param events the events to write
 */
export function sseLines(events: readonly StreamEvent[]): string[] {
  return events.map((event) => {
    const id = 'seq' in event ? `id: ${event.seq}\n` : ''
    return `${id}data: ${JSON.stringify(event)}\n\n`
  })
}

/** Every event of an async iterable, until it ends or `stopWhen` says so. */
export async function collect<T>(
  iterable: AsyncIterable<T>,
  options: { stopWhen?: (value: T) => boolean } = {},
): Promise<T[]> {
  const seen: T[] = []
  for await (const value of iterable) {
    seen.push(value)
    if (options.stopWhen?.(value) === true) {
      break
    }
  }
  return seen
}
