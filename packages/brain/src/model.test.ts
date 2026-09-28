import { describe, expect, it, vi } from 'vitest'

import { ZERO_MODEL_USAGE, streamModelRequest, toModelUsage } from './model'
import { mockModel } from './testing/mock-model'

describe('toModelUsage', () => {
  it('maps the AI SDK report onto the protocol counters', () => {
    expect(
      toModelUsage({
        inputTokens: 11,
        outputTokens: 5,
        totalTokens: 16,
        inputTokenDetails: {
          noCacheTokens: 6,
          cacheReadTokens: 2,
          cacheWriteTokens: 3,
        },
        outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
      }),
    ).toEqual({
      input_tokens: 11,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 3,
    })
  })

  it('reports zero for a counter the provider did not send', () => {
    expect(
      toModelUsage({
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      }),
    ).toEqual(ZERO_MODEL_USAGE)
  })
})

describe('streamModelRequest', () => {
  const messages = [{ role: 'user' as const, content: 'Hello' }]

  it('streams the text, in chunks, and reports the usage', async () => {
    const { factory, calls } = mockModel({ text: ['Hi ', 'there'], usage: { input_tokens: 9 } })
    const chunks: string[] = []

    const result = await streamModelRequest({
      model: factory('anthropic/claude-sonnet-5'),
      messages,
      onTextDelta: (text) => {
        chunks.push(text)
      },
    })

    expect(result).toMatchObject({ text: 'Hi there', aborted: false, error: undefined })
    expect(result.usage).toMatchObject({ input_tokens: 9, output_tokens: 64 })
    expect(chunks).toEqual(['Hi ', 'there'])
    expect(calls).toHaveLength(1)
  })

  it('reports a provider failure rather than throwing', async () => {
    const failure = Object.assign(new Error('Overloaded.'), { statusCode: 529 })
    const { factory } = mockModel({ failWith: failure })

    const result = await streamModelRequest({
      model: factory('anthropic/claude-sonnet-5'),
      messages,
    })

    expect(result).toEqual({ text: '', usage: ZERO_MODEL_USAGE, error: failure, aborted: false })
  })

  it('reports a failure that arrives mid-stream', async () => {
    const failure = Object.assign(new Error('Overloaded.'), { statusCode: 529 })
    const { factory } = mockModel({ text: ['par'], failAfterText: failure })

    const result = await streamModelRequest({
      model: factory('anthropic/claude-sonnet-5'),
      messages,
    })

    expect(result).toMatchObject({ text: 'par', aborted: false, error: failure })
  })

  it('reports an abort, with the text that had already arrived', async () => {
    const controller = new AbortController()
    const { factory } = mockModel({
      text: ['par', 'tial'],
      onChunk: () => {
        controller.abort()
      },
    })

    const result = await streamModelRequest({
      model: factory('anthropic/claude-sonnet-5'),
      messages,
      signal: controller.signal,
    })

    expect(result.aborted).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.usage).toEqual(ZERO_MODEL_USAGE)
  })

  it('never retries on its own: the turn loop owns the retries', async () => {
    const failure = Object.assign(new Error('Overloaded.'), { statusCode: 503 })
    const { factory, calls } = mockModel({ failWith: failure })

    await streamModelRequest({ model: factory('anthropic/claude-sonnet-5'), messages })

    expect(calls).toHaveLength(1)
  })

  it('passes the abort signal down to the provider', async () => {
    const controller = new AbortController()
    const { factory, calls } = mockModel({ text: ['hi'] })

    await streamModelRequest({
      model: factory('anthropic/claude-sonnet-5'),
      messages,
      signal: controller.signal,
    })

    expect(calls[0]?.abortSignal).toBe(controller.signal)
  })

  it('does not swallow a fenced write as if it were a model failure', async () => {
    const { factory } = mockModel({ text: ['hi'] })
    const fenced = Object.assign(new Error('fenced'), { name: 'FencedError', code: 'fenced' })
    const onTextDelta = vi.fn(() => {
      throw fenced
    })

    await expect(
      streamModelRequest({
        model: factory('anthropic/claude-sonnet-5'),
        messages,
        onTextDelta,
      }),
    ).rejects.toThrow(fenced)
  })
})
