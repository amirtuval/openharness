import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { createToolRegistry, textResult } from '@openharness/hands'
import type { ToolDefinition } from '@openharness/hands'
import { EVENT_TYPES } from '@openharness/protocol'
import type { ModelConfig, StoredEvent, UserEventInput } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { ModelCredential, ResolveCredential } from './model'
import { runTurn } from './turn'
import { logOf, message, newSession, TEST_MODEL_ID } from './testing/harness'
import { mockModel, readAssistantParts, resolveTestCredential } from './testing/mock-model'

/**
 * Provider-opaque content at the loop's boundary (epic #303, X13; issue #334).
 *
 * `opaque.test.ts` pins the rules on their own; this drives them through `runTurn`, because what
 * matters is what a **request** carries: the step's parts come back on the assistant message of
 * that step — before its text and its calls, which is the order a provider reads them in — and
 * only when the next request goes to the same family and the same model. The three families the
 * issue names are scripted here: Anthropic with a signature, an OpenAI-compatible endpoint with
 * plain `reasoning_content`, and an OpenAI Responses reasoning item.
 */

/** The fixture session's model — an Anthropic one, which is the family with the strictest rule. */
const ANTHROPIC = TEST_MODEL_ID

/** An `echo` tool, and nothing the loop's own tests do not already do. */
function echo(
  overrides: Partial<ToolDefinition<{ text: string }>> = {},
): ToolDefinition<{ text: string }> {
  return {
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: z.object({ text: z.string() }),
    permission: 'allow',
    run: (input: { text: string }) => textResult(input.text),
    ...overrides,
  }
}

/** A message that also switches the session's model, the way a client sends one (U3). */
function switchingMessage(text: string, model: ModelConfig): UserEventInput {
  return { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }], model }
}

/** A credential resolver that answers one provider with a credential of its own type (A3b). */
function credentialsFor(provider: string, credential: ModelCredential): ResolveCredential {
  return (asked) => Promise.resolve(asked === provider ? credential : resolveTestCredential(asked))
}

/** One part of a recorded request's assistant message, as plain data. */
interface AssistantPart {
  readonly type: string
  readonly text?: string
  readonly toolName?: string
  readonly providerOptions?: Record<string, Record<string, unknown>>
}

/** The parts of the nth assistant message of a recorded request, `[]` when there is none. */
function assistantPartsOf(
  calls: readonly LanguageModelV4CallOptions[],
  request: number,
  messageIndex = 0,
): AssistantPart[] {
  const parts = readAssistantParts(calls[request] as LanguageModelV4CallOptions)[messageIndex]
  return (parts ?? []) as unknown as AssistantPart[]
}

/** The part types of every assistant message of a recorded request, in order. */
function assistantShape(calls: readonly LanguageModelV4CallOptions[], request: number): string[][] {
  return readAssistantParts(calls[request] as LanguageModelV4CallOptions).map((parts) =>
    parts.flatMap((part) => [part.type]),
  )
}

/** The `agent.opaque_content` events of a log, in order. */
function storedOpaque(log: readonly StoredEvent[]) {
  return log.filter((event) => event.type === EVENT_TYPES.agentOpaqueContent)
}

