import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { createToolRegistry, textResult } from '@openharness/hands'
import type { ToolDefinition } from '@openharness/hands'
import { EVENT_TYPES, WEB_SEARCH_TOOL_NAME } from '@openharness/protocol'
import type { ModelConfig, StoredEvent, UserEventInput } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { ToolSettings, ToolSettingsResolver } from './tools'
import { runTurn } from './turn'
import { logOf, message, NATIVE_SEARCH_TOOL, newSession, TEST_MODEL_ID } from './testing/harness'
import {
  mockModel,
  readAssistantParts,
  readPrompt,
  resolveTestCredential,
} from './testing/mock-model'

/**
 * Provider-native web search at the loop's boundary (epic #303, X14; issue #335).
 *
 * `native-search.test.ts` pins the table and the policy on their own; this drives them through
 * `runTurn`, because what matters is a **request**: which model is offered the tool, what the
 * step's provider-executed search becomes in the log, what the next request carries of it, and
 * what a switch does to it.
 *
 * The search is scripted the way the AI SDK reports one: a `tool-call` with
 * `providerExecuted: true`, the `tool-result` that answers it, the `source` parts the provider
 * cited, and the count its own usage reported. Nothing here runs on our side, and the tests say
 * so — no registry tool is called, no `agent.tool_result` of ours is written for the search
 * except the readable one.
 */

/** The fixture session's model: a Claude, whose provider has a native search tool. */
const ANTHROPIC = TEST_MODEL_ID

/** A model whose provider has none, for the other half of the rule. */
const NO_SEARCH = 'deepseek/deepseek-chat'

/** An `echo` tool, so a step can mix the provider's search with one of ours. */
function echo(): ToolDefinition<{ text: string }> {
  return {
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: z.object({ text: z.string() }),
    permission: 'allow',
    run: (input: { text: string }) => textResult(input.text),
  }
}

/** A message that also switches the session's model, the way a client sends one (U3). */
function switchingMessage(text: string, model: ModelConfig): UserEventInput {
  return { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }], model }
}

/** The searches one scripted step ran: the call, its answer, and the citations around it. */
function scriptedSearch() {
  return {
    providerTools: [
      {
        id: 'srvtoolu_1',
        name: WEB_SEARCH_TOOL_NAME,
        input: { query: 'openharness architecture' },
        output: [
          {
            type: 'web_search_result',
            url: 'https://example.test/architecture',
            title: 'The architecture',
            pageAge: null,
            encryptedContent: 'ENCRYPTED-RESULT',
          },
        ],
        providerMetadata: { pageAge: null },
      },
    ],
    sources: [
      {
        url: 'https://example.test/architecture',
        title: 'The architecture',
        citedText: 'three ideas carry the design',
      },
    ],
  }
}

/**
 * A failure in the shape a provider's refusal arrives in: a message, and the status the SDK's
 * own error carries. A bare `Error` is what the classifier reads for the retry verdict.
 */
function rejectedTool(statusCode: number, message: string): Error {
  const failure: Error & { statusCode?: number } = new Error(message)
  failure.statusCode = statusCode
  return failure
}

/** A `ToolSettings` that turns `web_search` off, or names it without saying anything. */
function settingsFor(webSearch: { enabled: boolean; permission: 'allow' | 'deny' }): ToolSettings {
  return { [WEB_SEARCH_TOOL_NAME]: webSearch }
}

/** Every stored `agent.tool_use` of one name, in order. */
function toolUses(log: readonly StoredEvent[], name: string) {
  return log.filter((event) => event.type === EVENT_TYPES.agentToolUse && event.name === name)
}

/** The tools a recorded request offered the model, if it offered any. */
function offeredTo(call: LanguageModelV4CallOptions): unknown {
  return (call as { readonly tools?: unknown }).tools
}

