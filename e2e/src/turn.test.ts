import {
  createTranscript,
  selectIsRunning,
  selectMessages,
  selectStreamingMessage,
  type Client,
} from '@openharness/client'
import { EVENT_TYPES, type ModelRequestEndEvent, type Session } from '@openharness/protocol'
import { MOCK_MODEL_USAGE, MOCK_SLOW_MARKER, MOCK_SLOW_TOTAL_MS } from '@openharness/server'
import { describe, expect, it } from 'vitest'

import {
  agentMessages,
  collectStream,
  deltaText,
  e2eHarness,
  expectedSlowReply,
  isPreviewDelta,
  isStoredIdle,
  previewedEventId,
  readLog,
  textOf,
  typesOf,
  userMessages,
  waitForTurnEnd,
} from './harness'

/**
 * A turn, from the outside: what the client sees while it is running, what the log says once
 * it is over, and the two things a user can do to a turn in flight — steer it, and interrupt
 * it.
 *
 * Everything here runs against a real server process, a real Postgres and the built packages;
 * the model is the server's deterministic mock, so the assertions can be exact.
 */

const harness = e2eHarness('turn')

/** An agent and a session, the pair every test here drives. */
async function newSession(client: Client): Promise<Session> {
  const agent = await client.agents.create({
    name: 'Echo agent',
    model: { id: 'anthropic/claude-sonnet-5' },
  })
  return await client.sessions.create({ agent: agent.id })
}

