import {
  API_VERSION_PREFIX,
  EVENT_TYPES,
  type Session,
  type StoredEvent,
} from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { createTokenBudgetResolver } from './catalog/context-budget'
import type { ModelRegistry } from './catalog/registry'
import {
  asUser,
  createTestApp,
  httpSendMessage,
  postJson,
  postJsonAs,
  waitForIdle,
} from './test-support'

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

/**
 * The per-user controls over HTTP (epic #277, C3; issue #282): the threshold, the summary model
 * and the pass limit come from the **session owner's** stored preferences, resolved per request
 * through the production resolver (`resolveCompaction`), so one user's choices reach their chat
 * and never another's.
 */
describe('the per-user compaction controls over HTTP', () => {
  const PREFERENCES = `${API_VERSION_PREFIX}/me/preferences`

  /**
   * Two small models, one per provider: the chat's (`tiny/model`) and a dedicated summarizer
   * (`small/sum`), each with the same 3000-token budget so the cut is available.
   */
  const twoModels: ModelRegistry = {
    models: (provider) => {
      if (provider === 'tiny') {
        return [{ id: 'model', contextWindow: 4_000, maxOutput: 1_000 }]
      }
      if (provider === 'small') {
        return [{ id: 'sum', contextWindow: 4_000, maxOutput: 1_000 }]
      }
      return []
    },
  }

  /** Three messages of ~500 tokens: ~1500 of context — over a 0.3 share of 3000, under 0.7. */
  const batch = Array.from({ length: 3 }, () => ({
    type: EVENT_TYPES.userMessage,
    content: [{ type: 'text', text: LONG }],
  }))

  /** Create a session on `tiny/model` as one caller, and send it the batch. */
  async function run(
    test: ReturnType<typeof createTestApp>,
    token?: string,
  ): Promise<{ id: string; events: StoredEvent[] }> {
    const created =
      token === undefined
        ? await postJson(test, SESSIONS, { model: { id: 'tiny/model' } })
        : await postJsonAs(test, token, SESSIONS, { model: { id: 'tiny/model' } })
    const session = (await created.json()) as Session
    const sent =
      token === undefined
        ? await postJson(test, `${SESSIONS}/${session.id}/events`, { events: batch })
        : await postJsonAs(test, token, `${SESSIONS}/${session.id}/events`, { events: batch })
    expect(sent.status).toBe(200)
    await waitForIdle(test.store, session.id)
    const response =
      token === undefined
        ? await test.request(`${SESSIONS}/${session.id}/events`)
        : await test.request(`${SESSIONS}/${session.id}/events`, { headers: asUser(token) })
    const read = (await response.json()) as { data: StoredEvent[] }
    return { id: session.id, events: read.data }
  }

  it('compacts at the owner’s share and with the owner’s summary model', async () => {
    const test = createTestApp({
      registry: twoModels,
      replies: [{ text: ['## Goal\nfolded'] }, { text: ['ok'] }],
      resolveCompaction: true,
    })

    // The caller asks for a lower trigger share and a dedicated summarizer.
    const written = await test.request(PREFERENCES, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ compaction_threshold: 0.3, summary_model: 'small/sum' }),
    })
    expect(written.status).toBe(200)

    const { events } = await run(test)
    const summary = events.find((event) => event.type === 'session.context_summary')
    // The owner's share fired (1500 > 0.3 × 3000) and the owner's model wrote it.
    expect(summary).toMatchObject({ reason: 'threshold', summary_model: 'small/sum', passes: 1 })
    expect(summary?.type === 'session.context_summary' ? summary.tokens_before : 0).toBeGreaterThan(
      900,
    )
  })

  it('does not reach another user’s chat, whose defaults stand', async () => {
    const test = createTestApp({
      registry: twoModels,
      replies: [{ text: ['## Goal\nfolded'] }, { text: ['ok'] }],
      resolveCompaction: true,
    })
    // One user writes preferences; the other saves nothing and keeps the server's 0.7 share.
    await test.request(PREFERENCES, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ compaction_threshold: 0.3, summary_model: 'small/sum' }),
    })
    const other = await test.signIn('compaction-other@example.com')

    const { events } = await run(test, other.token)
    // 1500 of context is under 0.7 × 3000, so the second user's chat writes no summary — the
    // first user's preference did not travel with the model.
    expect(events.map((event) => event.type)).not.toContain('session.context_summary')
    expect(events.map((event) => event.type)).not.toContain('session.context_summary_progress')
  })
})