describe('offering the provider’s search tool (#335)', () => {
  it('attaches it to a Claude’s request, and records it on the span', async () => {
    const { store, sessionId } = await newSession([message('look it up')])
    const { factory, calls } = mockModel({ text: ['Done.'] })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    // The provider's own tool, by its own id, keyed by the name the model calls it by.
    expect(offeredTo(calls[0]!)).toMatchObject([
      { type: 'function', name: 'echo' },
      { type: 'provider', id: 'anthropic.web_search_20260318', name: WEB_SEARCH_TOOL_NAME },
    ])
    const span = (await logOf(store, sessionId)).find(
      (event) => event.type === EVENT_TYPES.modelRequestStart,
    )
    expect(span?.type === EVENT_TYPES.modelRequestStart ? span.tools : []).toEqual([
      { name: 'echo', source: 'builtin' },
      NATIVE_SEARCH_TOOL,
    ])
  })

  it('offers none on a model whose provider has no search tool, and none when a user turns it off', async () => {
    const other = await newSession([message('look it up')])
    const { factory: otherModel, calls: otherCalls } = mockModel({ text: ['Okay.'] })
    await runTurn(other.sessionId, {
      store: other.store,
      model: otherModel,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
      toolSettings: () => ({}),
    })
    // The model decides: a DeepSeek has no native tool, so the request is the plain one.
    const switched = await newSession([switchingMessage('and now?', { id: NO_SEARCH })])

    const chat = await newSession([message('look it up')])
    const { factory, calls } = mockModel({ text: ['Okay.'] })
    const settings: ToolSettingsResolver = () =>
      settingsFor({ enabled: false, permission: 'allow' })
    await runTurn(chat.sessionId, {
      store: chat.store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
      toolSettings: settings,
    })

    expect(offeredTo(calls[0]!)).toMatchObject([{ type: 'function', name: 'echo' }])

    // The same for a `deny`: a provider-executed tool cannot be refused mid-flight, so the only
    // meaning left that keeps the user's decision is not attaching it at all.
    const denied = await newSession([message('look it up')])
    const { factory: denyModel, calls: denyCalls } = mockModel({ text: ['Okay.'] })
    await runTurn(denied.sessionId, {
      store: denied.store,
      model: denyModel,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
      toolSettings: () => settingsFor({ enabled: true, permission: 'deny' }),
    })

    expect(offeredTo(denyCalls[0]!)).toMatchObject([{ type: 'function', name: 'echo' }])

    // And a model switch mid-turn stops offering it from the next request on.
    const { factory: switchModel, calls: switchCalls } = mockModel({ text: ['Okay.'] })
    await runTurn(switched.sessionId, {
      store: switched.store,
      model: switchModel,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })
    expect(offeredTo(switchCalls[0]!)).toMatchObject([{ type: 'function', name: 'echo' }])
    expect(otherCalls[0]).toBeDefined()
  })
})

