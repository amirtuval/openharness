import { EVENT_TYPES, isStoredEvent, newEventId } from '@openharness/protocol'
import {
  makeAgentMessage,
  makeContextSummary,
  makeContextSummaryProgress,
  makeStoredEventDelta,
  makeStoredEventStart,
  makeModelRequestEnd,
  makeModelRequestStart,
  makeSessionCompact,
  makeSessionCompaction,
  makeSessionDeleted,
  makeSessionRewind,
  makeSessionError,
  makeSessionUsage,
  makeStatusIdle,
  makeStatusRescheduled,
  makeStatusRunning,
  makeUserInterrupt,
  makeUserMessage,
  sampleSessionHistory,
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
  selectContext,
  selectIsRunning,
  selectLastMessage,
  selectManualCompaction,
  selectMessages,
  selectSessionUsage,
  selectStreamingMessage,
  selectSummaries,
  selectSummarizing,
  selectTranscriptEntries,
  selectTruncation,
  replyCost,
  sessionCost,
  sessionUsageOf,
  type ModelPriceLookup,
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

/** The messages without their per-reply metadata: what every view of the log must agree on. */
function withoutMeta(messages: readonly TranscriptMessage[]): unknown[] {
  return messages.map(({ meta: _meta, ...rest }) => rest)
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

  it('starts idle, empty, not deleted, and with no model', () => {
    const state = initialTranscriptState()

    expect(state).toEqual({
      messages: [],
      status: 'idle',
      lastError: null,
      lastSeq: 0,
      deleted: false,
      model: null,
      pendingRequests: [],
      usage: null,
      summaries: [],
      summarizing: null,
      context: null,
      truncation: null,
      manualCompaction: null,
      toolCalls: [],
      truncatedToolResults: [],
      clearedToolResults: null,
      confirmations: [],
      toolSources: {},
      todos: null,
      todoEvents: [],
    })
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
      makeStoredEventStart(messageId),
      makeStoredEventDelta(messageId, 'Hel'),
      makeStoredEventDelta(messageId, 'lo, '),
      makeStoredEventDelta(messageId, 'world'),
    ])

    expect(state.messages).toHaveLength(1)
    expect(messageById(state, messageId)).toMatchObject({
      role: 'agent',
      text: 'Hello, world',
      parts: [{ type: 'text', text: 'Hello, world' }],
      streaming: true,
      pending: false,
    })
    expect(selectStreamingMessage(state)?.id).toBe(messageId)
  })

  it('accumulates deltas per content block', () => {
    const messageId = idA
    const state = reduceEvents([
      makeStoredEventStart(messageId),
      makeStoredEventDelta(messageId, 'first ', {
        delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'first ' } },
      }),
      makeStoredEventDelta(messageId, 'second', {
        delta: { type: 'content_delta', index: 1, content: { type: 'text', text: 'second' } },
      }),
      makeStoredEventDelta(messageId, 'block', {
        delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'block' } },
      }),
    ])

    expect(messageById(state, messageId).parts).toEqual([
      { type: 'text', text: 'first block' },
      { type: 'text', text: 'second' },
    ])
    expect(messageById(state, messageId).text).toBe('first blocksecond')
  })

  it('replaces the preview with the stored message that carries the same id', () => {
    const stored = makeAgentMessage('Hello, world', { seq: 4, id: idA })
    const preview = [
      makeStoredEventStart(stored.id, { seq: 1 }),
      makeStoredEventDelta(stored.id, 'Hello, ', { seq: 2 }),
      makeStoredEventDelta(stored.id, 'world', { seq: 3 }),
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
      seq: 6,
      processed_at: fixtureTimestamp(6),
    }
    const partial = makeAgentMessage('Events in a log,', { seq: 7, id: messageId })
    const end = makeModelRequestEnd(start, {
      seq: 8,
      id: idD,
      is_error: true,
      error: { type: 'interrupted', message: 'Interrupted by the user.' },
    })

    const state = reduceEvents([
      makeStatusRunning({ seq: 1 }),
      start,
      makeStoredEventStart(messageId, { seq: 3 }),
      makeStoredEventDelta(messageId, 'Events in ', { seq: 4 }),
      makeStoredEventDelta(messageId, 'a log,', { seq: 5 }),
      interrupt,
      partial,
      end,
      makeStatusIdle({ seq: 9, id: idE }),
    ])

    expect(asPairs(state)).toEqual(['agent:Events in a log,'])
    expect(selectStreamingMessage(state)).toBeNull()
    expect(state.status).toBe('idle')
  })

  it('drops a preview whose model request ended without storing it', () => {
    const start = makeModelRequestStart({ seq: 2 })
    const preview = makeStoredEventStart(idA, { seq: 3 })
    const end = makeModelRequestEnd(start, {
      seq: 4,
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
    const preview = makeStoredEventStart(idA, { seq: 3 })
    const idle = makeStatusIdle({ seq: 4 })

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
      makeStoredEventStart(idA, { seq: 3 }),
      makeStoredEventDelta(idA, 'half a repl', { seq: 4 }),
      makeStatusIdle({ seq: 5 }),
    ])

    expect(state.messages).toEqual([])
    expect(selectStreamingMessage(state)).toBeNull()
  })

  it('ignores a preview for a message that is already stored', () => {
    const stored = makeAgentMessage('the reply', { seq: 2 })
    const state = reduceEvents([
      stored,
      makeStoredEventStart(stored.id, { seq: 3 }),
      makeStoredEventDelta(stored.id, 'garbage', { seq: 4 }),
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

  it('reconciles the sample history with itself: loading it twice changes nothing', () => {
    const once = reduceEvents(sampleSessionHistory)
    const twice = reduceTranscriptAll(once, sampleSessionHistory)

    expect(twice).toBe(once)
    expect(asPairs(twice)).toHaveLength(9)
  })

  it('reads a log stored before D9: no consumes, no supersedes, no stored chunks', () => {
    // A database that predates D9 still holds events like these, and they have to read
    // correctly: a span start with no `consumes` means everything queued was picked up, a
    // reply with no `supersedes` keeps the position its preview opened at (here: its own
    // `seq`, since it never had one), and an interrupt simply cuts a reply short.
    const first = makeUserMessage('stored before the claims', {
      seq: 1,
      processed_at: fixtureTimestamp(1),
    })
    const start = makeModelRequestStart({ seq: 2 })
    const reply = makeAgentMessage('an old-style reply', { seq: 3, id: idA })
    const end = makeModelRequestEnd(start, { seq: 4 })
    const queued = makeUserMessage('sent but not yet read', { seq: 5, processed_at: null })
    const interrupt = makeUserInterrupt({ seq: 6, processed_at: null })

    const state = reduceEvents([first, start, reply, end, queued, interrupt])

    expect(asPairs(state)).toEqual([
      'user:stored before the claims',
      'agent:an old-style reply',
      'user:sent but not yet read',
    ])
    // The span start cleared the first message's pending flag; the ones after it are queued.
    expect(messageById(state, first.id).pending).toBe(false)
    expect(messageById(state, queued.id).pending).toBe(true)
    // A reply with no `supersedes` keeps its own `seq` and is final.
    expect(messageById(state, reply.id)).toMatchObject({ pending: false, position: 3 })
    expect(state.lastSeq).toBe(6)
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

  it('clears pending on the consumes of a span end and of a status idle (P4)', () => {
    // The other two claim sites: an interrupt that cut a request short is claimed by the
    // request's span end, and one that arrived with nothing running by the turn's idle event.
    const interrupted = makeUserMessage('stop this', { seq: 1, processed_at: null, id: idA })
    const start = makeModelRequestStart({ seq: 2, id: idB, consumes: [interrupted.id] })
    const end = makeModelRequestEnd(start, {
      seq: 3,
      id: idC,
      is_error: true,
      error: { type: 'interrupted', message: 'Interrupted by the user.' },
      consumes: [interrupted.id],
    })

    expect(messageById(reduceEvents([interrupted, start, end]), interrupted.id).pending).toBe(false)

    const queued = makeUserMessage('one more', { seq: 1, processed_at: null, id: idD })
    const idle = makeStatusIdle({ seq: 2, id: idE, consumes: [queued.id] })
    expect(messageById(reduceEvents([queued, idle]), queued.id).pending).toBe(false)
  })

  it('leaves pending alone when a span end or an idle carries no list: a pre-P4 log', () => {
    // A log written before P4: the closing events carry no `consumes`, which must not be read
    // as a claim. The span start here has no list either — a pre-D9 writer — so it keeps the
    // older reading and clears everything pending when it starts.
    const queued = makeUserMessage('queued', { seq: 1, processed_at: null, id: idA })
    const start = makeModelRequestStart({ seq: 2 })
    const end = makeModelRequestEnd(start, { seq: 3 })
    const idle = makeStatusIdle({ seq: 4 })

    const state = reduceEvents([queued, start, end, idle])

    expect(messageById(state, queued.id).pending).toBe(false)

    const late = makeUserMessage('sent after the log', { seq: 5, processed_at: null, id: idB })
    const withLate = reduceTranscript(state, late)

    // The late message is pending, and nothing that followed it re-opened or cleared it.
    expect(messageById(withLate, late.id).pending).toBe(true)
    expect(withLate.messages).toHaveLength(2)
  })
})

describe('positions (D9)', () => {
  it('keeps a reply without a supersedes range where its chunks opened', () => {
    // A log stored before D9: the chunks carry a `seq` (they are stored events since phase
    // P3), but the reply that replaces them carries no `supersedes` range — so it keeps the
    // position the bubble opened at, where the client accumulated it.
    const state = reduceEvents([
      makeUserMessage('hello', { seq: 1, processed_at: fixtureTimestamp(1) }),
      makeStatusRunning({ seq: 2 }),
      makeStoredEventStart(idA, { seq: 3 }),
      makeStoredEventDelta(idA, 'the reply', { seq: 4 }),
    ])

    expect(messageById(state, idA).position).toBe(3)

    const stored = reduceTranscript(state, makeAgentMessage('the reply', { seq: 5, id: idA }))

    expect(asPairs(stored)).toEqual(['user:hello', 'agent:the reply'])
    expect(messageById(stored, idA).position).toBe(3)
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

describe('typed parts (#201, X1)', () => {
  it('gives a user message one text part per content block, and keeps text as their join', () => {
    const message = makeUserMessage('', {
      seq: 1,
      id: idA,
      processed_at: fixtureTimestamp(1),
      content: [
        { type: 'text', text: 'one ' },
        { type: 'text', text: 'two' },
      ],
    })

    const state = reduceEvents([message])

    expect(messageById(state, idA).parts).toEqual([
      { type: 'text', text: 'one ' },
      { type: 'text', text: 'two' },
    ])
    expect(messageById(state, idA).text).toBe('one two')
  })

  it('gives an agent message one text part per content block', () => {
    const message = makeAgentMessage('', {
      seq: 1,
      id: idA,
      content: [
        { type: 'text', text: 'first block' },
        { type: 'text', text: 'second' },
      ],
    })

    const state = reduceEvents([message])

    expect(messageById(state, idA).parts).toEqual([
      { type: 'text', text: 'first block' },
      { type: 'text', text: 'second' },
    ])
    expect(messageById(state, idA).text).toBe('first blocksecond')
  })

  it('carries the same parts whether the reply was streamed or stored whole', () => {
    const stored = makeAgentMessage('Hello, world', { seq: 3, id: idA })
    const streamed = reduceEvents([
      makeStoredEventStart(stored.id, { seq: 1 }),
      makeStoredEventDelta(stored.id, 'Hello, ', { seq: 2 }),
      makeStoredEventDelta(stored.id, 'world', { seq: 3 }),
    ])

    expect(messageById(streamed, idA).parts).toEqual([{ type: 'text', text: 'Hello, world' }])
    expect(messageById(reduceEvents([stored]), idA).parts).toEqual(messageById(streamed, idA).parts)
  })
})

describe('per-reply metadata (#201, U1)', () => {
  /** A span end that reports `input` / `output` tokens. */
  function endOf(
    start: ReturnType<typeof makeModelRequestStart>,
    overrides: Partial<ReturnType<typeof makeModelRequestEnd>> = {},
  ): ReturnType<typeof makeModelRequestEnd> {
    return makeModelRequestEnd(start, {
      model_usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      ...overrides,
    })
  }

  it('reads a reply’s model, duration and tokens off the turn’s spans', () => {
    const start = makeModelRequestStart({
      seq: 2,
      id: idB,
      model: 'anthropic/claude-sonnet-5',
      processed_at: fixtureTimestamp(2),
    })
    const reply = makeAgentMessage('Hello.', { seq: 3, id: idA })
    const end = endOf(start, { seq: 4, id: idC, processed_at: fixtureTimestamp(4) })

    const state = reduceEvents([start, reply, end])

    expect(messageById(state, idA).meta).toEqual({
      model: 'anthropic/claude-sonnet-5',
      durationMs: 2000,
      usage: { input: 10, output: 4, cacheCreation: 0, cacheRead: 0, total: 14 },
    })
  })

  it('writes the tokens when the span end arrives, after the reply that it closes', () => {
    const start = makeModelRequestStart({
      seq: 2,
      id: idB,
      model: 'anthropic/claude-sonnet-5',
      processed_at: fixtureTimestamp(2),
    })
    const reply = makeAgentMessage('Hello.', { seq: 3, id: idA })

    // A reply whose span has not closed yet knows the model it is running on and nothing else:
    // the tokens and the time are on an event that has not arrived.
    const streaming = reduceEvents([start, reply])
    expect(messageById(streaming, idA).meta).toEqual({ model: 'anthropic/claude-sonnet-5' })

    const ended = reduceTranscript(
      streaming,
      endOf(start, { seq: 4, id: idC, processed_at: fixtureTimestamp(4) }),
    )
    expect(messageById(ended, idA).meta).toMatchObject({ durationMs: 2000 })
  })

  it('adds up a reply the brain retried, and runs it on the model that answered', () => {
    const failedStart = makeModelRequestStart({
      seq: 2,
      id: idB,
      model: 'anthropic/claude-sonnet-5',
      processed_at: fixtureTimestamp(2),
    })
    const failedEnd = endOf(failedStart, {
      seq: 3,
      id: idC,
      processed_at: fixtureTimestamp(3),
      is_error: true,
      error: { type: 'model_error', message: 'The model is overloaded.' },
    })
    const retryStart = makeModelRequestStart({
      seq: 4,
      id: idD,
      model: 'anthropic/claude-opus-5-5',
      processed_at: fixtureTimestamp(4),
    })
    const reply = makeAgentMessage('Second time lucky.', { seq: 5, id: idA })
    const retryEnd = endOf(retryStart, { seq: 6, id: idE, processed_at: fixtureTimestamp(6) })

    // The reply the retry produced already carries the failed attempt's tokens: they belong to
    // the same reply, and the request that spent them is still open.
    const beforeEnd = reduceEvents([failedStart, failedEnd, retryStart, reply])
    expect(messageById(beforeEnd, idA).meta).toEqual({
      model: 'anthropic/claude-opus-5-5',
      durationMs: 1000,
      usage: { input: 10, output: 4, cacheCreation: 0, cacheRead: 0, total: 14 },
    })

    const state = reduceEvents([failedStart, failedEnd, retryStart, reply, retryEnd])
    expect(messageById(state, idA).meta).toEqual({
      model: 'anthropic/claude-opus-5-5',
      durationMs: 4000,
      usage: { input: 20, output: 8, cacheCreation: 0, cacheRead: 0, total: 28 },
    })
  })

  it('leaves the tokens of a request no reply ever claimed out of the next turn', () => {
    const start = makeModelRequestStart({ seq: 1, id: idB, processed_at: fixtureTimestamp(1) })
    const end = endOf(start, { seq: 2, id: idC, processed_at: fixtureTimestamp(2) })
    const idle = makeStatusIdle({ seq: 3 })
    // The next turn: its reply has no request of its own — a log whose spans are missing — and
    // must not inherit the tokens the turn before it spent.
    const reply = makeAgentMessage('A later reply.', { seq: 4, id: idA })

    const state = reduceEvents([start, end, idle, reply])

    expect(messageById(state, idA).meta).toBeUndefined()
    expect(state.pendingRequests).toEqual([])
  })

  it('reports nothing rather than zero when the log says nothing', () => {
    const reply = makeAgentMessage('No span ever wrapped this.', { seq: 1, id: idA })

    const state = reduceEvents([reply])

    expect(messageById(state, idA).meta).toBeUndefined()
  })

  it('keeps the metadata it has when the span start names no model', () => {
    // A span start from before D9 carries no `model`, and the model is not something to guess:
    // the tokens and the time are still the log's word.
    const start = makeModelRequestStart({ seq: 1, id: idB, processed_at: fixtureTimestamp(1) })
    const reply = makeAgentMessage('Hello.', { seq: 2, id: idA })
    const end = endOf(start, { seq: 3, id: idC, processed_at: fixtureTimestamp(3) })

    const state = reduceEvents([start, reply, end])

    expect(messageById(state, idA).meta).toEqual({
      durationMs: 2000,
      usage: { input: 10, output: 4, cacheCreation: 0, cacheRead: 0, total: 14 },
    })
  })

  it('reads the sample history’s replies the way the log spells them', () => {
    const state = reduceEvents(sampleSessionHistory)
    const metaOf = (text: string): unknown =>
      state.messages.find((message) => message.text === text)?.meta

    // Turn 1: one request, 2 s of span, the fixture's tokens.
    expect(metaOf('openharness is an open-source implementation of Managed Agents.')).toEqual({
      durationMs: 2000,
      usage: { input: 640, output: 24, cacheCreation: 0, cacheRead: 0, total: 664 },
    })
    // Turn 3: an interrupt keeps the partial reply, and its span's tokens with it.
    expect(metaOf('Events in a log,')).toEqual({
      durationMs: 3000,
      usage: { input: 720, output: 6, cacheCreation: 0, cacheRead: 0, total: 726 },
    })
    // Turn 4: the failed attempt reported nothing and the retry reported the answer.
    expect(metaOf('MIT.')).toEqual({
      durationMs: 7000,
      usage: { input: 768, output: 2, cacheCreation: 0, cacheRead: 0, total: 770 },
    })
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
    const joinedLate = 'joined mid-chunks'

    for (const [client, eventsSeen] of Object.entries(views)) {
      const state = reduceEvents(eventsSeen)
      // The reply's model and its duration are on its `span.model_request_start`, so the view
      // that joined after that event has neither (#201, U1): its metadata is compared without.
      // The conversation, and everything the span end reports, is the same for all five.
      const messages = client === joinedLate ? withoutMeta(state.messages) : state.messages
      expect(messages, client).toEqual(
        client === joinedLate ? withoutMeta(expected.messages) : expected.messages,
      )
      expect(state.lastSeq, client).toBe(27)
    }

    // The reply's metadata, for a view that saw the whole turn: the model the request named,
    // and the tokens and the time its end reported. (`durationMs` is 0 because the scripted
    // turn's span start and end carry the fixtures' own timestamp.)
    expect(expected.messages[0]?.meta).toEqual({
      model: 'anthropic/claude-sonnet-5',
      durationMs: 0,
      usage: { input: 512, output: 64, cacheCreation: 0, cacheRead: 0, total: 576 },
    })
    // A client that joined after the span start cannot tie the span end it *did* see to the
    // reply — the end names the request that opened it, which is the event it missed — so the
    // reply keeps no metadata at all rather than a guess at one.
    expect(reduceEvents(views[joinedLate] ?? []).messages[0]?.meta).toBeUndefined()

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
    const before = JSON.stringify(frozen)

    const state = reduceTranscriptAll(initialTranscriptState(), frozen)

    expect(messageById(state, messageId).text).toBe(REPLY)
    expect(messageById(state, messageId).streaming).toBe(false)
    expect(selectStreamingMessage(state)).toBeNull()
    // Nothing in the fold wrote to an event: a reducer that did would throw on the freeze.
    expect(JSON.stringify(frozen)).toBe(before)
  })
})

describe('session.rewind (#238)', () => {
  /** A turn: the user speaks, the brain replies, the session goes idle. */
  const turn = (
    at: number,
    text: string,
    reply: string,
  ): { message: ReturnType<typeof makeUserMessage>; events: StreamEvent[] } => {
    const message = makeUserMessage(text, { seq: at, processed_at: fixtureTimestamp(at) })
    const start = makeModelRequestStart({ seq: at + 1, consumes: [message.id] })
    return {
      message,
      events: [
        makeStatusRunning({ seq: at - 1 }),
        message,
        start,
        makeAgentMessage(reply, { seq: at + 2 }),
        makeModelRequestEnd(start, { seq: at + 3 }),
        makeStatusIdle({ seq: at + 4 }),
      ],
    }
  }

  it('drops the conversation the rewind replaced, keeping what came before it', () => {
    const first = turn(2, 'write a haiku about rain', 'rain, on the window')
    const second = turn(7, 'and the moon?', 'the moon, also wet')
    const rewind = makeSessionRewind({ seq: 12, supersedes: { from_seq: 7, to_seq: 11 } })
    const edited = makeUserMessage('and the snow?', { seq: 13 })

    const state = reduceEvents([...first.events, ...second.events, rewind, edited])

    // The reader edited their second message: that message, its reply and the turn around
    // them are gone, and the first exchange — before the range — stays exactly where it was.
    expect(asPairs(state)).toEqual([
      'user:write a haiku about rain',
      'agent:rain, on the window',
      'user:and the snow?',
    ])
    expect(state.messages.at(-1)?.position).toBe(13)
    // Nothing a client never saw is invented: the rewound events simply are not there.
    expect(state.lastError).toBeNull()
    expect(state.status).toBe('idle')
  })

  it('is the same conversation a client that loads the session later gets', () => {
    const first = turn(2, 'write a haiku about rain', 'rain, on the window')
    const second = turn(7, 'and the moon?', 'the moon, also wet')
    const rewind = makeSessionRewind({ seq: 12, supersedes: { from_seq: 7, to_seq: 11 } })
    const edited = makeUserMessage('and the snow?', { seq: 13 })

    const live = reduceEvents([...first.events, ...second.events, rewind, edited])
    // A reload replays the log, which already skips the range: the rewind is the only trace
    // of the branch that was taken back.
    const reloaded = reduceEvents([...first.events, rewind, edited])

    expect(withoutMeta(live.messages)).toEqual(withoutMeta(reloaded.messages))
    expect(live.lastSeq).toBe(reloaded.lastSeq)
  })

  it('drops the error and the requests the replaced turn left behind', () => {
    const start = makeModelRequestStart({ seq: 2, consumes: [] })
    const script: StreamEvent[] = [
      makeStatusRunning({ seq: 1 }),
      start,
      makeSessionError({ seq: 3 }),
      makeStatusIdle({ seq: 4 }),
      makeSessionRewind({ seq: 5, supersedes: { from_seq: 1, to_seq: 4 } }),
    ]

    const state = reduceEvents(script)

    expect(asPairs(state)).toEqual([])
    expect(state.lastError).toBeNull()
    // The request of the turn that was taken back cannot cost the next reply anything.
    expect(state.pendingRequests).toEqual([])
  })

  it('keeps the edited message a client already showed when the rewind reaches it later', () => {
    const first = turn(2, 'write a haiku about rain', 'rain, on the window')
    const rewind = makeSessionRewind({ seq: 12, supersedes: { from_seq: 2, to_seq: 11 } })
    const edited = makeUserMessage('write a haiku about snow', { seq: 13 })

    // The sender's own view: the stored message is applied optimistically, and the rewind
    // arrives a moment later on the stream — with the lower `seq` of the range it replaced.
    // The edit is outside the range (it is the event *after* the rewind), so it survives, the
    // branch it replaced goes, and the resume position stays where the client got to.
    const state = reduceEvents([...first.events, edited, rewind])

    expect(asPairs(state)).toEqual(['user:write a haiku about snow'])
    expect(state.lastSeq).toBe(13)
  })

  it('touches nothing when the range covers nothing it holds', () => {
    const state = reduceEvents([makeUserMessage('first', { seq: 1 })])
    const rewind = makeSessionRewind({ seq: 5, supersedes: { from_seq: 4, to_seq: 4 } })

    const next = reduceTranscript(state, rewind)

    // The rewound range is past everything the transcript holds, so the messages are the very
    // same array — only the position moves, as it does for any event.
    expect(next.messages).toBe(state.messages)
    expect(asPairs(next)).toEqual(['user:first'])
    expect(next.lastSeq).toBe(5)
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

describe('a deleted session (#111)', () => {
  it('marks the transcript deleted without touching lastSeq', () => {
    const state = reduceEvents([makeUserMessage('bye', { seq: 1 }), makeSessionDeleted()])

    expect(state.deleted).toBe(true)
    // The event has no `seq`, so it is not a position: a resume still points where the log
    // got to.
    expect(state.lastSeq).toBe(1)
    expect(asPairs(state)).toEqual(['user:bye'])
    expect(state.status).toBe('idle')
  })

  it('is folded in even after a position the transcript passed', () => {
    // A stream that replays from the start delivers the deletion last, and a log the client
    // loaded from history already advanced `lastSeq` — either way the state has to flip.
    const state = reduceEvents([makeUserMessage('bye', { seq: 9 }), makeSessionDeleted()])

    expect(state.deleted).toBe(true)
    expect(state.lastSeq).toBe(9)
  })

  it('is idempotent: a replayed session.deleted changes nothing', () => {
    const deleted = makeSessionDeleted()
    const once = reduceEvents([makeUserMessage('bye', { seq: 1 }), deleted])

    const twice = reduceTranscript(once, deleted)

    expect(twice).toBe(once)
    expect(twice.deleted).toBe(true)
  })
})

describe('the model a user message switches to (#111)', () => {
  it('sets the state silently for the first model a message carries', () => {
    // Nothing has been seen yet, so the first model is not a change: no marker, and the
    // message just says which model the session is on.
    const message = makeUserMessage('switch', { seq: 1, model: { id: 'openai/gpt-4.1-mini' } })

    const state = reduceEvents([message])

    expect(state.model).toBe('openai/gpt-4.1-mini')
    expect(messageById(state, message.id)).not.toHaveProperty('modelChangedTo')
  })

  it('marks the message that changes the model, and moves the state', () => {
    const first = makeUserMessage('one', { seq: 1, model: { id: 'anthropic/claude-sonnet-5' } })
    const second = makeUserMessage('two', { seq: 2, model: { id: 'openai/gpt-4.1-mini' } })

    const state = reduceEvents([first, second])

    expect(messageById(state, second.id).modelChangedTo).toBe('openai/gpt-4.1-mini')
    expect(state.model).toBe('openai/gpt-4.1-mini')
    // The message that set the first model stays unmarked: the change is the second one.
    expect(messageById(state, first.id)).not.toHaveProperty('modelChangedTo')
  })

  it('leaves a message naming the current model unmarked', () => {
    const first = makeUserMessage('one', { seq: 1, model: { id: 'anthropic/claude-sonnet-5' } })
    const again = makeUserMessage('two', { seq: 2, model: { id: 'anthropic/claude-sonnet-5' } })

    const state = reduceEvents([first, again])

    expect(messageById(state, again.id)).not.toHaveProperty('modelChangedTo')
    expect(state.model).toBe('anthropic/claude-sonnet-5')
  })

  it('keeps the state and adds no marker for a message with no model', () => {
    const first = makeUserMessage('one', { seq: 1, model: { id: 'anthropic/claude-sonnet-5' } })
    const plain = makeUserMessage('two', { seq: 2 })

    const state = reduceEvents([first, plain])

    expect(state.model).toBe('anthropic/claude-sonnet-5')
    expect(messageById(state, plain.id)).not.toHaveProperty('modelChangedTo')
  })

  it('changes nothing when a message with a model is replayed', () => {
    const message = makeUserMessage('one', { seq: 1, model: { id: 'openai/gpt-4.1-mini' } })
    const once = reduceEvents([message])

    const twice = reduceTranscript(once, message)
    const replayedFromBefore = reduceTranscript(
      once,
      makeUserMessage('zero', { seq: 0, model: { id: 'anthropic/claude-sonnet-5' } }),
    )

    expect(twice).toBe(once)
    expect(twice.model).toBe('openai/gpt-4.1-mini')
    expect(replayedFromBefore).toBe(once)
    expect(replayedFromBefore.model).toBe('openai/gpt-4.1-mini')
  })
})

describe('the first model switch of a chat started from a model (#268)', () => {
  /** The model a chat is started on: what the session resource carries before any event. */
  const STARTED_ON = 'anthropic/claude-sonnet-5'

  it('marks the first switch against the model the transcript was seeded with', () => {
    // The bug: without a seed, the transcript's model is `null` until a message carries one,
    // so the first switch is drawn silently — the session was already running a model the
    // transcript had never heard of.
    const message = makeUserMessage('switch', { seq: 1, model: { id: 'openai/gpt-4.1-mini' } })

    const state = reduceTranscriptAll(initialTranscriptState({ model: STARTED_ON }), [message])

    expect(messageById(state, message.id).modelChangedTo).toBe('openai/gpt-4.1-mini')
    expect(state.model).toBe('openai/gpt-4.1-mini')
  })

  it('marks nothing on the first message: no model, or the model already running', () => {
    const plain = makeUserMessage('one', { seq: 1 })
    const same = makeUserMessage('two', { seq: 2, model: { id: STARTED_ON } })

    const state = reduceTranscriptAll(initialTranscriptState({ model: STARTED_ON }), [plain, same])

    expect(messageById(state, plain.id)).not.toHaveProperty('modelChangedTo')
    expect(messageById(state, same.id)).not.toHaveProperty('modelChangedTo')
    expect(state.model).toBe(STARTED_ON)
  })

  it('takes the model a request ran, so a resumed chat marks exactly what a live one did', () => {
    // A resumed session's resource carries only the model it is on *now* (U3 projects the
    // switch onto it), so a seed from it is not the model the log's first messages ran under.
    // The spans are: every request names the model it ran, so a replay settles on the same
    // baseline and draws the same markers a client that followed it live drew.
    const first = makeUserMessage('one', { seq: 1 })
    const second = makeUserMessage('two', { seq: 3, model: { id: 'openai/gpt-4.1-mini' } })
    const log = [
      first,
      makeModelRequestStart({ id: idA, seq: 2, model: STARTED_ON }),
      second,
      makeModelRequestStart({ id: idB, seq: 4, model: 'openai/gpt-4.1-mini' }),
    ]

    const live = reduceTranscriptAll(initialTranscriptState({ model: STARTED_ON }), log)
    // The resumed read seeds the model the session is on now — the *second* switch's — which
    // the first span corrects back to what the conversation actually started on.
    const resumed = reduceTranscriptAll(
      initialTranscriptState({ model: 'openai/gpt-4.1-mini' }),
      log,
    )

    const marked = (state: TranscriptState): string[] =>
      state.messages.filter((message) => message.modelChangedTo !== undefined).map((m) => m.id)
    expect(marked(resumed)).toEqual(marked(live))
    expect(marked(resumed)).toEqual([second.id])
    // The seeded value is not thrown away for a log that has nothing to correct it with.
    expect(initialTranscriptState({ model: STARTED_ON }).model).toBe(STARTED_ON)
    expect(initialTranscriptState().model).toBeNull()
  })

  it('seeds through a store reset, which is how the web hook loads a session', () => {
    const transcript = createTranscript()
    expect(transcript.getState().model).toBeNull()

    transcript.reset({ model: STARTED_ON })

    expect(transcript.getState().model).toBe(STARTED_ON)
    expect(transcript.getState().lastSeq).toBe(0)
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
      'id',
      'parts',
      'pending',
      'position',
      'role',
      'streaming',
      'text',
    ])
  })

  it('adds a reply’s metadata to an agent message, and to no other', () => {
    const state = reduceEvents(sampleSessionHistory.slice(0, 6))
    const [user, reply] = state.messages

    expect(user?.meta).toBeUndefined()
    expect(Object.keys(reply ?? {}).sort()).toEqual([
      'id',
      'meta',
      'parts',
      'pending',
      'position',
      'role',
      'streaming',
      'text',
    ])
  })
})

describe('the session’s usage (#247)', () => {
  const priced: ModelPriceLookup = (modelId) =>
    modelId === 'anthropic/claude-sonnet-5'
      ? { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 }
      : null

  it('keeps the running totals a session.usage event carries', () => {
    const snapshot = makeSessionUsage(
      [
        {
          model: 'anthropic/claude-sonnet-5',
          usage: {
            input_tokens: 512,
            output_tokens: 64,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          requests: 1,
        },
      ],
      { seq: 10 },
    )
    const state = reduceEvents([snapshot])

    // The event carries the totals directly, and the per-model breakdown beside them.
    expect(state.usage?.totals).toEqual({
      input: 512,
      output: 64,
      cacheCreation: 0,
      cacheRead: 0,
    })
    expect(selectSessionUsage(state).models).toEqual([
      {
        model: 'anthropic/claude-sonnet-5',
        usage: { input: 512, output: 64, cacheCreation: 0, cacheRead: 0 },
        requests: 1,
      },
    ])
  })

  it('derives the same totals from the spans for a log that has no session.usage', () => {
    // A session stored before the event existed: the newest one it can have is the spans, and
    // the fold over them is exactly what the event carries, which is what makes a replay equal
    // a live stream.
    const start = makeModelRequestStart({
      seq: 1,
      processed_at: fixtureTimestamp(1),
      model: 'anthropic/claude-sonnet-5',
    })
    const reply = makeAgentMessage('hello', { seq: 2, id: idE })
    const end = makeModelRequestEnd(start, {
      seq: 3,
      processed_at: fixtureTimestamp(3),
      model_usage: {
        input_tokens: 512,
        output_tokens: 64,
        cache_creation_input_tokens: 8,
        cache_read_input_tokens: 256,
      },
    })
    // The reply is what the derivation reads: its metadata is where the turn's tokens landed.
    const state = reduceEvents([start, reply, end])

    expect(state.usage).toBeNull()
    expect(selectSessionUsage(state)).toEqual({
      totals: { input: 512, output: 64, cacheCreation: 8, cacheRead: 256 },
      models: [
        {
          model: 'anthropic/claude-sonnet-5',
          usage: { input: 512, output: 64, cacheCreation: 8, cacheRead: 256 },
          requests: 1,
        },
      ],
    })
  })

  it('prefers the log’s own totals over the derivation when it has them', () => {
    // A reply the turn stored whose request reported nothing (a pre-#201 log) would derive to
    // zero; the event the server wrote is the better answer and is what is read.
    const start = makeModelRequestStart({ seq: 1, model: 'anthropic/claude-sonnet-5' })
    const reply = makeAgentMessage('hello', { seq: 2, id: idA })
    const snapshot = makeSessionUsage(undefined, { seq: 9 })
    const state = reduceEvents([start, reply, snapshot])

    // `makeSessionUsage` reports the fixtures' tokens, which the reply's spans never did —
    // so the value read is provably the event's and not the derivation's.
    expect(selectSessionUsage(state).totals).toEqual({
      input: 512,
      output: 64,
      cacheCreation: 0,
      cacheRead: 0,
    })
    expect(selectSessionUsage(state).models.map((entry) => entry.model)).toEqual([
      'anthropic/claude-sonnet-5',
    ])
  })

  it('prices a session per model, summing the priced requests and counting the unpriced', () => {
    // 1M input at $2/Mtok on a priced model, and an unpriced model that ran three requests.
    const usage = selectSessionUsage(
      reduceEvents([
        makeSessionUsage(
          [
            {
              model: 'anthropic/claude-sonnet-5',
              usage: {
                input_tokens: 1_000_000,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
              requests: 2,
            },
            {
              model: 'acme/mystery-1',
              usage: {
                input_tokens: 1000,
                output_tokens: 100,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
              requests: 3,
            },
          ],
          { seq: 1 },
        ),
      ]),
    )

    // All priced: the sum, and nothing left out.
    expect(sessionCost({ totals: usage.totals, models: [usage.models[0]!] }, priced)).toEqual({
      cost: 2,
      unpriced_requests: 0,
    })
    // Mixed (#247, decided 2026-10-09): the priced model's money, and the unpriced model's
    // *requests* counted — not the whole total turned unknowable.
    expect(sessionCost(usage, priced)).toEqual({ cost: 2, unpriced_requests: 3 })
    // Nothing priced: unknown, and the request count still names what was left out.
    expect(sessionCost(usage, () => null)).toEqual({ cost: null, unpriced_requests: 5 })
  })

  it('prices one reply, and answers null when the log or the catalog cannot', () => {
    const start = makeModelRequestStart({
      seq: 1,
      processed_at: fixtureTimestamp(1),
      model: 'anthropic/claude-sonnet-5',
    })
    const reply = makeAgentMessage('hi', { seq: 2, id: idA })
    const end = makeModelRequestEnd(start, {
      seq: 3,
      processed_at: fixtureTimestamp(3),
      model_usage: {
        input_tokens: 1000,
        output_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    })
    const meta = messageById(reduceEvents([start, reply, end]), idA).meta

    // 1,000 input at $2/Mtok and 100 output at $10/Mtok.
    expect(replyCost(meta, priced)).toBeCloseTo((1000 * 2 + 100 * 10) / 1_000_000, 12)
    expect(replyCost(meta, () => null)).toBeNull()
    expect(replyCost(undefined, priced)).toBeNull()
  })

  it('drops the running totals a rewind took back, falling back to what is left', () => {
    const start = makeModelRequestStart({
      seq: 1,
      processed_at: fixtureTimestamp(1),
      model: 'anthropic/claude-sonnet-5',
    })
    const reply = makeAgentMessage('old reply', { seq: 2, id: idA })
    const end = makeModelRequestEnd(start, { seq: 3, processed_at: fixtureTimestamp(3) })
    const message = makeUserMessage('write a haiku', { seq: 4, processed_at: fixtureTimestamp(4) })
    const snapshot = makeSessionUsage(undefined, { seq: 5 })
    const rewind = makeSessionRewind({ seq: 6, supersedes: { from_seq: 4, to_seq: 5 } })
    const edited = makeUserMessage('write a haiku about snow', {
      seq: 7,
      processed_at: null,
      id: idB,
    })

    const before = reduceEvents([start, reply, end, message, snapshot])
    expect(before.usage).not.toBeNull()

    const after = reduceEvents([start, reply, end, message, snapshot, rewind, edited])
    // The totals the rewind replaced counted a branch that is gone: the state starts over, and
    // the derivation from the messages that survived is what a UI reads until the next request
    // writes a fresh snapshot.
    expect(after.usage).toBeNull()
    expect(selectSessionUsage(after).totals).toEqual({
      input: 512,
      output: 64,
      cacheCreation: 0,
      cacheRead: 0,
    })
    expect(selectSessionUsage(after).models).toEqual([
      {
        model: 'anthropic/claude-sonnet-5',
        usage: { input: 512, output: 64, cacheCreation: 0, cacheRead: 0 },
        requests: 1,
      },
    ])
  })

  it('derives nothing from a reply the log does not name a model for', () => {
    // A reply with tokens but no model is in no breakdown: the totals stay the models' sum, so
    // a reader never sees a total it cannot break down.
    const message: TranscriptMessage = {
      id: idC,
      role: 'agent',
      parts: [{ type: 'text', text: 'hi' }],
      text: 'hi',
      pending: false,
      streaming: false,
      position: 1,
      meta: { usage: { input: 10, output: 2, cacheCreation: 0, cacheRead: 0, total: 12 } },
    }

    expect(sessionUsageOf([message])).toEqual({
      totals: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      models: [],
    })
  })
})

/**
 * The context visibility of epic #277 (#280): the summary dividers, the progress line, the
 * context meter's baseline and the truncation notice.
 *
 * Every event here carries an explicit `seq`, because that is what the rules are about: a
 * divider draws at the `seq` a summary covers, a rewind is tested against the `seq` an event
 * sits at, and the meter is the size the last real request reported.
 */
describe('context summaries (#277, K10; #280)', () => {
  /** The three input-side counters of a request's usage, which is the meter's measure. */
  const measured = (
    input: number,
    cacheCreation = 0,
    cacheRead = 0,
    output = 0,
  ): {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } => ({
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
  })

  it('marks where the older history was summarized, and keeps it on screen', () => {
    const user = makeUserMessage('hello', { seq: 1, processed_at: fixtureTimestamp() })
    const reply = makeAgentMessage('hi there', { seq: 2 })
    const summary = makeContextSummary({
      seq: 3,
      summary: 'They said hello and were answered.',
      covers: { to_seq: 2 },
      reason: 'threshold',
      summary_model: 'anthropic/claude-sonnet-5',
      passes: 3,
      tokens_before: 51_200,
    })

    const state = reduceEvents([user, reply, summary])

    // The history the summary covers is still the transcript's: a summary supersedes nothing.
    expect(asPairs(state)).toEqual(['user:hello', 'agent:hi there'])
    expect(selectSummaries(state)).toEqual([
      {
        id: summary.id,
        summary: 'They said hello and were answered.',
        reason: 'threshold',
        model: 'anthropic/claude-sonnet-5',
        passes: 3,
        tokensBefore: 51_200,
        // Where the model stops reading verbatim, not where the summary event sits.
        position: 2,
        seq: 3,
      },
    ])
  })

  it('records why a summary happened and what wrote it', () => {
    const manual = makeContextSummary({
      seq: 1,
      reason: 'manual',
      summary_model: 'openai/gpt-4o-mini',
      passes: 1,
      fallback_reason: 'no credential for the chosen summary model',
    })

    const state = reduceEvents([manual])

    expect(selectSummaries(state)[0]).toMatchObject({
      reason: 'manual',
      model: 'openai/gpt-4o-mini',
      passes: 1,
      fallbackReason: 'no credential for the chosen summary model',
    })
  })

  it('hides a summary a rewind took back, and the history under it', () => {
    const user = makeUserMessage('hello', { seq: 1, processed_at: fixtureTimestamp() })
    const reply = makeAgentMessage('hi there', { seq: 2 })
    const summary = makeContextSummary({ seq: 3, covers: { to_seq: 2 } })
    const rewind = makeSessionRewind({ seq: 4, supersedes: { from_seq: 1, to_seq: 3 } })
    const edited = makeUserMessage('hello again', { seq: 5, processed_at: fixtureTimestamp() })

    const state = reduceEvents([user, reply, summary, rewind, edited])

    // The rewind's range reaches to the end of the log as it stood, which is where the summary
    // event sits — so the summary goes with the branch it was written on.
    expect(selectSummaries(state)).toEqual([])
    expect(asPairs(state)).toEqual(['user:hello again'])
  })

  it('keeps a summary the rewind did not reach', () => {
    const user = makeUserMessage('hello', { seq: 1, processed_at: fixtureTimestamp() })
    const summary = makeContextSummary({ seq: 2, covers: { to_seq: 1 } })
    const later = makeUserMessage('and again', { seq: 3, processed_at: fixtureTimestamp() })
    // The edit is past the summary: only what follows it is taken back.
    const rewind = makeSessionRewind({ seq: 4, supersedes: { from_seq: 3, to_seq: 3 } })

    const state = reduceEvents([user, summary, later, rewind])

    expect(selectSummaries(state)).toHaveLength(1)
  })

  it('reports the pass a summary is on, and stops when the summary lands', () => {
    const progress = makeContextSummaryProgress({ seq: 1, pass: 3, passes: 7 })
    const summary = makeContextSummary({ seq: 2, covers: { to_seq: 0 } })

    const during = reduceEvents([progress])
    expect(selectSummarizing(during)).toEqual({ pass: 3, passes: 7, seq: 1 })

    const after = reduceEvents([progress, summary])
    expect(selectSummarizing(after)).toBeNull()
    expect(selectSummaries(after)).toHaveLength(1)
  })

  it('stops reporting a pass on a failure and on a turn end', () => {
    const progress = makeContextSummaryProgress({ seq: 1, pass: 1, passes: 2 })

    expect(selectSummarizing(reduceEvents([progress, makeSessionError({ seq: 2 })]))).toBeNull()
    expect(selectSummarizing(reduceEvents([progress, makeStatusIdle({ seq: 2 })]))).toBeNull()
  })

  it('stops reporting a pass when the chat makes its own request', () => {
    // A compaction that failed writes no summary and no error: the engine's passes are over and
    // the chat's request follows, which is the log's only way of saying so (K11).
    const progress = makeContextSummaryProgress({ seq: 1, pass: 1, passes: 2 })
    const start = makeModelRequestStart({ seq: 2, model: 'anthropic/claude-sonnet-5' })

    expect(selectSummarizing(reduceEvents([progress, start]))).toBeNull()
  })

  it('measures the context from the last real request it saw', () => {
    const user = makeUserMessage('hello', { seq: 1, processed_at: fixtureTimestamp() })
    const start = makeModelRequestStart({ seq: 2, model: 'anthropic/claude-sonnet-5' })
    const end = makeModelRequestEnd(start, {
      seq: 3,
      model_usage: measured(100, 20, 5, 7),
    })

    const state = reduceEvents([user, start, end])

    // The three input-side counters summed: cached tokens were really sent, so they are part of
    // how full the context is.
    expect(selectContext(state)).toEqual({ tokens: 125, estimated: false })
  })

  it('leaves the meter alone for a request that reported no tokens', () => {
    const first = makeModelRequestStart({ seq: 1 })
    const measuredEnd = makeModelRequestEnd(first, { seq: 2, model_usage: measured(400) })
    // A failed attempt closes its span with a zero usage: that is not a measurement.
    const second = makeModelRequestStart({ seq: 3 })
    const failed = makeModelRequestEnd(second, { seq: 4, model_usage: measured(0) })

    const state = reduceEvents([first, measuredEnd, second, failed])

    expect(selectContext(state)).toEqual({ tokens: 400, estimated: false })
  })

  it('never lets a summary request be a reply’s model or the meter’s baseline', () => {
    const user = makeUserMessage('hello', { seq: 1, processed_at: fixtureTimestamp() })
    const summaryStart = makeModelRequestStart({
      seq: 2,
      model: 'openai/gpt-4o-mini',
      purpose: 'summary',
    })
    const summaryEnd = makeModelRequestEnd(summaryStart, {
      seq: 3,
      model_usage: measured(9_000),
    })
    const summary = makeContextSummary({
      seq: 4,
      covers: { to_seq: 1 },
      summary_model: 'openai/gpt-4o-mini',
    })
    const chatStart = makeModelRequestStart({
      seq: 5,
      model: 'anthropic/claude-sonnet-5',
      consumes: [user.id],
    })
    const reply = makeAgentMessage('hi there', { seq: 6, id: idA })
    const chatEnd = makeModelRequestEnd(chatStart, { seq: 7, model_usage: measured(500, 0, 0, 7) })

    const state = reduceEvents([user, summaryStart, summaryEnd, summary, chatStart, reply, chatEnd])

    // The reply ran on the chat's model and took only the chat's tokens: a summary request
    // answers nothing, so it is neither the model a reply ran on nor what it cost.
    expect(messageById(state, reply.id).meta).toMatchObject({
      model: 'anthropic/claude-sonnet-5',
      usage: { input: 500, output: 7, cacheCreation: 0, cacheRead: 0, total: 507 },
    })
    // And the meter measures the chat's prompt, not the summarizer's 9,000.
    expect(selectContext(state)).toEqual({ tokens: 500, estimated: false })
  })

  it('estimates the context a summary leaves until the next real request', () => {
    const user = makeUserMessage('x'.repeat(400), { seq: 1, processed_at: fixtureTimestamp() })
    const reply = makeAgentMessage('y'.repeat(400), { seq: 2, id: idB })
    const start = makeModelRequestStart({ seq: 3, model: 'anthropic/claude-sonnet-5' })
    const end = makeModelRequestEnd(start, { seq: 4, model_usage: measured(1_000) })
    // 800 characters of conversation (the newline between the two messages too) replaced by
    // five: 201 tokens became 2, so the measured 1,000 drops by 199.
    const summary = makeContextSummary({
      seq: 5,
      summary: 'short',
      covers: { to_seq: 2 },
      tokens_before: 1_000,
    })

    const after = reduceEvents([user, reply, start, end, summary])
    expect(selectContext(after)).toEqual({ tokens: 801, estimated: true })

    // The next real request is what the meter reports from then on.
    const nextStart = makeModelRequestStart({ seq: 6 })
    const nextEnd = makeModelRequestEnd(nextStart, { seq: 7, model_usage: measured(120) })
    const measuredAgain = reduceEvents([user, reply, start, end, summary, nextStart, nextEnd])
    expect(selectContext(measuredAgain)).toEqual({ tokens: 120, estimated: false })
  })

  it('falls back to the size the summary recorded when no request measured one', () => {
    const user = makeUserMessage('x'.repeat(400), { seq: 1, processed_at: fixtureTimestamp() })
    const summary = makeContextSummary({
      seq: 2,
      summary: 'short',
      covers: { to_seq: 1 },
      tokens_before: 5_000,
    })

    // Nothing has measured a prompt, so the summary's own reading of the context is the
    // baseline: its 100 tokens of covered history became 2, and the result is still an estimate
    // of what the model will be told next.
    expect(selectContext(reduceEvents([user, summary]))).toEqual({ tokens: 4_902, estimated: true })
  })

  it('says the newest item was shortened, and clears it on the next real request', () => {
    const long = makeUserMessage('x'.repeat(400), { seq: 1, processed_at: fixtureTimestamp() })
    const capped = makeModelRequestStart({
      seq: 2,
      model: 'anthropic/claude-sonnet-5',
      consumes: [long.id],
      truncated: { seq: 1, tokens_before: 100, tokens_after: 40 },
    })

    const state = reduceEvents([long, capped])
    expect(selectTruncation(state)).toEqual({
      seq: 1,
      tokensBefore: 100,
      tokensAfter: 40,
      recordedAt: 2,
    })

    // A later request that capped nothing is the answer to "is the newest item too long?".
    const next = makeModelRequestStart({ seq: 3, model: 'anthropic/claude-sonnet-5' })
    expect(selectTruncation(reduceEvents([long, capped, next]))).toBeNull()
  })

  it('takes the truncation notice back with the message a rewind replaced', () => {
    const long = makeUserMessage('x'.repeat(400), { seq: 1, processed_at: fixtureTimestamp() })
    const capped = makeModelRequestStart({
      seq: 2,
      truncated: { seq: 1, tokens_before: 100, tokens_after: 40 },
    })
    const rewind = makeSessionRewind({ seq: 3, supersedes: { from_seq: 1, to_seq: 2 } })

    expect(selectTruncation(reduceEvents([long, capped, rewind]))).toBeNull()
  })

  it('drops the meter, the progress and the notice a rewind took back', () => {
    const user = makeUserMessage('hello', { seq: 1, processed_at: fixtureTimestamp() })
    const progress = makeContextSummaryProgress({ seq: 2, pass: 1, passes: 2 })
    const start = makeModelRequestStart({ seq: 3, model: 'anthropic/claude-sonnet-5' })
    const end = makeModelRequestEnd(start, { seq: 4, model_usage: measured(900) })
    // The edit comes after the measurement: everything before it is taken back.
    const rewind = makeSessionRewind({ seq: 5, supersedes: { from_seq: 1, to_seq: 4 } })

    const state = reduceEvents([user, progress, start, end, rewind])

    expect(selectContext(state)).toBeNull()
    expect(selectSummarizing(state)).toBeNull()
    expect(selectMessages(state)).toEqual([])
  })

  it('folds a replayed summary twice into one divider', () => {
    const summary = makeContextSummary({ seq: 1, covers: { to_seq: 0 } })

    expect(selectSummaries(reduceEvents([summary, summary]))).toHaveLength(1)
  })

  it('ignores a progress event it has already seen', () => {
    const progress = makeContextSummaryProgress({ seq: 2, pass: 2, passes: 3 })
    const older = makeContextSummaryProgress({ seq: 1, pass: 1, passes: 3 })

    // The dedupe is the `seq` rule every event takes: a replay cannot move the line backwards.
    expect(selectSummarizing(reduceEvents([progress, older]))).toEqual({
      pass: 2,
      passes: 3,
      seq: 2,
    })
  })
})

/** The one ordered list both frontends render (#280), so a divider lands in the same place. */
describe('selectTranscriptEntries (#280)', () => {
  it('draws a divider after the message whose history it covers', () => {
    const user = makeUserMessage('hello', { seq: 1, processed_at: fixtureTimestamp() })
    const reply = makeAgentMessage('hi there', { seq: 2 })
    // Covers exactly the user message: the divider belongs between it and the reply.
    const summary = makeContextSummary({ seq: 3, covers: { to_seq: 1 } })
    const later = makeUserMessage('again', { seq: 4, processed_at: fixtureTimestamp() })

    const state = reduceEvents([user, reply, summary, later])

    expect(
      selectTranscriptEntries(state).map((entry) =>
        entry.kind === 'message' ? `${entry.message.role}:${entry.message.text}` : entry.kind,
      ),
    ).toEqual(['user:hello', 'summary', 'agent:hi there', 'user:again'])
  })

  it('keeps a divider at the end when it covers the whole conversation', () => {
    const user = makeUserMessage('hello', { seq: 1, processed_at: fixtureTimestamp() })
    const summary = makeContextSummary({ seq: 2, covers: { to_seq: 1 } })

    const state = reduceEvents([user, summary])

    expect(selectTranscriptEntries(state).map((entry) => entry.kind)).toEqual([
      'message',
      'summary',
    ])
  })

  it('is the messages alone for a conversation with no summary', () => {
    const state = reduceEvents([makeUserMessage('hello', { seq: 1 })])

    expect(selectTranscriptEntries(state).every((entry) => entry.kind === 'message')).toBe(true)
  })
})

describe('a manual compaction (#277, K8; #283)', () => {
  it('is pending from the request until the brain answers it', () => {
    const pending = reduceEvents([makeSessionCompact({ seq: 5 })])

    // The ask is stored and answered asynchronously, so "the newest of the pair is a request" is
    // the state a UI draws "Compacting…" from.
    expect(selectManualCompaction(pending)).toEqual({ pending: true, outcome: null, seq: 5 })

    const answered = reduceEvents([
      makeSessionCompact({ seq: 5 }),
      makeSessionCompaction({ seq: 6, outcome: 'summarized', summary_seq: 9 }),
    ])
    expect(selectManualCompaction(answered)).toEqual({
      pending: false,
      outcome: 'summarized',
      seq: 6,
    })
  })

  it('carries the brain’s sentence for the two outcomes a reader is owed one for', () => {
    const nothing = reduceEvents([
      makeSessionCompact({ seq: 1 }),
      makeSessionCompaction({
        seq: 2,
        outcome: 'nothing_to_summarize',
        message: 'There is no older history yet.',
      }),
    ])
    expect(selectManualCompaction(nothing)).toEqual({
      pending: false,
      outcome: 'nothing_to_summarize',
      message: 'There is no older history yet.',
      seq: 2,
    })

    const failed = reduceEvents([
      makeSessionCompact({ seq: 1 }),
      makeSessionCompaction({ seq: 2, outcome: 'failed', message: 'The model refused.' }),
    ])
    expect(selectManualCompaction(failed)?.outcome).toBe('failed')
  })

  it('is the same rule the route’s idempotency reads, so a second ask while one waits is pending', () => {
    // Two requests with no answer between them: the newest of the pair is still a request, which
    // is exactly what `POST …/compact` reads to answer with the one already waiting (#283).
    const state = reduceEvents([makeSessionCompact({ seq: 1 }), makeSessionCompact({ seq: 2 })])
    expect(selectManualCompaction(state)).toEqual({ pending: true, outcome: null, seq: 2 })
  })

  it('is null for a conversation nobody asked to compact', () => {
    expect(selectManualCompaction(reduceEvents([makeUserMessage('hello', { seq: 1 })]))).toBeNull()
  })

  it('goes with the branch a rewind took back', () => {
    const state = reduceEvents([
      makeSessionCompact({ seq: 2 }),
      makeSessionCompaction({ seq: 3, outcome: 'failed', message: 'The model refused.' }),
      // The edit reaches from the request through the outcome, so both are the reader's to take
      // back — the same test a summary's or a truncation notice's `seq` gets.
      makeSessionRewind({ seq: 4, supersedes: { from_seq: 2, to_seq: 3 } }),
    ])

    expect(selectManualCompaction(state)).toBeNull()
  })
})
