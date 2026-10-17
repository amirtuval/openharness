import { createToolRegistry, textResult } from '@openharness/hands'
import { EVENT_TYPES } from '@openharness/protocol'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { TurnHandoff } from './handoff'
import { eventTypes, message, newSession, rawLogOf, textOf } from './testing/harness'
import { mockModel, resolveTestCredential } from './testing/mock-model'
import { runTurn } from './turn'

/**
 * The **soft** stop — a drain — driven through `runTurn` (#378, P2).
 *
 * A drain is the scheduler saying "this process should not own this turn any more, but you have
 * time": the model request or tool step in flight finishes and stores its result, and the turn
 * stops at the next step boundary without opening another request. It is deliberately not an
 * abort: the stream's hard `signal` is still what ends a step that outlives the deadline, and a
 * user's interrupt is unchanged.
 *
 * The tests assert the event order because it is the contract: the drain leaves the turn
 * **open** (no `session.status_idle`), exactly as a hard handoff does, unless the step it let
 * finish was the one that ended the turn naturally — then the idle is written here and the next
 * owner has nothing to do.
 */

describe('draining a turn at a step boundary', () => {
  it('finishes the request in flight and stores its reply before handing off', async () => {
    const { store, sessionId } = await newSession([message('First')])
    const drain = new AbortController()
    let steeringId: string | undefined
    const { factory, calls } = mockModel(
      {
        text: ['Answering ', 'the first'],
        onChunk: async (_chunk, index) => {
          if (index === 0) {
            // The drain arrives mid-stream. A message arriving beside it is the work the turn
            // must **not** start answering: it stays queued for whichever process owns the
            // session next.
            drain.abort()
            const [steering] = await store.appendEvents(sessionId, [
              { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'Steering' }] },
            ])
            steeringId = steering?.id
          }
        },
      },
      { text: ['the next owner answers this'] },
    )

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      drain: drain.signal,
    })

    expect(outcome).toEqual({ outcome: 'handed_off' })
    // The request in flight ran once, and the reply it produced is in the log whole.
    expect(calls).toHaveLength(1)
    const raw = await rawLogOf(store, sessionId)
    expect(eventTypes(raw)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.eventStart,
      // The steering message lands while the request streams, ahead of its reply.
      EVENT_TYPES.userMessage,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionUsage,
    ])
    const reply = raw.find((event) => event.type === EVENT_TYPES.agentMessage)
    expect(textOf(reply)).toBe('Answering the first')
    // Nothing was written after the boundary that handed the turn off: no idle, no answer to
    // the steering message, and the turn is left open for the next owner.
    expect(raw.some((event) => event.type === EVENT_TYPES.sessionStatusIdle)).toBe(false)
    expect(await store.getTurnState(sessionId)).toMatchObject({ state: 'unfinished' })
    expect((await store.getPendingUserEvents(sessionId)).map((event) => event.id)).toEqual([
      steeringId,
    ])
  })

  it('lets a tool step finish and store its results, then hands off before the next request', async () => {
    const { store, sessionId } = await newSession([message('Use the tool')])
    const drain = new AbortController()
    const run = vi.fn(() => {
      // The drain lands while the tool is running — the step is still in flight, so it is
      // allowed to finish and its result is stored.
      drain.abort()
      return textResult('the tool said: hi')
    })
    const registry = createToolRegistry([
      {
        name: 'echo',
        description: 'Echo the text back.',
        inputSchema: z.object({ text: z.string() }),
        permission: 'allow',
        run,
      },
    ])
    const { factory, calls } = mockModel(
      { text: ['calling'], toolCalls: [{ name: 'echo', input: { text: 'hi' } }] },
      { text: ['the follow-up request belongs to the next owner'] },
    )

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: registry,
      drain: drain.signal,
    })

    expect(outcome).toEqual({ outcome: 'handed_off' })
    expect(calls).toHaveLength(1)
    expect(run).toHaveBeenCalledOnce()
    const raw = await rawLogOf(store, sessionId)
    expect(eventTypes(raw)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.eventStart,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionUsage,
      EVENT_TYPES.agentToolUse,
      EVENT_TYPES.agentToolResult,
    ])
    const result = raw.find((event) => event.type === EVENT_TYPES.agentToolResult)
    expect(result).toMatchObject({ is_error: false })
    expect(raw.some((event) => event.type === EVENT_TYPES.sessionStatusIdle)).toBe(false)
    // The tool step's answer is stored, so the next owner builds the follow-up request from
    // the log rather than answering a call nobody recorded.
    expect(await store.getTurnState(sessionId)).toMatchObject({ state: 'unfinished' })
  })

  it('lets a last step end the turn normally: it writes its idle instead of handing off', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const drain = new AbortController()
    const { factory, calls } = mockModel({
      text: ['Hi ', 'there'],
      onChunk: (_chunk, index) => {
        if (index === 0) {
          drain.abort()
        }
      },
    })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      drain: drain.signal,
    })

    // The best case for a deploy: the step in flight was the whole turn, so there is nothing
    // to hand off — the reply and the idle are both written here.
    expect(outcome).toEqual({ outcome: 'idle' })
    expect(calls).toHaveLength(1)
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
      EVENT_TYPES.sessionUsage,
      EVENT_TYPES.sessionStatusIdle,
    ])
    expect(raw.at(-1)).toMatchObject({ stop_reason: { type: 'end_turn' } })
  })

  it('still hard-hands-off when the drain deadline passes mid-stream', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const drain = new AbortController()
    const hard = new AbortController()
    const { factory, calls } = mockModel({
      text: ['partial', 'never stored'],
      onChunk: (_chunk, index) => {
        if (index === 0) {
          drain.abort()
          hard.abort(new TurnHandoff('shutdown'))
        }
      },
    })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      drain: drain.signal,
      signal: hard.signal,
    })

    expect(outcome).toEqual({ outcome: 'handed_off' })
    expect(calls).toHaveLength(1)
    const raw = await rawLogOf(store, sessionId)
    // The hard handoff writes nothing after the abort — no partial reply, no span end, no idle
    // — and leaves the turn open for the next owner, exactly as #378 P1 defined it. A chunk
    // the stream had already produced may be stored; nothing may supersede or close it here.
    expect(eventTypes(raw).slice(0, 4)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.eventStart,
    ])
    expect(
      raw.every(
        (event) =>
          event.type !== EVENT_TYPES.agentMessage &&
          event.type !== EVENT_TYPES.modelRequestEnd &&
          event.type !== EVENT_TYPES.sessionStatusIdle,
      ),
    ).toBe(true)
    expect(raw.some((event) => event.type === EVENT_TYPES.modelRequestEnd)).toBe(false)
    expect(raw.some((event) => event.type === EVENT_TYPES.sessionStatusIdle)).toBe(false)
    expect(await store.getTurnState(sessionId)).toMatchObject({ state: 'running' })
  })

  it('keeps a user interrupt an interrupt, even with a drain set', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const drain = new AbortController()
    const interrupt = new AbortController()
    const { factory, calls } = mockModel({
      text: ['one', 'two'],
      onChunk: (_chunk, index) => {
        if (index === 0) {
          drain.abort()
          // A user's Stop carries no handoff reason: it is an ending.
          interrupt.abort()
        }
      },
    })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      drain: drain.signal,
      signal: interrupt.signal,
    })

    expect(outcome).toEqual({ outcome: 'interrupted' })
    expect(calls).toHaveLength(1)
    const raw = await rawLogOf(store, sessionId)
    // The partial reply is kept (when a chunk had already reached the log), the span closes
    // `interrupted`, and the turn goes idle — the lifecycle a user's abort has always had,
    // unchanged by the drain signal beside it.
    const reply = raw.find((event) => event.type === EVENT_TYPES.agentMessage)
    if (reply !== undefined) {
      expect('one'.startsWith(textOf(reply))).toBe(true)
      expect(textOf(reply).length).toBeGreaterThan(0)
    }
    expect(raw.find((event) => event.type === EVENT_TYPES.modelRequestEnd)).toMatchObject({
      error: { type: 'interrupted' },
    })
    expect(raw.at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
  })

  it('writes nothing at all when the drain is already set before the turn starts', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const drain = new AbortController()
    drain.abort()
    const { factory, calls } = mockModel({ text: ['never'] })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      drain: drain.signal,
    })

    expect(outcome).toEqual({ outcome: 'handed_off' })
    expect(calls).toHaveLength(0)
    // The message stays queued and the turn was never opened: the next owner runs it.
    expect(await rawLogOf(store, sessionId)).toHaveLength(1)
    expect(await store.getPendingUserEvents(sessionId)).toHaveLength(1)
    expect(await store.getTurnState(sessionId)).toMatchObject({ state: 'idle' })
  })
})