describe('a search the provider ran inside a request (#335)', () => {
  it('stores the provider’s parts, the readable pair and its sources, and counts the search', async () => {
    const { store, sessionId } = await newSession([message('look it up')])
    const { factory } = mockModel(
      { ...scriptedSearch(), searches: 2, text: ['It is three ideas.'] },
      { text: ['Anything else?'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })

    const log = await logOf(store, sessionId)
    // The provider's own content: the call and the answer it can read back, encrypted payload
    // and all — replayed to the provider, never rendered.
    const opaque = log.filter((event) => event.type === EVENT_TYPES.agentOpaqueContent)
    expect(opaque).toHaveLength(1)
    expect(opaque[0]).toMatchObject({
      provider: 'anthropic',
      model: ANTHROPIC,
      parts: [
        {
          type: 'tool-call',
          text: '',
          payload: { toolCallId: 'srvtoolu_1', toolName: 'web_search' },
        },
        { type: 'tool-result' },
      ],
    })
    // The result part carries the reading a request that cannot have it replays instead: what
    // was searched and found, in prose — and the provider's own payload beside it.
    expect(JSON.stringify(opaque[0])).toContain(
      'The architecture — https://example.test/architecture',
    )
    expect(JSON.stringify(opaque[0])).toContain('ENCRYPTED-RESULT')

    // The readable pair: the call the model made, and the answer a reader and a client see.
    const calls = toolUses(log, WEB_SEARCH_TOOL_NAME)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      name: WEB_SEARCH_TOOL_NAME,
      input: { query: 'openharness architecture' },
      evaluated_permission: 'allow',
      source: 'provider',
    })
    const result = log.find(
      (event) =>
        event.type === EVENT_TYPES.agentToolResult &&
        event.tool_use_id === (calls[0] as { readonly id: string } | undefined)?.id,
    )
    expect(result).toMatchObject({
      is_error: false,
      sources: [
        {
          url: 'https://example.test/architecture',
          title: 'The architecture',
          cited_text: 'three ideas carry the design',
        },
      ],
    })
    expect(JSON.stringify(result)).toContain('three ideas carry the design')

    // The search is the provider's count, on the span that spent it.
    const spanEnds = log.filter((event) => event.type === EVENT_TYPES.modelRequestEnd)
    expect(spanEnds[0]).toMatchObject({ searches: 2 })
  })

  it('sends the provider’s own call and answer back on the next request', async () => {
    const { store, sessionId } = await newSession([message('look it up')])
    const { factory, calls } = mockModel(
      // The search and a call of our own in one step — which is the case the issue names, and
      // the only way a second request happens at all: a step that ran nothing of ours answered
      // the turn.
      {
        ...scriptedSearch(),
        text: ['It is three ideas.'],
        toolCalls: [{ name: 'echo', input: { text: 'again' } }],
      },
      { text: ['Done.'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })

    // The assistant turn of the search step, as the second request carries it: the provider's
    // call and its answer, in that order, before the text — and no `tool-call` of ours for the
    // readable pair, which is a record and not part of the request.
    const parts = readAssistantParts(calls[1] as LanguageModelV4CallOptions)[0] ?? []
    // The provider's own pair, then the step's text, then the call of ours — and no second
    // `tool-call` for the readable record, which is a reading and not part of the request.
    expect(parts.map((part) => part.type)).toEqual([
      'tool-call',
      'tool-result',
      'text',
      'tool-call',
    ])
    expect(parts[0]).toMatchObject({
      toolCallId: 'srvtoolu_1',
      toolName: WEB_SEARCH_TOOL_NAME,
      providerExecuted: true,
    })
    expect(parts[1]).toMatchObject({ toolCallId: 'srvtoolu_1', output: { type: 'json' } })
    expect(JSON.stringify(parts[1])).toContain('ENCRYPTED-RESULT')
  })

  it('rebuilds a step that wrote around its search in the provider’s own order', async () => {
    // The shape a Claude search step really streams: a sentence, the provider's call and its
    // answer, then the reply that reads the results. The step's assistant turn has to go back
    // exactly like that — the reordering #335's report is about — and not with the provider's
    // parts hoisted ahead of the text.
    const { store, sessionId } = await newSession([message('look it up')])
    const { factory, calls } = mockModel(
      {
        ...scriptedSearch(),
        textBeforeProviders: ['Let me look that up.'],
        text: ['It is three ideas.'],
        toolCalls: [{ name: 'echo', input: { text: 'again' } }],
      },
      { text: ['Done.'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })

    const parts = readAssistantParts(calls[1] as LanguageModelV4CallOptions)[0] ?? []
    expect(parts.map((part) => part.type)).toEqual([
      'text',
      'tool-call',
      'tool-result',
      'text',
      'tool-call',
    ])
    expect(parts[0]).toMatchObject({ text: 'Let me look that up.' })
    expect(parts[3]).toMatchObject({ text: 'It is three ideas.' })
    // The provider's own call and answer are the SDK's pair, `providerExecuted`, in between —
    // and the readable `web_search` record our own log carries is not sent as a second call.
    expect(parts[1]).toMatchObject({
      toolCallId: 'srvtoolu_1',
      toolName: WEB_SEARCH_TOOL_NAME,
      providerExecuted: true,
    })
    expect(parts[2]).toMatchObject({ toolCallId: 'srvtoolu_1' })
    expect(parts[4]).toMatchObject({ toolName: 'echo' })
  })

  it('keeps the provider’s order across a paused turn’s continuation', async () => {
    const { store, sessionId } = await newSession([message('look it up')])
    const { factory, calls } = mockModel(
      {
        ...scriptedSearch(),
        textBeforeProviders: ['Looking that up.'],
        rawFinishReason: 'pause_turn',
      },
      { text: ['Finished after all.'] },
    )

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(calls).toHaveLength(2)
    // The paused step sends its own content back, in the order it wrote it: the sentence, then
    // the provider's call and answer.
    const parts = readAssistantParts(calls[1] as LanguageModelV4CallOptions)[0] ?? []
    expect(parts.map((part) => part.type)).toEqual(['text', 'tool-call', 'tool-result'])
    expect(parts[0]).toMatchObject({ text: 'Looking that up.' })
    expect(parts[1]).toMatchObject({ providerExecuted: true })
  })

  it('reads what was searched from the answer, for a provider whose call says nothing', async () => {
    // OpenAI's and xAI's wire formats put nothing on the call: the query — or the page an
    // `openPage` action opened — is on the answer, so the readable call is built from both ends.
    const { store, sessionId } = await newSession([message('look it up')])
    const { factory } = mockModel({
      providerTools: [
        {
          id: 'ws_1',
          name: WEB_SEARCH_TOOL_NAME,
          input: {},
          output: { action: { type: 'search', query: 'the query', queries: ['the query'] } },
        },
      ],
      sources: [{ url: 'https://example.test/a', title: 'T' }],
      text: ['Found it.'],
    })

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })

    const calls = toolUses(await logOf(store, sessionId), WEB_SEARCH_TOOL_NAME)
    expect(calls[0]).toMatchObject({ input: { query: 'the query' } })

    // A call that opened a page instead carries the URL it opened, which is what the line shows.
    const opened = await newSession([message('look it up')])
    const { factory: pageModel } = mockModel({
      providerTools: [
        {
          id: 'ws_2',
          name: WEB_SEARCH_TOOL_NAME,
          input: {},
          output: { action: { type: 'openPage', url: 'https://example.test/page' } },
        },
      ],
      sources: [{ url: 'https://example.test/page', title: 'The page' }],
      text: ['Read it.'],
    })
    await runTurn(opened.sessionId, {
      store: opened.store,
      model: pageModel,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })
    const [read] = toolUses(await logOf(opened.store, opened.sessionId), WEB_SEARCH_TOOL_NAME)
    expect(read).toMatchObject({ input: { url: 'https://example.test/page' } })
  })

  it('continues the same turn when the provider paused it', async () => {
    const { store, sessionId } = await newSession([message('look it up')])
    const { factory, calls } = mockModel(
      { ...scriptedSearch(), rawFinishReason: 'pause_turn' },
      { text: ['Finished after all.'] },
    )

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    // A second request, and the paused step's own content is what it carries.
    expect(calls).toHaveLength(2)
    const parts = readAssistantParts(calls[1] as LanguageModelV4CallOptions)[0] ?? []
    expect(parts.map((part) => part.type)).toEqual(['tool-call', 'tool-result'])
    expect(
      (await logOf(store, sessionId)).some((event) => event.type === EVENT_TYPES.agentMessage),
    ).toBe(true)
  })
})

