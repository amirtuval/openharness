import { describe, expect, it } from 'vitest'

import { newProviderCredentialId } from '../ids'
import {
  AzureOpenAICredentialSchema,
  ListProviderCredentialsResponseSchema,
  MAX_AZURE_DEPLOYMENTS,
  ProviderCredentialSchema,
  ProviderCredentialTypeSchema,
  PutProviderCredentialRequestSchema,
} from './provider-credential'

const credential = {
  id: newProviderCredentialId(),
  type: 'api_key',
  name: 'anthropic',
  last4: 'cdef',
  created_at: '2026-03-15T10:00:00Z',
  updated_at: '2026-03-15T10:00:00Z',
  validated_at: '2026-03-15T10:00:00Z',
}

describe('ProviderCredentialSchema', () => {
  it('parses a credential, with and without validated_at', () => {
    expect(ProviderCredentialSchema.parse(credential)).toEqual(credential)
    const { validated_at: _validated, ...unvalidated } = credential
    expect(ProviderCredentialSchema.parse(unvalidated)).toEqual(unvalidated)
  })

  it('carries a name, which is the provider half of the model ids it serves', () => {
    // A named credential is stored under a name the user chose; the wire field is the same one
    // a fixed provider carries its provider id in.
    expect(ProviderCredentialSchema.parse({ ...credential, name: 'azure-eu' }).name).toBe(
      'azure-eu',
    )
    const { name: _dropped, ...nameless } = credential
    expect(ProviderCredentialSchema.safeParse(nameless).success).toBe(false)
    expect(ProviderCredentialSchema.safeParse({ ...credential, name: '' }).success).toBe(false)
  })

  it('carries a pcred_ id, not any other kind', () => {
    expect(ProviderCredentialSchema.parse(credential).id).toBe(credential.id)
    expect(ProviderCredentialSchema.safeParse({ ...credential, id: 'agent_nope' }).success).toBe(
      false,
    )
    expect(
      ProviderCredentialSchema.safeParse({
        ...credential,
        id: credential.id.replace('pcred_', 'sesn_'),
      }).success,
    ).toBe(false)
  })

  it('is metadata only: a secret in the payload is not part of it', () => {
    // The response schema has no api_key field, so one smuggled into a payload is stripped
    // like any unknown field — the wire type cannot carry the secret back to a caller.
    const parsed: Record<string, unknown> = ProviderCredentialSchema.parse({
      ...credential,
      api_key: 'sk-ant-secret',
    })
    expect(parsed).toEqual(credential)
    expect(parsed).not.toHaveProperty('api_key')
  })

  it('requires the name and the last4', () => {
    for (const field of ['id', 'type', 'name', 'last4', 'created_at', 'updated_at'] as const) {
      const { [field]: _dropped, ...partial } = credential
      expect(ProviderCredentialSchema.safeParse(partial).success, `without ${field}`).toBe(false)
    }
  })

  it('rejects an unknown type, an empty name and a malformed timestamp', () => {
    expect(ProviderCredentialSchema.safeParse({ ...credential, type: 'aws' }).success).toBe(false)
    expect(ProviderCredentialSchema.safeParse({ ...credential, name: '' }).success).toBe(false)
    expect(ProviderCredentialSchema.safeParse({ ...credential, last4: 12 }).success).toBe(false)
    expect(ProviderCredentialSchema.safeParse({ ...credential, updated_at: 'never' }).success).toBe(
      false,
    )
  })
})

describe('ProviderCredentialTypeSchema', () => {
  it('is api_key and azure_openai today and nothing else', () => {
    expect(ProviderCredentialTypeSchema.parse('api_key')).toBe('api_key')
    expect(ProviderCredentialTypeSchema.parse('azure_openai')).toBe('azure_openai')
    // The later types — aws, gcp_service_account — are new members of this union, not new
    // designs, but until they land the schema stays closed.
    for (const type of ['aws', 'gcp_service_account', 'azure', 'oauth']) {
      expect(ProviderCredentialTypeSchema.safeParse(type).success, type).toBe(false)
    }
  })
})

