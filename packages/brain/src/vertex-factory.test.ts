import { generateKeyPairSync } from 'node:crypto'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProviderFetch } from './provider-fetch'
import type { VertexModelCredential } from './model'

/**
 * What the factory hands the provider package for a Vertex credential (epic #245, A3d).
 *
 * The provider package is replaced here, on purpose: this is the one place the *options* are
 * observable — the real client's token exchange fails on any key a test can generate, so the
 * request itself never happens — and the options are where the no-ADC guarantee is written.
 * `vertex-model.test.ts` is the other half, and the more important one: the same factory, the
 * real provider, and every Application Default Credentials decoy the environment can offer.
 */

const { createVertex, createVertexAnthropic } = vi.hoisted(() => ({
  createVertex: vi.fn(),
  createVertexAnthropic: vi.fn(),
}))

vi.mock('@ai-sdk/google-vertex', () => ({ createVertex }))
vi.mock('@ai-sdk/google-vertex/anthropic', () => ({ createVertexAnthropic }))

const { createProviderModelFactory } = await import('./model')

/** A throwaway key pair, so the document under test is a real one of the right shape. */
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'openharness-vertex',
  private_key_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  client_email: 'vertex-runner@openharness-vertex.iam.gserviceaccount.com',
  client_id: '118204773655879341057',
  token_uri: 'https://oauth2.googleapis.com/token',
}

const CREDENTIAL: VertexModelCredential = {
  type: 'vertex',
  project: 'openharness-vertex',
  location: 'europe-west4',
  serviceAccount: JSON.stringify(SERVICE_ACCOUNT),
}

/** The provider the mock stands in for: it answers a model the test can recognize. */
function fakeProvider(): { languageModel: (id: string) => unknown } {
  return { languageModel: (id: string) => ({ fake: 'vertex', modelId: id }) }
}

beforeEach(() => {
  createVertex.mockReset().mockReturnValue(fakeProvider())
  createVertexAnthropic.mockReset().mockReturnValue(fakeProvider())
})

describe('the Vertex model factory', () => {
  it('passes the stored project, location and key — and shuts every environment door', () => {
    createProviderModelFactory()('vertex/gemini-2.5-pro', CREDENTIAL)

    expect(createVertex).toHaveBeenCalledTimes(1)
    const settings = createVertex.mock.calls[0]?.[0] as Record<string, unknown>
    expect(settings.project).toBe('openharness-vertex')
    expect(settings.location).toBe('europe-west4')
    // The whole service-account document, parsed — that is what google-auth-library signs with,
    // and its presence is what keeps ADC out of the request entirely.
    expect(settings.googleAuthOptions).toEqual({ credentials: SERVICE_ACCOUNT })
    // An **empty** apiKey, not an absent one: left undefined the provider reads
    // GOOGLE_VERTEX_API_KEY and switches the request into express mode, where a key from the
    // environment authenticates it. `''` is what the provider sees and treats as "none".
    expect(settings).toHaveProperty('apiKey', '')
    // Nothing else: no baseURL (the endpoint is derived from the location), no headers.
    expect(Object.keys(settings).sort()).toEqual([
      'apiKey',
      'googleAuthOptions',
      'location',
      'project',
    ])
  })

  it('builds a Gemini model with the Gemini client', () => {
    const model = createProviderModelFactory()('vertex/gemini-2.5-pro', CREDENTIAL)
    expect(createVertex).toHaveBeenCalledTimes(1)
    expect(createVertexAnthropic).not.toHaveBeenCalled()
    expect(model).toEqual({ fake: 'vertex', modelId: 'gemini-2.5-pro' })
  })

  it('builds an Anthropic model with the Anthropic client, and gives it the same settings', () => {
    const model = createProviderModelFactory()('vertex/claude-sonnet-4-5@20250929', CREDENTIAL)
    expect(createVertexAnthropic).toHaveBeenCalledTimes(1)
    expect(createVertex).not.toHaveBeenCalled()
    expect(model).toEqual({ fake: 'vertex', modelId: 'claude-sonnet-4-5@20250929' })
    expect(createVertexAnthropic.mock.calls[0]?.[0]).toEqual(createVertexSettings())
  })

  it('passes a host’s own fetch through, and nothing when it has none', () => {
    const fetch = vi.fn() as unknown as ProviderFetch
    createProviderModelFactory({ vertexFetch: fetch })('vertex/gemini-2.5-pro', CREDENTIAL)
    expect((createVertex.mock.calls[0]?.[0] as Record<string, unknown>).fetch).toBe(fetch)

    createVertex.mockClear()
    createProviderModelFactory()('vertex/gemini-2.5-pro', CREDENTIAL)
    expect(createVertex.mock.calls[0]?.[0]).not.toHaveProperty('fetch')
  })

  it('refuses a stored document that is not JSON, without naming any of it', () => {
    // A row edited by hand, or one written before the protocol's check existed: the turn must
    // fail with a sentence a reader can act on rather than a stack trace from the auth library.
    expect(() =>
      createProviderModelFactory()('vertex/gemini-2.5-pro', {
        ...CREDENTIAL,
        serviceAccount: 'not json',
      }),
    ).toThrow(/service account/i)
    expect(createVertex).not.toHaveBeenCalled()
  })
})

/** The settings the two Vertex clients are built with — the same for either family. */
function createVertexSettings(): unknown {
  return {
    project: 'openharness-vertex',
    location: 'europe-west4',
    apiKey: '',
    googleAuthOptions: { credentials: SERVICE_ACCOUNT },
  }
}
