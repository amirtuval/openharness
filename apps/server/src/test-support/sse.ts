import { type StreamEvent, StreamEventSchema } from '@openharness/protocol'

/**
 * A small SSE reader, for tests that follow a real event stream.
 *
 * `@openharness/client` does this properly, and the server may not depend on it —
 * `yarn check:deps` says so — so this is the least a test needs: `data:` lines, `id:` lines,
 * comments ignored, messages dispatched on the blank line that ends them. It is the same
 * wire format `packages/client`'s parser implements, written small.
 */

/** One message off the wire: its `id` field (the `seq`), and the event it carried. */
export interface SseMessage {
  /** The `id:` field verbatim, or `null` when the message carried none. */
  readonly id: string | null
  /** The parsed event. */
  readonly event: StreamEvent
}

/** A stream being followed: pull messages, or close it. */
export interface SseReader extends AsyncIterable<SseMessage> {
  /**
   * The next message, or `null` when the stream ended.
   *
   * Rejects when the server wrote something that is not a `StreamEvent` (a frame the
   * protocol does not allow), or when none arrived in time. A malformed frame ends the read
   * as well: everything after it is unread.
   */
  next(timeoutMs?: number): Promise<SseMessage | null>
  /** Stop reading; the connection is dropped. */
  close(): void
}

/** How long {@link SseReader.next} waits for a message before it gives up. */
const DEFAULT_TIMEOUT_MS = 5000

/**
 * Read an SSE response body message by message.
 *
 * @param response the response of a stream request
 */
export function openSse(response: Response): SseReader {
  if (response.body === null) {
    throw new Error('the stream response has no body')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const messages: SseMessage[] = []
  const waiters: ((message: SseMessage | null) => void)[] = []
  let buffer = ''
  let ended = false
  /**
   * A message the server wrote that is not a `StreamEvent`.
   *
   * Kept rather than thrown from the reading loop: a parse failure is the *server's* bug, and
   * a test has to see it as that. Swallowing it — which is what a reader that only ends its
   * stream would do — reports "the stream ended" for what is really an invalid frame.
   */
  let malformed: Error | null = null

  const push = (message: SseMessage | null): void => {
    const waiter = waiters.shift()
    if (waiter === undefined) {
      if (message !== null) {
        messages.push(message)
      }
    } else {
      waiter(message)
    }
  }

  const finish = (): void => {
    if (ended) {
      return
    }
    ended = true
    while (waiters.length > 0) {
      waiters.shift()?.(null)
    }
  }

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const end = buffer.indexOf('\n\n')
          if (end === -1) {
            break
          }
          const raw = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          let message: SseMessage | null
          try {
            message = parseMessage(raw)
          } catch (error) {
            // The frame is the story here, not the error: `data:` is what the server wrote.
            malformed =
              error instanceof Error
                ? new Error(`the server wrote a message that is not a stream event: ${raw}`, {
                    cause: error,
                  })
                : new Error(String(error))
            break
          }
          if (message !== null) {
            push(message)
          }
        }
        if (malformed !== null) {
          break
        }
      }
    } catch {
      // A test that dropped the connection on purpose: the reader ends, nothing to report.
    } finally {
      finish()
    }
  })()

  const next = (timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SseMessage | null> => {
    const buffered = messages.shift()
    if (buffered !== undefined) {
      return Promise.resolve(buffered)
    }
    if (malformed !== null) {
      return Promise.reject(malformed)
    }
    if (ended) {
      return Promise.resolve(null)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(malformed ?? new Error(`no SSE message within ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref()
      waiters.push((message) => {
        clearTimeout(timer)
        if (message === null && malformed !== null) {
          reject(malformed)
          return
        }
        resolve(message)
      })
    })
  }

  return {
    next,
    close: () => {
      void reader.cancel().catch(() => {})
      finish()
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const message = await next()
        if (message === null) {
          return
        }
        yield message
      }
    },
  }
}

/** Read every message until the server ends the stream. */
export async function collectSse(response: Response): Promise<SseMessage[]> {
  const reader = openSse(response)
  const collected: SseMessage[] = []
  for await (const message of reader) {
    collected.push(message)
  }
  return collected
}

/** Parse one raw SSE message; `null` for a message that carried no `data`. */
function parseMessage(raw: string): SseMessage | null {
  let id: string | null = null
  const data: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) {
      continue
    }
    const colon = line.indexOf(':')
    if (colon === -1) {
      continue
    }
    const field = line.slice(0, colon)
    const value = line.slice(colon + 1).replace(/^ /, '')
    if (field === 'id') {
      id = value
    } else if (field === 'data') {
      data.push(value)
    }
  }
  if (data.length === 0) {
    return null
  }
  const payload: unknown = JSON.parse(data.join('\n'))
  return { id, event: StreamEventSchema.parse(payload) }
}
