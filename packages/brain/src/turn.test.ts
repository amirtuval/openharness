import {
  FIXTURE_MODEL_USAGE,
  makeModelRequestEnd,
  makeModelRequestStart,
  makeStatusRescheduled,
  makeStatusRunning,
  makeUserMessage,
} from '@openharness/protocol/fixtures'
import {
  EVENT_TYPES,
  newEventId,
  newSessionId,
  partitionOf,
  StoredEventSchema,
} from '@openharness/protocol'
import type {
  EventId,
  ModelRequestEndEvent,
  SessionId,
  StoredEvent,
  Supersedes,
} from '@openharness/protocol'
import { InMemorySessionStore, isFencedError } from '@openharness/session'
import type { AppendableEvent, AppendEventsOptions, SessionStore } from '@openharness/session'
import { describe, expect, it, vi } from 'vitest'

import { eventDelta, eventStart, spanStart } from './events'
import { isClaimConflictError } from './errors'
import type { ModelFactory } from './model'
import { misdeclaredSpec, mockModel, readPrompt, type MockModelScript } from './testing/mock-model'
import {
  TEST_MODEL_ID,
  TEST_OWNER_ID,
  chunkDeltaOf,
  chunksOf,
  deltaTextOf,
  eventTypes,
  interrupt,
  logOf,
  message,
  newSession,
  rawLogOf,
  settle,
  spanStartOf,
  textOf,
} from './testing/harness'
import { runTurn } from './turn'

/**
 * The turn loop, driven end to end: a real `InMemorySessionStore`, a scripted mock model, and
 * the log asserted event by event.
 *
 * The order of the events is the contract — a client replays the log, so a status that lands
 * after the reply it closes, or a span that is never closed, is a bug the tests have to catch
 * rather than a detail a reader can infer. Since D9 (issue #46) the tests assert three more
 * things on every scenario: the claim a span start carries (`consumes`), the model that served
 * the request, and that **replay holds no superseded chunk** — the log a client reads back is
 * the log it would have followed live.
 */

/** A retryable provider error, the shape a real SDK throws. */
function rateLimited(): Error {
  return Object.assign(new Error('Rate limited by the provider.'), { statusCode: 429 })
}

/** A failure the model reports mid-stream, after some text reached the client. */
function overloaded(): Error {
  return Object.assign(new Error('Overloaded.'), { statusCode: 503 })
}

/** Whether an appendable event opens a model-request span. */
function isSpanStart(event: AppendableEvent): boolean {
  return event.type === EVENT_TYPES.modelRequestStart
}

/** Every chunk of `raw` a recorded `supersedes` range covers. */
function supersededChunks(raw: readonly StoredEvent[]): StoredEvent[] {
  const ranges = raw.flatMap((event): Supersedes[] =>
    'supersedes' in event && event.supersedes !== undefined ? [event.supersedes] : [],
  )
  return chunksOf(raw).filter((chunk) =>
    ranges.some((range) => chunk.seq >= range.from_seq && chunk.seq <= range.to_seq),
  )
}

/**
 * The claim, the model and the replay of a log, asserted together.
 *
 * The three halves of D9 the loop owns: every span start claims what it answers and records the
 * model that ran; every superseded chunk is gone from the replay read; and what the replay does
 * hold is the exact protocol shape.
 */
async function expectClean(
  store: SessionStore,
  sessionId: Parameters<typeof logOf>[1],
): Promise<void> {
  const raw = await rawLogOf(store as InMemorySessionStore, sessionId)
  const replayed = await logOf(store as InMemorySessionStore, sessionId)

  // The replay read is what a client resumes from: it skips exactly the superseded chunks.
  const superseded = new Set(supersededChunks(raw).map((chunk) => chunk.id))
  expect(replayed.some((event) => superseded.has(event.id))).toBe(false)

  for (const event of raw) {
    expect(StoredEventSchema.safeParse(event).success, `${event.type} parses`).toBe(true)
    if (event.type === EVENT_TYPES.modelRequestStart) {
      // Every span start is a real model request: it claims what it answers, records the model
      // that served it, and — since P4 removed the claim span — a span start with no request
      // behind it does not exist.
      expect(event.consumes, `${event.id} claims`).toBeDefined()
      expect(event.model, `${event.id} records its model`).toBe(TEST_MODEL_ID)
    }
  }
  // Every claim names a real user event of the log, and no event is claimed twice. The three
  // event types may carry a claim (P4): a span start, a span end, a status idle.
  const claimed: EventId[] = []
  for (const event of raw) {
    if (
      event.type !== EVENT_TYPES.modelRequestStart &&
      event.type !== EVENT_TYPES.modelRequestEnd &&
      event.type !== EVENT_TYPES.sessionStatusIdle
    ) {
      continue
    }
    for (const id of event.consumes ?? []) {
      expect(
        raw.some((other) => other.id === id),
        `${event.id} claims ${id}`,
      ).toBe(true)
      expect(claimed, `${id} is claimed once`).not.toContain(id)
      claimed.push(id)
    }
  }
}

