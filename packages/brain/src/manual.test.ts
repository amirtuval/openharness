import { EVENT_TYPES } from '@openharness/protocol'
import { makeSessionCompact, makeSessionCompaction } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import { createContextStrategy } from './context'
import { pendingManualCompaction } from './manual'
import type { ModelFactory } from './model'
import type { ContextCompactionConfig } from './summarize'
import {
  contextSummaryOf,
  eventTypes,
  logOf,
  message,
  newSession,
  summaryRequestsOf,
} from './testing/harness'
import { mockModel, readPrompt, TEST_CREDENTIAL } from './testing/mock-model'
import { runTurn } from './turn'

/**
 * Manual compaction in the turn loop (epic #277, K8; issue #283).
 *
 * The engine's own suite covers the passes; this is the loop's half — a `/compact [instructions]`
 * read off the log at a request boundary, answered with the engine under `reason: 'manual'`
 * even below the threshold, the user's guidance reaching the summarizer's prompt, a chat too
 * short to compact getting a clear stored outcome, and an idle session compacting without a
 * model reply of its own.
 */

/** The summary model these tests choose — a different provider, so the chat's calls stay its own. */
const SUMMARY_MODEL = 'openai/gpt-5-mini'

/** Exactly `tokens` tokens of text, at the four-characters-per-token estimate. */
function text(tokens: number): string {
  return 'a'.repeat(tokens * 4)
}

/** A 2000-token chat budget, so a manual cut lands inside the history these tests build. */
const budgetFor = (modelId: string): number => (modelId === SUMMARY_MODEL ? 8_000 : 2_000)

/** The engine's config for these tests: manual always runs, and a summary model of its own. */
const compaction: ContextCompactionConfig = {
  // A threshold no small chat reaches, so only a manual request summarizes.
  threshold: 1,
  summaryModel: SUMMARY_MODEL,
  tokenBudgetFor: budgetFor,
}

describe('pendingManualCompaction', () => {
  it('is null when the log holds no request', () => {
    expect(pendingManualCompaction([])).toBeNull()
  })

  it('is the newest request while no outcome follows it', () => {
    expect(
      pendingManualCompaction([makeSessionCompact({ seq: 1, instructions: 'be brief' })]),
    ).toEqual({ seq: 1, instructions: 'be brief' })
    // A request with no guidance answers `null` instructions, not undefined.
    expect(
      pendingManualCompaction([makeSessionCompact({ seq: 2, instructions: undefined })]),
    ).toEqual({ seq: 2, instructions: null })
  })

  it('is answered by the outcome written after it', () => {
    expect(
      pendingManualCompaction([
        makeSessionCompact({ seq: 1 }),
        makeSessionCompaction({ seq: 2, outcome: 'nothing_to_summarize' }),
      ]),
    ).toBeNull()
  })

  it('answers the newest of two requests that raced', () => {
    // A second ask before the first was handled does not queue a second compaction: the newest
    // request is the one answered, and the outcome consumes both.
    expect(
      pendingManualCompaction([
        makeSessionCompact({ seq: 1, instructions: 'first' }),
        makeSessionCompact({ seq: 2, instructions: 'second' }),
      ]),
    ).toEqual({ seq: 2, instructions: 'second' })
    expect(
      pendingManualCompaction([
        makeSessionCompact({ seq: 1 }),
        makeSessionCompact({ seq: 2 }),
        makeSessionCompaction({ seq: 3 }),
      ]),
    ).toBeNull()
    // And a new request after an outcome is pending again.
    expect(
      pendingManualCompaction([
        makeSessionCompact({ seq: 1 }),
        makeSessionCompaction({ seq: 2 }),
        makeSessionCompact({ seq: 3, instructions: 'again' }),
      ]),
    ).toEqual({ seq: 3, instructions: 'again' })
  })
})

