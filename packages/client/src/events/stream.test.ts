import { EVENT_TYPES, isStoredEvent, newEventId } from '@openharness/protocol'
import {
  makeAgentMessage,
  makeEventDelta,
  makeEventStart,
  makeSessionError,
  makeStatusIdle,
  makeStatusRescheduled,
  makeStatusRunning,
  makeStoredEventDelta,
  makeStoredEventStart,
  makeUserMessage,
} from '@openharness/protocol/fixtures'
import type { StreamEvent } from '@openharness/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient, type Client } from '../client'
import type { DebugHook } from '../http'
import {
  collect,
  createMockFetch,
  errorResponse,
  sseLines,
  sseResponse,
} from '../test-support/mock-fetch'

const SESSION_ID = 'sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ'
const BASE_URL = 'https://api.test'

/** A client over a mock fetch, with a debug hook the test can inspect. */
function clientWith(handler: Parameters<typeof createMockFetch>[0]): {
  client: Client
  mock: ReturnType<typeof createMockFetch>
  debug: string[]
} {
  const mock = createMockFetch(handler)
  const debug: string[] = []
  const onDebug: DebugHook = (message) => {
    debug.push(message)
  }
  return { client: createClient({ baseUrl: BASE_URL, fetch: mock.fetch, onDebug }), mock, debug }
}

/**
 * Read a stream until the session goes idle, then stop it.
 *
 * The abort happens *after* the event is taken, so the iteration ends there and every event
 * up to it still arrives.
 */
async function collectUntilIdle(
  stream: AsyncIterable<StreamEvent>,
  controller: AbortController,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of stream) {
    events.push(event)
    if (event.type === EVENT_TYPES.sessionStatusIdle) {
      controller.abort()
    }
  }
  return events
}

/** Every stored event of the sample history, as one turn. */
const TURN: StreamEvent[] = [
  makeStatusRunning({ seq: 1 }),
  makeUserMessage('hello', { seq: 2, processed_at: '2026-03-15T10:00:02Z' }),
  makeAgentMessage('hi there', { seq: 3 }),
  makeStatusIdle({ seq: 4 }),
]

afterEach(() => {
  vi.useRealTimers()
})

describe('stream requests', () => {
  it('asks for deltas only when they are wanted', async () => {
    const { client, mock } = clientWith(() => sseResponse(sseLines([makeStatusIdle({ seq: 1 })])))
    const plain = new AbortController()
    const withDeltas = new AbortController()

    for await (const _event of client.sessions.events.stream(SESSION_ID, {
      signal: plain.signal,
    })) {
      plain.abort()
    }
    for await (const _event of client.sessions.events.stream(SESSION_ID, {
      deltas: true,
      signal: withDeltas.signal,
    })) {
      withDeltas.abort()
    }

    expect(mock.urlOf(0)).toContain(`/v1/sessions/${SESSION_ID}/events/stream`)
    expect(new URL(mock.urlOf(0)).searchParams.get('event_deltas[]')).toBeNull()
    expect(new URL(mock.urlOf(1)).searchParams.get('event_deltas[]')).toBe(EVENT_TYPES.agentMessage)
  })

  it('sends the api key and accepts an event stream', async () => {
    const mock = createMockFetch(() => sseResponse(sseLines([makeStatusIdle({ seq: 1 })])))
    const client = createClient({ baseUrl: BASE_URL, apiKey: 'oh_key', fetch: mock.fetch })
    const controller = new AbortController()

    for await (const _event of client.sessions.events.stream(SESSION_ID, {
      signal: controller.signal,
    })) {
      controller.abort()
    }

    const request = mock.requests[0]
    expect(request?.headers.get('x-api-key')).toBe('oh_key')
    expect(request?.headers.get('accept')).toBe('text/event-stream')
    expect(request?.headers.get('last-event-id')).toBeNull()
  })

  it('sends no last-event-id or after_seq on a fresh stream', async () => {
    const { client, mock } = clientWith(() => sseResponse(sseLines([makeStatusIdle({ seq: 1 })])))
    const controller = new AbortController()

    for await (const _event of client.sessions.events.stream(SESSION_ID, {
      signal: controller.signal,
    })) {
      controller.abort()
    }

    expect(mock.urlOf(0)).not.toContain('after_seq')
    expect(mock.requests[0]?.headers.get('last-event-id')).toBeNull()
  })

  it('starts from after_seq when one is given, and honors it as last-event-id too', async () => {
    const { client, mock } = clientWith(() => sseResponse(sseLines([makeStatusIdle({ seq: 13 })])))
    const controller = new AbortController()

    for await (const _event of client.sessions.events.stream(SESSION_ID, {
      afterSeq: 12,
      signal: controller.signal,
    })) {
      controller.abort()
    }

    expect(new URL(mock.urlOf(0)).searchParams.get('after_seq')).toBe('12')
    expect(mock.requests[0]?.headers.get('last-event-id')).toBe('12')
  })

  it('throws when the stream request is refused with a status that will not fix itself', async () => {
    const { client } = clientWith(() => errorResponse(401, 'authentication_error', 'Bad key.'))

    await expect(collect(client.sessions.events.stream(SESSION_ID))).rejects.toMatchObject({
      status: 401,
      type: 'authentication_error',
    })
  })

  it('refuses a 200 that is not an event stream', async () => {
    const { client } = clientWith(
      () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )

    await expect(collect(client.sessions.events.stream(SESSION_ID))).rejects.toThrow(
      /instead of an event stream/,
    )
  })
})