/** The `supersedes` range of the `n`-th `span.model_request_end` of a log. */
function spanEndRange(log: readonly StoredEvent[], n: number): Supersedes | undefined {
  const ends = log.filter(
    (event): event is ModelRequestEndEvent => event.type === EVENT_TYPES.modelRequestEnd,
  )
  return ends[n]?.supersedes
}

describe('runTurn', () => {
  it('does nothing when there is no turn and nothing queued', async () => {
    const { store, sessionId } = await newSession()
    const { factory, calls } = mockModel({ text: ['unused'] })

    const outcome = await runTurn(sessionId, { store, model: factory })

    expect(outcome).toEqual({ outcome: 'noop' })
    expect(await rawLogOf(store, sessionId)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('runs a turn in the documented order, claims its prompt, and supersedes its chunks', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const { factory } = mockModel({ text: ['Hi ', 'there'] })

    const outcome = await runTurn(sessionId, { store, model: factory })

    expect(outcome).toEqual({ outcome: 'idle' })
    const raw = await rawLogOf(store, sessionId)
    expect(eventTypes(raw)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.eventStart,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    const [user, running, start, chunkStart, deltaOne, deltaTwo, reply, end, idle] = raw
    expect(running?.type).toBe(EVENT_TYPES.sessionStatusRunning)
    expect(user?.processed_at).not.toBeNull()

    // The claim: the span start lists the message it answers, and the model that served it.
    expect(start).toMatchObject({
      type: EVENT_TYPES.modelRequestStart,
      consumes: [user?.id],
      model: TEST_MODEL_ID,
    })

    // The chunks: stored events under the id the message will be stored under, in order.
    expect(chunkStart).toMatchObject({
      type: EVENT_TYPES.eventStart,
      event: { type: EVENT_TYPES.agentMessage, id: reply?.id },
    })
    expect(chunksOf(raw).map((chunk) => chunk.seq)).toEqual([4, 5, 6])
    expect(deltaTextOf(chunkDeltaOf(deltaOne))).toBe('Hi ')
    expect(deltaTextOf(chunkDeltaOf(deltaTwo))).toBe('there')

    // The message supersedes exactly the range its chunks cover.
    expect(reply).toMatchObject({
      type: EVENT_TYPES.agentMessage,
      supersedes: { from_seq: 4, to_seq: 6 },
    })
    expect(textOf(reply)).toBe('Hi there')
    expect(end).toMatchObject({
      type: EVENT_TYPES.modelRequestEnd,
      model_request_start_id: start?.id,
      model_usage: FIXTURE_MODEL_USAGE,
      is_error: null,
    })
    expect(idle).toMatchObject({
      type: EVENT_TYPES.sessionStatusIdle,
      stop_reason: { type: 'end_turn' },
    })

    // What a client reads back: no chunks, the message once, everything claimed.
    const replayed = await logOf(store, sessionId)
    expect(eventTypes(replayed)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    expect(replayed.every((event) => event.processed_at !== null)).toBe(true)
    await expectClean(store, sessionId)
  })

  it('appends each chunk as it arrives, under the id its message is stored with', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const { factory } = mockModel({ text: ['Hi ', 'there'] })
    const delivered: StoredEvent[] = []
    await store.subscribe(sessionId, (event) => {
      if (event.type === EVENT_TYPES.eventStart || event.type === EVENT_TYPES.eventDelta) {
        delivered.push(event)
      }
    })

    await runTurn(sessionId, { store, model: factory })
    await settle()

    // A chunk is a stored event: it reaches a live subscriber with its `id` and `seq`, and in
    // the order the log holds — which is what makes a resume from mid-reply possible at all.
    expect(delivered.map((event) => event.type)).toEqual([
      EVENT_TYPES.eventStart,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.eventDelta,
    ])
    expect(delivered.map((event) => event.seq)).toEqual([4, 5, 6])

    const raw = await rawLogOf(store, sessionId)
    const reply = raw.find((event) => event.type === EVENT_TYPES.agentMessage)
    const chunks = chunksOf(raw)
    expect(chunks[0]).toMatchObject({
      type: EVENT_TYPES.eventStart,
      event: { type: EVENT_TYPES.agentMessage, id: reply?.id },
    })
    expect(
      chunks.slice(1).map((chunk) => (chunk.type === EVENT_TYPES.eventDelta ? chunk.event_id : '')),
    ).toEqual([reply?.id, reply?.id])
    // The chunks spell the reply, which is the guarantee a client's accumulator relies on.
    expect(
      chunks
        .flatMap((chunk) => (chunk.type === EVENT_TYPES.eventDelta ? [deltaTextOf(chunk)] : []))
        .join(''),
    ).toBe(textOf(reply))
  })

  it('stores the counts a mis-declared provider spec hides, as integers', async () => {
    // Issue #39: the router declares the `v2` provider spec while reporting v3-shaped usage, so
    // the AI SDK sums those reports into `"0[object Object]"`. The turn must store the counts
    // the request really spent — and a log a client can replay, event for event.
    const { store, sessionId } = await newSession([message('Hello')])
    const { factory } = mockModel({
      text: ['Hi'],
      usage: { input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 2 },
    })
    const model: ModelFactory = (modelId) => misdeclaredSpec(factory(modelId))

    const outcome = await runTurn(sessionId, { store, model })

    expect(outcome).toEqual({ outcome: 'idle' })
    const log = await rawLogOf(store, sessionId)
    expect(log.find((event) => event.type === EVENT_TYPES.modelRequestEnd)).toMatchObject({
      type: EVENT_TYPES.modelRequestEnd,
      is_error: null,
      model_usage: {
        input_tokens: 9,
        output_tokens: 3,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
      },
    })
    await expectClean(store, sessionId)
  })

  it('picks up a message that arrives mid-stream in a second request', async () => {
    const { store, sessionId } = await newSession([message('First')])
    let steeringId: EventId | undefined
    const { factory, calls } = mockModel(
      {
        text: ['Answering ', 'the first'],
        onChunk: async (_chunk, index) => {
          if (index === 0) {
            const [steering] = await store.appendEvents(sessionId, [
              { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'Steering' }] },
            ])
            steeringId = steering?.id
          }
        },
      },
      { text: ['Answering the steering message'] },
    )

    const outcome = await runTurn(sessionId, { store, model: factory })

    expect(outcome).toEqual({ outcome: 'idle' })
    const raw = await rawLogOf(store, sessionId)
    expect(eventTypes(raw)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.eventStart,
      // The steering message lands in the log while the first request is still streaming, ahead
      // of the reply to the message before it.
      EVENT_TYPES.userMessage,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.eventStart,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])

    // The second request claims the steering message; the first one claims only the message it
    // was started for.
    const starts = raw.filter((event) => event.type === EVENT_TYPES.modelRequestStart)
    expect(starts[0]).toMatchObject({ consumes: [raw[0]?.id] })
    expect(starts[1]).toMatchObject({ consumes: [steeringId] })
    // A message the request in flight did not answer is still claimed by the request it started.
    expect((await rawLogOf(store, sessionId)).every((event) => event.processed_at !== null)).toBe(
      true,
    )
    expect(await store.getPendingUserEvents(sessionId)).toEqual([])

    // The steering message was not answered by the request that was already in flight: it is
    // the second request's prompt that carries it.
    expect(calls).toHaveLength(2)
    expect(readPrompt(calls[0]!)).toEqual([
      { role: 'system', text: 'You are a concise technical assistant.' },
      { role: 'user', text: 'First' },
    ])
    // In `seq` order, which is the log's: the steering message was appended while the first
    // request was streaming, so it precedes that request's reply.
    expect(readPrompt(calls[1]!)).toEqual([
      { role: 'system', text: 'You are a concise technical assistant.' },
      { role: 'user', text: 'First' },
      { role: 'user', text: 'Steering' },
      { role: 'assistant', text: 'Answering the first' },
    ])
    await expectClean(store, sessionId)
  })

  it('keeps the partial text and closes the span when the turn is aborted', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const controller = new AbortController()
    await store.subscribe(sessionId, (event) => {
      if (event.type === EVENT_TYPES.eventDelta) {
        controller.abort()
      }
    })
    const { factory } = mockModel({ text: ['Par', 'tial'] })

    const outcome = await runTurn(sessionId, { store, model: factory, signal: controller.signal })

    expect(outcome).toEqual({ outcome: 'interrupted' })
    const raw = await rawLogOf(store, sessionId)
    // The abort lands while a chunk is in flight, so what was stored is a prefix of the reply.
    const reply = raw.find((event) => event.type === EVENT_TYPES.agentMessage)
    const partial = textOf(reply)
    expect(partial).not.toBe('')
    expect('Partial'.startsWith(partial)).toBe(true)

    // The partial message supersedes the chunks it was streamed as; the span end closes the
    // request without a range of its own, because the message carries it.
    const storedChunks = chunksOf(raw)
    expect(reply?.supersedes).toEqual({
      from_seq: storedChunks[0]?.seq,
      to_seq: storedChunks[storedChunks.length - 1]?.seq,
    })
    const end = raw.find((event) => event.type === EVENT_TYPES.modelRequestEnd)
    expect(end).toMatchObject({
      is_error: true,
      error: { type: 'interrupted' },
      model_usage: { input_tokens: 0, output_tokens: 0 },
    })
    expect(end && 'supersedes' in end ? end.supersedes : undefined).toBeUndefined()
    expect(raw[raw.length - 1]).toMatchObject({ type: EVENT_TYPES.sessionStatusIdle })
    await expectClean(store, sessionId)
  })

  it('stores no message and supersedes the chunks when the interrupt precedes any text', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const controller = new AbortController()
    // Abort in the window between the reply's `event_start` and its first delta: the request is
    // cut short with nothing to store, and the chunk it announced is orphaned.
    await store.subscribe(sessionId, (event) => {
      if (event.type === EVENT_TYPES.eventStart) {
        controller.abort()
      }
    })
    const { factory } = mockModel({ text: [] })

    const outcome = await runTurn(sessionId, { store, model: factory, signal: controller.signal })

    expect(outcome).toEqual({ outcome: 'interrupted' })
    const raw = await rawLogOf(store, sessionId)
    expect(eventTypes(raw)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.eventStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    // No message: an empty `agent.message` would be a reply the model did not make. The span
    // end supersedes the chunk instead, so replay never sees it.
    expect(raw.some((event) => event.type === EVENT_TYPES.agentMessage)).toBe(false)
    expect(spanEndRange(raw, 0)).toEqual({ from_seq: 4, to_seq: 4 })
    await expectClean(store, sessionId)
  })

  it('stores no message when the reply is empty, and the span end supersedes the event_start', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const { factory, calls } = mockModel({ text: [] })

    const outcome = await runTurn(sessionId, { store, model: factory })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(calls).toHaveLength(1)
    const raw = await rawLogOf(store, sessionId)
    expect(eventTypes(raw)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.eventStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    expect(raw.some((event) => event.type === EVENT_TYPES.agentMessage)).toBe(false)
    expect(raw[4]).toMatchObject({ is_error: null, model_usage: FIXTURE_MODEL_USAGE })
    expect(spanEndRange(raw, 0)).toEqual({ from_seq: 4, to_seq: 4 })
    await expectClean(store, sessionId)
  })

  it('ends the turn when a user.interrupt is waiting before the first request', async () => {
    const { store, sessionId } = await newSession([interrupt(), message('Hello')])
    const { factory, calls } = mockModel({ text: ['unused'] })

    const outcome = await runTurn(sessionId, { store, model: factory })

    expect(outcome).toEqual({ outcome: 'interrupted' })
    const raw = await rawLogOf(store, sessionId)
    // Nothing was running, so the turn ends on the interrupt and its `session.status_idle`
    // carries the claim (P4). No span is opened for an interrupt: there is no model request
    // to bracket, and since P4 no span exists without one.
    expect(eventTypes(raw)).toEqual([
      EVENT_TYPES.userInterrupt,
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.sessionStatusIdle,
    ])
    expect(raw[3]).toMatchObject({
      type: EVENT_TYPES.sessionStatusIdle,
      consumes: [raw[0]?.id],
    })
    // The interrupt was claimed; the message it interrupted was not, so the next turn answers it.
    expect(raw[0]?.processed_at).not.toBeNull()
    expect(raw[1]?.processed_at).toBeNull()
    expect(calls).toHaveLength(0)
    expect(await store.getPendingUserEvents(sessionId)).toHaveLength(1)
    await expectClean(store, sessionId)
  })

  it('claims a user.interrupt that arrives while the turn is streaming on the span end', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    let interruptId: EventId | undefined
    const controller = new AbortController()
    const { factory } = mockModel({
      text: ['one', 'two'],
      onChunk: async (_chunk, index) => {
        if (index === 0) {
          const [event] = await store.appendEvents(sessionId, [{ type: 'user.interrupt' }])
          interruptId = event?.id
          controller.abort()
        }
      },
    })

    const outcome = await runTurn(sessionId, { store, model: factory, signal: controller.signal })

    expect(outcome).toEqual({ outcome: 'interrupted' })
    const raw = await rawLogOf(store, sessionId)
    // The interrupt stopped an open request, so that request's span end is what claims it —
    // and it is the only span in the log: the turn called the model once.
    expect(raw.filter(isSpanStart)).toHaveLength(1)
    const end = raw.find((event) => event.type === EVENT_TYPES.modelRequestEnd)
    expect(end).toMatchObject({
      is_error: true,
      error: { type: 'interrupted' },
      consumes: [interruptId],
    })
    expect(await store.getPendingUserEvents(sessionId)).toEqual([])
    await expectClean(store, sessionId)
  })

  it('claims a user.interrupt that arrives with nothing running on the status idle', async () => {
    // The interrupt lands during the backoff after a failed request: the span is already
    // closed, so nothing is in flight to end, and the turn's idle event is what claims it.
    const { store, sessionId } = await newSession([message('Hello')])
    let interruptId: EventId | undefined
    const controller = new AbortController()
    const { factory } = mockModel({ failWith: rateLimited() })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      signal: controller.signal,
      retry: {
        sleep: async () => {
          const [event] = await store.appendEvents(sessionId, [{ type: 'user.interrupt' }])
          interruptId = event?.id
          controller.abort()
        },
      },
    })

    expect(outcome).toEqual({ outcome: 'interrupted' })
    const raw = await rawLogOf(store, sessionId)
    expect(raw.filter(isSpanStart)).toHaveLength(1)
    expect(raw.at(-1)).toMatchObject({
      type: EVENT_TYPES.sessionStatusIdle,
      consumes: [interruptId],
    })
    expect(await store.getPendingUserEvents(sessionId)).toEqual([])
    await expectClean(store, sessionId)
  })

  it('ends the turn when the signal is already aborted', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const controller = new AbortController()
    controller.abort()
    const { factory, calls } = mockModel({ text: ['unused'] })

    const outcome = await runTurn(sessionId, { store, model: factory, signal: controller.signal })

    expect(outcome).toEqual({ outcome: 'interrupted' })
    expect(eventTypes(await rawLogOf(store, sessionId))).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.sessionStatusIdle,
    ])
    expect(calls).toHaveLength(0)
  })

  it('retries a retryable failure and finishes the turn', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const sleep = vi.fn(async () => {})
    const { factory, calls } = mockModel({ failWith: rateLimited() }, { text: ['Recovered'] })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      retry: { sleep, jitter: () => 0.5 },
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    const raw = await rawLogOf(store, sessionId)
    expect(eventTypes(raw)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.eventStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionError,
      EVENT_TYPES.sessionStatusRescheduled,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.eventStart,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    // The failed attempt closes its span with the range of the chunks it announced — there is
    // no message coming for them — and the retry opens a fresh span with a new message id.
    expect(raw[4]).toMatchObject({
      is_error: true,
      error: { type: 'model_error' },
      model_usage: { input_tokens: 0, output_tokens: 0 },
      supersedes: { from_seq: 4, to_seq: 4 },
    })
    const firstChunks = chunksOf(raw.slice(0, 5))
    const retryChunks = chunksOf(raw.slice(8))
    expect(firstChunks).toHaveLength(1)
    expect(chunksOf(raw).length).toBe(firstChunks.length + retryChunks.length)
    expect(
      retryChunks[0]?.type === EVENT_TYPES.eventStart ? retryChunks[0].event.id : undefined,
    ).not.toBe(
      firstChunks[0]?.type === EVENT_TYPES.eventStart ? firstChunks[0].event.id : undefined,
    )
    expect(raw[5]).toMatchObject({
      type: EVENT_TYPES.sessionError,
      error: {
        type: 'model_rate_limited_error',
        message: 'Rate limited by the provider.',
        retry_status: { type: 'retrying' },
      },
    })
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(2)
    await expectClean(store, sessionId)
  })

  it('classifies a 5xx as an overloaded model, and never stores the partial output', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const { factory, calls } = mockModel(
      { text: ['ok'], failAfterText: overloaded() },
      { text: ['Recovered'] },
    )

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      retry: { sleep: async () => {} },
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(calls).toHaveLength(2)
    const raw = await rawLogOf(store, sessionId)
    expect(raw[6]).toMatchObject({
      type: EVENT_TYPES.sessionError,
      error: { type: 'model_overloaded_error', retry_status: { type: 'retrying' } },
    })
    // Text streamed before the failure is not stored: the retried request answers in full, and
    // the chunks of the failed attempt are superseded by its span end.
    const messages = raw.filter((event) => event.type === EVENT_TYPES.agentMessage)
    expect(messages).toHaveLength(1)
    expect(textOf(messages[0])).toBe('Recovered')
    expect(spanEndRange(raw, 0)).toEqual({ from_seq: 4, to_seq: 5 })
    await expectClean(store, sessionId)
  })

  it('gives up after the retries are exhausted', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const sleep = vi.fn(async () => {})
    const { factory, calls } = mockModel({ failWith: rateLimited() })

    const outcome = await runTurn(sessionId, { store, model: factory, retry: { sleep } })

    expect(outcome).toEqual({ outcome: 'error' })
    expect(calls).toHaveLength(4)
    const raw = await rawLogOf(store, sessionId)
    const ends = raw.filter((event) => event.type === EVENT_TYPES.modelRequestEnd)
    expect(ends).toHaveLength(4)
    // Every attempt superseded the chunk it announced: no orphaned range is left behind.
    expect(ends.map((end) => end.supersedes)).toEqual(
      chunksOf(raw).map((chunk) => ({ from_seq: chunk.seq, to_seq: chunk.seq })),
    )
    for (const end of ends) {
      expect(end).toMatchObject({ is_error: true })
    }
    expect(raw.filter((event) => event.type === EVENT_TYPES.sessionError).at(-1)).toMatchObject({
      error: { retry_status: { type: 'exhausted' } },
    })
    expect(sleep).toHaveBeenCalledTimes(3)
    expect(await store.getTurnState(sessionId)).toMatchObject({ state: 'idle' })
    await expectClean(store, sessionId)
  })

  it('ends the turn without retrying a failure that is not retryable', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const sleep = vi.fn(async () => {})
    const { factory, calls } = mockModel({
      failWith: Object.assign(new Error('Bad request.'), { statusCode: 400 }),
    })

    const outcome = await runTurn(sessionId, { store, model: factory, retry: { sleep } })

    expect(outcome).toEqual({ outcome: 'error' })
    expect(calls).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
    const raw = await rawLogOf(store, sessionId)
    expect(eventTypes(raw)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.eventStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionError,
      EVENT_TYPES.sessionStatusIdle,
    ])
    expect(raw[5]).toMatchObject({
      error: { type: 'model_request_failed_error', retry_status: { type: 'terminal' } },
    })
    await expectClean(store, sessionId)
  })

  it('ends the turn when the signal aborts during the backoff', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const controller = new AbortController()
    const { factory, calls } = mockModel({ failWith: rateLimited() })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      signal: controller.signal,
      retry: {
        sleep: () => {
          controller.abort()
          return Promise.resolve()
        },
      },
    })

    expect(outcome).toEqual({ outcome: 'interrupted' })
    expect(calls).toHaveLength(1)
    expect(eventTypes(await rawLogOf(store, sessionId))).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.eventStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionError,
      EVENT_TYPES.sessionStatusRescheduled,
      EVENT_TYPES.sessionStatusIdle,
    ])
    await expectClean(store, sessionId)
  })

  it('stops at a fenced write and writes nothing more', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const partition = partitionOf(sessionId)
    const lease = await store.acquirePartition(partition, 'owner-1', 30_000)
    expect(lease).not.toBeNull()
    const { factory } = mockModel({
      text: ['Hi'],
      onChunk: async () => {
        // Another owner takes the partition over while the request is streaming.
        await store.releasePartition(partition, 'owner-1', lease!.epoch)
      },
    })

    await expect(
      runTurn(sessionId, {
        store,
        model: factory,
        fence: { partition, epoch: lease!.epoch },
      }),
    ).rejects.toSatisfy(isFencedError)

    // The chunk the request had announced is where the write stopped: the delta could not be
    // stored under a lost lease, and nothing was written after it.
    expect(eventTypes(await rawLogOf(store, sessionId))).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.eventStart,
    ])
  })

  it('stops when another owner claimed the events it was about to answer', async () => {
    // The fencing loss of D9: the claim is the append of the span start, so a rival owner that
    // takes the message in the moment between this brain's read and its append wins, and the
    // brain stops where it stands instead of answering something that is not its to answer.
    /** A store where a rival owner claims the message just before the span start lands. */
    class RivalStore extends InMemorySessionStore {
      /** The events the rival takes at the next span-start append. */
      rivalTargets: EventId[] = []

      override async appendEvents(
        sessionId: SessionId,
        events: AppendableEvent[],
        options?: AppendEventsOptions,
      ): Promise<StoredEvent[]> {
        if (this.rivalTargets.length > 0 && events.some(isSpanStart)) {
          // The rival claims the way the contract says one does: a span start of its own,
          // whose `consumes` takes the event (P4 — the claim is the append).
          await super.appendEvents(sessionId, [spanStart(this.rivalTargets, TEST_MODEL_ID)])
          this.rivalTargets = []
        }
        return super.appendEvents(sessionId, events, options)
      }
    }

    const store = new RivalStore()
    const agent = await store.createAgent(
      {
        name: 'Summarizer',
        model: { id: TEST_MODEL_ID },
        system: 'You are a concise technical assistant.',
      },
      TEST_OWNER_ID,
    )
    const session = await store.createSession(agent.id, {
      ownerId: TEST_OWNER_ID,
      initial_events: [message('Hello')],
    })
    const [pending] = await store.getPendingUserEvents(session.id)
    store.rivalTargets = [pending?.id ?? newEventId()]
    const { factory, calls } = mockModel({ text: ['unused'] })

    await expect(runTurn(session.id, { store, model: factory })).rejects.toSatisfy(
      isClaimConflictError,
    )

    expect(calls).toHaveLength(0)
    // The rival's claiming span is the last thing in the log; the brain's own span start —
    // the one whose append was refused — never landed.
    expect(eventTypes(await rawLogOf(store, session.id))).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
    ])
    expect(await store.getPendingUserEvents(session.id)).toEqual([])
  })

  it('closes an inherited span and runs the request again, superseding its chunks', async () => {
    const { store, sessionId } = await newSession()
    const replyId = newEventId()
    const stored = await store.appendEvents(sessionId, [
      makeUserMessage('Hello', { processed_at: null }),
      makeStatusRunning(),
      spanStart([], TEST_MODEL_ID),
      eventStart(replyId),
      eventDelta(replyId, 'half a rep'),
      eventDelta(replyId, 'ly'),
    ])
    const crashed = spanStartOf(stored[2])
    const { factory, calls } = mockModel({ text: ['Recovered'] })

    const outcome = await runTurn(sessionId, { store, model: factory })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(calls).toHaveLength(1)
    const raw = await rawLogOf(store, sessionId)
    // The dead request's chunks are superseded by the span end that closes it, so replay never
    // shows a reply nobody stored.
    const lostEnd = raw.find(
      (event) => event.type === EVENT_TYPES.modelRequestEnd && event.error?.type === 'brain_lost',
    )
    expect(lostEnd).toMatchObject({
      model_request_start_id: crashed.id,
      supersedes: { from_seq: stored[3]?.seq, to_seq: stored[5]?.seq },
    })
    // The re-run uses a new message id and its own chunks.
    const retryStart = raw.filter((event) => event.type === EVENT_TYPES.eventStart).at(-1)
    expect(retryStart?.type === EVENT_TYPES.eventStart ? retryStart.event.id : undefined).not.toBe(
      replyId,
    )
    const replayed = await logOf(store, sessionId)
    expect(chunksOf(replayed)).toEqual([])
    expect(replayed.filter((event) => event.type === EVENT_TYPES.agentMessage)).toHaveLength(1)
    await expectClean(store, sessionId)
  })

  it('does not repeat a reply the log already holds', async () => {
    const { store, sessionId } = await newSession()
    const [queued] = await store.appendEvents(sessionId, [makeUserMessage('Hello')])
    const stored = await store.appendEvents(sessionId, [
      makeStatusRunning(),
      // The claim this turn inherited: the message is the dead brain's already, and so is the
      // reply below — this brain must not ask for a second one.
      spanStart([queued?.id ?? newEventId()], TEST_MODEL_ID),
      { type: EVENT_TYPES.agentMessage, content: [{ type: 'text', text: 'Hi there' }] },
    ])
    const start = spanStartOf(stored[1])
    const { factory, calls } = mockModel({ text: ['a second reply'] })

    const outcome = await runTurn(sessionId, { store, model: factory })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(calls).toHaveLength(0)
    expect(eventTypes(await rawLogOf(store, sessionId))).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    const log = await rawLogOf(store, sessionId)
    expect(log[4]).toMatchObject({
      model_request_start_id: start.id,
      is_error: true,
      error: { type: 'brain_lost' },
    })
  })

  it('ends a turn whose reply was stored before the brain died', async () => {
    const { store, sessionId } = await newSession()
    const [queued] = await store.appendEvents(sessionId, [makeUserMessage('Hello')])
    const stored = await store.appendEvents(sessionId, [
      makeStatusRunning(),
      spanStart([queued?.id ?? newEventId()], TEST_MODEL_ID),
    ])
    const start = spanStartOf(stored[1])
    await store.appendEvents(sessionId, [
      { type: EVENT_TYPES.agentMessage, content: [{ type: 'text', text: 'Hi there' }] },
      makeModelRequestEnd(start),
    ])
    const { factory, calls } = mockModel({ text: ['a second reply'] })

    const outcome = await runTurn(sessionId, { store, model: factory })

    // The turn was open but its reply was already in the log: the brain closes it rather than
    // asking the model the same question again.
    expect(outcome).toEqual({ outcome: 'idle' })
    expect(calls).toHaveLength(0)
    expect(eventTypes(await rawLogOf(store, sessionId))).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    expect((await rawLogOf(store, sessionId))[0]?.id).toBe(queued?.id)
  })

  it('resumes a turn that was rescheduled', async () => {
    const { store, sessionId } = await newSession()
    const stored = await store.appendEvents(sessionId, [
      makeUserMessage('Hello', { processed_at: '2026-03-15T10:00:00.000Z' }),
      makeStatusRunning(),
      makeModelRequestStart(),
    ])
    const start = spanStartOf(stored[2])
    await store.appendEvents(sessionId, [
      makeModelRequestEnd(start, { is_error: true, error: { type: 'model_error' } }),
      {
        type: EVENT_TYPES.sessionError,
        error: {
          type: 'model_overloaded_error',
          message: 'Overloaded.',
          retry_status: { type: 'retrying' },
        },
      },
      makeStatusRescheduled(),
    ])
    const { factory, calls } = mockModel({ text: ['Recovered'] })

    const outcome = await runTurn(sessionId, { store, model: factory })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(calls).toHaveLength(1)
    expect(eventTypes(await logOf(store, sessionId))).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionError,
      EVENT_TYPES.sessionStatusRescheduled,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
  })

  it('runs the queued message of an unfinished turn without opening a second one', async () => {
    const { store, sessionId } = await newSession()
    await store.appendEvents(sessionId, [
      makeUserMessage('Hello', { processed_at: null }),
      makeStatusRunning(),
    ])
    const { factory, calls } = mockModel({ text: ['Recovered'] })

    const outcome = await runTurn(sessionId, { store, model: factory })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(calls).toHaveLength(1)
    expect(eventTypes(await logOf(store, sessionId))).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    expect((await rawLogOf(store, sessionId))[0]?.processed_at).not.toBeNull()
    await expectClean(store, sessionId)
  })

  it('runs a request for a claimed message an unfinished turn never answered', async () => {
    const { store, sessionId } = await newSession()
    // The crash window between claiming the message and answering it: the claim is in the log,
    // nothing is in flight, and the message is the brain's already.
    const [queued] = await store.appendEvents(sessionId, [makeUserMessage('Hello')])
    const [claim] = await store.appendEvents(sessionId, [
      spanStart([queued?.id ?? newEventId()], TEST_MODEL_ID),
    ])
    await store.appendEvents(sessionId, [
      makeModelRequestEnd(spanStartOf(claim)),
      makeStatusRunning(),
    ])
    const { factory, calls } = mockModel({ text: ['Recovered'] })

    const outcome = await runTurn(sessionId, { store, model: factory })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(calls).toHaveLength(1)
    const raw = await rawLogOf(store, sessionId)
    expect(eventTypes(raw)).toEqual([
      EVENT_TYPES.userMessage,
      // The inherited claim, closed before the crash.
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.eventStart,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    // There is nothing left to claim — the message was claimed before the crash — so the new
    // request consumes nothing and answers from the log it has.
    expect(raw[4]).toMatchObject({ consumes: [], model: TEST_MODEL_ID })
    await expectClean(store, sessionId)
  })

  it('refuses a session that does not exist', async () => {
    const { store } = await newSession()
    const { factory, calls } = mockModel({ text: ['unused'] })

    await expect(runTurn(newSessionId(), { store, model: factory })).rejects.toMatchObject({
      name: 'SessionNotFoundError',
    })
    expect(calls).toHaveLength(0)
  })

  it('carries the fence on every write it makes, and writes only through appendEvents', async () => {
    const { store, sessionId } = await newSession([interrupt(), message('Hello')])
    const partition = partitionOf(sessionId)
    const lease = await store.acquirePartition(partition, 'owner-1', 30_000)
    const { factory } = mockModel({ text: ['Hi there'] })
    const before = (await rawLogOf(store, sessionId)).length
    const append = vi.spyOn(store, 'appendEvents')
    // Every write is an append: the contract has no other way in (P4 removed the out-of-band
    // claim and preview calls), so a spy on the log's own rows is what proves nothing else ran.
    const fence = { partition, epoch: lease!.epoch }

    await runTurn(sessionId, { store, model: factory, fence })

    expect(append.mock.calls.length).toBeGreaterThan(0)
    for (const [, , options] of append.mock.calls) {
      expect(options).toMatchObject({ fence })
    }
    // The events the turn added are exactly what the appends carried — no row appeared any
    // other way. `rawLogOf` reads what the log actually holds.
    const raw = await rawLogOf(store, sessionId)
    const written = append.mock.calls.reduce((total, [, events]) => total + events.length, 0)
    expect(raw.length - before).toBe(written)
  })

  it('opens no span without a model request, for an interrupt or the turn it ends', async () => {
    // The P4 rule, asserted where the old brain broke it: an interrupt used to be claimed by a
    // pretend `span.model_request_start`/`_end` pair with no model call behind it. Now the only
    // spans in any log are ones a request really ran, and every interrupt is claimed by the
    // event that ended the work it stopped.
    for (const initial of [[message('Hello')], [interrupt()], [interrupt(), message('Hello')]]) {
      const { store, sessionId } = await newSession(initial)
      const { factory, calls } = mockModel({ text: ['Hi'] })

      const outcome = await runTurn(sessionId, { store, model: factory })

      const raw = await rawLogOf(store, sessionId)
      const spans = raw.filter(isSpanStart).length
      const interrupted = initial.some((event) => event.type === 'user.interrupt')
      // One span per model request, and one model call per span — nothing else opens one.
      expect(spans, `${initial.length} initial events: spans`).toBe(calls.length)
      expect(outcome.outcome).toBe(interrupted ? 'interrupted' : 'idle')
      // Every interrupt the log holds is claimed, and by an event that ends work.
      for (const event of raw) {
        if (event.type === EVENT_TYPES.userInterrupt) {
          expect(event.processed_at, `${event.id} is claimed`).not.toBeNull()
        }
      }
    }
  })

  it('streams the context the strategy builds', async () => {
    const { store, sessionId } = await newSession([message('Hello')], { system: null })
    const { factory, calls } = mockModel({
      text: ['Hi'],
      usage: { input_tokens: 7, output_tokens: 3 },
    })

    await runTurn(sessionId, {
      store,
      model: factory,
      contextStrategy: (events) =>
        [
          {
            role: 'user',
            content: `messages: ${events.filter((event) => event.type === EVENT_TYPES.userMessage).length}`,
          },
        ] as never,
    })

    expect(readPrompt(calls[0]!)).toEqual([{ role: 'user', text: 'messages: 1' }])
    const log = await rawLogOf(store, sessionId)
    expect(log.find((event) => event.type === EVENT_TYPES.modelRequestEnd)).toMatchObject({
      model_usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    })
  })

  it('keeps the configurable retry budget', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const sleep = vi.fn(async () => {})
    const { factory, calls } = mockModel({ failWith: rateLimited() } satisfies MockModelScript)

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      retry: { maxRetries: 1, sleep },
    })

    expect(outcome).toEqual({ outcome: 'error' })
    expect(calls).toHaveLength(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    const log = await rawLogOf(store, sessionId)
    expect((log[log.length - 1] as StoredEvent).type).toBe(EVENT_TYPES.sessionStatusIdle)
  })
})