describe('what a provider switch does to a search (#335)', () => {
  it('replays the results as plain text, never as the provider’s own content', async () => {
    const { store, sessionId } = await newSession([message('look it up')])
    const { factory } = mockModel(
      {
        ...scriptedSearch(),
        text: ['It is three ideas.'],
        toolCalls: [{ name: 'echo', input: { text: 'again' } }],
      },
      { text: ['Done.'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })
    // The switch is the next message, which the next turn picks up (U3).
    await store.appendEvents(sessionId, [
      switchingMessage('and now?', { id: NO_SEARCH }),
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'carry on' }] },
    ])
    const { factory: switchedModel, calls: switchedCalls } = mockModel({ text: ['Carrying on.'] })
    await runTurn(sessionId, {
      store,
      model: switchedModel,
      resolveCredential: (provider) =>
        Promise.resolve(
          provider === 'deepseek'
            ? { type: 'api_key' as const, apiKey: 'deepseek-key' }
            : resolveTestCredential(provider),
        ),
      tools: createToolRegistry([echo()]),
    })

    // The first assistant turn of the switched request: the search's own call and answer are
    // gone, and what it found rides as one text block.
    const parts = readAssistantParts(switchedCalls[0] as LanguageModelV4CallOptions)[0] ?? []
    // What the previous provider found is kept, as prose: neither its encrypted payload nor its
    // `server_tool_use` spelling goes to a model that cannot read either.
    const texts = parts
      .filter((part) => part.type === 'text')
      .map((part) => (part as { readonly text: string }).text)
    expect(texts.join('\n')).toContain('The architecture — https://example.test/architecture')
    expect(texts.join('\n')).toContain('three ideas carry the design')
    expect(JSON.stringify(parts)).not.toContain('ENCRYPTED-RESULT')
    // The reading stands for the whole entry and goes where the entry went before a part carried
    // a place — ahead of the step's own text — so a switch's request is ordered as it always was.
    expect(texts[0]).toContain('The architecture — https://example.test/architecture')
    expect(texts[1]).toBe('It is three ideas.')
  })
})

