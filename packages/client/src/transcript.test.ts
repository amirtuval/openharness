import { EVENT_TYPES, isStoredEvent, newEventId } from '@openharness/protocol'
import {
  makeAgentMessage,
  makeEventDelta,
  makeEventStart,
  makeModelRequestEnd,
  makeModelRequestStart,
  makeSessionError,
  makeStatusIdle,
  makeStatusRescheduled,
  makeStatusRunning,
  makeStoredEventDelta,
  makeStoredEventStart,
  makeUserInterrupt,
  makeUserMessage,
  sampleSessionHistory,
  sampleStreamPreview,
  fixtureTimestamp,
} from '@openharness/protocol/fixtures'
import type { StreamEvent } from '@openharness/protocol'
import { describe, expect, it, vi } from 'vitest'

import { deepFreeze } from './testing/freeze'
import {
  createTranscript,
  initialTranscriptState,
  reduceTranscript,
  reduceTranscriptAll,
  selectIsRunning,
  selectLastMessage,
  selectMessages,
  selectStreamingMessage,
  type TranscriptMessage,
  type TranscriptState,
} from './transcript'

/**
 * Ids for the events that are referenced by more than one assertion, so a test can point at
 * the message a preview belongs to. Generated rather than spelled out: a `sevt_` id has to be
 * a real ULID.
 */
const idA = newEventId()
const idB = newEventId()
const idC = newEventId()
const idD = newEventId()
const idE = newEventId()

/** Fold a list of events into a fresh transcript. */
function reduceEvents(events: readonly StreamEvent[]): TranscriptState {
  return reduceTranscriptAll(initialTranscriptState(), events)
}

/** The messages as `role:text` pairs, which is what most assertions are about. */
function asPairs(state: TranscriptState): string[] {
  return state.messages.map((message) => `${message.role}:${message.text}`)
}

/** The message with `id`, or a failure naming what is there instead. */
function messageById(state: TranscriptState, id: string): TranscriptMessage {
  const found = state.messages.find((message) => message.id === id)
  if (found === undefined) {
    throw new Error(`no message ${id}; there is ${JSON.stringify(asPairs(state))}`)
  }
  return found
}

