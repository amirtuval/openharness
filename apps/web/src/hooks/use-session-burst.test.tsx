import type { StreamEvent } from '@openharness/protocol'
import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { makeFake, renderApp } from '../test-support/render-app'

/**
 * A reply that arrives as a burst of stored chunks, folded by the real hook (React #185).
 *
 * The stream delivers a whole network read's worth of events in one turn of the event loop —
 * a resumed connection's backlog, a fast provider's deltas — so the transcript is folded many
 * times per turn and the store notifies React on each fold. `useSyncExternalStore` turns every
 * notification into a synchronous update, and a long enough burst pushed React past its
 * nested-update limit: "Maximum update depth exceeded" (React #185), thrown out of the hook's
 * own `transcript.apply` — which the stream loop catches and reports as a failed request, so
 * the chat the reader saw was a "Request failed" banner carrying React's own message.
 *
 * The test is the burst: this log is a real one (a stored `event_start`, its deltas, and the
 * `agent.message` that supersedes them), replayed the way the hook really folds a session.
 */

const MODEL = 'anthropic/claude-sonnet-5'
/** Enough chunks to cross React's limit of 50 nested updates when they are all unbatched. */
const CHUNKS = 400

/** One stored event of the log. */
function event(seq: number, body: Record<string, unknown>): StreamEvent {
  return {
    id: `sevt_burst${String(seq).padStart(16, '0')}`,
    seq,
    processed_at: '2026-10-12T00:00:00.000Z',
    ...body,
  } as unknown as StreamEvent
}

/** A session whose log holds one reply, streamed in {@link CHUNKS} stored chunks. */
function burstLog(): StreamEvent[] {
  const messageId = 'sevt_burstmsg00000000000001'
  const text = (index: number): string => `chunk ${String(index)} `
  const events: StreamEvent[] = [
    event(1, {
      type: 'user.message',
      model: { id: MODEL },
      content: [{ type: 'text', text: 'tell me something long' }],
    }),
    event(2, { type: 'span.model_request_start', model: MODEL, consumes: [] }),
    event(3, {
      type: 'event_start',
      id: messageId,
      event: { type: 'agent.message', id: messageId },
    }),
  ]
  for (let index = 0; index < CHUNKS; index += 1) {
    events.push(
      event(4 + index, {
        type: 'event_delta',
        event_id: messageId,
        delta: { type: 'content_delta', index: 0, content: { type: 'text', text: text(index) } },
      }),
    )
  }
  events.push(
    event(4 + CHUNKS, {
      type: 'agent.message',
      id: messageId,
      content: [
        { type: 'text', text: Array.from({ length: CHUNKS }, (_, index) => text(index)).join('') },
      ],
      supersedes: { from_seq: 3, to_seq: 3 + CHUNKS },
    }),
    event(5 + CHUNKS, {
      type: 'span.model_request_end',
      model_request_start_id: 'sevt_burst0000000000000002',
      model_usage: {
        input_tokens: 10,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      is_error: null,
    }),
    event(6 + CHUNKS, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }),
  )
  return events
}

describe('a reply that arrives in one burst (#185)', () => {
  it('folds every chunk without React giving up on the update depth', async () => {
    const fake = makeFake()
    const session = await fake.sessions.create({ model: { id: MODEL } })
    const log = burstLog()
    fake.sessions.events.iterate = () =>
      ({
        async *[Symbol.asyncIterator]() {
          for (const part of log) {
            // One microtask per event, like the paged read the client really walks: an async
            // iterable suspends between items however fast its source is.
            await Promise.resolve()
            yield part
          }
        },
      }) as unknown as ReturnType<typeof fake.sessions.events.iterate>

    renderApp(fake, { hash: `#/s/${session.id}` })

    // The reply is on screen — and the screen is not the "Request failed" banner whose message
    // is React's own `Maximum update depth exceeded`, which is how this failed before.
    await waitFor(() => {
      expect(screen.getByText(/chunk 0 /)).toBeInTheDocument()
    })
    const banner = screen.queryByText('Request failed')
    if (banner !== null) {
      console.log('BANNER MESSAGE:', banner.parentElement?.textContent?.slice(0, 400))
    }
    expect(banner).toBeNull()
  })
})
