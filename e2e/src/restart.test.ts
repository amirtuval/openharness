import {
  createTranscript,
  selectMessages,
  selectStreamingMessage,
  type Client,
} from '@openharness/client'
import { EVENT_TYPES, type Session } from '@openharness/protocol'
import { MOCK_SLOW_MARKER } from '@openharness/server'
import { describe, expect, it } from 'vitest'

import {
  agentMessages,
  collectStream,
  e2eHarness,
  expectedSlowReply,
  hasOpenTurn,
  isPreviewDelta,
  modelRequestEnds,
  readLog,
  textOf,
  typesOf,
  waitForTurnEnd,
} from './harness'

/**
 * A server process that dies in the middle of a turn.
 *
 * This is the durable-session claim, tested the only way that means anything: `SIGKILL` the
 * process running a turn — no shutdown, no cleanup, no chance to write anything — start a new
 * one against the same database, and let it find the turn the way a real deployment would
 * after a crash. The log is the source of truth, so the recovery is visible in it: the
 * orphaned span is closed with `brain_lost`, the prompt is answered by the new process, and
 * the session ends up idle again.
 */

const harness = e2eHarness('restart')

/** An agent and a session, the pair the test drives. */
async function newSession(client: Client): Promise<Session> {
  const agent = await client.agents.create({
    name: 'Echo agent',
    model: { id: 'anthropic/claude-sonnet-5' },
  })
  return await client.sessions.create({ agent: agent.id })
}

describe('a server that dies mid-turn', () => {
  it('is recovered by the next process: brain_lost, a re-run, then idle', async () => {
    const first = await harness.server()
    const client = await harness.client(first)
    const session = await newSession(client)
    const prompt = `${MOCK_SLOW_MARKER} survive a SIGKILL`

    const watcher = collectStream(client, session.id, { deltas: true, afterSeq: 0 })
    await client.sendMessage(session.id, prompt)
    await watcher.waitFor((events) => events.some(isPreviewDelta), 'the first preview delta')
    await watcher.stop()

    // The turn is in flight: a request was opened and nothing has closed it yet. Only when
    // that is true is the kill below a mid-turn kill.
    const before = await readLog(client, session.id)
    expect(hasOpenTurn(before)).toBe(true)
    expect(agentMessages(before)).toHaveLength(0)

    await first.kill('SIGKILL')

    // A new process against the same database. Nothing tells it what happened; it finds the
    // open turn in the log on startup.
    const second = await harness.server()
    const resumed = await harness.client(second)
    expect(second.port).not.toBe(first.port)

    // The re-run streams the slow reply again, so this waits out a whole turn — the recovery
    // itself is immediate, but the ten-second reply has to be produced a second time.
    await waitForTurnEnd(resumed, session.id, { timeoutMs: 45_000 })

    const log = await readLog(resumed, session.id)
    const ends = modelRequestEnds(log)

    // The span the dead process left open is closed as lost, and the turn is run again —
    // from the same prompt, with nothing lost and nothing asked twice.
    expect(ends).toHaveLength(2)
    expect(ends[0]?.error?.type).toBe('brain_lost')
    expect(ends[0]?.is_error).toBe(true)
    // The crash closed the request before any message was stored, so the recovering brain's
    // span end supersedes the chunks the dead one had streamed: the orphaned range is skipped
    // by every reader from then on (D9).
    expect(ends[0]?.supersedes).toBeDefined()
    expect(ends[1]?.is_error).toBeNull()
    expect(ends[1]?.supersedes).toBeUndefined()
    // Exactly one reply, whole: the crashed attempt's chunks never became a message.
    expect(agentMessages(log).map(textOf)).toEqual([expectedSlowReply()])

    expect(typesOf(log).at(-1)).toBe(EVENT_TYPES.sessionStatusIdle)
    expect(hasOpenTurn(log)).toBe(false)
    // Every event is claimed: nothing is left queued for a third process to pick up.
    expect(log.every((event) => event.processed_at !== null)).toBe(true)

    // No ghost previews: a client that reads the log after the recovery folds one clean
    // conversation — nothing left streaming, the half-written reply nowhere in it.
    const transcript = createTranscript()
    for await (const event of resumed.sessions.events.iterate(session.id)) {
      transcript.apply(event)
    }
    expect(selectStreamingMessage(transcript.getState())).toBeNull()
    expect(
      selectMessages(transcript.getState()).map((message) => `${message.role}:${message.text}`),
    ).toEqual([`user:${prompt}`, `agent:${expectedSlowReply()}`])
  })
})
