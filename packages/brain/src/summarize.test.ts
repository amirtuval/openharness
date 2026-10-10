import type { ModelRequestPurpose } from '@openharness/protocol'
import { APICallError } from 'ai'
import { describe, expect, it } from 'vitest'

import { createContextStrategy } from './context'
import { contextSummary } from './events'
import type { ModelFactory, ResolveCredential } from './model'
import type { ContextCompactionConfig } from './summarize'
import { resolveContextCompaction, SUMMARY_PROMPT_VERSION, summarizeContext } from './summarize'
import {
  contextSummariesOf,
  contextSummaryOf,
  eventTypes,
  logOf,
  message,
  newSession,
  summaryRequestsOf,
  TEST_MODEL_ID,
  TEST_OWNER_ID,
  TEST_SYSTEM,
  textOf,
} from './testing/harness'
import type { MockModel, MockModelScript } from './testing/mock-model'
import { mockModel, readPrompt, TEST_CREDENTIAL } from './testing/mock-model'
import { runTurn } from './turn'

/**
 * The compaction engine (epic #277, C2; issue #279).
 *
 * Two layers. The engine on its own — `summarizeContext` against a hand-built log — pins the
 * decision it makes (where to cut, which model, how many passes, how items are capped) by
 * reading the prompts the summarizer was sent. The turn loop's half — the trigger at a request
 * boundary, the overflow retry, the failure path — is pinned by running `runTurn`.
 *
 * Every size here is exact, not approximate: `text(n)` costs exactly `n` tokens at the
 * characters-per-token estimate the engine budgets with, so the assertions about where the cut
 * lands are arithmetic rather than coincidence.
 */

/** The chat model the fixture session runs. */
const CHAT_MODEL = TEST_MODEL_ID
/** The summary model these tests choose — a different provider, so the fallbacks are real. */
const SUMMARY_MODEL = 'openai/gpt-5-mini'

/** Exactly `tokens` tokens of text, at the estimate the engine budgets with. */
function text(tokens: number): string {
  return 'a'.repeat(tokens * 4)
}

/** `tokens` tokens of text that begins with `label`, so a prompt can be searched for it. */
function tagged(tokens: number, label: number): string {
  return `[${label}]`.padEnd(8, '.') + 'a'.repeat(tokens * 4 - 8)
}

/** `count` user messages of `tokens` tokens each, labelled `[1]`…`[count]`. */
function history(count: number, tokens: number): ReturnType<typeof message>[] {
  return Array.from({ length: count }, (_, index) => message(tagged(tokens, index + 1)))
}

/** `count` user messages of `tokens` tokens each, with no label to search for. */
function messages(count: number, tokens: number): ReturnType<typeof message>[] {
  return Array.from({ length: count }, () => message(text(tokens)))
}

/** A factory that answers a scripted model per model id, and the recorded calls. */
interface ScriptedModels {
  readonly factory: ModelFactory
  readonly chat: MockModel
  readonly summary: MockModel
}

function scriptedModels(
  chatScripts: MockModelScript[],
  summaryScripts: MockModelScript[] = [{ text: ['## Goal\nsummarized'] }],
): ScriptedModels {
  const chat = mockModel(...chatScripts)
  const summary = mockModel(...summaryScripts)
  return {
    factory: (modelId, credential) =>
      (modelId === SUMMARY_MODEL ? summary : chat).factory(modelId, credential),
    chat,
    summary,
  }
}

/**
 * The engine tests' configuration: the chat's budget, the chosen summary model's, and the
 * summary model itself — `null` (the default) for the chat model writing its own summaries.
 *
 * `threshold: 0` makes the trigger fire for any positive estimate, so an engine test is about
 * the decision it makes rather than about the boundary the loop tests pin.
 */
function budgets(
  chatBudget: number,
  summaryBudget: number,
  summaryModel: string | null = null,
): ContextCompactionConfig {
  return {
    threshold: 0,
    summaryModel,
    tokenBudgetFor: (modelId) => (modelId === SUMMARY_MODEL ? summaryBudget : chatBudget),
  }
}

