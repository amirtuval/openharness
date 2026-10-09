/**
 * A Server-Sent Events parser over a `ReadableStream`, per the WHATWG EventSource grammar.
 *
 * `fetch` rather than `EventSource` is the point: `EventSource` cannot set request headers,
 * and the CLI authenticates with `Authorization: Bearer`. What the protocol puts in the
 * stream is one JSON `StreamEvent` per `data:` line; everything below is the transport's
 * business, not the client's.
 *
 * The wire, from the protocol:
 *
 * - each message has `data:` — the JSON event;
 * - stored events also carry `id: <seq>`, stream-only previews carry no `id`;
 * - a line starting with `:` is a comment (the server's keepalive) and is ignored.
 */

/** One dispatched SSE message: the fields this API uses, defaults already applied. */
export interface SseMessage {
  /**
   * The `id:` field, verbatim, or `null` when the message carried none.
   *
   * The protocol puts the stored event's `seq` here, which is what makes it the resume
   * position; the client reads the `seq` out of the parsed event instead, so this is for
   * callers that want the wire field itself.
   */
  id: string | null
  /** The `event:` field; this API does not use it and leaves it `null`. */
  event: string | null
  /** The message's `data:` lines, joined with `\n`. */
  data: string
}

/**
 * Parse an SSE byte stream into messages.
 *
 * Lines are assembled across chunk boundaries, so a message may arrive in any number of
 * chunks and a field may be split anywhere — including inside a `\r\n`, which is why a
 * trailing `\r` is held back until the next chunk can disambiguate it.
 *
 * Nothing is dispatched at the end of the stream: per the spec an event is only delivered by
 * its terminating blank line, so a connection that dies mid-message leaves no half-event
 * behind. What the message contained is then re-sent on the next connection anyway, because
 * the client resumes from the last `seq` it saw.
 *
 * @param body the response body of an event-stream request
 * @returns every complete message, in arrival order
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let firstChunk = true
  const state = new SseMessageState()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        // The stream is over, so a trailing `\r` can no longer be the first half of a `\r\n`
        // and terminates the line it ends. Whatever is left below that has no terminator is
        // an event the server never finished, and the spec says to drop it: the same event,
        // whole, arrives on the next connection.
        for (;;) {
          const line = takeLine(buffer, true)
          if (line === null) {
            break
          }
          buffer = line.rest
          const message = state.consumeLine(line.line)
          if (message !== null) {
            yield message
          }
        }
        break
      }
      buffer += decoder.decode(value, { stream: true })
      if (firstChunk) {
        // A byte order mark before the first field is part of the encoding, not the stream.
        buffer = buffer.replace(/^\uFEFF/, '')
        firstChunk = false
      }
      for (;;) {
        const line = takeLine(buffer, false)
        if (line === null) {
          break
        }
        buffer = line.rest
        const message = state.consumeLine(line.line)
        if (message !== null) {
          yield message
        }
      }
    }
  } finally {
    // Ends the response body, which closes the connection; without it an aborted iteration
    // would leave the socket open until the server noticed.
    try {
      await reader.cancel()
    } catch {
      // The stream is already gone; there is nothing left to cancel.
    }
  }
}

/**
 * Split the first complete line off `buffer`, or `null` when it holds no complete line yet.
 *
 * @param buffer the text read so far
 * @param atEof whether the stream has ended, in which case a trailing `\r` does terminate the
 *   line it ends instead of waiting for a `\n` that can no longer arrive
 */
function takeLine(buffer: string, atEof: boolean): { line: string; rest: string } | null {
  for (let index = 0; index < buffer.length; index += 1) {
    const code = buffer.charCodeAt(index)
    if (code === 0x0a) {
      // \n
      return { line: buffer.slice(0, index), rest: buffer.slice(index + 1) }
    }
    if (code === 0x0d) {
      // \r, and \r\n counts as one terminator. A \r at the very end of the buffer may still
      // be the first half of a \r\n, so the next chunk decides — unless there is no next
      // chunk.
      if (index === buffer.length - 1 && !atEof) {
        return null
      }
      const skip = buffer.charCodeAt(index + 1) === 0x0a ? 2 : 1
      return { line: buffer.slice(0, index), rest: buffer.slice(index + skip) }
    }
  }
  return null
}

/**
 * The field buffer of one message, per the EventSource processing model.
 *
 * A message is assembled from `field: value` lines and dispatched by a blank line. Unknown
 * fields (`retry`, anything else) are recorded and ignored, which is what the spec asks for.
 */
class SseMessageState {
  #data: string[] = []
  #event: string | null = null
  #id: string | null = null

  /**
   * Feed one line.
   *
   * @param line a line with its terminator removed
   * @returns the message to dispatch, or `null` when the line did not complete one
   */
  consumeLine(line: string): SseMessage | null {
    if (line === '') {
      return this.#dispatch()
    }
    if (line.startsWith(':')) {
      // A comment. The server uses these as keepalives; there is nothing to do about them.
      return null
    }
    const { field, value } = splitField(line)
    if (field === 'data') {
      this.#data.push(value)
    } else if (field === 'event') {
      this.#event = value
    } else if (field === 'id') {
      // The spec leaves an `id` containing a NUL byte alone; so does this parser.
      if (!value.includes('\u0000')) {
        this.#id = value
      }
    }
    return null
  }

  /** Hand out the buffered message, if it has data, and start a new one. */
  #dispatch(): SseMessage | null {
    if (this.#data.length === 0) {
      // A message with no `data` never dispatches; an `id`-only line is how a server moves
      // the resume position without sending anything.
      this.#event = null
      this.#id = null
      return null
    }
    const message: SseMessage = {
      id: this.#id,
      event: this.#event,
      data: this.#data.join('\n'),
    }
    this.#data = []
    this.#event = null
    this.#id = null
    return message
  }
}

/**
 * Split `name: value` at the first colon; a line without one is a field with an empty value,
 * and exactly one space after the colon is part of the syntax rather than the value.
 */
function splitField(line: string): { field: string; value: string } {
  const colon = line.indexOf(':')
  if (colon === -1) {
    return { field: line, value: '' }
  }
  const value = line.slice(colon + 1)
  return { field: line.slice(0, colon), value: value.startsWith(' ') ? value.slice(1) : value }
}
