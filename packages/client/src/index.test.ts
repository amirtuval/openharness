import { makeAgent, makeUserMessage } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import {
  ApiError,
  AuthenticationError,
  OPENHARNESS_CLI_CLIENT_ID,
  PACKAGE_NAME,
  ResponseValidationError,
  createClient,
  createTranscript,
  errorTypeForStatus,
  initialTranscriptState,
  reduceTranscript,
} from './index'
import { createMockFetch, errorResponse, jsonResponse } from './test-support/mock-fetch'

/**
 * The barrel, driven rather than counted.
 *
 * A `typeof x === 'function'` list proves nothing a rename would not have caught at compile
 * time; what it cannot catch — the exports being wired to something that does not work — is
 * what these tests run: a request through `createClient`, the classes it actually throws, the
 * status map, and a protocol event folded through the transcript. The transcript half also
 * pins the dist-based protocol edge the package resolves through `@openharness/protocol`.
 */

describe('@openharness/client', () => {
  it('exposes its package name and the CLI client id', () => {
    expect(PACKAGE_NAME).toBe('@openharness/client')
    expect(OPENHARNESS_CLI_CLIENT_ID).toBe('openharness-cli')
  })

  it('serves a working client, and throws the error classes it exports', async () => {
    const agent = makeAgent()
    const mock = createMockFetch((_request, call) =>
      call === 0 ? jsonResponse(agent) : errorResponse(401, 'authentication_error', 'Expired.'),
    )
    const client = createClient({ baseUrl: 'https://api.test', fetch: mock.fetch })

    await expect(client.agents.get(agent.id)).resolves.toEqual(agent)

    // The 401 handler's class is this module's, not a second copy a consumer's `instanceof`
    // would miss.
    const failure = client.sessions.list().catch((error: unknown) => error)
    await expect(failure).resolves.toBeInstanceOf(AuthenticationError)
    await expect(failure).resolves.toBeInstanceOf(ApiError)
  })

  it('refuses a 200 that does not match the protocol, with the class it exports', async () => {
    const mock = createMockFetch(() => jsonResponse({ not: 'an agent' }))
    const client = createClient({ baseUrl: 'https://api.test', fetch: mock.fetch })

    const failure = client.agents.get(makeAgent().id).catch((error: unknown) => error)

    await expect(failure).resolves.toBeInstanceOf(ResponseValidationError)
  })

  it('maps a bare status to the protocol’s error type', () => {
    expect(errorTypeForStatus(429)).toBe('rate_limit_error')
    expect(errorTypeForStatus(401)).toBe('authentication_error')
    expect(errorTypeForStatus(418)).toBe('api_error')
  })

  it('folds protocol events through the transcript it exports', () => {
    const event = makeUserMessage('hi', { seq: 1 })
    const viaStore = createTranscript()
    viaStore.apply(event)
    const viaReducer = reduceTranscript(initialTranscriptState(), event)

    // The store and the pure reducer are two spellings of one rule; they have to agree.
    expect(viaStore.getState()).toEqual(viaReducer)
    expect(viaReducer.messages.map((message) => message.text)).toEqual(['hi'])
    expect(viaReducer.lastSeq).toBe(1)
  })
})