/** What the engine tests hand `summarizeContext` beyond the log. */
interface EngineRunOptions {
  readonly scripts: ScriptedModels
  readonly resolveCredential?: ResolveCredential
  readonly config?: ContextCompactionConfig
  readonly estimatedTokens?: number
  readonly reason?: 'threshold' | 'overflow' | 'manual'
  readonly system?: string | null
}

/** Run the engine on a session's log, as the turn loop would. */
async function runEngine(
  session: Awaited<ReturnType<typeof newSession>>,
  options: EngineRunOptions,
) {
  const events = await logOf(session.store, session.sessionId)
  const config = resolveContextCompaction(options.config ?? budgets(20_000, 8_000, SUMMARY_MODEL))
  return await summarizeContext({
    chatModel: CHAT_MODEL,
    reason: options.reason ?? 'threshold',
    events,
    system: options.system === undefined ? TEST_SYSTEM : options.system,
    estimatedTokens: options.estimatedTokens ?? 1_000_000,
    config,
    model: options.scripts.factory,
    resolveCredential: options.resolveCredential ?? (() => Promise.resolve(TEST_CREDENTIAL)),
    append: (appended) => session.store.appendEvents(session.sessionId, appended),
  })
}

describe('summarizeContext — where the history is cut (K4)', () => {
  it('keeps the newest quarter of the chat budget verbatim, at a user-message boundary', async () => {
    // 15 messages of 1000 tokens, a 20k chat budget with the chat model summarizing: the tail
    // must reach 5000 tokens (five messages) and the first ten are what the summary covers.
    const session = await newSession(history(15, 1_000))
    const scripts = scriptedModels([{ text: ['ok'] }])
    const result = await runEngine(session, { scripts, config: budgets(20_000, 20_000) })

    expect(result.outcome).toBe('summarized')
    expect(result.coversTo).toBe(10)

    const events = await logOf(session.store, session.sessionId)
    expect(events[10]?.seq).toBe(11)
    const summary = contextSummaryOf(events)!
    expect(summary.covers.to_seq).toBe(10)
    expect(summary.passes).toBe(1)
    expect(summary.reason).toBe('threshold')
    expect(summary.prompt_version).toBe(SUMMARY_PROMPT_VERSION)
    expect(summary.summary_model).toBe(CHAT_MODEL)

    // The summarizer was sent the ten covered messages and nothing newer. The chat model wrote
    // this one (no summary model is configured here), so its call is the chat mock's.
    const prompt = readPrompt(scripts.chat.calls[0]!)
    const sent = prompt.map((entry) => entry.text).join('\n')
    for (const label of [1, 5, 10]) {
      expect(sent).toContain(`[${label}]`)
    }
    expect(sent).not.toContain('[11]')
    expect(prompt[0]?.role).toBe('system')
    expect(prompt[0]?.text).toContain('## Goal')
    expect(prompt[0]?.text).toContain('Keep the summary under 2400 tokens.')
  })

  it('answers skipped, writing nothing, when there is nowhere to cut', async () => {
    // One message is the whole history: summarizing it away would leave the model with nothing.
    const session = await newSession(messages(1, 1_000))
    const scripts = scriptedModels([{ text: ['ok'] }])
    const before = await logOf(session.store, session.sessionId)

    const result = await runEngine(session, { scripts })

    expect(result.outcome).toBe('skipped')
    expect(await logOf(session.store, session.sessionId)).toEqual(before)
    expect(scripts.summary.calls).toEqual([])
  })

  it('stops short of the threshold, writing nothing (K2)', async () => {
    const session = await newSession(messages(15, 1_000))
    const scripts = scriptedModels([{ text: ['ok'] }])
    // A threshold of 0.7 against a budget of 1,000: a 15k context is far over it… so this run
    // is the *under* case only when the estimate is under the share.
    const result = await runEngine(session, {
      scripts,
      config: { threshold: 0.7, tokenBudgetFor: () => 1_000_000 },
      estimatedTokens: 500_000,
    })

    expect(result.outcome).toBe('skipped')
    expect(scripts.summary.calls).toEqual([])
  })
})

