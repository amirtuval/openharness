import { newEventId } from '@openharness/protocol'
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
  makeUserMessage,
  sampleSessionHistory,
  sampleStreamPreview,
  fixtureTimestamp,
} from '@openharness/protocol/fixtures'
import type { StreamEvent } from '@openharness/protocol'
import { describe, expect, it, vi } from 'vitest'

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
      'role',
      'streaming',
      'text',
    ])
  })
})
