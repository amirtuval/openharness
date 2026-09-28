import {
  FIXTURE_MODEL_USAGE,
  makeModelRequestEnd,
  makeModelRequestStart,
  makeStatusRescheduled,
  makeStatusRunning,
  makeUserMessage,
} from '@openharness/protocol/fixtures'
import { EVENT_TYPES, newSessionId, partitionOf } from '@openharness/protocol'
import type { EventDelta, EventStart, StoredEvent, StreamEvent } from '@openharness/protocol'
import { SessionNotFoundError, isFencedError } from '@openharness/session'
import { describe, expect, it, vi } from 'vitest'

import { mockModel, readPrompt, type MockModelScript } from './testing/mock-model'
import {
  eventTypes,
  interrupt,
  logOf,
  message,
  newSession,
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
 * rather than a detail a reader can infer.
 */

/** A retryable provider error, the shape a real SDK throws. */
function rateLimited(): Error {
  return Object.assign(new Error('Rate limited by the provider.'), { statusCode: 429 })
}

/** A failure the model reports mid-stream, after some text reached the client. */
function overloaded(): Error {
  return Object.assign(new Error('Overloaded.'), { statusCode: 503 })
}

describe('runTurn', () => {
  it('does nothing when there is no turn and nothing queued', async () => {
    const { store, sessionId } = await newSession()
    const { factory, calls } = mockModel({ text: ['unused'] })

    const outcome = await runTurn(sessionId, { store, model: factory })

    expect(outcome).toEqual({ outcome: 'noop' })
    expect(await logOf(store, sessionId)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('runs a turn in the documented order', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const { factory } = mockModel({ text: ['Hi ', 'there'] })

    const outcome = await runTurn(sessionId, { store, model: factory })

    expect(outcome).toEqual({ outcome: 'idle' })
    const log = await logOf(store, sessionId)
    expect(eventTypes(log)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    const [user, running, start, reply, end, idle] = log
    expect(user?.processed_at).not.toBeNull()
    expect(running?.type).toBe(EVENT_TYPES.sessionStatusRunning)
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
  })

  it('publishes the live preview under one id, before the reply it previews', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const { factory } = mockModel({ text: ['Hi ', 'there'] })
    const previews: StreamEvent[] = []
    await store.subscribe(sessionId, (event) => {
      if (event.type === EVENT_TYPES.eventStart || event.type === EVENT_TYPES.eventDelta) {
        previews.push(event)
      }
    })

    await runTurn(sessionId, { store, model: factory })
    await settle()

    const start = previews[0]
    const deltas = previews.filter(
      (event): event is EventDelta => event.type === EVENT_TYPES.eventDelta,
    )
    const stored = (await logOf(store, sessionId)).find(
      (event) => event.type === EVENT_TYPES.agentMessage,
    )
    expect(start).toMatchObject({
      type: EVENT_TYPES.eventStart,
      event: { type: EVENT_TYPES.agentMessage },
    })
    const previewId = (start as EventStart).event.id
    expect(previewId).toEqual(expect.any(String))
    expect(deltas.map((delta) => delta.event_id)).toEqual([previewId, previewId])
    expect(deltas.map((delta) => delta.delta.content.text)).toEqual(['Hi ', 'there'])
    expect(deltas.every((delta) => delta.delta.index === 0)).toBe(true)
    // The preview is a prefix of the stored reply, which is what a client accumulates on.
    expect(deltas.map((delta) => delta.delta.content.text).join('')).toBe(textOf(stored))
    // The stored reply keeps the id its preview announced, so a client can swap one for the other.
    expect(stored?.id).toBe(previewId)
  })

  it('picks up a message that arrives mid-stream in a second request', async () => {
    const { store, sessionId } = await newSession([message('First')])
    const { factory, calls } = mockModel(
      {
        text: ['Answering ', 'the first'],
        onChunk: async (_chunk, index) => {
          if (index === 0) {
            await store.appendEvents(sessionId, [
              { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'Steering' }] },
            ])
          }
        },
      },
      { text: ['Answering the steering message'] },
    )

    const outcome = await runTurn(sessionId, { store, model: factory })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(eventTypes(await logOf(store, sessionId))).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      // The steering message lands in the log while the first request is still streaming, ahead
      // of the reply to the message before it.
      EVENT_TYPES.userMessage,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
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
  })

  it('keeps the partial text and closes the span when the turn is aborted', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const controller = new AbortController()
    const previews: StreamEvent[] = []
    await store.subscribe(sessionId, (event) => {
      if (event.type === EVENT_TYPES.eventDelta) {
        previews.push(event)
        controller.abort()
      }
    })
    const { factory } = mockModel({ text: ['Par', 'tial'] })

    const outcome = await runTurn(sessionId, { store, model: factory, signal: controller.signal })
    await settle()

    expect(outcome).toEqual({ outcome: 'interrupted' })
    const log = await logOf(store, sessionId)
    expect(eventTypes(log)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    // The abort lands while a chunk is in flight, so what was stored is a prefix of the reply.
    expect(textOf(log[3])).not.toBe('')
    expect('Partial'.startsWith(textOf(log[3]))).toBe(true)
    expect(log[4]).toMatchObject({
      type: EVENT_TYPES.modelRequestEnd,
      is_error: true,
      error: { type: 'interrupted' },
      model_usage: { input_tokens: 0, output_tokens: 0 },
    })
    // Whatever was published is a prefix of the reply the request would have produced, which is
    // the guarantee a client's accumulator relies on.
    const previewed = previews.map((event) => (event as EventDelta).delta.content.text).join('')
    expect('Partial'.startsWith(previewed)).toBe(true)
    expect(log[5]).toMatchObject({ type: EVENT_TYPES.sessionStatusIdle })
  })

  it('ends the turn when a user.interrupt is waiting before the first request', async () => {
    const { store, sessionId } = await newSession([interrupt(), message('Hello')])
    const { factory, calls } = mockModel({ text: ['unused'] })

    const outcome = await runTurn(sessionId, { store, model: factory })

    expect(outcome).toEqual({ outcome: 'interrupted' })
    const log = await logOf(store, sessionId)
    expect(eventTypes(log)).toEqual([
      EVENT_TYPES.userInterrupt,
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.sessionStatusIdle,
    ])
    // The interrupt was claimed; the message it interrupted was not, so the next turn answers it.
    expect(log[0]?.processed_at).not.toBeNull()
    expect(log[1]?.processed_at).toBeNull()
    expect(calls).toHaveLength(0)
    expect(await store.getPendingUserEvents(sessionId)).toHaveLength(1)
  })

  it('ends the turn when the signal is already aborted', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const controller = new AbortController()
    controller.abort()
    const { factory, calls } = mockModel({ text: ['unused'] })

    const outcome = await runTurn(sessionId, { store, model: factory, signal: controller.signal })

    expect(outcome).toEqual({ outcome: 'interrupted' })
    expect(eventTypes(await logOf(store, sessionId))).toEqual([
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
    const log = await logOf(store, sessionId)
    expect(log[3]).toMatchObject({
      is_error: true,
      error: { type: 'model_error' },
      model_usage: { input_tokens: 0, output_tokens: 0 },
    })
    expect(log[4]).toMatchObject({
      type: EVENT_TYPES.sessionError,
      error: {
        type: 'model_rate_limited_error',
        message: 'Rate limited by the provider.',
        retry_status: { type: 'retrying' },
      },
    })
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(2)
  })

  it('classifies a 5xx as an overloaded model', async () => {
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
    const log = await logOf(store, sessionId)
    expect(log[4]).toMatchObject({
      type: EVENT_TYPES.sessionError,
      error: { type: 'model_overloaded_error', retry_status: { type: 'retrying' } },
    })
    // Text streamed before the failure is not stored: the retried request answers in full.
    expect(log.filter((event) => event.type === EVENT_TYPES.agentMessage)).toHaveLength(1)
  })

  it('gives up after the retries are exhausted', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const sleep = vi.fn(async () => {})
    const { factory, calls } = mockModel({ failWith: rateLimited() })

    const outcome = await runTurn(sessionId, { store, model: factory, retry: { sleep } })

    expect(outcome).toEqual({ outcome: 'error' })
    expect(calls).toHaveLength(4)
    const log = await logOf(store, sessionId)
    expect(eventTypes(log)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionError,
      EVENT_TYPES.sessionStatusRescheduled,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionError,
      EVENT_TYPES.sessionStatusRescheduled,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionError,
      EVENT_TYPES.sessionStatusRescheduled,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionError,
      EVENT_TYPES.sessionStatusIdle,
    ])
    expect(log[19]).toMatchObject({
      type: EVENT_TYPES.sessionError,
      error: { retry_status: { type: 'exhausted' } },
    })
    expect(sleep).toHaveBeenCalledTimes(3)
    expect(await store.getTurnState(sessionId)).toMatchObject({ state: 'idle' })
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
    expect(eventTypes(await logOf(store, sessionId))).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionError,
      EVENT_TYPES.sessionStatusIdle,
    ])
    const log = await logOf(store, sessionId)
    expect(log[4]).toMatchObject({
      error: { type: 'model_request_failed_error', retry_status: { type: 'terminal' } },
    })
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
    expect(eventTypes(await logOf(store, sessionId))).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionError,
      EVENT_TYPES.sessionStatusRescheduled,
      EVENT_TYPES.sessionStatusIdle,
    ])
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

    expect(eventTypes(await logOf(store, sessionId))).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
    ])
  })

  it('closes an inherited span and runs the request again', async () => {
    const { store, sessionId } = await newSession()
    const stored = await store.appendEvents(sessionId, [
      makeUserMessage('Hello', { processed_at: null }),
      makeStatusRunning(),
      makeModelRequestStart(),
    ])
    const interrupted = spanStartOf(stored[2])
    const { factory, calls } = mockModel({ text: ['Recovered'] })

    const outcome = await runTurn(sessionId, { store, model: factory })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(calls).toHaveLength(1)
    expect(eventTypes(await logOf(store, sessionId))).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    const log = await logOf(store, sessionId)
    expect(log[2]?.id).toBe(interrupted.id)
    expect(log[3]).toMatchObject({
      model_request_start_id: interrupted.id,
      is_error: true,
      error: { type: 'brain_lost' },
      model_usage: { input_tokens: 0, output_tokens: 0 },
    })
  })

  it('does not repeat a reply the log already holds', async () => {
    const { store, sessionId } = await newSession()
    const stored = await store.appendEvents(sessionId, [
      makeUserMessage('Hello', { processed_at: '2026-03-15T10:00:00.000Z' }),
      makeStatusRunning(),
      makeModelRequestStart(),
      { type: EVENT_TYPES.agentMessage, content: [{ type: 'text', text: 'Hi there' }] },
    ])
    const start = spanStartOf(stored[2])
    const { factory, calls } = mockModel({ text: ['a second reply'] })

    const outcome = await runTurn(sessionId, { store, model: factory })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(calls).toHaveLength(0)
    expect(eventTypes(await logOf(store, sessionId))).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    const log = await logOf(store, sessionId)
    expect(log[4]).toMatchObject({
      model_request_start_id: start.id,
      is_error: true,
      error: { type: 'brain_lost' },
    })
  })

  it('ends a turn whose reply was stored before the brain died', async () => {
    const { store, sessionId } = await newSession()
    const stored = await store.appendEvents(sessionId, [
      makeUserMessage('Hello', { processed_at: '2026-03-15T10:00:00.000Z' }),
      makeStatusRunning(),
      makeModelRequestStart(),
    ])
    const start = spanStartOf(stored[2])
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
    expect(eventTypes(await logOf(store, sessionId))).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    expect((await logOf(store, sessionId))[0]?.id).toBe(stored[0]?.id)
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
    expect((await logOf(store, sessionId))[0]?.processed_at).not.toBeNull()
  })

  it('runs a request for a claimed message an unfinished turn never answered', async () => {
    const { store, sessionId } = await newSession()
    // The crash window between claiming the message and opening a span: nothing is in flight,
    // and the message is the brain's already.
    await store.appendEvents(sessionId, [
      makeUserMessage('Hello', { processed_at: '2026-03-15T10:00:00.000Z' }),
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
  })

  it('refuses a session that does not exist', async () => {
    const { store } = await newSession()
    const { factory, calls } = mockModel({ text: ['unused'] })

    await expect(runTurn(newSessionId(), { store, model: factory })).rejects.toBeInstanceOf(
      SessionNotFoundError,
    )
    expect(calls).toHaveLength(0)
  })

  it('carries the fence on every write it makes', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const partition = partitionOf(sessionId)
    const lease = await store.acquirePartition(partition, 'owner-1', 30_000)
    const { factory } = mockModel({ text: ['Hi there'] })
    const append = vi.spyOn(store, 'appendEvents')
    const markProcessed = vi.spyOn(store, 'markProcessed')
    const fence = { partition, epoch: lease!.epoch }

    await runTurn(sessionId, { store, model: factory, fence })

    expect(append.mock.calls.length).toBeGreaterThan(0)
    expect(markProcessed.mock.calls.length).toBeGreaterThan(0)
    for (const [, , options] of append.mock.calls) {
      expect(options).toMatchObject({ fence })
    }
    for (const [, , options] of markProcessed.mock.calls) {
      expect(options).toMatchObject({ fence })
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
    const log = await logOf(store, sessionId)
    expect(log[4]).toMatchObject({
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
    const log = await logOf(store, sessionId)
    expect((log[log.length - 1] as StoredEvent).type).toBe(EVENT_TYPES.sessionStatusIdle)
  })
})