describe('PutProviderCredentialRequestSchema', () => {
  it('parses the api_key form', () => {
    expect(
      PutProviderCredentialRequestSchema.parse({ type: 'api_key', api_key: 'sk-ant-abc' }),
    ).toEqual({ type: 'api_key', api_key: 'sk-ant-abc' })
  })

  it('parses the azure_openai form', () => {
    const body = {
      type: 'azure_openai',
      endpoint: 'https://my-resource.openai.azure.com',
      api_key: 'az-secret',
      deployments: ['gpt-4o', 'gpt-4o-mini'],
    }
    expect(PutProviderCredentialRequestSchema.parse(body)).toEqual(body)
  })

  it('discriminates on type: forms that have not landed are not accepted', () => {
    expect(
      PutProviderCredentialRequestSchema.safeParse({ type: 'aws', access_key_id: 'AKIA…' }).success,
    ).toBe(false)
    expect(
      PutProviderCredentialRequestSchema.safeParse({ type: 'gcp_service_account', json: '{}' })
        .success,
    ).toBe(false)
  })

  it('requires a non-empty api_key', () => {
    expect(PutProviderCredentialRequestSchema.safeParse({ type: 'api_key' }).success).toBe(false)
    expect(
      PutProviderCredentialRequestSchema.safeParse({ type: 'api_key', api_key: '' }).success,
    ).toBe(false)
    expect(
      PutProviderCredentialRequestSchema.safeParse({ type: 'api_key', api_key: 42 }).success,
    ).toBe(false)
    expect(PutProviderCredentialRequestSchema.safeParse({ api_key: 'sk-ant-abc' }).success).toBe(
      false,
    )
  })
})

describe('AzureOpenAICredentialSchema', () => {
  const azure = {
    type: 'azure_openai',
    endpoint: 'https://my-resource.openai.azure.com',
    api_key: 'az-secret',
    deployments: ['gpt-4o'],
  }

  it('accepts an https endpoint and a non-empty deployment list', () => {
    expect(AzureOpenAICredentialSchema.parse(azure)).toEqual(azure)
  })

  it('refuses a non-https endpoint', () => {
    for (const endpoint of [
      'http://my-resource.openai.azure.com',
      'ftp://my-resource.openai.azure.com',
      'my-resource.openai.azure.com',
      'ws://my-resource.openai.azure.com',
    ]) {
      expect(AzureOpenAICredentialSchema.safeParse({ ...azure, endpoint }).success, endpoint).toBe(
        false,
      )
    }
  })

  it('requires at least one deployment and no more than the cap', () => {
    expect(AzureOpenAICredentialSchema.safeParse({ ...azure, deployments: [] }).success).toBe(false)
    expect(AzureOpenAICredentialSchema.safeParse({ ...azure, deployments: [''] }).success).toBe(
      false,
    )
    const tooMany = Array.from({ length: MAX_AZURE_DEPLOYMENTS + 1 }, (_, i) => `d${i}`)
    expect(AzureOpenAICredentialSchema.safeParse({ ...azure, deployments: tooMany }).success).toBe(
      false,
    )
    const atCap = tooMany.slice(0, MAX_AZURE_DEPLOYMENTS)
    expect(AzureOpenAICredentialSchema.safeParse({ ...azure, deployments: atCap }).success).toBe(
      true,
    )
  })

  it('requires an api_key and a type', () => {
    expect(AzureOpenAICredentialSchema.safeParse({ ...azure, api_key: '' }).success).toBe(false)
    const { type: _type, ...untyped } = azure
    expect(AzureOpenAICredentialSchema.safeParse(untyped).success).toBe(false)
  })
})

describe('ListProviderCredentialsResponseSchema', () => {
  it('parses a list of metadata, and the empty list a fresh account starts with', () => {
    expect(ListProviderCredentialsResponseSchema.parse({ data: [credential] })).toEqual({
      data: [credential],
    })
    expect(ListProviderCredentialsResponseSchema.parse({ data: [] })).toEqual({ data: [] })
  })

  it('rejects a missing data array and a non-array one', () => {
    expect(ListProviderCredentialsResponseSchema.safeParse({}).success).toBe(false)
    expect(ListProviderCredentialsResponseSchema.safeParse({ data: {} }).success).toBe(false)
    expect(ListProviderCredentialsResponseSchema.safeParse([credential]).success).toBe(false)
  })
})
