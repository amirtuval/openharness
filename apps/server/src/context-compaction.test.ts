import {
  API_VERSION_PREFIX,
  EVENT_TYPES,
  type Session,
  type StoredEvent,
} from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { createTokenBudgetResolver } from './catalog/context-budget'
import type { ModelRegistry } from './catalog/registry'
import { createTestApp, httpSendMessage, postJson, waitForIdle } from './test-support'

/**
 * Context compaction over HTTP (epic #277, C2; issue #279).
 *
 * The brain's own suite covers the engine; this is the server's half — the production wiring
 * (a threshold from the config, budgets from the registry) reaching `runTurn`, a summary landing
 * in the log through the real append path, and the chat continuing on the model it ran.
 */

const SESSIONS = `${API_VERSION_PREFIX}/sessions`

/**
 * One small model: a 4000-token window with a 1000-token output ceiling, so the history budget
 * is 3000 and the default 0.7 threshold fires at 2100 tokens of context.
 */
const registry: ModelRegistry = {
  models: (provider) =>
    provider === 'tiny' ? [{ id: 'model', contextWindow: 4_000, maxOutput: 1_000 }] : [],
}

/** Five messages that together are over the threshold, each one ~500 tokens. */
const LONG = 'a'.repeat(2_000)

describe('context compaction over HTTP', () => {
  it('summarizes the older history before a request that would be over the threshold', async () => {
    const test = createTestApp({
      registry,
      replies: [{ text: ['ok'] }],
      // The production wiring: the config's threshold and the registry's budgets.
      compaction: { tokenBudgetFor: createTokenBudgetResolver(registry) },
    })
    const created = await postJson(test, SESSIONS, { model: { id: 'tiny/model' } })
    const session = (await created.json()) as Session

    // One batch: the first request of the turn sees all five as its context (~2500 tokens),
    // which is over 0.7 × 3000 — so it summarizes before it asks.
    const batch = Array.from({ length: 5 }, () => ({
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: LONG }],
    }))
    const sent = await postJson(test, `${SESSIONS}/${session.id}/events`, { events: batch })
    expect(sent.status).toBe(200)
    await waitForIdle(test.store, session.id)

    const events = (await (await test.request(`${SESSIONS}/${session.id}/events`)).json()) as {
      data: StoredEvent[]
    }
    const data = events.data

    const summary = data.find((event) => event.type === 'session.context_summary')
    expect(summary).toMatchObject({
      reason: 'threshold',
      summary_model: 'tiny/model',
      prompt_version: 'context-summary-v1',
      passes: 1,
    })
    // The summary covers the oldest messages and leaves the newest verbatim (K4).
    expect(summary?.type === 'session.context_summary' && summary.covers.to_seq).toBeGreaterThan(0)
    expect(summary?.type === 'session.context_summary' && summary.tokens_before).toBeGreaterThan(
      2_100,
    )

    // The summary request is in the log as one of the engine's own (K3, #247): marked
    // `purpose: 'summary'`, claiming nothing, and followed by a progress event.
    const summaryStart = data.find(
      (event) => event.type === 'span.model_request_start' && event.purpose === 'summary',
    )
    expect(summaryStart).toMatchObject({ consumes: [] })
    expect(data.map((event) => event.type)).toContain('session.context_summary_progress')

    // The chat request that followed was built from the summary: the summary as a system
    // message (this session has no system prompt of its own), then the messages the cut kept.
    const chatRequest = test.model.histories.at(-1) ?? []
    expect(chatRequest[0]?.role).toBe('system')
    expect(chatRequest[0]?.text).toContain('Earlier messages in this conversation were summarized')
    expect(chatRequest.slice(1).length).toBeGreaterThan(0)
    expect(chatRequest.slice(1).length).toBeLessThan(5)

    // And the summarizer's model did not become the chat's: the session still runs what it ran
    // (epic #277, C2 — the projection a summary span must not make).
    const read = await test.request(`${SESSIONS}/${session.id}`)
    expect(((await read.json()) as Session).model).toEqual({ id: 'tiny/model' })
  })

  it('leaves a chat under the threshold exactly as it was', async () => {
    const test = createTestApp({
      registry,
      replies: [{ text: ['ok'] }],
      compaction: { tokenBudgetFor: createTokenBudgetResolver(registry) },
    })
    const created = await postJson(test, SESSIONS, { model: { id: 'tiny/model' } })
    const session = (await created.json()) as Session

    // One short message: about 3 tokens of context, nowhere near 2100.
    await httpSendMessage(test, session.id, 'short')
    await waitForIdle(test.store, session.id)

    const events = (await (await test.request(`${SESSIONS}/${session.id}/events`)).json()) as {
      data: StoredEvent[]
    }
    const types = events.data.map((event) => event.type)
    expect(types).not.toContain('session.context_summary')
    expect(types).not.toContain('session.context_summary_progress')
    // The request is the one #278 built: the session's system prompt, then the message.
    expect(test.model.histories[0]?.map((message) => message.role)).toEqual(['user'])
  })
})
