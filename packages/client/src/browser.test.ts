/**
 * @vitest-environment jsdom
 *
 * The package is loaded by browsers as well as by Node, and this file is the browser half of
 * that promise: it runs in a DOM environment (jsdom), with `Buffer` taken away, and drives the
 * same client and transcript code the other tests do.
 *
 * `src/` is also *type*-checked against the DOM lib only — `tsconfig.json` extends the
 * config's browser-safe base, so `Buffer`, `process` or a `node:*` import in a source file is
 * a type error — and this is the runtime half of that rule.
 *
 * The scenario is a streamed turn rather than a JSON request because undici's `Response` needs
 * `Buffer` to read a body, and the point here is precisely that there is none: a body that
 * arrives as a byte stream is what a browser and a Node 24 client both handle the same way.
 */
import { EVENT_TYPES } from '@openharness/protocol'
import { makeAgentMessage, makeStatusIdle, makeStatusRunning } from '@openharness/protocol/fixtures'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createClient } from './client'
import { createMockFetch, sseLines, sseResponse } from './test-support/mock-fetch'
import { createTranscript } from './transcript'

const SESSION_ID = 'sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ'

describe('in a DOM environment', () => {
  beforeAll(() => {
    // A browser has no `Buffer`; if any of this reached for one, it would fail here.
    vi.stubGlobal('Buffer', undefined)
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('is actually running in a DOM, without Buffer', () => {
    expect(typeof window).toBe('object')
    expect(typeof document).toBe('object')
    expect((globalThis as { Buffer?: unknown }).Buffer).toBeUndefined()
  })

  it('streams a turn and reduces it to a transcript', async () => {
    const events = [
      makeStatusRunning({ seq: 1 }),
      makeAgentMessage('hello from a browser', { seq: 2 }),
      makeStatusIdle({ seq: 3 }),
    ]
    const mock = createMockFetch(() => sseResponse(sseLines(events)))
    const client = createClient({
      baseUrl: 'https://api.test',
      token: 'oh_token',
      fetch: mock.fetch,
    })
    const transcript = createTranscript()
    const controller = new AbortController()

    for await (const event of client.sessions.events.stream(SESSION_ID, {
      deltas: true,
      signal: controller.signal,
    })) {
      transcript.apply(event)
      if (event.type === EVENT_TYPES.sessionStatusIdle) {
        controller.abort()
      }
    }

    expect(mock.requests[0]?.headers.get('authorization')).toBe('Bearer oh_token')
    expect(mock.requests[0]?.init?.credentials).toBe('include')
    expect(mock.requests[0]?.headers.get('accept')).toBe('text/event-stream')
    expect(transcript.getState().messages.map((message) => message.text)).toEqual([
      'hello from a browser',
    ])
    expect(transcript.getState().status).toBe('idle')
    expect(transcript.getState().lastSeq).toBe(3)
    expect(mock.requests).toHaveLength(1)
  })

  it('parses a stream that arrives in pieces', async () => {
    const message = makeAgentMessage('split across chunks', { seq: 1 })
    const [chunk = ''] = sseLines([message])
    const pieces = [chunk.slice(0, 12), chunk.slice(12)]
    const mock = createMockFetch(() => sseResponse(pieces))
    const client = createClient({ baseUrl: 'https://api.test', fetch: mock.fetch })
    const controller = new AbortController()

    const collected = []
    for await (const event of client.sessions.events.stream(SESSION_ID, {
      signal: controller.signal,
    })) {
      collected.push(event)
      if (event.type === EVENT_TYPES.agentMessage) {
        controller.abort()
      }
    }

    expect(collected).toEqual([message])
  })
})