describe('delivering events', () => {
  it('parses stored events in order', async () => {
    const { client, mock } = clientWith(() => sseResponse(sseLines(TURN)))
    const controller = new AbortController()

    const events = await collectUntilIdle(
      client.sessions.events.stream(SESSION_ID, { signal: controller.signal }),
      controller,
    )

    expect(events).toEqual(TURN)
    expect(mock.requests).toHaveLength(1)
  })

  it('ignores keepalive comments between events', async () => {
    const body = [
      ': ping\n\n',
      ...sseLines(TURN.slice(0, 1)),
      ': ping\n\n',
      ...sseLines(TURN.slice(1)),
    ]
    const { client } = clientWith(() => sseResponse(body))
    const controller = new AbortController()

    const events = await collectUntilIdle(
      client.sessions.events.stream(SESSION_ID, { signal: controller.signal }),
      controller,
    )

    expect(events.map((event) => event.type)).toEqual(TURN.map((event) => event.type))
  })

  it('skips unknown event types and reports them to the debug hook', async () => {
    const unknown = { type: 'agent.thinking', seq: 99, id: 'sevt_01HZZZZZZZZZZZZZZZZZZZZZZZ' }
    const body = [
      ...sseLines(TURN.slice(0, 1)),
      `data: ${JSON.stringify(unknown)}\n\n`,
      ...sseLines(TURN.slice(1)),
    ]
    const { client, debug } = clientWith(() => sseResponse(body))
    const controller = new AbortController()

    const events = await collectUntilIdle(
      client.sessions.events.stream(SESSION_ID, { signal: controller.signal }),
      controller,
    )

    expect(events).toEqual(TURN)
    expect(debug.some((message) => message.includes('agent.thinking'))).toBe(true)
  })

  it('skips a message that is not JSON', async () => {
    const body = ['data: not json at all\n\n', ...sseLines(TURN)]
    const { client, debug } = clientWith(() => sseResponse(body))
    const controller = new AbortController()

    const events = await collectUntilIdle(
      client.sessions.events.stream(SESSION_ID, { signal: controller.signal }),
      controller,
    )

    expect(events).toEqual(TURN)
    expect(debug.length).toBeGreaterThan(0)
  })

  it('treats a stored chunk as a stored event, and resumes from it', async () => {
    vi.useFakeTimers()
    const messageId = newEventId()
    const running = makeStatusRunning({ seq: 1 })
    const user = makeUserMessage('hello', { seq: 2, processed_at: '2026-03-15T10:00:02Z' })
    // A reply in flight, stored chunk by chunk (D9): the same `type` strings as the previews
    // above, and a `seq` on every one.
    const chunks: StreamEvent[] = [
      makeStoredEventStart(messageId, { seq: 3 }),
      makeStoredEventDelta(messageId, 'the whole ', { seq: 4 }),
      makeStoredEventDelta(messageId, 'reply', { seq: 5 }),
    ]
    const message = makeAgentMessage('the whole reply', { seq: 6, id: messageId })
    const idle = makeStatusIdle({ seq: 7 })

    // The connection dies mid-reply; the client resumes from the last chunk it saw.
    const bodies = [
      sseResponse(sseLines([running, user, ...chunks]), { failWith: new Error('reset') }),
      sseResponse(sseLines([message, idle])),
    ]
    const { client, mock } = clientWith((_request, call) => bodies[call] ?? sseResponse([]))
    const controller = new AbortController()

    const collected: StreamEvent[] = []
    const iterating = (async () => {
      for await (const event of client.sessions.events.stream(SESSION_ID, {
        signal: controller.signal,
      })) {
        collected.push(event)
        if (event.type === EVENT_TYPES.sessionStatusIdle) {
          controller.abort()
        }
      }
    })()
    await vi.advanceTimersByTimeAsync(1000)
    await iterating

    expect(collected).toEqual([running, user, ...chunks, message, idle])
    // Every chunk is a stored event, and the resume position is the last one seen — which is
    // what lets a client that dropped mid-reply pick the reply back up where it stopped.
    expect(collected.filter(isStoredEvent).map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(mock.requests.length).toBeGreaterThanOrEqual(2)
    expect(mock.requests[1]?.headers.get('last-event-id')).toBe('5')
    expect(new URL(mock.urlOf(1)).searchParams.get('after_seq')).toBe('5')
  })

  it('delivers previews before the stored message that replaces them', async () => {
    const message = makeAgentMessage('the whole reply', { seq: 3 })
    const preview: StreamEvent[] = [
      makeEventStart(message.id),
      makeEventDelta(message.id, 'the whole '),
      makeEventDelta(message.id, 'reply'),
    ]
    const body = [
      ...sseLines(TURN.slice(0, 2)),
      ...sseLines(preview),
      ...sseLines([message, ...TURN.slice(3)]),
    ]
    const { client } = clientWith(() => sseResponse(body))
    const controller = new AbortController()

    const events = await collectUntilIdle(
      client.sessions.events.stream(SESSION_ID, { deltas: true, signal: controller.signal }),
      controller,
    )

    expect(events.map((event) => event.type)).toEqual([
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.userMessage,
      EVENT_TYPES.eventStart,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.sessionStatusIdle,
    ])
    expect(events.filter(isStoredEvent).map((event) => event.seq)).toEqual([1, 2, 3, 4])
  })
})

describe('resuming after a disconnect', () => {
  it('reconnects with the last seq and delivers every stored event exactly once', async () => {
    vi.useFakeTimers()
    // The server sends two events, the connection dies, and the next connection replays from
    // an earlier position than the client got to — the duplicate must not be delivered twice.
    const bodies = [
      sseResponse(sseLines(TURN.slice(0, 2)), { failWith: new Error('connection reset') }),
      sseResponse(sseLines([...TURN.slice(0, 2), ...TURN.slice(2)])),
      sseResponse([]),
    ]
    const { client, mock } = clientWith((_request, call) => bodies[call] ?? sseResponse([]))
    const controller = new AbortController()

    const collected: StreamEvent[] = []
    const iterating = (async () => {
      for await (const event of client.sessions.events.stream(SESSION_ID, {
        signal: controller.signal,
      })) {
        collected.push(event)
        if (event.type === EVENT_TYPES.sessionStatusIdle) {
          controller.abort()
        }
      }
    })()
    await vi.advanceTimersByTimeAsync(1000)
    await iterating

    expect(collected).toEqual(TURN)
    expect(mock.requests.length).toBeGreaterThanOrEqual(2)
    expect(mock.requests[1]?.headers.get('last-event-id')).toBe('2')
    expect(new URL(mock.urlOf(1)).searchParams.get('after_seq')).toBe('2')
  })

  it('reconnects when the server closes the stream without an error', async () => {
    vi.useFakeTimers()
    const { client, mock } = clientWith((_request, call) =>
      call === 0 ? sseResponse(sseLines(TURN.slice(0, 1))) : sseResponse(sseLines(TURN.slice(1))),
    )
    const controller = new AbortController()

    const collected: StreamEvent[] = []
    const iterating = (async () => {
      for await (const event of client.sessions.events.stream(SESSION_ID, {
        signal: controller.signal,
      })) {
        collected.push(event)
        if (event.type === EVENT_TYPES.sessionStatusIdle) {
          controller.abort()
        }
      }
    })()
    await vi.advanceTimersByTimeAsync(1000)
    await iterating

    expect(collected).toEqual(TURN)
    expect(mock.requests.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps retrying while the server is unavailable', async () => {
    vi.useFakeTimers()
    const { client, mock } = clientWith((_request, call) =>
      call < 2
        ? errorResponse(503, 'overloaded_error', 'Come back later.')
        : sseResponse(sseLines(TURN)),
    )
    const controller = new AbortController()

    const collected: StreamEvent[] = []
    const iterating = (async () => {
      for await (const event of client.sessions.events.stream(SESSION_ID, {
        signal: controller.signal,
      })) {
        collected.push(event)
        if (event.type === EVENT_TYPES.sessionStatusIdle) {
          controller.abort()
        }
      }
    })()
    await vi.advanceTimersByTimeAsync(10_000)
    await iterating

    expect(mock.requests.length).toBe(3)
    expect(collected).toEqual(TURN)
  })

  it('backs off further with every failed attempt', async () => {
    vi.useFakeTimers()
    const { client, mock } = clientWith(() =>
      errorResponse(503, 'overloaded_error', 'Come back later.'),
    )
    const controller = new AbortController()
    const iterating = collect(
      client.sessions.events.stream(SESSION_ID, { signal: controller.signal }),
    )

    // The first two reconnects wait 500ms and 1s (± jitter); nothing more has been attempted
    // 400ms in, and several have been after 3 seconds.
    await vi.advanceTimersByTimeAsync(300)
    expect(mock.requests.length).toBe(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(mock.requests.length).toBeGreaterThanOrEqual(3)

    controller.abort()
    await iterating
  })

  it('stops the iteration when the caller aborts, without throwing', async () => {
    const { client } = clientWith(() => sseResponse(sseLines(TURN)))
    const controller = new AbortController()

    const collected: StreamEvent[] = []
    for await (const event of client.sessions.events.stream(SESSION_ID, {
      signal: controller.signal,
    })) {
      collected.push(event)
      controller.abort()
    }

    expect(collected).toHaveLength(1)
  })

  it('stops before reconnecting when aborted mid-backoff', async () => {
    vi.useFakeTimers()
    const { client, mock } = clientWith(() =>
      errorResponse(503, 'overloaded_error', 'Come back later.'),
    )
    const controller = new AbortController()
    const iterating = collect(
      client.sessions.events.stream(SESSION_ID, { signal: controller.signal }),
    )

    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await iterating

    expect(mock.requests).toHaveLength(1)
  })
})

describe('a session that errors', () => {
  it('delivers the retry sequence in order', async () => {
    const error = makeSessionError({ seq: 3 })
    const sequence: StreamEvent[] = [
      makeStatusRunning({ seq: 1 }),
      makeUserMessage('and the license?', { seq: 2, processed_at: '2026-03-15T10:00:02Z' }),
      error,
      makeStatusRescheduled({ seq: 4 }),
      makeStatusRunning({ seq: 5 }),
      makeAgentMessage('MIT.', { seq: 6 }),
      makeStatusIdle({ seq: 7 }),
    ]
    const { client } = clientWith((_request, call) =>
      call === 0 ? sseResponse(sseLines(sequence)) : sseResponse([]),
    )
    const controller = new AbortController()

    const events = await collectUntilIdle(
      client.sessions.events.stream(SESSION_ID, { signal: controller.signal }),
      controller,
    )

    expect(events).toHaveLength(7)
    expect(events[2]?.type).toBe(EVENT_TYPES.sessionError)
  })
})
