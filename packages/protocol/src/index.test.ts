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
    expect(protocol.DEFAULT_PARTITION_COUNT).toBe(64)
    // The exact partition for a given id is pinned in `constants.test.ts`; what the barrel
    // has to show is that the function is the same one and lands in range for the default
    // partition count.
    const partition = protocol.partitionOf('sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7')
    expect(partition).toBeGreaterThanOrEqual(0)
    expect(partition).toBeLessThan(protocol.DEFAULT_PARTITION_COUNT)
    expect(protocol.partitionOf('sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7', 1)).toBe(0)
  })
})