describe('summarizeContext — incremental and chunked passes (K4/K5)', () => {
  it('updates the summary in force with only the newly covered history', async () => {
    const session = await newSession(history(20, 1_000))
    const log = await logOf(session.store, session.sessionId)
    // A summary already in force, covering the first ten messages.
    await session.store.appendEvents(session.sessionId, [
      contextSummary('## Goal\nthe earlier summary', { to_seq: log[9]!.seq }, 'threshold', {
        tokensBefore: 10_000,
        summaryModel: CHAT_MODEL,
        promptVersion: SUMMARY_PROMPT_VERSION,
        passes: 1,
      }),
    ])
    const scripts = scriptedModels([{ text: ['ok'] }])

    const result = await runEngine(session, { scripts })

    expect(result.outcome).toBe('summarized')
    const first = readPrompt(scripts.summary.calls[0]!)
    expect(first[0]?.text).toContain('The summary so far and the new history follow.')
    expect(first[1]?.text).toContain('the earlier summary')
    expect(first[2]?.text).toContain('New history:')
    // Only history newer than the summary in force is handed over: messages 11..15 are newly
    // covered (across the run's two passes), and the five the cut kept (16..20) are not.
    const sent = scripts.summary.calls
      .flatMap((call) => readPrompt(call))
      .map((entry) => entry.text)
      .join('\n')
    expect(sent).toContain('[11]')
    expect(sent).toContain('[15]')
    expect(sent).not.toContain('[16]')
    const events = await logOf(session.store, session.sessionId)
    expect(contextSummariesOf(events)).toHaveLength(2)
    expect(contextSummaryOf(events)?.covers.to_seq).toBe(log[14]!.seq)
  })

  it('folds a long history in slices, one pass each, within the plan (K5)', async () => {
    const session = await newSession(messages(15, 1_000))
    const scripts = scriptedModels(
      [{ text: ['ok'] }],
      [{ text: ['first'] }, { text: ['second'] }, { text: ['third'] }],
    )

    // An 8000-token summary budget: at most 2000 may go to the summary itself, so a pass
    // carries ~4000 tokens of history — the 10 covered messages need three passes.
    const result = await runEngine(session, {
      scripts,
      config: budgets(20_000, 8_000, SUMMARY_MODEL),
    })

    expect(result.outcome).toBe('summarized')
    expect(result.passes).toBe(3)
    expect(result.summaryModel).toBe(SUMMARY_MODEL)
    expect(scripts.summary.calls).toHaveLength(3)

    const events = await logOf(session.store, session.sessionId)
    const progress = events.filter((event) => event.type === 'session.context_summary_progress')
    expect(progress).toEqual([
      expect.objectContaining({ pass: 1, passes: 3 }),
      expect.objectContaining({ pass: 2, passes: 3 }),
      expect.objectContaining({ pass: 3, passes: 3 }),
    ])
    expect(contextSummaryOf(events)!.summary).toBe('third')
    expect(contextSummaryOf(events)!.passes).toBe(3)
  })

  it('summarizes the running summary alone when no slice fits, then continues (K5)', async () => {
    const session = await newSession(history(15, 1_000))
    const log = await logOf(session.store, session.sessionId)
    // A summary far over the cap the prompt asks for (2000 of this model's 8000-token budget):
    // a pass has no room for history beside it, so the summary is folded first.
    await session.store.appendEvents(session.sessionId, [
      contextSummary(text(8_000), { to_seq: log[14]!.seq }, 'threshold', {
        tokensBefore: 15_000,
        summaryModel: CHAT_MODEL,
        promptVersion: SUMMARY_PROMPT_VERSION,
        passes: 3,
      }),
    ])
    await session.store.appendEvents(session.sessionId, history(10, 1_000))
    const scripts = scriptedModels(
      [{ text: ['ok'] }],
      [{ text: ['## Goal\nfolded'] }, { text: ['## Goal\nfolded and extended'] }],
    )

    const result = await runEngine(session, {
      scripts,
      config: budgets(20_000, 8_000, SUMMARY_MODEL),
    })

    expect(result.outcome).toBe('summarized')
    // One fold, then two slices of the five covered messages at 4000 tokens each.
    expect(result.passes).toBe(3)
    const first = readPrompt(scripts.summary.calls[0]!)
    expect(first[1]?.text).toContain('Summary so far:')
    expect(first.map((entry) => entry.text).join('')).not.toContain('New history:')
    const second = readPrompt(scripts.summary.calls[1]!)
    expect(second.map((entry) => entry.text).join('')).toContain('New history:')
    const events = await logOf(session.store, session.sessionId)
    const progress = events.filter((event) => event.type === 'session.context_summary_progress')
    expect(progress).toHaveLength(3)
    expect(progress[0]).toMatchObject({ pass: 1, passes: 3 })
  })

  it('caps one oversized item in the summarizer’s input (K6)', async () => {
    const session = await newSession([message(text(3_000)), ...messages(14, 1_000)])
    const scripts = scriptedModels([{ text: ['ok'] }])

    const result = await runEngine(session, {
      scripts,
      config: budgets(20_000, 8_000, SUMMARY_MODEL),
    })

    expect(result.outcome).toBe('summarized')
    const sent = scripts.summary.calls
      .flatMap((call) => readPrompt(call))
      .map((entry) => entry.text)
      .join('\n')
    // A quarter of the 8000-token summary budget is 2000, so the 3000-token message is cut to a
    // head and a tail around the marker rather than handed over whole.
    expect(sent).toContain('tokens omitted')
    expect(sent).not.toContain(text(3_000))
  })
})

