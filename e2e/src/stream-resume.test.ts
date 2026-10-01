import { type Client } from '@openharness/client'
import { type Session } from '@openharness/protocol'
import { MOCK_SLOW_MARKER } from '@openharness/server'
import { describe, expect, it } from 'vitest'

import {
  collectStream,
  e2eHarness,
  isStoredIdle,
  readLog,
  storedSeqs,
  waitForTurnEnd,
} from './harness'

/**
 * The SSE stream, and what a client that loses it sees.
 *
 * A chat UI holds one long-lived stream per open session, and streams break: a laptop sleeps,
 * a proxy reaps an idle connection, a server is deployed. The resume contract is that a
 * client says where it got to — `after_seq`, or the `last-event-id` header — and gets the
 * rest, exactly once. Both halves of that are checked here: a client that comes back to a
 * session on its own, and a stream iteration that never stopped and is fed the events of a
 * *different* server process.
 */

const harness = e2eHarness('stream-resume')

/** An agent and a session, the pair the tests here drive. */
async function newSession(client: Client): Promise<Session> {
  const agent = await client.agents.create({
    name: 'Echo agent',
    model: { id: 'anthropic/claude-sonnet-5' },
  })
  return await client.sessions.create({ agent: agent.id })
}

describe('resuming a session stream', () => {
  it('picks up after a disconnect where the client left off, without gaps or duplicates', async () => {
    const server = await harness.server()
    const client = harness.client(server)
    const session = await newSession(client)

    // A client that follows the session from the beginning.
    const first = collectStream(client, session.id, { deltas: true, afterSeq: 0 })
    await client.sendMessage(session.id, 'the message the live stream sees')
    await first.waitFor((events) => events.some(isStoredIdle), 'the first turn to end')
    await first.stop()

    const resumedFrom = storedSeqs(first.events).at(-1) ?? 0
    expect(resumedFrom).toBeGreaterThan(0)

    // A whole turn happens with nobody listening: this is what a reconnect has to replay.
    const sent = await client.sendMessage(session.id, 'the message nobody streamed')
    await waitForTurnEnd(client, session.id, { afterSeq: sent.seq })
    const log = await readLog(client, session.id)
    const lastSeq = log.at(-1)?.seq
    expect(lastSeq).toBeGreaterThan(resumedFrom)

    // The client comes back and says where it got to.
    const second = collectStream(client, session.id, { afterSeq: resumedFrom })
    await second.waitFor(
      (events) => storedSeqs(events).includes(lastSeq ?? 0),
      'the missed events to be replayed',
    )
    await second.stop()

    // What the two connections delivered between them covers the log in order, with every
    // event once. The first connection asked for deltas, so it also saw the reply's stored
    // chunks — which the log's replay read has since superseded — so the check is that the
    // union holds every event a reader needs, once, and nothing was delivered twice.
    const seen = [...storedSeqs(first.events), ...storedSeqs(second.events)]
    expect(seen).toEqual([...seen].sort((left, right) => left - right))
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen[0]).toBe(1)
    expect(log.every((event) => seen.includes(event.seq))).toBe(true)
    // The resume picked up exactly where the first connection stopped.
    expect(storedSeqs(second.events)[0]).toBeGreaterThan(resumedFrom)
  })

  it('keeps one stream alive across a restart of the server it is reading', async () => {
    const first = await harness.server()
    const client = harness.client(first)
    const session = await newSession(client)
    const prompt = `${MOCK_SLOW_MARKER} keep streaming through this`

    // No reconnects at the client, no second iteration: one `for await` that has to survive
    // the server being killed and replaced.
    const stream = collectStream(client, session.id, { afterSeq: 0 })
    await client.sendMessage(session.id, prompt)
    // A turn is in flight once its request has been opened: the user message, the status and
    // the span start are the three events the brain writes before it talks to the model.
    await stream.waitFor((events) => storedSeqs(events).length >= 3, 'the turn to be in flight')

    await first.kill('SIGKILL')
    // A different process, the same address: the client's own reconnect logic has no idea
    // anything happened, and its `last-event-id` is what makes the new process continue.
    const second = await harness.server({ port: first.port })
    const resumedClient = harness.client(second)
    await waitForTurnEnd(resumedClient, session.id, { timeoutMs: 45_000 })

    const log = await readLog(resumedClient, session.id)
    const lastSeq = log.at(-1)?.seq ?? 0
    await stream.waitFor(
      (events) => storedSeqs(events).includes(lastSeq),
      'the stream to catch up with the recovered turn',
      { timeoutMs: 45_000 },
    )
    await stream.stop()

    expect(storedSeqs(stream.events)).toEqual(log.map((event) => event.seq))
  })
})
