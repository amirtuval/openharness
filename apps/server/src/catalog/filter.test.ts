import { describe, expect, it } from 'vitest'

import { isChatModel, isNonChatFamily } from './filter'

/**
 * The chat-model filter (C2): never hide a usable chat model, never show a non-chat one —
 * the non-chat families, and the precedence the explicit verdicts of the provider and the
 * registry have over the name heuristic.
 */

describe('the non-chat families', () => {
  it.each([
    'text-embedding-3-large',
    'text-embedding-ada-002',
    'gemini-embedding-001',
    'nomic-embed-text',
    'tts-1',
    'tts-1-hd',
    'gpt-4o-mini-tts',
    'whisper-1',
    'gpt-4o-transcribe',
    'gpt-4o-transcribe-diarize',
    'dall-e-3',
    'dalle-2',
    'gpt-image-1',
    'chatgpt-image-latest',
    'imagen-3.0-generate-002',
    'omni-moderation-latest',
    'gpt-realtime-2.1',
    'gpt-audio',
    'gpt-4o-audio-preview',
    'gpt-4o-search-preview',
    'gpt-5-search-api',
    'rerank-v3.5',
    'sora-2',
    'babbage-002',
    'davinci-002',
    'gpt-3.5-turbo-instruct',
  ])('drops %s', (id) => {
    expect(isNonChatFamily(id)).toBe(true)
    expect(isChatModel({ rawId: id })).toBe(false)
  })

  it.each([
    'gpt-4.1',
    'gpt-5.4-mini-2026-03-17',
    'o3-pro',
    'o3-deep-research', // research is not the search family
    'claude-sonnet-5',
    'gemini-2.5-flash',
    'llama-3.3-70b-versatile',
    'deepseek-v4-pro',
    'qwen/qwen3.8-27b',
    'ft:gpt-3.5-turbo-0125:tabnine::92cf4eQT', // a fine-tune of a chat model
    'computer-use-preview',
    'grok-4.3',
  ])('keeps %s: an unknown family is a chat model', (id) => {
    expect(isNonChatFamily(id)).toBe(false)
    expect(isChatModel({ rawId: id })).toBe(true)
  })
})

describe('explicit verdicts', () => {
  it('keeps a model the provider says is chat even when the name looks non-chat', () => {
    // Gemini's own method list is the provider data this server reads; a model the registry
    // of a future version flags as chat would be kept the same way.
    expect(isChatModel({ rawId: 'whisper-1', providerChat: true })).toBe(true)
    expect(isChatModel({ rawId: 'whisper-1', registryChat: true })).toBe(true)
  })

  it('drops a model either side says is not chat — the name heuristic does not get a vote', () => {
    expect(isChatModel({ rawId: 'gemini-2.5-flash', providerChat: false })).toBe(false)
    expect(isChatModel({ rawId: 'gpt-4.1', registryChat: false })).toBe(false)
  })

  it('lets an explicit non-chat win over an explicit chat', () => {
    // The cost of showing an embeddings model is a turn that cannot stream; a provider that
    // says a model cannot generate content is believed over a registry that says chat.
    expect(isChatModel({ rawId: 'mystery-1', providerChat: true, registryChat: false })).toBe(false)
    expect(isChatModel({ rawId: 'mystery-1', providerChat: false, registryChat: true })).toBe(false)
  })

  it('treats an absent verdict as no opinion, never as chat or non-chat', () => {
    expect(isChatModel({ rawId: 'mystery-1', providerChat: undefined })).toBe(true)
    expect(isChatModel({ rawId: 'mystery-embed', providerChat: undefined })).toBe(false)
  })
})