describe('summarizeContext — which model writes it (K3/K5)', () => {
  it('falls back to the chat model when the chosen one would need too many passes', async () => {
    const session = await newSession(messages(15, 1_000))
    const scripts = scriptedModels([{ text: ['ok'] }], [{ text: ['never reached'] }])

    // A 4000-token summary budget: ~770 tokens of history per pass, so ten covered messages
    // need fourteen passes — over the limit of three.
    const result = await runEngine(session, {
      scripts,
      config: {
        threshold: 0,
        summaryModel: SUMMARY_MODEL,
        tokenBudgetFor: (id) => (id === SUMMARY_MODEL ? 4_000 : 20_000),
      },
    })

    expect(result.outcome).toBe('summarized')
    expect(result.summaryModel).toBe(CHAT_MODEL)
    expect(result.fallbackReason).toContain('passes')
    expect(scripts.summary.calls).toEqual([])

    const events = await logOf(session.store, session.sessionId)
    const summary = contextSummaryOf(events)!
    expect(summary.summary_model).toBe(CHAT_MODEL)
    expect(summary.fallback_reason).toContain('over the limit of 3')
    expect(summary.passes).toBe(1)
  })

  it('falls back to the chat model when the chosen one has no credential (K3)', async () => {
    const session = await newSession(messages(15, 1_000))
    const scripts = scriptedModels([{ text: ['ok'] }], [{ text: ['never reached'] }])
    const resolveCredential: ResolveCredential = (provider) =>
      Promise.resolve(provider === 'openai' ? null : TEST_CREDENTIAL)

    const result = await runEngine(session, { scripts, resolveCredential })

    expect(result.outcome).toBe('summarized')
    expect(result.summaryModel).toBe(CHAT_MODEL)
    expect(result.fallbackReason).toBe(`${SUMMARY_MODEL} has no credential`)
    expect(scripts.summary.calls).toEqual([])
    const events = await logOf(session.store, session.sessionId)
    expect(contextSummaryOf(events)!.fallback_reason).toBe(`${SUMMARY_MODEL} has no credential`)
  })
})

