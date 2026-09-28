import { describe, expect, it } from 'vitest'

import { parseSseStream, type SseMessage } from './sse'

/** Parse a body written as a list of chunks, the way the network delivers it. */
async function parseChunks(chunks: readonly string[]): Promise<SseMessage[]> {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  const messages: SseMessage[] = []
  for await (const message of parseSseStream(body)) {
    messages.push(message)
  }
  return messages
}

/** Parse a body delivered as one chunk. */
function parse(body: string): Promise<SseMessage[]> {
  return parseChunks([body])
}

describe('parseSseStream', () => {
  it('parses one message per blank line', async () => {
    const messages = await parse('data: {"n":1}\n\ndata: {"n":2}\n\n')

    expect(messages).toEqual([
      { id: null, event: null, data: '{"n":1}' },
      { id: null, event: null, data: '{"n":2}' },
    ])
  })

  it('carries the id and event fields of a message', async () => {
    const messages = await parse('id: 7\nevent: agent.message\ndata: {"n":1}\n\n')

    expect(messages).toEqual([{ id: '7', event: 'agent.message', data: '{"n":1}' }])
  })

  it('accepts a field without a space after the colon, and strips only one', async () => {
    const messages = await parse('data:{"n":1}\n\ndata:  two\n\n')

    expect(messages).toEqual([
      { id: null, event: null, data: '{"n":1}' },
      { id: null, event: null, data: ' two' },
    ])
  })

  it('joins multi-line data with a newline', async () => {
    const messages = await parse('data: first\ndata: second\ndata: third\n\n')

    expect(messages).toEqual([{ id: null, event: null, data: 'first\nsecond\nthird' }])
  })

  it('ignores keepalive comments', async () => {
    const messages = await parse(': keepalive\n\ndata: {"n":1}\n\n: another\n\n')

    expect(messages).toEqual([{ id: null, event: null, data: '{"n":1}' }])
  })

  it('treats a field with no colon as a field with an empty value', async () => {
    const messages = await parse('data\n\n')

    expect(messages).toEqual([{ id: null, event: null, data: '' }])
  })

  it('does not dispatch a message without data', async () => {
    const messages = await parse('id: 9\n\ndata: {"n":1}\n\n')

    expect(messages).toEqual([{ id: null, event: null, data: '{"n":1}' }])
  })

  it('joins a message split across chunks', async () => {
    const messages = await parseChunks(['data: {"n"', ':1}\n', '\n'])

    expect(messages).toEqual([{ id: null, event: null, data: '{"n":1}' }])
  })

  it('joins a message split inside a CRLF', async () => {
    const messages = await parseChunks(['data: {"n":1}\r', '\n\r\n'])

    expect(messages).toEqual([{ id: null, event: null, data: '{"n":1}' }])
  })

  it('accepts CRLF and lone CR line endings', async () => {
    const messages = await parse('id: 1\r\ndata: a\r\n\r\ndata: b\r\r')

    expect(messages).toEqual([
      { id: '1', event: null, data: 'a' },
      { id: null, event: null, data: 'b' },
    ])
  })

  it('strips a byte order mark', async () => {
    const messages = await parseChunks(['﻿data: {"n":1}\n\n'])

    expect(messages).toEqual([{ id: null, event: null, data: '{"n":1}' }])
  })

  it('drops an event the stream ended in the middle of', async () => {
    const messages = await parse('data: complete\n\ndata: cut off mid-')

    expect(messages).toEqual([{ id: null, event: null, data: 'complete' }])
  })

  it('parses a JSON event split across many chunks', async () => {
    const json = JSON.stringify({ type: 'user.message', seq: 1 })
    const chunks = [`data: ${json.slice(0, 5)}`, json.slice(5, 20), `${json.slice(20)}\n\n`]

    expect(await parseChunks(chunks)).toEqual([{ id: null, event: null, data: json }])
  })

  it('cancels the body when the consumer stops early', async () => {
    let cancelled = false
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"n":1}\n\n'))
      },
      cancel() {
        cancelled = true
      },
    })

    for await (const message of parseSseStream(body)) {
      expect(message.data).toBe('{"n":1}')
      break
    }

    expect(cancelled).toBe(true)
  })
})