describe('a step’s parts come back on that step’s assistant message (X13)', () => {
  it('keeps an Anthropic thinking block with its signature, and sends it before the call', async () => {
    const { store, sessionId } = await newSession([message('check it')])
    const { factory, calls } = mockModel(
      {
        reasoning: [
          { text: 'weighing the options', metadata: { anthropic: { signature: 'sig-1' } } },
        ],
        toolCalls: [{ name: 'echo', input: { text: 'hi' } }],
      },
      { text: ['It said hi.'] },
    )

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    const log = await logOf(store, sessionId)
    // The step that called the tool streamed no text at all — the case the event exists for —
    // so the parts are what is written beside the span, before the call it made.
    expect(storedOpaque(log)).toMatchObject([
      {
        provider: 'anthropic',
        model: ANTHROPIC,
        parts: [
          {
            type: 'reasoning',
            text: 'weighing the options',
            provider_options: { signature: 'sig-1' },
          },
        ],
      },
    ])
    const types = log.map((event) => event.type)
    expect(types.indexOf(EVENT_TYPES.agentOpaqueContent)).toBeLessThan(
      types.indexOf(EVENT_TYPES.agentToolUse),
    )

    // The next request carries it, on the assistant message that made the call and **before**
    // the call itself — the order Anthropic reads a thinking block in.
    expect(assistantShape(calls, 1)).toEqual([['reasoning', 'tool-call']])
    expect(assistantPartsOf(calls, 1)[0]).toEqual({
      type: 'reasoning',
      text: 'weighing the options',
      providerOptions: { anthropic: { signature: 'sig-1' } },
    })
    expect(assistantPartsOf(calls, 1)[1]?.toolName).toBe('echo')
  })

  it('keeps a redacted block, whose text is empty and whose payload is the block', async () => {
    const { store, sessionId } = await newSession([message('check it')])
    const { factory, calls } = mockModel(
      {
        reasoning: [
          { text: 'weighing the options', metadata: { anthropic: { signature: 'sig-1' } } },
          { metadata: { anthropic: { redactedData: 'blob' } } },
        ],
        toolCalls: [{ name: 'echo', input: { text: 'hi' } }],
      },
      { text: ['It said hi.'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })

    expect(assistantShape(calls, 1)).toEqual([['reasoning', 'reasoning', 'tool-call']])
    expect(assistantPartsOf(calls, 1)[1]).toEqual({
      type: 'reasoning',
      text: '',
      providerOptions: { anthropic: { redactedData: 'blob' } },
    })
  })

  it('keeps every step of a multi-step turn, not only the newest one', async () => {
    // The compatible families need the key on *every* assistant turn of a thinking-mode
    // conversation, and the real endpoint refuses the turn that lacks one (issue #330, one step
    // later than its first request). So a two-step turn's third request carries both.
    const { store, sessionId } = await newSession([message('both')])
    const { factory, calls } = mockModel(
      {
        reasoning: [
          { text: 'first thought', metadata: { anthropic: { signature: 'sig-1' } } },
        ],
        toolCalls: [{ name: 'echo', input: { text: 'one' } }],
      },
      {
        reasoning: [{ text: 'second thought', metadata: { anthropic: { signature: 'sig-2' } } }],
        toolCalls: [{ name: 'echo', input: { text: 'two' } }],
      },
      { text: ['Done.'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })

    expect(assistantShape(calls, 2)).toEqual([
      ['reasoning', 'tool-call'],
      ['reasoning', 'tool-call'],
    ])
    expect(assistantPartsOf(calls, 2)[0]?.providerOptions).toEqual({
      anthropic: { signature: 'sig-1' },
    })
    expect(assistantPartsOf(calls, 2, 1)[0]?.providerOptions).toEqual({
      anthropic: { signature: 'sig-2' },
    })
  })

  it('keeps an OpenAI-compatible step’s reasoning and sends it back as plain text', async () => {
    const custom = 'custom/deepseek-v4'
    const { store, sessionId } = await newSession([
      switchingMessage('think and check', { id: custom }),
    ])
    const { factory, calls } = mockModel(
      {
        reasoning: [{ text: 'their reasoning' }],
        toolCalls: [{ name: 'echo', input: { text: 'hi' } }],
      },
      { text: ['It said hi.'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: credentialsFor('custom', {
        type: 'openai_compatible',
        apiKey: '',
        baseUrl: 'https://example.test/v1',
      }),
      tools: createToolRegistry([echo()]),
    })

    expect(storedOpaque(await logOf(store, sessionId))).toMatchObject([
      {
        provider: 'openai-compatible',
        model: custom,
        parts: [{ type: 'reasoning', text: 'their reasoning' }],
      },
    ])
    // A chat-completions client replays the text alone — the step's `reasoning_content` — with
    // no per-part options at all.
    expect(assistantShape(calls, 1)).toEqual([['reasoning', 'tool-call']])
    expect(assistantPartsOf(calls, 1)[0]).toEqual({ type: 'reasoning', text: 'their reasoning' })
  })

  it('keeps an OpenAI Responses reasoning item and sends its id back', async () => {
    const openai = 'openai/gpt-5'
    const { store, sessionId } = await newSession([
      switchingMessage('think and check', { id: openai }),
    ])
    const { factory, calls } = mockModel(
      {
        reasoning: [
          {
            text: 'their reasoning',
            metadata: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'encrypted' } },
          },
        ],
        toolCalls: [{ name: 'echo', input: { text: 'hi' } }],
      },
      { text: ['It said hi.'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })

    expect(storedOpaque(await logOf(store, sessionId))).toMatchObject([
      {
        provider: 'openai',
        model: openai,
        parts: [
          {
            type: 'reasoning',
            text: 'their reasoning',
            provider_options: { itemId: 'rs_1', reasoningEncryptedContent: 'encrypted' },
          },
        ],
      },
    ])
    expect(assistantPartsOf(calls, 1)[0]).toMatchObject({
      type: 'reasoning',
      providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'encrypted' } },
    })
  })
})

