import { createTranscript } from '@openharness/client'
import { EVENT_TYPES, type ModelRequestStartEvent } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import {
  collectStream,
  e2eHarness,
  isPreviewDelta,
  readLog,
  userMessages,
  waitForTurnEnd,
} from './harness'

/**
 * Switching the model mid-chat, end to end (epic #116, U3).
 *
 * A `user.message` may carry `model`; the append projects it onto the session in the same
 * transaction, and the brain asks the session for its **current** model at every request
 * boundary. What only a deployment can show is the consequence the frontends depend on: the
 * stored span of the request that ran names the model that ran — so the log attributes each
 * turn to the right model — and the switch survives everything after it.
 *
 * "Mid-turn" is real here: the mock's `__slow__` reply streams for about ten seconds, and the
 * switching message is sent while it does. The request in flight finishes on the model it
 * started with; the queued steering message is answered by the *next* request, on the new
 * model. Nothing here reaches a provider — the mock answers every request — so a different
 * provider id is free to use, which is the cross-provider case.
 */

const harness = e2eHarness('model-switch')

/** The `model` of every request the session started, in order — what the log attributes. */
function requestModels(log: Awaited<ReturnType<typeof readLog>>): (string | undefined)[] {
  return log
    .filter(
      (event): event is ModelRequestStartEvent => event.type === EVENT_TYPES.modelRequestStart,
    )
    .map((event) => event.model)
}

describe('switching the model mid-chat (U3)', () => {
  it('runs the next request on the new model, records it on the span, and sticks', async () => {
    const server = await harness.server()
    const client = await harness.client(server)

    const first = 'anthropic/claude-sonnet-5'
    const second = 'openai/gpt-5.1'
    const third = 'google/gemini-2.5-flash'
    const session = await client.sessions.create({ model: { id: first } })

    // A message that names a model switches the session to it: the stored event carries it
    // and the turn that starts from it runs it.
    const switched = await client.sendMessage(session.id, 'hello on the new model', {
      model: { id: second },
    })
    expect(switched.model).toEqual({ id: second })
    await waitForTurnEnd(client, session.id, { afterSeq: switched.seq })

    const afterFirst = await readLog(client, session.id)
    expect(requestModels(afterFirst)).toEqual([second])
    // The projection is the session's own model, not a per-event decoration: every read
    // agrees, which is what a new chat's composer reads to show the model in effect.
    expect((await client.sessions.get(session.id)).model).toEqual({ id: second })

    // It sticks: a later message with no model of its own runs the model the session now is
    // — no model on the event, no change of model.
    const quiet = await client.sendMessage(session.id, 'and again, without naming one')
    expect(quiet.model).toBeUndefined()
    await waitForTurnEnd(client, session.id, { afterSeq: quiet.seq })

    const afterSecond = await readLog(client, session.id)
    expect(requestModels(afterSecond)).toEqual([second, second])

    // And another switch moves it again — the client's own transcript (what both frontends
    // render) marks this one, because by now the log has a model for it to differ from.
    const again = await client.sendMessage(session.id, 'one more, on the third model', {
      model: { id: third },
    })
    await waitForTurnEnd(client, session.id, { afterSeq: again.seq })
    expect(requestModels(await readLog(client, session.id))).toEqual([second, second, third])

    const transcript = createTranscript()
    for (const event of await readLog(client, session.id)) {
      transcript.apply(event)
    }
    const state = transcript.getState()
    expect(state.model).toBe(third)
    const marked = state.messages.find((message) => message.modelChangedTo !== undefined)
    expect(marked?.modelChangedTo).toBe(third)
    // The first switch was the log's first model, not a change: no marker is drawn for it.
    expect(state.messages.filter((message) => message.modelChangedTo !== undefined)).toHaveLength(1)
  })

  it('applies a switch made mid-turn to the next request, not the one in flight', async () => {
    const server = await harness.server()
    const client = await harness.client(server)

    const running = 'anthropic/claude-sonnet-5'
    const next = 'openai/gpt-5.1'
    const session = await client.sessions.create({ model: { id: running } })

    // Watch the slow reply so the steering message is genuinely sent while a request is in
    // flight — the state the rule is about.
    const watching = collectStream(client, session.id, { deltas: true })
    await client.sendMessage(session.id, '__slow__ take your time')
    await watching.waitFor(
      (events) => events.some(isPreviewDelta),
      'the request in flight to stream its first chunk',
    )

    const steering = await client.sendMessage(session.id, 'answer this one next, please', {
      model: { id: next },
    })
    await waitForTurnEnd(client, session.id, { afterSeq: steering.seq })
    await watching.stop()

    const log = await readLog(client, session.id)
    // The request in flight finished on the model it started with; the queued message was
    // answered by the second request, on the switch's model — the brain reads the session's
    // current model at each request boundary.
    expect(requestModels(log)).toEqual([running, next])

    // The second request is the one that claimed the steering message (P3), which is what
    // makes "the switch applied at the next request" a statement about this turn.
    const starts = log.filter(
      (event): event is ModelRequestStartEvent => event.type === EVENT_TYPES.modelRequestStart,
    )
    expect(starts[1]?.consumes).toContain(steering.id)
    expect((await client.sessions.get(session.id)).model).toEqual({ id: next })

    // The mock answers both requests, so the conversation completed: two replies, one idle.
    expect(log.filter((event) => event.type === EVENT_TYPES.agentMessage)).toHaveLength(2)
    expect(log.at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
    expect(userMessages(log).map((event) => event.model?.id)).toEqual([undefined, next])
  })
})