describe('a provider that refuses the search tool (#335)', () => {
  it('retries the request without it once, and records that on the span', async () => {
    const { store, sessionId } = await newSession([message('look it up')])
    const { factory, calls } = mockModel(
      { failWith: rejectedTool(400, 'tools.0.web_search_20260318: Extra inputs') },
      { text: ['Answered without searching.'] },
    )

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    // Two requests: the one that offered the tool and was refused, and the one that did not.
    expect(calls).toHaveLength(2)
    expect(offeredTo(calls[0]!)).toMatchObject([
      { type: 'function', name: 'echo' },
      { type: 'provider', name: WEB_SEARCH_TOOL_NAME },
    ])
    expect(offeredTo(calls[1]!)).toMatchObject([{ type: 'function', name: 'echo' }])

    const log = await logOf(store, sessionId)
    const ends = log.filter((event) => event.type === EVENT_TYPES.modelRequestEnd)
    expect(ends[0]).toMatchObject({ is_error: true, search_rejected: true })
    expect(ends[1]).toMatchObject({ is_error: null })
    expect(log.some((event) => event.type === EVENT_TYPES.agentMessage)).toBe(true)
  })

  it('does not retry a failure that is not about the tool', async () => {
    const { store, sessionId } = await newSession([message('look it up')])
    const { factory, calls } = mockModel({
      failWith: rejectedTool(400, 'the model does not exist'),
    })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })

    expect(outcome).toEqual({ outcome: 'error' })
    expect(calls).toHaveLength(1)
    const ends = (await logOf(store, sessionId)).filter(
      (event) => event.type === EVENT_TYPES.modelRequestEnd,
    )
    expect(
      ends[0]?.type === EVENT_TYPES.modelRequestEnd ? ends[0].search_rejected : undefined,
    ).toBeUndefined()
  })
})

describe('a log stored before #335 (#335)', () => {
  it('still replays a `web_search` call of the operator-key era as a tool of ours', async () => {
    const { store, sessionId } = await newSession([message('look it up')])
    // What #305 stored: a call of this build's own, with no `source`, and the result that
    // answered it. Nothing about it is a provider's, so the request carries the pair the way it
    // always did — the removal of the tool's *implementation* does not rewrite the log.
    const [call] = await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.agentToolUse,
        name: WEB_SEARCH_TOOL_NAME,
        input: { query: 'brave era' },
        evaluated_permission: 'allow',
      },
    ])
    if (call === undefined) {
      throw new Error('the call was not stored')
    }
    await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.agentToolResult,
        tool_use_id: call.id,
        content: [{ type: 'text', text: '1. An old result' }],
        is_error: false,
      },
    ])

    const { factory, calls } = mockModel({ text: ['Carrying on.'] })
    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })

    // One assistant turn carrying the call, and the `tool` message that answers it: the pair
    // the log holds, rebuilt exactly as #305's own request had it.
    expect(readPrompt(calls[0] as LanguageModelV4CallOptions).map((entry) => entry.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ])
    expect(JSON.stringify(calls[0]?.prompt)).toContain('An old result')
  })
})

describe('the crash rule leaves a provider-executed call alone (#335)', () => {
  it('is not answered with execution lost, because nothing of ours was ever running', async () => {
    const { store, sessionId } = await newSession([message('look it up')])
    // A call the provider ran whose readable answer never landed — the shape a turn that died
    // between the two appends leaves behind.
    const [call] = await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.agentToolUse,
        name: WEB_SEARCH_TOOL_NAME,
        input: { query: 'anything' },
        evaluated_permission: 'allow',
        source: 'provider',
      },
    ])
    expect(call).toBeDefined()

    const { factory } = mockModel({ text: ['Carrying on.'] })
    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })

    const log = await logOf(store, sessionId)
    expect(log.some((event) => JSON.stringify(event).includes('execution lost'))).toBe(false)
  })
})