describe('the turn loop’s manual compaction (#283)', () => {
  /** A session with one answered turn, so there is older history a manual cut can cover. */
  async function answeredChat() {
    const chat = mockModel({ text: ['ok'] })
    const session = await newSession([
      message(text(500)),
      message(text(500)),
      message(text(500)),
      message(text(500)),
    ])
    // Answer the four messages with no compaction wired — the ordinary #278 turn. One request
    // claims them all, which is what a batch of messages is.
    await runTurn(session.sessionId, {
      store: session.store,
      model: chat.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
    })
    expect(chat.calls).toHaveLength(1)
    return { session, chat }
  }

  it('summarizes on demand below the threshold, with the guidance in the prompt', async () => {
    const { session, chat } = await answeredChat()
    const summary = mockModel({ text: ['## Goal\nsummarized'] })
    const factory: ModelFactory = (modelId, credential) =>
      (modelId === SUMMARY_MODEL ? summary : chat).factory(modelId, credential)

    await session.store.appendEvents(session.sessionId, [
      { type: EVENT_TYPES.sessionCompact, instructions: 'keep the API decisions in detail' },
    ])

    const outcome = await runTurn(session.sessionId, {
      store: session.store,
      model: factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      contextStrategy: createContextStrategy({ tokenBudgetFor: budgetFor }),
      compaction,
    })

    expect(outcome.outcome).toBe('idle')
    const events = await logOf(session.store, session.sessionId)
    const written = contextSummaryOf(events)
    expect(written).toMatchObject({ reason: 'manual', summary_model: SUMMARY_MODEL })
    expect(written?.covers.to_seq).toBeGreaterThan(0)

    // The outcome is stored, points at the summary, and echoes the guidance.
    const result = events.find((event) => event.type === EVENT_TYPES.sessionCompaction)
    expect(result).toMatchObject({
      outcome: 'summarized',
      instructions: 'keep the API decisions in detail',
    })
    expect(result?.type === EVENT_TYPES.sessionCompaction && result.summary_seq).toBe(written?.seq)

    // The user's guidance reached the summarizer's instructions.
    const prompt = readPrompt(summary.calls[0]!)
    expect(prompt[0]?.text).toContain('keep the API decisions in detail')
    expect(prompt[0]?.text).toContain('The user asked for this summary')

    // A manual compaction makes no chat reply of its own: the chat's one request stays one, and
    // the only new request is the summarizer's.
    expect(chat.calls).toHaveLength(1)
    expect(summaryRequestsOf(events)).toHaveLength(1)
  })

  it('answers a short chat with a clear nothing-to-summarize outcome', async () => {
    const chat = mockModel({ text: ['ok'] })
    const summary = mockModel({ text: ['unused'] })
    const session = await newSession([message('short')])
    await runTurn(session.sessionId, {
      store: session.store,
      model: chat.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
    })

    await session.store.appendEvents(session.sessionId, [{ type: EVENT_TYPES.sessionCompact }])

    const outcome = await runTurn(session.sessionId, {
      store: session.store,
      model: (modelId, credential) =>
        (modelId === SUMMARY_MODEL ? summary : chat).factory(modelId, credential),
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      contextStrategy: createContextStrategy({ tokenBudgetFor: budgetFor }),
      compaction,
    })

    expect(outcome.outcome).toBe('idle')
    const events = await logOf(session.store, session.sessionId)
    // Nothing was summarized, and no model call was made to say so.
    expect(contextSummaryOf(events)).toBeNull()
    expect(summary.calls).toHaveLength(0)
    const result = events.find((event) => event.type === EVENT_TYPES.sessionCompaction)
    expect(result).toMatchObject({ outcome: 'nothing_to_summarize' })
    expect(result?.type === EVENT_TYPES.sessionCompaction && result.message).toBeTruthy()
    // The turn is idle and wrote no agent reply: it existed only to answer the request.
    expect(eventTypes(events).filter((type) => type === EVENT_TYPES.agentMessage)).toHaveLength(1)
  })
})
