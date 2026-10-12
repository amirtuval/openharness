import {
  API_VERSION_PREFIX,
  type Session,
  type SessionCompactEvent,
  type SessionCompactionEvent,
  type SessionId,
  type StoredEvent,
} from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { createTokenBudgetResolver } from './catalog/context-budget'
import type { ModelRegistry } from './catalog/registry'
import {
  createTestApp,
  defer,
  httpSendMessage,
  postJson,
  readHistory,
  waitFor,
  waitForIdle,
  type TestContext,
} from './test-support'

/**
 * Manual compaction over HTTP (epic #277, K8; issue #283).
 *
 * The engine's own suite covers the passes; this is the server's half — the route that turns a
 * `/compact [instructions]` into a stored `session.compact`, the brain answering it below the
 * automatic threshold, the user's guidance reaching the summarizer's prompt, and the clear
 * outcomes a short chat gets instead of a silent no-op.
 */

const SESSIONS = `${API_VERSION_PREFIX}/sessions`
const compact = (sessionId: string): string => `${SESSIONS}/${sessionId}/compact`

/** A 4000-token window, so the default 0.7 threshold fires at 2100 and these chats stay under it. */
const registry: ModelRegistry = {
  models: (provider) =>
    provider === 'tiny' ? [{ id: 'model', contextWindow: 4_000, maxOutput: 1_000 }] : [],
}

/** ~250 tokens, so four turns leave older history the manual cut can cover. */
const LONG = 'a'.repeat(1_000)

async function newSession(test: TestContext): Promise<Session> {
  const created = await postJson(test, SESSIONS, { model: { id: 'tiny/model' } })
  return (await created.json()) as Session
}

async function logOf(test: TestContext, sessionId: SessionId): Promise<StoredEvent[]> {
  // The whole log, page by page — a single `GET …/events` is one page, and a compaction's
  // events land past the first.
  return readHistory(test.store, sessionId)
}

/** Four short turns — below the threshold, so only a manual compaction summarizes them. */
async function longChat(test: TestContext, sessionId: SessionId): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await httpSendMessage(test, sessionId, LONG)
    await waitForIdle(test.store, sessionId)
  }
}

/**
 * Wait until the log holds `count` manual-compaction outcomes.
 *
 * `waitForIdle` cannot be used right after a `/compact`: the signal that starts the compaction's
 * turn is asynchronous, so the session is briefly still idle. Polling for the outcome event is
 * what makes the wait about the thing the assertions read.
 */
async function waitForOutcomes(
  test: TestContext,
  sessionId: SessionId,
  count: number,
): Promise<StoredEvent[]> {
  let data: StoredEvent[] = []
  await waitFor(
    async () => {
      data = await logOf(test, sessionId)
      return data.filter((event) => event.type === 'session.compaction').length >= count
    },
    { timeoutMs: 5_000, message: `session ${sessionId} did not record ${count} compaction(s)` },
  )
  return data
}

