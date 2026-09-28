import { makeUserMessage } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import {
  ApiError,
  PACKAGE_NAME,
  ResponseValidationError,
  createClient,
  createTranscript,
  errorTypeForStatus,
  initialTranscriptState,
  reduceTranscript,
  reduceTranscriptAll,
  selectIsRunning,
  selectLastMessage,
  selectMessages,
  selectStreamingMessage,
} from './index'

describe('@openharness/client', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@openharness/client')
  })

  it('exposes the client and its errors', () => {
    expect(typeof createClient).toBe('function')
    expect(typeof errorTypeForStatus).toBe('function')
    expect(ApiError.prototype).toBeInstanceOf(Error)
    expect(ResponseValidationError.prototype).toBeInstanceOf(Error)
  })

  it('exposes the transcript and its selectors', () => {
    expect(typeof createTranscript).toBe('function')
    expect(typeof reduceTranscript).toBe('function')
    expect(typeof reduceTranscriptAll).toBe('function')
    expect(typeof selectMessages).toBe('function')
    expect(typeof selectIsRunning).toBe('function')
    expect(typeof selectLastMessage).toBe('function')
    expect(typeof selectStreamingMessage).toBe('function')
    expect(initialTranscriptState()).toEqual({
      messages: [],
      status: 'idle',
      lastError: null,
      lastSeq: 0,
    })
  })

  it('reaches protocol through its built output', () => {
    // The transcript consumes protocol events, so folding one in proves the edge.
    const state = reduceTranscript(initialTranscriptState(), makeUserMessage('hi', { seq: 1 }))

    expect(state.messages.map((message) => message.text)).toEqual(['hi'])
  })
})