describe('reduceTranscript', () => {
  it('loads a whole session history', () => {
    const state = reduceEvents(sampleSessionHistory)

    expect(asPairs(state)).toEqual([
      'user:Summarize the repo README in one sentence.',
      'agent:openharness is an open-source implementation of Managed Agents.',
      'user:Actually, mention the session log.',
      'agent:openharness is Managed Agents in the open: a durable session log, a stateless brain.',
      'user:Now write a haiku about it.',
      'agent:Events in a log,',
      'user:And the license?',
      'agent:MIT.',
      'user:One more thing: who maintains it?',
    ])
    expect(state.lastSeq).toBe(32)
    expect(state.status).toBe('running')
    // Turn 4's error was superseded by the reply that followed the retry.
    expect(state.lastError).toBeNull()
  })

  it('starts idle and empty', () => {
    const state = initialTranscriptState()

    expect(state).toEqual({ messages: [], status: 'idle', lastError: null, lastSeq: 0 })
  })

  it('shows a queued user message as pending until a model request starts', () => {
    const queued = makeUserMessage('one more thing', {
      seq: 1,
      processed_at: null,
      id: idA,
    })
    const start = makeModelRequestStart({ seq: 2, id: idB })

    const waiting = reduceEvents([queued])
    expect(messageById(waiting, queued.id).pending).toBe(true)

    const picked = reduceTranscript(waiting, start)
    expect(messageById(picked, queued.id).pending).toBe(false)
  })

  it('keeps a steering message where it arrived', () => {
    const first = makeUserMessage('start', { seq: 1, processed_at: fixtureTimestamp(1), id: idA })
    const start = makeModelRequestStart({ seq: 2, id: idB })
    const steering = makeUserMessage('actually, wait', { seq: 3, processed_at: null, id: idC })
    const reply = makeAgentMessage('ok', { seq: 4, id: idD })
    const secondStart = makeModelRequestStart({ seq: 5, id: idE })

    const state = reduceEvents([first, start, steering, reply, secondStart])

    expect(asPairs(state)).toEqual(['user:start', 'user:actually, wait', 'agent:ok'])
    expect(messageById(state, steering.id).pending).toBe(false)
  })

  it('accumulates preview deltas into the streaming message', () => {
    const messageId = idA
    const state = reduceEvents([
      makeEventStart(messageId),
      makeEventDelta(messageId, 'Hel'),
      makeEventDelta(messageId, 'lo, '),
      makeEventDelta(messageId, 'world'),
    ])

    expect(state.messages).toHaveLength(1)
    expect(messageById(state, messageId)).toMatchObject({
      role: 'agent',
      text: 'Hello, world',
      blocks: ['Hello, world'],
      streaming: true,
      pending: false,
    })
    expect(selectStreamingMessage(state)?.id).toBe(messageId)
  })

  it('accumulates deltas per content block', () => {
    const messageId = idA
    const state = reduceEvents([
      makeEventStart(messageId),
      makeEventDelta(messageId, 'first ', {
        delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'first ' } },
      }),
      makeEventDelta(messageId, 'second', {
        delta: { type: 'content_delta', index: 1, content: { type: 'text', text: 'second' } },
      }),
      makeEventDelta(messageId, 'block', {
        delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'block' } },
      }),
    ])

    expect(messageById(state, messageId).blocks).toEqual(['first block', 'second'])
    expect(messageById(state, messageId).text).toBe('first blocksecond')
  })

  it('replaces the preview with the stored message that carries the same id', () => {
    const stored = makeAgentMessage('Hello, world', { seq: 4, id: idA })
    const preview = [
      makeEventStart(stored.id),
      makeEventDelta(stored.id, 'Hello, '),
      makeEventDelta(stored.id, 'world'),
    ]

    const state = reduceEvents([...preview, stored])

    expect(asPairs(state)).toEqual(['agent:Hello, world'])
    expect(messageById(state, stored.id).streaming).toBe(false)
    expect(selectStreamingMessage(state)).toBeNull()
  })

  it('keeps the partial reply of an interrupted turn', () => {
    const messageId = idA
    const start = makeModelRequestStart({ seq: 2, id: idB })
    const interrupt = {
      id: idC,
      type: 'user.interrupt' as const,
      seq: 3,
      processed_at: fixtureTimestamp(3),
    }
    const partial = makeAgentMessage('Events in a log,', { seq: 4, id: messageId })
    const end = makeModelRequestEnd(start, {
      seq: 5,
      id: idD,
      is_error: true,
      error: { type: 'interrupted', message: 'Interrupted by the user.' },
    })

    const state = reduceEvents([
      makeStatusRunning({ seq: 1 }),
      start,
      makeEventStart(messageId),
      makeEventDelta(messageId, 'Events in '),
      makeEventDelta(messageId, 'a log,'),
      interrupt,
      partial,
      end,
      makeStatusIdle({ seq: 6, id: idE }),
    ])

    expect(asPairs(state)).toEqual(['agent:Events in a log,'])
    expect(selectStreamingMessage(state)).toBeNull()
    expect(state.status).toBe('idle')
  })

  it('drops a preview whose model request ended without storing it', () => {
    const start = makeModelRequestStart({ seq: 2 })
    const preview = makeEventStart(idA)
    const end = makeModelRequestEnd(start, {
      seq: 3,
      is_error: true,
      error: { type: 'brain_lost', message: 'The brain died.' },
    })

    const state = reduceEvents([makeStatusRunning({ seq: 1 }), start, preview, end])

    expect(state.messages).toEqual([])
  })

  it('drops a preview that is still open when the session goes idle', () => {
    // The turn with no reply (#40), as one reaches the reducer: the preview is announced, no
    // deltas follow, no `agent.message` is stored — and the `span.model_request_end` that would
    // close the preview is missing, because a stored event this client cannot parse is skipped
    // (`events/stream.ts`), which is what a real provider's span usage did to every turn. The
    // idle is then the only evidence that the turn is over, and the bubble must not outlive it.
    const start = makeModelRequestStart({ seq: 2 })
    const preview = makeEventStart(idA)
    const idle = makeStatusIdle({ seq: 3 })

    const state = reduceEvents([makeStatusRunning({ seq: 1 }), start, preview, idle])

    expect(state.messages).toEqual([])
    expect(selectStreamingMessage(state)).toBeNull()
    expect(state.status).toBe('idle')
  })

  it('drops a preview that had started to stream when the session goes idle', () => {
    // Same turn, but the deltas arrived: the reply was never stored, so there is still nothing
    // to keep — what is dropped is the preview, whether or not it had started to say something.
    const start = makeModelRequestStart({ seq: 2 })
    const state = reduceEvents([
      makeStatusRunning({ seq: 1 }),
      start,
      makeEventStart(idA),
      makeEventDelta(idA, 'half a repl'),
      makeStatusIdle({ seq: 3 }),
    ])

    expect(state.messages).toEqual([])
    expect(selectStreamingMessage(state)).toBeNull()
  })

  it('ignores a preview for a message that is already stored', () => {
    const stored = makeAgentMessage('the reply', { seq: 2 })
    const state = reduceEvents([
      stored,
      makeEventStart(stored.id),
      makeEventDelta(stored.id, 'garbage'),
    ])

    expect(asPairs(state)).toEqual(['agent:the reply'])
    expect(messageById(state, stored.id).streaming).toBe(false)
  })

  it('keeps the stored reply when the span closes after it', () => {
    const start = makeModelRequestStart({ seq: 1 })
    const stored = makeAgentMessage('the reply', { seq: 2 })

    const state = reduceEvents([start, stored, makeModelRequestEnd(start, { seq: 3 })])

    expect(asPairs(state)).toEqual(['agent:the reply'])
  })

  it('drops an event it has already seen', () => {
    const message = makeUserMessage('once', { seq: 1 })
    const state = reduceEvents([
      message,
      message,
      makeStatusRunning({ seq: 2 }),
      makeStatusRunning({ seq: 2 }),
    ])

    expect(asPairs(state)).toEqual(['user:once'])
    expect(state.lastSeq).toBe(2)
  })

  it('lets history and a resumed stream overlap without duplicating a message', () => {
    // The resumed stream starts at seq 3, before where the loaded history ended: the overlap
    // must be folded in once, not twice.
    const history = sampleSessionHistory.slice(0, 6)
    const resumed = sampleSessionHistory.slice(2)

    const state = reduceEvents([...history, ...resumed])

    expect(state).toEqual(reduceEvents(sampleSessionHistory))
  })

  it('tracks the session status through a retry', () => {
    const running = makeStatusRunning({ seq: 1 })
    const error = makeSessionError({ seq: 2, id: idA })
    const rescheduled = makeStatusRescheduled({ seq: 3, id: idB })

    const failed = reduceEvents([running, error])
    expect(selectIsRunning(failed)).toBe(true)
    expect(failed.lastError).toEqual({
      type: 'model_overloaded_error',
      message: 'The model is overloaded. Retrying.',
      retryStatus: 'retrying',
    })

    const retrying = reduceTranscript(failed, rescheduled)
    expect(selectIsRunning(retrying)).toBe(true)

    const idle = reduceTranscript(retrying, makeStatusIdle({ seq: 4, id: idC }))
    expect(selectIsRunning(idle)).toBe(false)
    // An error that is not superseded by a reply stays visible.
    expect(idle.lastError?.retryStatus).toBe('retrying')
  })

  it('clears the last error once a reply lands', () => {
    const state = reduceEvents([
      makeSessionError({ seq: 1, id: idA }),
      makeAgentMessage('all good now', { seq: 2, id: idB }),
    ])

    expect(state.lastError).toBeNull()
  })

  it('keeps a terminal error', () => {
    const terminal = makeSessionError({
      seq: 1,
      id: idA,
      error: {
        type: 'model_overloaded_error',
        message: 'The overload persisted.',
        retry_status: { type: 'exhausted' },
      },
    })

    const state = reduceEvents([terminal, makeStatusIdle({ seq: 2, id: idB })])

    expect(state.lastError).toMatchObject({ retryStatus: 'exhausted' })
    expect(selectIsRunning(state)).toBe(false)
  })

  it('does not mutate the state it is given', () => {
    const before = reduceEvents(sampleSessionHistory.slice(0, 6))
    const snapshot = JSON.parse(JSON.stringify(before)) as TranscriptState

    const after = reduceTranscript(before, sampleSessionHistory[6] as StreamEvent)

    expect(before).toEqual(snapshot)
    expect(after).not.toBe(before)
  })

  it('returns the same state when an event changes nothing', () => {
    const state = reduceEvents(sampleSessionHistory.slice(0, 6))

    expect(reduceTranscript(state, makeUserMessage('again', { seq: 1 }))).toBe(state)
  })

  it('produces state that survives a JSON round trip', () => {
    const state = reduceEvents(sampleSessionHistory)

    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
  })

  it('ignores an event it does not know, without losing its place in the log', () => {
    const state = reduceEvents(sampleSessionHistory.slice(0, 2))
    const unknown = { type: 'agent.thinking', seq: 3 } as unknown as StreamEvent

    const next = reduceTranscript(state, unknown)

    expect(next.messages).toEqual(state.messages)
    expect(next.status).toBe(state.status)
    // The position still moves: the event was seen, and a resume must not ask for it again.
    expect(next.lastSeq).toBe(3)
  })

  it('reconciles the sample preview with the sample history', () => {
    const withPreview = reduceTranscriptAll(
      reduceEvents(sampleSessionHistory.slice(0, 3)),
      sampleStreamPreview,
    )

    expect(withPreview.messages).toHaveLength(2)
    expect(withPreview.messages[1]).toMatchObject({
      text: 'openharness is an open-source implementation of Managed Agents.',
      streaming: false,
    })
  })
})

