import { describe, expect, it } from 'vitest'

import {
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_STRATEGY,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  DEFAULT_MAX_RETRIES,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  DEPENDENCIES,
  PACKAGE_NAME,
  ZERO_MODEL_USAGE,
  abortableSleep,
  backoffDelay,
  classifyModelError,
  createContextStrategy,
  estimateTokens,
  isRetryableModelError,
  resolveRetryPolicy,
  providerModelFactory,
  runTurn,
  streamModelRequest,
  toModelUsage,
} from './index'
import { TEST_CREDENTIAL } from './testing/mock-model'

describe('@openharness/brain', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@openharness/brain')
  })

  it('reaches protocol, session and hands through their built output', () => {
    expect(DEPENDENCIES).toEqual([
      '@openharness/protocol',
      '@openharness/session',
      '@openharness/hands',
    ])
  })

  it('exports the turn loop and its knobs', () => {
    expect(typeof runTurn).toBe('function')
    expect(typeof streamModelRequest).toBe('function')
    expect(typeof providerModelFactory).toBe('function')
    expect(typeof createContextStrategy).toBe('function')
    expect(typeof classifyModelError).toBe('function')
    expect(typeof isRetryableModelError).toBe('function')
    expect(typeof resolveRetryPolicy).toBe('function')
    expect(typeof backoffDelay).toBe('function')
    expect(typeof abortableSleep).toBe('function')
    expect(typeof estimateTokens).toBe('function')
    expect(typeof toModelUsage).toBe('function')
    expect(typeof DEFAULT_CONTEXT_STRATEGY).toBe('function')
  })

  it('exports the defaults a host reads to know what it is getting', () => {
    expect(DEFAULT_CONTEXT_TOKEN_BUDGET).toBeGreaterThan(0)
    expect(CHARS_PER_TOKEN).toBe(4)
    expect(DEFAULT_MAX_RETRIES).toBe(3)
    expect(DEFAULT_BASE_DELAY_MS).toBeGreaterThan(0)
    expect(DEFAULT_MAX_DELAY_MS).toBeGreaterThan(DEFAULT_BASE_DELAY_MS)
    expect(ZERO_MODEL_USAGE).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
  })

  it('builds a model from a model id, authenticated by the credential it is given', () => {
    // Constructing a provider model touches no network: the client is built from the id, the
    // key and the pinned base URL, and nothing is sent until the first request is streamed.
    expect(providerModelFactory('anthropic/claude-sonnet-5', TEST_CREDENTIAL)).toMatchObject({
      provider: 'anthropic.messages',
      modelId: 'claude-sonnet-5',
    })
  })
})