describe('a full turn', () => {
  it('streams previews under the id of the reply they announce', async () => {
    const server = await harness.server()
    const client = harness.client(server)
    const session = await newSession(client)
    const prompt = 'hello from the end-to-end suite'

    // The boot log is the only place that says the schema came from the migrations this
    // process applied, rather than from a database somebody set up by hand.
    expect(server.output()).toMatch(/applied \d+ migration file\(s\)/)

    const transcript = createTranscript()
    const stream = collectStream(client, session.id, { deltas: true, afterSeq: 0 })
    await client.sendMessage(session.id, prompt)

    // A preview is visible while the reply is still being written.
    await stream.waitFor((events) => events.some(isPreviewDelta), 'the first preview delta')
    const previewed = previewedEventId(stream.events)
    expect(previewed).toMatch(/^sevt_/)
    const whileStreaming = [...stream.events]
    for (const event of whileStreaming) {
      transcript.apply(event)
    }
    const streaming = selectStreamingMessage(transcript.getState())
    expect(streaming?.id).toBe(previewed)
    expect(streaming?.text).toBe(deltaText(whileStreaming, previewed ?? ''))
    expect(streaming?.text.length).toBeGreaterThan(0)

    // The reply that ends up in the log carries the same id, so a UI can replace the preview
    // with the stored event in place.
    await stream.waitFor((events) => events.some(isStoredIdle), 'the turn to end')
    await stream.stop()
    const log = await readLog(client, session.id)
    const reply = agentMessages(log)[0]
    expect(reply?.id).toBe(previewed)
    expect(textOf(reply!)).toBe(prompt)

    // Previews may be shed — what arrived is a prefix of what was stored, never a rewrite.
    expect(prompt.startsWith(deltaText(whileStreaming, previewed ?? ''))).toBe(true)

    // The client's transcript reducer, driven by the same events, ends up with the chat.
    for (const event of stream.events) {
      transcript.apply(event)
    }
    expect(
      selectMessages(transcript.getState()).map((message) => [message.role, message.text]),
    ).toEqual([
      ['user', prompt],
      ['agent', prompt],
    ])
    expect(selectStreamingMessage(transcript.getState())).toBeNull()
    expect(selectIsRunning(transcript.getState())).toBe(false)
    expect(selectMessages(transcript.getState())[0]?.pending).toBe(false)
  })

  it('writes the log in the documented order, with usage and no gaps', async () => {
    const server = await harness.server()
    const client = harness.client(server)
    const session = await newSession(client)
    const prompt = 'another turn, please'

    const sent = await client.sendMessage(session.id, prompt)
    await waitForTurnEnd(client, session.id, { afterSeq: sent.seq })

    const log = await readLog(client, session.id)
    expect(typesOf(log)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    expect(log.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(log.every((event) => event.processed_at !== null)).toBe(true)

    const spanEnd = log.find(
      (event): event is ModelRequestEndEvent => event.type === EVENT_TYPES.modelRequestEnd,
    )
    expect(spanEnd?.model_usage).toEqual(MOCK_MODEL_USAGE)
    expect(spanEnd?.is_error).toBeNull()

    const [user] = userMessages(log)
    expect(user?.processed_at).not.toBeNull()
    expect(textOf(user!)).toBe(prompt)
    expect((await client.sessions.get(session.id)).status).toBe('idle')
  })

  it('answers a steering message in a second request', async () => {
    const server = await harness.server()
    const client = harness.client(server)
    const session = await newSession(client)
    const prompt = `${MOCK_SLOW_MARKER} take your time`
    const steering = 'actually, keep it short'

    const stream = collectStream(client, session.id, { deltas: true, afterSeq: 0 })
    await client.sendMessage(session.id, prompt)
    await stream.waitFor((events) => events.some(isPreviewDelta), 'the first preview delta')

    // The turn is mid-stream; this message is not part of the request in flight.
    await client.sendMessage(session.id, steering)
    await stream.waitFor((events) => events.some(isStoredIdle), 'the turn to end', {
      timeoutMs: MOCK_SLOW_TOTAL_MS * 2,
    })
    await stream.stop()

    const log = await readLog(client, session.id)
    // Two requests: the one that was streaming, and the one that answers the steering message.
    expect(log.filter((event) => event.type === EVENT_TYPES.modelRequestStart)).toHaveLength(2)
    expect(log.filter((event) => event.type === EVENT_TYPES.sessionStatusRunning)).toHaveLength(1)
    expect(log.filter((event) => event.type === EVENT_TYPES.sessionStatusIdle)).toHaveLength(1)
    expect(agentMessages(log).map(textOf)).toEqual([expectedSlowReply(), steering])
    expect(userMessages(log).every((message) => message.processed_at !== null)).toBe(true)
  })

  it('keeps the partial reply when a turn is interrupted', async () => {
    const server = await harness.server()
    const client = harness.client(server)
    const session = await newSession(client)
    const prompt = `${MOCK_SLOW_MARKER} interrupt this one`

    const stream = collectStream(client, session.id, { deltas: true, afterSeq: 0 })
    await client.sendMessage(session.id, prompt)
    await stream.waitFor((events) => events.some(isPreviewDelta), 'the first preview delta')
    const announced = previewedEventId(stream.events)

    await client.interrupt(session.id)
    await stream.waitFor((events) => events.some(isStoredIdle), 'the interrupted turn to end')
    await stream.stop()

    const log = await readLog(client, session.id)
    expect(typesOf(log)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.userInterrupt,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])

    const spanEnd = log.find(
      (event): event is ModelRequestEndEvent => event.type === EVENT_TYPES.modelRequestEnd,
    )
    expect(spanEnd?.error?.type).toBe('interrupted')
    expect(spanEnd?.is_error).toBe(true)

    // The reply that was cut short is kept, under the id its previews announced, and it is a
    // strict prefix of what the model was streaming: proof the interrupt landed mid-flight.
    const reply = agentMessages(log)[0]
    expect(reply?.id).toBe(announced)
    const partial = textOf(reply!)
    expect(partial.length).toBeGreaterThan(0)
    expect(expectedSlowReply().startsWith(partial)).toBe(true)
    expect(partial).not.toBe(expectedSlowReply())

    expect(userMessages(log).every((message) => message.processed_at !== null)).toBe(true)
    expect(userMessages(log)).toHaveLength(1)
  })
})