describe('stored chunks (D9)', () => {
  it('accumulates stored deltas into the preview of their message', () => {
    const state = reduceEvents([
      makeStoredEventStart(idA, { seq: 1 }),
      makeStoredEventDelta(idA, 'Hel', { seq: 2 }),
      makeStoredEventDelta(idA, 'lo, ', { seq: 3 }),
      makeStoredEventDelta(idA, 'world', { seq: 4 }),
    ])

    expect(asPairs(state)).toEqual(['agent:Hello, world'])
    expect(messageById(state, idA)).toMatchObject({ streaming: true, position: 1 })
    expect(state.lastSeq).toBe(4)
  })

  it('opens a stored preview at its first delta when the start was skipped', () => {
    // A client that joined mid-reply never saw the `event_start`; its first delta is where
    // the bubble can open.
    const state = reduceEvents([
      makeUserMessage('earlier', { seq: 1, processed_at: fixtureTimestamp(1) }),
      makeStoredEventDelta(idA, 'the tail of ', { seq: 10 }),
      makeStoredEventDelta(idA, 'a reply', { seq: 11 }),
    ])

    expect(asPairs(state)).toEqual(['user:earlier', 'agent:the tail of a reply'])
    expect(messageById(state, idA).position).toBe(10)
  })

  it('deduplicates stored chunks like any other stored event', () => {
    const chunk = makeStoredEventDelta(idA, 'once', { seq: 4 })
    const state = reduceEvents([
      makeStoredEventStart(idA, { seq: 3 }),
      chunk,
      chunk,
      makeStoredEventStart(idA, { seq: 3 }),
    ])

    expect(asPairs(state)).toEqual(['agent:once'])
    expect(state.lastSeq).toBe(4)
  })

  it('ignores a stored delta for a message whose reply is already stored', () => {
    const stored = makeAgentMessage('the reply', { seq: 5, id: idA })
    const state = reduceEvents([stored, makeStoredEventDelta(idA, 'more', { seq: 6 })])

    expect(asPairs(state)).toEqual(['agent:the reply'])
    expect(messageById(state, idA).streaming).toBe(false)
    // The chunk was still seen, and still moves the resume position past it.
    expect(state.lastSeq).toBe(6)
  })

  it('drops a stored preview when the turn ends without reconciling it', () => {
    const state = reduceEvents([
      makeStatusRunning({ seq: 1 }),
      makeModelRequestStart({ seq: 2 }),
      makeStoredEventStart(idA, { seq: 3 }),
      makeStoredEventDelta(idA, 'never stored', { seq: 4 }),
      makeStatusIdle({ seq: 5 }),
    ])

    expect(state.messages).toEqual([])
    expect(state.status).toBe('idle')
  })

  it('clears pending only for the messages a span start claims', () => {
    const claimed = makeUserMessage('claimed', { seq: 1, processed_at: null, id: idA })
    const steering = makeUserMessage('steering', { seq: 2, processed_at: null, id: idB })
    const start = makeModelRequestStart({ seq: 3, id: idC, consumes: [claimed.id] })

    const state = reduceEvents([claimed, steering, start])

    expect(messageById(state, claimed.id).pending).toBe(false)
    // A message sent while the turn runs stays pending until the request that claims it.
    expect(messageById(state, steering.id).pending).toBe(true)
  })

  it('clears nothing when a span start claims nothing', () => {
    const queued = makeUserMessage('queued', { seq: 1, processed_at: null, id: idA })
    const state = reduceEvents([queued, makeModelRequestStart({ seq: 2, id: idB, consumes: [] })])

    expect(messageById(state, queued.id).pending).toBe(true)
  })
})

