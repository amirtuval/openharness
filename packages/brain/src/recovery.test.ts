import { EVENT_TYPES } from '@openharness/protocol'
import type { EventId, SessionId } from '@openharness/protocol'
import type { InMemorySessionStore } from '@openharness/session'
import { describe, expect, it } from 'vitest'

import { spanEnd, spanStart, statusRunning } from './events'
import { ZERO_MODEL_USAGE } from './model'
import { eventTypes, logOf, message, newSession, textOf } from './testing/harness'
import { mockModel, resolveTestCredential } from './testing/mock-model'
import { consecutiveRecoveryClosures } from './log'
import { DEFAULT_MAX_RECOVERY_ATTEMPTS, runTurn } from './turn'

/**
 * The recovery cap (#378, P4): a turn that keeps being taken over without finishing anything
 * is stopped instead of being recovered for ever.
 *
 * The process cannot be crashed in-process, so these tests build the log a crash leaves —
 * an open span and a run of `brain_lost` closures — and run the next owner against it. That
 * is the same state a real `kill -9` produces, and it is what the loop reads.
 */

const TEST_MODEL_ID = 'anthropic/claude-sonnet-5'

/** The id of the queued message a test's first request claimed. */
async function claimFirstMessage(
  store: InMemorySessionStore,
  sessionId: SessionId,
): Promise<EventId> {
  const [queued] = await store.getPendingUserEvents(sessionId)
  if (queued === undefined) {
    throw new Error('the fixture session has no queued user event')
  }
  return queued.id
}

/**
 * Append the log a turn leaves when `recoveries` owners have already died on it and the
 * current owner died too: `recoveries` closed `brain_lost` spans, then one open span.
 *
 * The first request claims the queued message; every later attempt of a turn claims nothing,
 * which is what a crash after the claim leaves.
 */
async function crashLog(
  store: InMemorySessionStore,
  sessionId: SessionId,
  recoveries: number,
): Promise<void> {
  const claimed = await claimFirstMessage(store, sessionId)
  await store.appendEvents(sessionId, [statusRunning()])
  for (let index = 0; index < recoveries; index += 1) {
    const [start] = await store.appendEvents(sessionId, [
      spanStart(index === 0 ? [claimed] : [], TEST_MODEL_ID),
    ])
    if (start === undefined) {
      throw new Error('the fixture span start was not stored')
    }
    await store.appendEvents(sessionId, [
      spanEnd(start.id, ZERO_MODEL_USAGE, {
        error: { type: 'brain_lost', message: 'The brain that opened this request is gone.' },
      }),
    ])
  }
  // The attempt that died most recently left its span open.
  await store.appendEvents(sessionId, [spanStart([], TEST_MODEL_ID)])
}

describe('the recovery cap', () => {
  it('stops an inherited turn once recovery has been tried the configured number of times', async () => {
    const { store, sessionId } = await newSession([message('crash me every time')])
    await crashLog(store, sessionId, DEFAULT_MAX_RECOVERY_ATTEMPTS)

    const model = mockModel({ text: ['never runs'] })
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
    })

    // The turn ended with a failure, and no model request was made by this owner: the whole
    // point of the cap is that the poison never reaches another request.
    expect(outcome.outcome).toBe('error')
    expect(model.calls).toHaveLength(0)

    const log = await logOf(store, sessionId)
    const error = log.find((event) => event.type === EVENT_TYPES.sessionError)
    expect(error).toMatchObject({
      type: 'session.error',
      error: {
        type: 'recovery_exhausted_error',
        retry_status: { type: 'terminal' },
      },
    })
    expect(error).toBeDefined()
    if (error?.type === EVENT_TYPES.sessionError) {
      expect(error.error.message).toContain('recovered 3 times without completing a step')
    }
    // Every span is closed, and the turn went idle.
    expect(log.filter((event) => event.type === EVENT_TYPES.modelRequestEnd)).toHaveLength(
      DEFAULT_MAX_RECOVERY_ATTEMPTS + 1,
    )
    expect(log.at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
  })

  it('recovers while the count is under the limit, and a completed request resets it', async () => {
    const { store, sessionId } = await newSession([message('recover me')])
    await crashLog(store, sessionId, DEFAULT_MAX_RECOVERY_ATTEMPTS - 1)

    const model = mockModel({ text: ['recovered'] })
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
    })

    expect(outcome.outcome).toBe('idle')
    expect(model.calls).toHaveLength(1)
    const log = await logOf(store, sessionId)
    expect(log.some((event) => event.type === EVENT_TYPES.sessionError)).toBe(false)
    expect(textOf(log.find((event) => event.type === EVENT_TYPES.agentMessage))).toBe('recovered')
  })

  it('counts only the closures after the last completed request', async () => {
    const { store, sessionId } = await newSession([message('progress then crash')])
    const claimed = await claimFirstMessage(store, sessionId)
    await store.appendEvents(sessionId, [statusRunning()])
    // A completed request — progress — then a run of recoveries. The closures before the
    // completed request belong to a turn that really did some work.
    const [start] = await store.appendEvents(sessionId, [spanStart([claimed], TEST_MODEL_ID)])
    if (start === undefined) {
      throw new Error('the fixture span start was not stored')
    }
    await store.appendEvents(sessionId, [spanEnd(start.id, ZERO_MODEL_USAGE)])
    for (let index = 0; index < 2; index += 1) {
      const [retry] = await store.appendEvents(sessionId, [spanStart([], TEST_MODEL_ID)])
      if (retry === undefined) {
        throw new Error('the fixture span start was not stored')
      }
      await store.appendEvents(sessionId, [
        spanEnd(retry.id, ZERO_MODEL_USAGE, {
          error: { type: 'brain_lost', message: 'gone' },
        }),
      ])
    }
    await store.appendEvents(sessionId, [spanStart([], TEST_MODEL_ID)])

    const log = await logOf(store, sessionId)
    expect(consecutiveRecoveryClosures(log)).toBe(2)
    expect(eventTypes(log).length).toBeGreaterThan(0)
  })

  it('claims the queued input with the idle event, so the poison cannot run again', async () => {
    const { store, sessionId } = await newSession([message('crash me every time')])
    // The first owner died before it could claim the message, which is the worst shape: it is
    // still queued, and a scheduler that finds it would start the same turn again.
    await store.appendEvents(sessionId, [statusRunning()])
    for (let index = 0; index < DEFAULT_MAX_RECOVERY_ATTEMPTS; index += 1) {
      const [start] = await store.appendEvents(sessionId, [spanStart([], TEST_MODEL_ID)])
      if (start === undefined) {
        throw new Error('the fixture span start was not stored')
      }
      await store.appendEvents(sessionId, [
        spanEnd(start.id, ZERO_MODEL_USAGE, {
          error: { type: 'brain_lost', message: 'gone' },
        }),
      ])
    }
    await store.appendEvents(sessionId, [spanStart([], TEST_MODEL_ID)])

    const model = mockModel({ text: ['never runs'] })
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
    })

    expect(await store.getPendingUserEvents(sessionId)).toEqual([])
    const log = await logOf(store, sessionId)
    const idle = log.at(-1)
    expect(idle?.type).toBe(EVENT_TYPES.sessionStatusIdle)
    if (idle?.type === EVENT_TYPES.sessionStatusIdle) {
      expect(idle.consumes).toHaveLength(1)
    }
  })
})
