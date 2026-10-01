import { type Client } from '@openharness/client'
import {
  EVENT_TYPES,
  type ModelRequestEndEvent,
  type Session,
  type SessionErrorEvent,
  type StoredEvent,
} from '@openharness/protocol'
import { MOCK_RETRYABLE_MARKER, MOCK_TERMINAL_MARKER } from '@openharness/server'
import { describe, expect, it } from 'vitest'

import { agentMessages, e2eHarness, readLog, textOf, typesOf, waitForTurnEnd } from './harness'

/**
 * What a failed model request does to a session.
 *
 * The server's mock model can fail on purpose: `__fail_retryable__` answers 503 once and then
 * succeeds, `__fail_terminal__` answers 400 every time. Both paths are the ones a real
 * provider takes eventually, and both must end somewhere a user can prompt again from.
 */

const harness = e2eHarness('failures')

/** An agent and a session, the pair the tests here drive. */
async function newSession(client: Client): Promise<Session> {
  const agent = await client.agents.create({
    name: 'Echo agent',
    model: { id: 'anthropic/claude-sonnet-5' },
  })
  return await client.sessions.create({ agent: agent.id })
}

/** The `session.error` events of a log, in order. */
function sessionErrors(log: readonly StoredEvent[]): SessionErrorEvent[] {
  return log.filter((event): event is SessionErrorEvent => event.type === EVENT_TYPES.sessionError)
}

describe('a model request that fails', () => {
  it('retries a retryable failure and answers on the next attempt', async () => {
    const server = await harness.server()
    const client = await harness.client(server)
    const session = await newSession(client)
    const prompt = `${MOCK_RETRYABLE_MARKER} please recover`

    const sent = await client.sendMessage(session.id, prompt)
    await waitForTurnEnd(client, session.id, { afterSeq: sent.seq })

    const log = await readLog(client, session.id)
    expect(typesOf(log)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      // The first attempt fails, the session says so and reschedules itself, and the retry
      // is a fresh request — a closed span and a new one, not a reopened one.
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

    const errors = sessionErrors(log)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.error).toMatchObject({
      type: 'model_overloaded_error',
      retry_status: { type: 'retrying' },
    })

    const [failed, succeeded] = log.filter(
      (event): event is ModelRequestEndEvent => event.type === EVENT_TYPES.modelRequestEnd,
    )
    expect(failed?.is_error).toBe(true)
    expect(failed?.error?.type).toBe('model_error')
    expect(succeeded?.is_error).toBeNull()

    // The retry is the same request, so the user gets the reply they asked for.
    expect(agentMessages(log).map(textOf)).toEqual([prompt])
  })

  it('ends the turn, without a reply, when the failure is terminal', async () => {
    const server = await harness.server()
    const client = await harness.client(server)
    const session = await newSession(client)
    const prompt = `${MOCK_TERMINAL_MARKER} do not retry this`

    const sent = await client.sendMessage(session.id, prompt)
    await waitForTurnEnd(client, session.id, { afterSeq: sent.seq })

    const log = await readLog(client, session.id)
    expect(typesOf(log)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionError,
      EVENT_TYPES.sessionStatusIdle,
    ])

    const errors = sessionErrors(log)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.error).toMatchObject({
      type: 'model_request_failed_error',
      retry_status: { type: 'terminal' },
    })

    // Nothing was streamed, so no message is stored for it; the prompt is still claimed, so
    // a restart does not send it again.
    const spanEnd = log.find(
      (event): event is ModelRequestEndEvent => event.type === EVENT_TYPES.modelRequestEnd,
    )
    expect(spanEnd?.is_error).toBe(true)
    expect(agentMessages(log)).toHaveLength(0)
    expect(log.find((event) => event.type === EVENT_TYPES.userMessage)?.processed_at).not.toBeNull()
    expect((await client.sessions.get(session.id)).status).toBe('idle')
  })
})