describe('positions (D9)', () => {
  it('places a stream-only preview after everything stored so far, and keeps it there', () => {
    // Today's server: no `seq` on the chunks. The bubble opens after the stored events, and
    // the stored message that replaces it does not move it.
    const state = reduceEvents([
      makeUserMessage('hello', { seq: 1, processed_at: fixtureTimestamp(1) }),
      makeStatusRunning({ seq: 2 }),
      makeEventStart(idA),
      makeEventDelta(idA, 'the reply'),
    ])

    expect(messageById(state, idA).position).toBe(2.5)

    const stored = reduceTranscript(state, makeAgentMessage('the reply', { seq: 3, id: idA }))

    expect(asPairs(stored)).toEqual(['user:hello', 'agent:the reply'])
    expect(messageById(stored, idA).position).toBe(2.5)
  })

  it('moves a reply back to where it started when its message supersedes its chunks', () => {
    // The reply's chunks run 13..52, a steering message arrives at 30, and the stored message
    // lands at 53. A client that accumulated the preview placed the reply at 13; a client
    // that only ever saw the stored message must place it there too.
    const messageId = idA
    const steering = makeUserMessage('actually, wait', { seq: 30, processed_at: null, id: idB })
    const stored = makeAgentMessage('steered reply', {
      seq: 53,
      id: messageId,
      supersedes: { from_seq: 13, to_seq: 52 },
    })

    const withChunks = reduceEvents([
      makeStoredEventStart(messageId, { seq: 13 }),
      makeStoredEventDelta(messageId, 'steered ', { seq: 14 }),
      steering,
      makeStoredEventDelta(messageId, 'reply', { seq: 52 }),
      stored,
    ])
    const storedOnly = reduceEvents([steering, stored])

    expect(withChunks.messages.map((message) => message.id)).toEqual([messageId, steering.id])
    expect(storedOnly.messages.map((message) => message.id)).toEqual([messageId, steering.id])
    expect(storedOnly.messages[0]?.position).toBe(13)
    expect(messageById(withChunks, messageId).position).toBe(13)
  })
})