describe('POST /v1/sessions/{id}/compact', () => {
  it('summarizes older history on demand, with the user’s guidance in the prompt', async () => {
    const test = createTestApp({
      registry,
      replies: [{ text: ['ok'] }],
      compaction: { tokenBudgetFor: createTokenBudgetResolver(registry) },
    })
    const session = await newSession(test)
    await longChat(test, session.id)

    const response = await postJson(test, compact(session.id), {
      instructions: 'keep the API decisions in detail',
    })
    expect(response.status).toBe(200)
    const request = ((await response.json()) as { data: SessionCompactEvent }).data
    expect(request).toMatchObject({
      type: 'session.compact',
      instructions: 'keep the API decisions in detail',
    })
    const data = await waitForOutcomes(test, session.id, 1)

    const summary = data.find((event) => event.type === 'session.context_summary')
    // The threshold never fired, so the summary is the manual one — and its reason says so.
    expect(summary).toMatchObject({ reason: 'manual', summary_model: 'tiny/model', passes: 1 })

    const outcome = data.find(
      (event): event is SessionCompactionEvent => event.type === 'session.compaction',
    )
    expect(outcome).toMatchObject({
      outcome: 'summarized',
      instructions: 'keep the API decisions in detail',
    })
    // The outcome points at the summary it produced.
    expect(outcome?.summary_seq).toBe(summary?.seq)

    // The guidance reached the summarizer's instructions as the user's own (K8).
    const summaryPrompt = test.model.histories.find((prompt) =>
      prompt.some((message) => message.text.includes('History to summarize:')),
    )
    const system = summaryPrompt?.find((message) => message.role === 'system')?.text ?? ''
    expect(system).toContain('keep the API decisions in detail')
    expect(system).toContain('The user asked for this summary')
    // The base prompt is the one the engine ships — guidance never bumps its version (K7) —
    // and #306 bumped that base prompt for the tool-work section, so this is v2.
    expect(summary?.type === 'session.context_summary' && summary.prompt_version).toBe(
      'context-summary-v2',
    )
  })

  it('answers a short chat with a clear nothing-to-summarize outcome', async () => {
    const test = createTestApp({
      registry,
      replies: [{ text: ['ok'] }],
      compaction: { tokenBudgetFor: createTokenBudgetResolver(registry) },
    })
    const session = await newSession(test)
    await httpSendMessage(test, session.id, 'short')
    await waitForIdle(test.store, session.id)
    const requestsBefore = test.model.requests

    const response = await postJson(test, compact(session.id), {})
    expect(response.status).toBe(200)
    const data = await waitForOutcomes(test, session.id, 1)

    // Nothing was summarized — and the request did not make a model call to say so.
    expect(data.some((event) => event.type === 'session.context_summary')).toBe(false)
    const outcome = data.find(
      (event): event is SessionCompactionEvent => event.type === 'session.compaction',
    )
    expect(outcome).toMatchObject({ outcome: 'nothing_to_summarize' })
    expect(outcome?.message).toBeTruthy()
    expect(test.model.requests).toBe(requestsBefore)
  })

  it('queues behind a running turn and is idempotent while one request is pending', async () => {
    const gate = defer()
    const test = createTestApp({
      registry,
      // The first reply is held open so the test can act while the turn is running.
      replies: [{ text: ['one', 'two'], onChunk: () => gate.promise }, { text: ['ok'] }],
      compaction: { tokenBudgetFor: createTokenBudgetResolver(registry) },
    })
    const session = await newSession(test)
    await httpSendMessage(test, session.id, 'hold this')

    // The turn is running: `/compact` is accepted and stored, not run.
    const first = await postJson(test, compact(session.id), { instructions: 'be brief' })
    const firstBody = ((await first.json()) as { data: SessionCompactEvent }).data
    expect(firstBody.type).toBe('session.compact')

    // A second ask while the first waits for an answer is the same request, not a second.
    const second = await postJson(test, compact(session.id), { instructions: 'be brief' })
    const secondBody = ((await second.json()) as { data: SessionCompactEvent }).data
    expect(secondBody.id).toBe(firstBody.id)

    gate.release()
    const data = await waitForOutcomes(test, session.id, 1)

    expect(data.filter((event) => event.type === 'session.compact')).toHaveLength(1)
    expect(data.filter((event) => event.type === 'session.compaction')).toHaveLength(1)
    // The compaction ran after the held reply finished: queued for the turn's next boundary.
    const reply = data.findIndex((event) => event.type === 'agent.message')
    const outcome = data.findIndex((event) => event.type === 'session.compaction')
    expect(outcome).toBeGreaterThan(reply)
  })

  it('bounds the instructions it accepts', async () => {
    const test = createTestApp({
      compaction: { tokenBudgetFor: createTokenBudgetResolver(registry) },
    })
    const session = await newSession(test)

    const tooLong = await postJson(test, compact(session.id), { instructions: 'x'.repeat(2_001) })
    expect(tooLong.status).toBe(400)
    const empty = await postJson(test, compact(session.id), { instructions: '' })
    expect(empty.status).toBe(400)
    // Nothing was appended for either refusal.
    expect(
      (await logOf(test, session.id)).filter((e) => e.type === 'session.compact'),
    ).toHaveLength(0)

    const atLimit = await postJson(test, compact(session.id), { instructions: 'x'.repeat(2_000) })
    expect(atLimit.status).toBe(200)
  })

  it('404s a session that does not exist', async () => {
    const test = createTestApp()
    const response = await postJson(test, compact('sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ'), {})
    expect(response.status).toBe(404)
  })
})