describe('summarizeContext — recording what it did (K3, #247, #279)', () => {
  it('marks every pass as a summary request, and adds its usage to the session totals', async () => {
    const session = await newSession(messages(15, 1_000))
    const scripts = scriptedModels(
      [{ text: ['ok'] }],
      [
        { text: ['first'], usage: { input_tokens: 500, output_tokens: 40 } },
        { text: ['second'], usage: { input_tokens: 600, output_tokens: 50 } },
        { text: ['third'], usage: { input_tokens: 700, output_tokens: 60 } },
      ],
    )

    await runEngine(session, { scripts, config: budgets(20_000, 8_000, SUMMARY_MODEL) })

    const events = await logOf(session.store, session.sessionId)
    const purposes: (ModelRequestPurpose | undefined)[] = summaryRequestsOf(events).map(
      (start) => start.purpose,
    )
    expect(purposes).toEqual(['summary', 'summary', 'summary'])
    for (const start of summaryRequestsOf(events)) {
      expect(start.consumes).toEqual([])
      expect(start.model).toBe(SUMMARY_MODEL)
    }

    const usage = events.filter((event) => event.type === 'session.usage').at(-1)
    expect(usage?.models).toEqual([
      {
        model: SUMMARY_MODEL,
        usage: {
          input_tokens: 1_800,
          output_tokens: 150,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        requests: 3,
      },
    ])
    expect(usage?.input_tokens).toBe(1_800)

    // Every span a summary request opened is closed with its own usage.
    const ends = events.filter((event) => event.type === 'span.model_request_end')
    expect(ends).toHaveLength(3)
    expect(ends.map((end) => end.model_usage.input_tokens)).toEqual([500, 600, 700])
  })

  it('closes the span with the error and writes no summary when the summarizer fails (K11)', async () => {
    const session = await newSession(messages(15, 1_000))
    const failure = new APICallError({
      message: 'the summarizer is down',
      url: 'https://api.example.test/v1/messages',
      requestBodyValues: {},
      statusCode: 500,
      isRetryable: true,
    })
    const scripts = scriptedModels([{ text: ['ok'] }], [{ failWith: failure }])

    const result = await runEngine(session, { scripts })

    expect(result.outcome).toBe('failed')
    const events = await logOf(session.store, session.sessionId)
    expect(contextSummaryOf(events)).toBeNull()
    const end = events.find((event) => event.type === 'span.model_request_end')
    expect(end).toMatchObject({
      is_error: true,
      error: { type: 'model_error', message: 'the summarizer is down' },
    })
    // The progress event is in the log — everything a client is shown is stored (D9).
    expect(eventTypes(events)).toContain('session.context_summary_progress')
  })

  it('answers failed, writing no summary, when the summarizer returns nothing', async () => {
    const session = await newSession(messages(15, 1_000))
    const scripts = scriptedModels([{ text: ['ok'] }], [{ text: [] }])

    const result = await runEngine(session, { scripts })

    expect(result.outcome).toBe('failed')
    const events = await logOf(session.store, session.sessionId)
    expect(contextSummaryOf(events)).toBeNull()
  })
})

describe('runTurn — the trigger at the request boundary (K2)', () => {
  it('summarizes when the measured context is over the threshold share of the chat budget', async () => {
    const session = await newSession(messages(5, 1_000))
    const scripts = scriptedModels([{ text: ['the reply'], usage: { input_tokens: 5_100 } }])
    const tokenBudgetFor = (modelId: string) => (modelId === SUMMARY_MODEL ? 8_000 : 4_000)

    const outcome = await runTurn(session.sessionId, {
      store: session.store,
      model: scripts.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      contextStrategy: createContextStrategy({ tokenBudgetFor }),
      compaction: { summaryModel: SUMMARY_MODEL, tokenBudgetFor },
    })

    expect(outcome.outcome).toBe('idle')
    expect(scripts.summary.calls).toHaveLength(1)
    const summaryCall = readPrompt(scripts.summary.calls[0]!)
    expect(summaryCall[0]?.text).toContain('## Goal')

    const events = await logOf(session.store, session.sessionId)
    const summary = contextSummaryOf(events)!
    expect(summary.reason).toBe('threshold')
    expect(summary.tokens_before).toBe(5_010)

    // The chat request that followed was built from the summary, not from the history it
    // replaced: a system message carrying the summary introduction.
    const chatCall = readPrompt(scripts.chat.calls[0]!)
    expect(chatCall[0]).toEqual({ role: 'system', text: TEST_SYSTEM })
    expect(chatCall[1]?.role).toBe('system')
    expect(chatCall[1]?.text).toContain('Earlier messages in this conversation were summarized')
  })

  it('leaves a chat that never reaches the threshold exactly as it was', async () => {
    const session = await newSession(messages(5, 1_000))
    const scripts = scriptedModels([{ text: ['the reply'] }])
    const tokenBudgetFor = () => 200_000

    const outcome = await runTurn(session.sessionId, {
      store: session.store,
      model: scripts.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      contextStrategy: createContextStrategy({ tokenBudgetFor }),
      compaction: { tokenBudgetFor },
    })

    expect(outcome.outcome).toBe('idle')
    expect(scripts.summary.calls).toEqual([])
    const events = await logOf(session.store, session.sessionId)
    expect(contextSummaryOf(events)).toBeNull()
    expect(eventTypes(events)).not.toContain('session.context_summary_progress')
    expect(eventTypes(events)).not.toContain('session.context_summary')
    // The request is the one #278 built: the session's system prompt, then the messages.
    const chatCall = readPrompt(scripts.chat.calls[0]!)
    expect(chatCall.map((entry) => entry.role)).toEqual([
      'system',
      'user',
      'user',
      'user',
      'user',
      'user',
    ])
  })

  it('carries on with trimming when the summarizer fails (K11)', async () => {
    const session = await newSession(messages(5, 1_000))
    const scripts = scriptedModels(
      [{ text: ['the reply'], usage: { input_tokens: 5_100 } }],
      [{ failWith: new Error('the summarizer is down') }],
    )
    const tokenBudgetFor = (modelId: string) => (modelId === SUMMARY_MODEL ? 8_000 : 4_000)

    const outcome = await runTurn(session.sessionId, {
      store: session.store,
      model: scripts.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      contextStrategy: createContextStrategy({ tokenBudgetFor }),
      compaction: { summaryModel: SUMMARY_MODEL, tokenBudgetFor },
    })

    expect(outcome.outcome).toBe('idle')
    const events = await logOf(session.store, session.sessionId)
    expect(contextSummaryOf(events)).toBeNull()
    expect(events.some((event) => event.type === 'agent.message')).toBe(true)
    expect(eventTypes(events).at(-1)).toBe('session.status_idle')
  })
})

/** A provider refusal shaped the way an OpenAI-family 400 reports an over-long request. */
function overflowError(): APICallError {
  return new APICallError({
    message: "This model's maximum context length is 4000 tokens.",
    url: 'https://api.example.test/v1/messages',
    requestBodyValues: {},
    statusCode: 400,
    isRetryable: false,
    data: {
      error: {
        message: "This model's maximum context length is 4000 tokens.",
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
      },
    },
  })
}

describe('runTurn — a request the provider refused as too long (K2)', () => {
  it('compacts with tighter caps and retries exactly once', async () => {
    // 30k tokens of history against a 200k budget: the threshold never fires (70% is 140k), so
    // the only compaction in this turn is the overflow one — whose tail is an eighth of the
    // budget, 25k, which leaves the oldest 4k to summarize.
    const session = await newSession(messages(15, 2_000))
    const scripts = scriptedModels(
      [{ failWith: overflowError() }, { text: ['the reply'] }],
      [{ text: ['## Goal\nfolded tight'] }],
    )
    const tokenBudgetFor = (modelId: string) => (modelId === SUMMARY_MODEL ? 8_000 : 200_000)

    const outcome = await runTurn(session.sessionId, {
      store: session.store,
      model: scripts.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      contextStrategy: createContextStrategy({ tokenBudgetFor }),
      compaction: { summaryModel: SUMMARY_MODEL, tokenBudgetFor },
    })

    expect(outcome.outcome).toBe('idle')
    expect(scripts.chat.calls).toHaveLength(2)
    expect(scripts.summary.calls).toHaveLength(1)

    const events = await logOf(session.store, session.sessionId)
    const summary = contextSummaryOf(events)!
    expect(summary.reason).toBe('overflow')
    expect(eventTypes(events)).toContain('session.context_summary')
    // The retry's request was built from the summary.
    const retry = readPrompt(scripts.chat.calls[1]!)
    expect(retry[1]?.text).toContain('Earlier messages in this conversation were summarized')
    // The refusal is in the log as a retryable-by-us error, not as a terminal one.
    const errors = events.filter((event) => event.type === 'session.error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.error.retry_status).toEqual({ type: 'retrying' })
  })

  it('ends with a clear error, without looping, when the retry does not fit either', async () => {
    const session = await newSession(messages(15, 2_000))
    const scripts = scriptedModels(
      [{ failWith: overflowError() }, { failWith: overflowError() }, { text: ['never reached'] }],
      [{ text: ['## Goal\nfolded tight'] }],
    )
    const tokenBudgetFor = (modelId: string) => (modelId === SUMMARY_MODEL ? 8_000 : 200_000)

    const outcome = await runTurn(session.sessionId, {
      store: session.store,
      model: scripts.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      contextStrategy: createContextStrategy({ tokenBudgetFor }),
      compaction: { summaryModel: SUMMARY_MODEL, tokenBudgetFor },
    })

    expect(outcome.outcome).toBe('error')
    expect(scripts.chat.calls).toHaveLength(2)
    const events = await logOf(session.store, session.sessionId)
    const errors = events.filter((event) => event.type === 'session.error')
    expect(errors.at(-1)?.error.retry_status).toEqual({ type: 'exhausted' })
    expect(errors.at(-1)?.error.message).toContain(
      'was compacted and the request still did not fit',
    )
    expect(eventTypes(events).at(-1)).toBe('session.status_idle')
  })

  it('compacts then fails clearly when there is nowhere to cut', async () => {
    // One message: the overflow cannot be compacted away, and the turn says so rather than
    // trying the same request again.
    const session = await newSession(messages(1, 5_000))
    const scripts = scriptedModels([{ failWith: overflowError() }, { text: ['never reached'] }])

    const outcome = await runTurn(session.sessionId, {
      store: session.store,
      model: scripts.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      compaction: { tokenBudgetFor: () => 200_000 },
    })

    expect(outcome.outcome).toBe('error')
    expect(scripts.chat.calls).toHaveLength(1)
    expect(scripts.summary.calls).toEqual([])
    const events = await logOf(session.store, session.sessionId)
    expect(eventTypes(events)).toContain('session.error')
    expect(eventTypes(events)).toContain('session.status_idle')
    // The message must not claim a compaction that never happened — the summary was skipped
    // because there was nowhere to cut, and it says so.
    const errors = events.filter((event) => event.type === 'session.error')
    expect(errors.at(-1)?.error.message).toContain('no older history to summarize')
    expect(errors.at(-1)?.error.message).not.toContain('was compacted')
  })

  it('says the summary failed, not that the context was compacted, when it did', async () => {
    // A cut is possible, but the summarizer itself fails: the context was **not** compacted, and
    // the error has to say that rather than blame a compaction that never landed.
    const session = await newSession(messages(15, 2_000))
    const scripts = scriptedModels(
      [{ failWith: overflowError() }, { text: ['never reached'] }],
      [{ failWith: new Error('the summarizer is down') }],
    )
    const tokenBudgetFor = (modelId: string) => (modelId === SUMMARY_MODEL ? 8_000 : 200_000)

    const outcome = await runTurn(session.sessionId, {
      store: session.store,
      model: scripts.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      contextStrategy: createContextStrategy({ tokenBudgetFor }),
      compaction: { summaryModel: SUMMARY_MODEL, tokenBudgetFor },
    })

    expect(outcome.outcome).toBe('error')
    expect(scripts.chat.calls).toHaveLength(1)
    expect(scripts.summary.calls).toHaveLength(1)
    const events = await logOf(session.store, session.sessionId)
    expect(contextSummaryOf(events)).toBeNull()
    const errors = events.filter((event) => event.type === 'session.error')
    expect(errors.at(-1)?.error.retry_status).toEqual({ type: 'exhausted' })
    expect(errors.at(-1)?.error.message).toContain('summarizing the history failed')
    expect(errors.at(-1)?.error.message).not.toContain('was compacted')
  })
})

describe('runTurn — the per-owner compaction controls (C3, #282)', () => {
  it('asks the resolver with the session’s owner and applies what it answers', async () => {
    // 30 messages of 2000 tokens = 60000: over a 0.1 share of the 200k budget, and old enough
    // (past the 50k tail) to cut. The resolver answers with the chat model summarizing, so the
    // event records the chat's own id — the field that travelled through the resolver.
    const session = await newSession(messages(30, 2_000))
    const scripts = scriptedModels([{ text: ['the reply'] }])
    const owners: string[] = []
    const tokenBudgetFor = (modelId: string) => (modelId === SUMMARY_MODEL ? 8_000 : 200_000)

    const outcome = await runTurn(session.sessionId, {
      store: session.store,
      model: scripts.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      contextStrategy: createContextStrategy({ tokenBudgetFor }),
      compaction: (ownerId) => {
        owners.push(ownerId)
        return { threshold: 0.1, summaryModel: null, tokenBudgetFor }
      },
    })

    expect(outcome.outcome).toBe('idle')
    expect(owners).toEqual([TEST_OWNER_ID])
    const summary = contextSummaryOf(await logOf(session.store, session.sessionId))!
    expect(summary.summary_model).toBe(CHAT_MODEL)
    expect(summary.passes).toBe(1)
  })

  it('asks it again at the next request boundary, so a changed answer applies from there', async () => {
    // The first call answers a threshold nothing crosses; the second answers one the history is
    // over. Only the second request compacts, which is what "per request" buys: a settings
    // change mid-turn applies to the request after it.
    const session = await newSession(messages(30, 2_000))
    let steeringId: string | undefined
    const scripts = scriptedModels([
      {
        text: ['first'],
        // The real size of the first prompt, so the second request's estimate has a usable
        // baseline — the trigger measures what the request will be, not only what is new.
        usage: { input_tokens: 60_000 },
        onChunk: async (_chunk, index) => {
          if (index !== 0) return
          const [steering] = await session.store.appendEvents(session.sessionId, [
            { type: 'user.message', content: [{ type: 'text', text: 'steering' }] },
          ])
          steeringId = steering?.id
        },
      },
      { text: ['second'] },
    ])
    const owners: string[] = []
    const tokenBudgetFor = (modelId: string) => (modelId === SUMMARY_MODEL ? 8_000 : 200_000)

    const outcome = await runTurn(session.sessionId, {
      store: session.store,
      model: scripts.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      contextStrategy: createContextStrategy({ tokenBudgetFor }),
      compaction: (ownerId) => {
        owners.push(ownerId)
        return {
          threshold: owners.length === 1 ? 0.99 : 0.1,
          summaryModel: SUMMARY_MODEL,
          tokenBudgetFor,
        }
      },
    })

    expect(outcome.outcome).toBe('idle')
    expect(steeringId).toBeDefined()
    expect(owners).toEqual([TEST_OWNER_ID, TEST_OWNER_ID])
    // Exactly one summary — the second request's — and it was written before the second chat
    // request, which is the one built from it.
    const events = await logOf(session.store, session.sessionId)
    expect(contextSummariesOf(events)).toHaveLength(1)
    expect(scripts.chat.calls).toHaveLength(2)
    const second = readPrompt(scripts.chat.calls[1]!)
    expect(second[1]?.text).toContain('Earlier messages in this conversation were summarized')
  })
})

describe('runTurn — the summary the model is told about', () => {
  it('replaces the covered history with the summary in the request that follows', async () => {
    const session = await newSession(messages(15, 1_000))
    const scripts = scriptedModels([{ text: ['the reply'], usage: { input_tokens: 20_100 } }])
    const tokenBudgetFor = () => 20_000

    await runTurn(session.sessionId, {
      store: session.store,
      model: scripts.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      contextStrategy: createContextStrategy({ tokenBudgetFor }),
      compaction: {
        summaryModel: SUMMARY_MODEL,
        tokenBudgetFor: (id) => (id === SUMMARY_MODEL ? 8_000 : 20_000),
      },
    })

    const events = await logOf(session.store, session.sessionId)
    const summary = contextSummaryOf(events)!
    const prompt = readPrompt(scripts.chat.calls[0]!)
    // The messages the request was built from: the five the cut kept. (The reply the request
    // itself produced is newer than the summary too, and was not in its own prompt.)
    const kept = events.filter(
      (event) => event.type === 'user.message' && event.seq > summary.covers.to_seq,
    )
    expect(prompt[1]?.text).toContain('Earlier messages in this conversation were summarized')
    expect(prompt.slice(2).map((entry) => entry.text)).toEqual(kept.map((event) => textOf(event)))
    expect(prompt.slice(2)).toHaveLength(5)
  })
})