describe('one reply, five clients (D9 convergence)', () => {
  const REPLY = 'openharness streams a reply in fragments'

  /**
   * A scripted turn in the D9 shapes. `seq` 1..27, all of it stored:
   *
   * ```
   * 1      session.status_running
   * 2      span.model_request_start   (claims the message that started the turn)
   * 3      event_start  M1            (the first stored chunk)
   * 4..13  event_delta  M1            (ten fragments)
   * 14     user.message U2            (sent mid-reply: steering)
   * 15..24 event_delta  M1            (ten more fragments)
   * 25     agent.message M1           (supersedes 3..24)
   * 26     span.model_request_end
   * 27     session.status_idle
   * ```
   */
  function scriptedTurn(): {
    events: StreamEvent[]
    messageId: string
    steeringId: string
  } {
    const messageId = newEventId()
    const steeringId = newEventId()
    // The message this request claims started the turn before the window every client below
    // replays — the one a client that joins mid-turn cannot have seen. `consumes` naming an
    // id the transcript does not hold is harmless.
    const claimed = makeUserMessage('the message that started the turn')
    const start = makeModelRequestStart({
      seq: 2,
      consumes: [claimed.id],
      model: 'anthropic/claude-sonnet-5',
    })
    const fragments = splitText(REPLY, 20)

    const events: StreamEvent[] = [
      makeStatusRunning({ seq: 1 }),
      start,
      makeStoredEventStart(messageId, { seq: 3 }),
      ...fragments
        .slice(0, 10)
        .map((text, index) => makeStoredEventDelta(messageId, text, { seq: 4 + index })),
      makeUserMessage('actually, wait', { seq: 14, id: steeringId, processed_at: null }),
      ...fragments
        .slice(10)
        .map((text, index) => makeStoredEventDelta(messageId, text, { seq: 15 + index })),
      makeAgentMessage(REPLY, {
        seq: 25,
        id: messageId,
        supersedes: { from_seq: 3, to_seq: 24 },
      }),
      makeModelRequestEnd(start, { seq: 26 }),
      makeStatusIdle({ seq: 27 }),
    ]
    return { events, messageId, steeringId }
  }

  /** The stored events of `events` at or after `seq`. */
  function from(events: readonly StreamEvent[], seq: number): StreamEvent[] {
    return events.filter((event) => isStoredEvent(event) && event.seq >= seq)
  }

  /** The stored events of `events` at or before `seq`. */
  function upTo(events: readonly StreamEvent[], seq: number): StreamEvent[] {
    return events.filter((event) => isStoredEvent(event) && event.seq <= seq)
  }

  it('shows the same conversation to every view of the stream', () => {
    const { events, messageId, steeringId } = scriptedTurn()
    const withoutChunks = (event: StreamEvent): boolean =>
      event.type !== EVENT_TYPES.eventStart && event.type !== EVENT_TYPES.eventDelta

    const views: Record<string, StreamEvent[]> = {
      // (a) a client that followed everything.
      everything: events,
      // (b) a client that joined mid-reply: its first event is a stored delta.
      'joined mid-chunks': from(events, 8),
      // (c) a client that had the reply streaming, disconnected mid-chunks, and resumed
      // after the superseded chunks were deleted — the next event it gets is the message.
      'resumed with the chunks removed': [...upTo(events, 20), ...from(events, 25)],
      // (d) a log whose chunks were already superseded: only the stored message remains.
      'no chunks at all': events.filter(withoutChunks),
      // (e) a client that did not ask for deltas: no chunk ever reaches it.
      'no deltas': events.filter(withoutChunks),
    }

    const expected = reduceEvents(events)

    for (const [client, eventsSeen] of Object.entries(views)) {
      const state = reduceEvents(eventsSeen)
      expect(state.messages, client).toEqual(expected.messages)
      expect(state.lastSeq, client).toBe(27)
    }

    expect(expected.messages.map((message) => `${message.role}:${message.text}`)).toEqual([
      `agent:${REPLY}`,
      'user:actually, wait',
    ])
    expect(expected.messages[0]?.id).toBe(messageId)
    expect(expected.messages[1]?.id).toBe(steeringId)
    // M1 sorts where it started, ahead of the steering message it was interleaved with.
    expect(expected.messages[0]?.position).toBe(3)
    expect(expected.messages[1]?.position).toBe(14)
    expect(expected.messages[0]?.streaming).toBe(false)
    expect(expected.messages[1]?.pending).toBe(true)
    expect(expected.status).toBe('idle')
  })

  it('folds deep-frozen events without writing to them', () => {
    const { events, messageId } = scriptedTurn()
    const frozen = events.map((event) => deepFreeze(event))
    const preview = deepFreeze([makeEventStart(idE), makeEventDelta(idE, 'a preview')])
    const before = JSON.stringify(frozen)

    const state = reduceTranscriptAll(reduceEvents(preview), frozen)

    expect(messageById(state, messageId).text).toBe(REPLY)
    expect(messageById(state, messageId).streaming).toBe(false)
    expect(selectStreamingMessage(state)).toBeNull()
    expect(JSON.stringify(frozen)).toBe(before)
  })
})

