import { describe, expect, it } from 'vitest'

import * as protocol from './index'

describe('@openharness/protocol', () => {
  it('exposes its package name', () => {
    expect(protocol.PACKAGE_NAME).toBe('@openharness/protocol')
  })

  it('exports the schemas every other package codes against', () => {
    // A smoke test for the barrel: a missing export here is a broken build for a dependent.
    for (const name of [
      'AgentSchema',
      'SessionSchema',
      'StoredEventSchema',
      'StreamEventSchema',
      'UserEventInputSchema',
      'SendEventsRequestSchema',
      'ListEventsResponseSchema',
      'StreamEventsQuerySchema',
      'ApiErrorBodySchema',
      'AgentIdSchema',
      'PageCursorSchema',
      'KeyCursorSchema',
      'encodeSeqCursor',
      'encodeKeyCursor',
      // The auth work (epic #65) a dependent builds against.
      'UserSchema',
      'GetMeResponseSchema',
      'UserIdSchema',
      'ProviderCredentialSchema',
      'ProviderCredentialIdSchema',
      'PutProviderCredentialRequestSchema',
      'ListProviderCredentialsResponseSchema',
      'newProviderCredentialId',
    ] as const) {
      expect(protocol[name], name).toBeDefined()
    }
  })

  it('exports the constants shared by the server and the store', () => {
    expect(protocol.API_VERSION_PREFIX).toBe('/v1')
    // Deprecated (epic #65, A8), kept only while the server and client still import it.
    expect(protocol.API_KEY_HEADER).toBe('x-api-key')
    expect(protocol.DEFAULT_PARTITION_COUNT).toBe(64)
    expect(protocol.partitionOf('sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7')).toBe(
      protocol.partitionOf('sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7'),
    )
    expect(protocol.partitionOf('sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7', 1)).toBe(0)
  })
})
