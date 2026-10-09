import {
  PutProviderCredentialRequestSchema,
  type ProviderCredentialType,
  type PutProviderCredentialRequest,
} from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import {
  CREDENTIAL_TARGETS,
  PROVIDERS,
  credentialDisplayName,
  providerInfo,
  providerName,
} from './providers'

/**
 * One body the protocol's request union parses, per credential type — what the target check
 * below needs, and the one place the test has to know each type's payload fields.
 */
const REPRESENTATIVE_BODIES: Readonly<
  Record<ProviderCredentialType, PutProviderCredentialRequest>
> = {
  api_key: { type: 'api_key', api_key: 'k' },
  azure_openai: {
    type: 'azure_openai',
    endpoint: 'https://x.openai.azure.com',
    api_key: 'k',
    deployments: ['d'],
  },
  bedrock: {
    type: 'bedrock',
    access_key_id: 'AKIAIOSFODNN7EXAMPLE',
    secret_access_key: 'secret',
    region: 'us-east-1',
  },
  openai_compatible: {
    type: 'openai_compatible',
    base_url: 'https://x.example.com/v1',
    api_key: 'k',
  },
}

/**
 * The provider metadata both frontends offer (#209).
 *
 * The list is the shared one (`@openharness/protocol`, epic #245, A0) plus the two hints only a
 * form or a tile needs, so "it describes providers the server will accept a key for" is a
 * compile-time property of the built list, not an assertion here. What is left for a test is
 * everything the merged list must be on its own.
 */
describe('PROVIDERS', () => {
  it('has one entry per provider id, with the fields a tile needs', () => {
    const ids = PROVIDERS.map((provider) => provider.id)

    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBeGreaterThan(0)
    for (const provider of PROVIDERS) {
      expect(provider.id).not.toBe('')
      expect(provider.name).not.toBe('')
      // Every key a reader is sent to fetch is over https. The path is not pinned: a provider
      // whose exact keys page could not be confirmed links to its account home instead, which
      // is a bare host (#209).
      expect(provider.keyUrl).toMatch(/^https:\/\/[^/]+/)
    }
  })

  it('names the credential type the protocol knows, and a form the API accepts', () => {
    for (const provider of PROVIDERS) {
      // The form the web app builds for this type has to produce a body the route parses, so
      // the type is checked against the request schema rather than against a string literal.
      const parsed = PutProviderCredentialRequestSchema.safeParse({
        type: provider.credential,
        api_key: 'sk-test-1234',
      })
      expect(parsed.success).toBe(true)
    }
  })

  it('answers the display name, and the id for a provider it does not carry', () => {
    expect(providerInfo('anthropic')?.name).toBe('Anthropic')
    expect(providerInfo('made-up-provider')).toBeUndefined()
    // An unrecognized provider is not an error — the credentials API takes any provider id, so
    // the id is what the reader typed and what they see.
    expect(providerName('made-up-provider')).toBe('made-up-provider')
  })
})

describe('CREDENTIAL_TARGETS', () => {
  it('offers the eleven providers and then the named credential types', () => {
    expect(CREDENTIAL_TARGETS.map((target) => target.name)).toEqual([
      ...PROVIDERS.map((provider) => provider.id),
      'azure',
      'custom',
      'bedrock',
    ])
    expect(
      CREDENTIAL_TARGETS.filter((target) => target.named).map((target) => target.credential),
    ).toEqual(['azure_openai', 'openai_compatible', 'bedrock'])
  })

  it('gives every target what a tile and a form need', () => {
    for (const target of CREDENTIAL_TARGETS) {
      expect(target.displayName, target.name).not.toBe('')
      // A fixed provider always links to its key page; a named type links only when it has a
      // console to send the reader to (a custom endpoint is the user's own, #249).
      if (target.keyUrl !== undefined) {
        expect(target.keyUrl, target.name).toMatch(/^https:\/\/[^/]+/)
      }
      // The credential type is what selects the form, so it has to be one the protocol's
      // request union parses — for a named target with a representative payload.
      const body = REPRESENTATIVE_BODIES[target.credential]
      expect(PutProviderCredentialRequestSchema.safeParse(body).success, target.name).toBe(true)
    }
  })

  it('gives a custom endpoint no key page, and the form no link to draw', () => {
    const custom = CREDENTIAL_TARGETS.find((target) => target.credential === 'openai_compatible')
    expect(custom).toMatchObject({ name: 'custom', named: true })
    expect(custom?.keyUrl).toBeUndefined()
  })

  it('carries a representative payload for every credential type a target can name', () => {
    // The `Record` is what keeps the bodies above total: a credential type the protocol grows
    // without a body here is a compile error rather than a target silently left unchecked.
    expect(Object.keys(REPRESENTATIVE_BODIES).sort()).toEqual([
      'api_key',
      'azure_openai',
      'bedrock',
      'openai_compatible',
    ])
  })
})

describe('credentialDisplayName', () => {
  it('names a provider by its display name, and a named credential by its own name', () => {
    expect(credentialDisplayName({ name: 'anthropic', type: 'api_key' })).toBe('Anthropic')
    // The default name reads as the type's display name; the reader's own label stays theirs.
    expect(credentialDisplayName({ name: 'azure', type: 'azure_openai' })).toBe('Azure OpenAI')
    expect(credentialDisplayName({ name: 'azure-eu', type: 'azure_openai' })).toBe('azure-eu')
    // A string this list has never heard of reads as itself, never as a blank.
    expect(credentialDisplayName({ name: 'acme', type: 'api_key' })).toBe('acme')
  })
})