describe('interrupts and crashes (D9)', () => {
  it('keeps the partial reply of an interrupt that supersedes its chunks', () => {
    const messageId = idA
    const start = makeModelRequestStart({ seq: 2, id: idB })
    const script: StreamEvent[] = [
      makeStatusRunning({ seq: 1 }),
      start,
      makeStoredEventStart(messageId, { seq: 3, id: idC }),
      makeStoredEventDelta(messageId, 'Events in ', { seq: 4 }),
      makeStoredEventDelta(messageId, 'a log,', { seq: 5 }),
      makeUserInterrupt({ seq: 6, id: idD }),
      makeAgentMessage('Events in a log,', {
        seq: 7,
        id: messageId,
        supersedes: { from_seq: 3, to_seq: 5 },
      }),
      makeModelRequestEnd(start, {
        seq: 8,
        id: idE,
        is_error: true,
        error: { type: 'interrupted', message: 'Interrupted by the user.' },
      }),
      makeStatusIdle({ seq: 9 }),
    ]

    const state = reduceEvents(script)

    expect(asPairs(state)).toEqual(['agent:Events in a log,'])
    expect(messageById(state, messageId).position).toBe(3)
    expect(selectStreamingMessage(state)).toBeNull()
    expect(state.status).toBe('idle')

    // A client whose chunks were already gone: the stored message alone, same conversation.
    const storedOnly = reduceEvents(
      script.filter(
        (event) => event.type !== EVENT_TYPES.eventStart && event.type !== EVENT_TYPES.eventDelta,
      ),
    )
    expect(storedOnly.messages).toEqual(state.messages)
  })

  it('leaves no ghost preview when a crash closes the span and the request is re-run', () => {
    const crashedId = idA
    const retryId = idE
    const crashedStart = makeModelRequestStart({ seq: 2, id: idB })
    const retryStart = makeModelRequestStart({ seq: 7, id: idD })
    const script: StreamEvent[] = [
      makeStatusRunning({ seq: 1 }),
      crashedStart,
      makeStoredEventStart(crashedId, { seq: 3 }),
      makeStoredEventDelta(crashedId, 'half a rep', { seq: 4 }),
      makeStoredEventDelta(crashedId, 'ly', { seq: 5 }),
      // The recovering brain closes the orphaned span, superseding what it streamed…
      makeModelRequestEnd(crashedStart, {
        seq: 6,
        id: idC,
        is_error: true,
        error: { type: 'brain_lost', message: 'The brain died.' },
        supersedes: { from_seq: 3, to_seq: 5 },
      }),
      // …and the request runs again under a new message id.
      retryStart,
      makeStoredEventStart(retryId, { seq: 8 }),
      makeStoredEventDelta(retryId, 'a fresh reply', { seq: 9 }),
      makeAgentMessage('a fresh reply', {
        seq: 10,
        id: retryId,
        supersedes: { from_seq: 8, to_seq: 9 },
      }),
      makeModelRequestEnd(retryStart, { seq: 11 }),
      makeStatusIdle({ seq: 12 }),
    ]

    const state = reduceEvents(script)

    expect(state.messages.map((message) => message.id)).toEqual([retryId])
    expect(asPairs(state)).toEqual(['agent:a fresh reply'])
    expect(state.messages.some((message) => message.id === crashedId)).toBe(false)
    expect(selectStreamingMessage(state)).toBeNull()
    expect(state.status).toBe('idle')

    // A client that resumed after the crashed chunks were deleted never had the ghost
    // preview; it must end up with the same conversation. The span end that superseded them
    // is still there — and finds nothing to drop.
    const chunksGone = reduceEvents(
      script.filter((event) => !isStoredEvent(event) || event.seq < 3 || event.seq > 5),
    )
    expect(chunksGone.messages).toEqual(state.messages)
  })
})