describe('what a switch does to a step’s parts (X13)', () => {
  it('drops them when the next request goes to another provider, mid-turn', async () => {
    const { store, sessionId } = await newSession([message('check it')])
    const switching = echo({
      run: async (input: { text: string }) => {
        // A steering message carrying a model switch, appended while the tool runs: the next
        // request is the other provider's.
        await store.appendEvents(sessionId, [
          switchingMessage('answer on the other model', { id: 'openai/gpt-5' }),
        ])
        return textResult(input.text)
      },
    })
    const { factory, calls } = mockModel(
      {
        reasoning: [
          { text: 'weighing the options', metadata: { anthropic: { signature: 'sig-1' } } },
        ],
        toolCalls: [{ name: 'echo', input: { text: 'hi' } }],
      },
      { text: ['Answered elsewhere.'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([switching]),
    })

    // The step's parts are in the log — the log keeps what the provider sent — and the request
    // that goes to the other provider carries none of them.
    expect(storedOpaque(await logOf(store, sessionId))).toHaveLength(1)
    expect(assistantShape(calls, 1)).toEqual([['tool-call']])
  })

  it('drops them when the next request goes to another model of the same provider', async () => {
    const { store, sessionId } = await newSession([message('check it')])
    const { factory, calls } = mockModel(
      {
        reasoning: [
          { text: 'weighing the options', metadata: { anthropic: { signature: 'sig-1' } } },
        ],
        toolCalls: [{ name: 'echo', input: { text: 'hi' } }],
      },
      // The step after the tool call asks for another turn, and a message carrying a switch to
      // another Anthropic model lands while it streams: a block is bound to the model that
      // produced it, so the request after the switch must not carry it.
      {
        text: ['Switching.'],
        onChunk: async (_chunk, index) => {
          if (index === 0) {
            await store.appendEvents(sessionId, [
              switchingMessage('carry on', { id: 'anthropic/claude-opus-5-5' }),
            ])
          }
        },
      },
      { text: ['On the other model.'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })

    expect(calls).toHaveLength(3)
    // The step that made the call carried its block; the request after the switch does not.
    expect(assistantShape(calls, 1)).toEqual([['reasoning', 'tool-call']])
    expect(assistantShape(calls, 2)).toEqual([['tool-call'], ['text']])
  })
})

describe('a step that produced nothing opaque (X13)', () => {
  it('stores no event, and the request built from it carries no reasoning part', async () => {
    const { store, sessionId } = await newSession([message('check it')])
    const { factory, calls } = mockModel(
      { text: ['Let me check.'], toolCalls: [{ name: 'echo', input: { text: 'hi' } }] },
      { text: ['It said hi.'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo()]),
    })

    expect(storedOpaque(await logOf(store, sessionId))).toEqual([])
    // The step's assistant turn is its text and its call, exactly as it was before #334.
    expect(assistantShape(calls, 1)).toEqual([['text', 'tool-call']])
  })
})
