import {
  EVENT_TYPES,
  SessionSchema,
  type ModelRequestStartEvent,
  type UserMessageEvent,
} from '@openharness/protocol'
import { MOCK_SLOW_MARKER } from '@openharness/server'
import { describe, expect, it } from 'vitest'

import type { Client } from '@openharness/client'

import {
  e2eHarness,
  errorOf,
  readLog,
  userMessages,
  waitForModelRequestStart,
  waitForTurnEnd,
} from './harness'

/**
 * Switching a session's model mid-chat, end to end (epic #116, U3).
 *
 * A `user.message` may carry `model`. Appending it sets the session's current model in the
 * same transaction, and the brain builds **every** model request from the session's current
 * model — so a switch applies from the next message, and from the next request inside the same
 * turn when one is sent while a reply is streaming.
 *
 * The evidence is in the log, not in the session resource: `span.model_request_start` is the
 * record of the model that actually ran for a request, so "the switch took effect" is a claim
 * about the spans, and `Session.model` is the *projection* the clients read. The in-process
 * suite covers the storage rules (`apps/server/src/model-switch.test.ts`); this file proves
 * them against a real server, a real Postgres, and the client the frontends use.
 */

const harness = e2eHarness('model-switch')

const FIRST_MODEL = 'openai/gpt-5.1'
const SECOND_MODEL = 'anthropic/claude-sonnet-5'

/**
 * The model of every model request the log records, in order.
 *
 * `model` is optional in the schema for the D9 transition only (a log stored before it keeps
 * validating), so the answer is `string | undefined` — and a request this brain appended is
 * expected to name one, which is what the assertions below pin.
 */
function requestedModels(log: readonly { type: string }[]): (string | undefined)[] {
  return log
    .filter(
      (event): event is ModelRequestStartEvent => event.type === EVENT_TYPES.modelRequestStart,
    )
    .map((event) => event.model)
}

/** One message, sent with the optional model switch the composer sends. */
async function send(client: Client, sessionId: string, text: string, model?: string) {
  const response = await client.sessions.events.send(sessionId, [
    {
      type: 'user.message',
      content: [{ type: 'text', text }],
      ...(model === undefined ? {} : { model: { id: model } }),
    },
  ])
  return response.data[0]?.seq
}

describe('switching the model mid-chat (U3)', () => {
  it('takes effect from the message that carries it, and sticks for the messages after', async () => {
    const server = await harness.server()
    const client = await harness.client(server)

    const session = SessionSchema.parse(
      await client.sessions.create({ model: { id: FIRST_MODEL } }),
    )
    expect(session.model).toEqual({ id: FIRST_MODEL })

    await send(client, session.id, 'the first message')
    await waitForTurnEnd(client, session.id)

    // The switch: this message carries the model, and the append is what changes the session.
    const switchSeq = await send(client, session.id, 'and now something else', SECOND_MODEL)
    await waitForTurnEnd(client, session.id, { afterSeq: switchSeq })

    // The projection is the new model — the same transaction as the append, so a read taken
    // once the message was accepted cannot see the old one.
    expect((await client.sessions.get(session.id)).model).toEqual({ id: SECOND_MODEL })

    // A message without a model leaves it alone: the switch is sticky, not per-message.
    const afterSeq = await send(client, session.id, 'and one more')
    await waitForTurnEnd(client, session.id, { afterSeq })

    const log = await readLog(client, session.id)
    expect(requestedModels(log)).toEqual([FIRST_MODEL, SECOND_MODEL, SECOND_MODEL])
    expect((await client.sessions.get(session.id)).model).toEqual({ id: SECOND_MODEL })

    // The log is the source of truth and names the switch: the message that changed the model
    // carries it, and the ones that did not do not.
    const messages = userMessages(log) as readonly UserMessageEvent[]
    expect(messages.map((message) => message.model?.id ?? null)).toEqual([null, SECOND_MODEL, null])
  })

  it('applies from the next request when it is sent while a reply is streaming', async () => {
    const server = await harness.server()
    const client = await harness.client(server)

    const session = SessionSchema.parse(
      await client.sessions.create({ model: { id: FIRST_MODEL } }),
    )

    // A long reply, so the turn is still running when the steering message lands. The brain
    // finishes the request in flight on the model it started with and builds the next one from
    // the session — which is the switch.
    const firstSeq = await send(client, session.id, `${MOCK_SLOW_MARKER} a long first answer`)

    // The switch can only mean "the next request" once the first one is open: a request's
    // model is resolved before its `span.model_request_start` is appended, so this wait is
    // what tells the test the request in flight is already committed to the old model — send
    // the steering message earlier and the switch is simply the model of the only request
    // there is. (The slow reply streams for about ten seconds, so the switch still lands well
    // inside that first request.)
    const firstRequest = await waitForModelRequestStart(client, session.id, { afterSeq: firstSeq })
    expect(firstRequest.model).toBe(FIRST_MODEL)

    // The steering message is accepted while the turn runs: the reply's own request is already
    // past its model lookup, so this one cannot change it — only the request after it.
    const secondSeq = await send(client, session.id, 'steer it somewhere else', SECOND_MODEL)
    expect(secondSeq).toBeGreaterThan(firstSeq ?? 0)

    await waitForTurnEnd(client, session.id, { afterSeq: secondSeq })

    // Two requests in one turn, two models: the one in flight kept the model it started with,
    // and the request the steering message caused ran on the new one.
    const log = await readLog(client, session.id)
    expect(requestedModels(log)).toEqual([FIRST_MODEL, SECOND_MODEL])
    expect((await client.sessions.get(session.id)).model).toEqual({ id: SECOND_MODEL })
  })

  it('refuses a switch that is not a provider/model id, and appends nothing', async () => {
    const server = await harness.server()
    const client = await harness.client(server)

    const session = SessionSchema.parse(
      await client.sessions.create({ model: { id: FIRST_MODEL } }),
    )

    for (const bad of ['gpt-5.1', 'openai/', '/gpt-5.1', 'openai//gpt-5.1']) {
      const refused = await errorOf(() =>
        client.sessions.events.send(session.id, [
          {
            type: 'user.message',
            content: [{ type: 'text', text: 'never stored' }],
            model: { id: bad },
          },
        ]),
      )
      expect([bad, refused.status]).toEqual([bad, 400])
      expect([bad, refused.type]).toEqual([bad, 'invalid_request_error'])
    }

    // Nothing was appended and the model did not move: a refused switch is not a switch.
    expect(await readLog(client, session.id)).toEqual([])
    expect((await client.sessions.get(session.id)).model).toEqual({ id: FIRST_MODEL })

    // The shape rule is the same at creation, where the inline model takes the same path.
    const malformedAtCreation = await errorOf(() =>
      client.sessions.create({ model: { id: 'not-a-router-id' } }),
    )
    expect(malformedAtCreation.status).toBe(400)

    // And a well-formed id the catalogue does not know is accepted: the router takes models
    // the catalogue has never heard of (C5).
    await send(client, session.id, 'a model ahead of the catalogue', 'acme/not-in-any-catalogue')
    await waitForTurnEnd(client, session.id)
    expect((await client.sessions.get(session.id)).model).toEqual({
      id: 'acme/not-in-any-catalogue',
    })
  })
})