/** `text`, split into `count` fragments: the pieces a reply is streamed in. */
function splitText(text: string, count: number): string[] {
  const size = Math.ceil(text.length / count)
  const fragments: string[] = []
  for (let index = 0; index < text.length; index += size) {
    fragments.push(text.slice(index, index + size))
  }
  return fragments
}

describe('selectors', () => {
  it('read the transcript', () => {
    const state = reduceEvents(sampleSessionHistory)

    expect(selectMessages(state)).toBe(state.messages)
    expect(selectIsRunning(state)).toBe(true)
    expect(selectLastMessage(state)?.text).toBe('One more thing: who maintains it?')
    expect(selectStreamingMessage(state)).toBeNull()
    expect(selectLastMessage(initialTranscriptState())).toBeNull()
  })
})

describe('createTranscript', () => {
  it('folds events, tells subscribers, and resets', () => {
    const transcript = createTranscript()
    const seen = vi.fn()
    const unsubscribe = transcript.subscribe(seen)

    transcript.apply(makeStatusRunning({ seq: 1 }))
    transcript.applyAll([makeUserMessage('hi', { seq: 2 })])
    expect(seen).toHaveBeenCalledTimes(2)
    expect(asPairs(transcript.getState())).toEqual(['user:hi'])
    expect(selectIsRunning(transcript.getState())).toBe(true)

    unsubscribe()
    transcript.reset()
    expect(seen).toHaveBeenCalledTimes(2)
    expect(transcript.getState()).toEqual(initialTranscriptState())
  })

  it('can start from a state the caller already has', () => {
    const history = reduceEvents(sampleSessionHistory.slice(0, 6))
    const transcript = createTranscript(history)

    expect(transcript.getState()).toBe(history)
  })
})

describe('the state a UI reads', () => {
  it('exposes exactly the documented message fields', () => {
    const state = reduceEvents(sampleSessionHistory.slice(0, 3))
    const message = selectLastMessage(state)

    expect(message).not.toBeNull()
    expect(Object.keys(message ?? {}).sort()).toEqual([
      'blocks',
      'id',
      'pending',
      'position',
      'role',
      'streaming',
      'text',
    ])
  })
})
