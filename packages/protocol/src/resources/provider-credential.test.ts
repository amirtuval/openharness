import { describe, expect, it } from 'vitest'

import { BEDROCK_REGIONS, DEFAULT_BEDROCK_REGION } from '../bedrock'
import { newProviderCredentialId } from '../ids'
import {
  AzureOpenAICredentialSchema,
  BedrockCredentialDetailsSchema,
  BedrockCredentialSchema,
  ListProviderCredentialsResponseSchema,
  MAX_AZURE_DEPLOYMENTS,
  OpenAICompatibleCredentialDetailsSchema,
  OpenAICompatibleCredentialSchema,
  ProviderCredentialSchema,
  ProviderCredentialTypeSchema,
  PutProviderCredentialRequestSchema,
  VERTEX_LOCATIONS,
  VertexCredentialDetailsSchema,
  VertexCredentialSchema,
  isServiceAccountKey,
  parseServiceAccountKey,
} from './provider-credential'

/** A service-account key document, shaped exactly as Google's console issues one. */
const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'openharness-vertex',
  private_key_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n',
  client_email: 'vertex-runner@openharness-vertex.iam.gserviceaccount.com',
  client_id: '118204773655879341057',
  token_uri: 'https://oauth2.googleapis.com/token',
}

const SERVICE_ACCOUNT_JSON = JSON.stringify(SERVICE_ACCOUNT)

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

  it('carries per-type details, and none for a credential that has nothing to report', () => {
    // A Bedrock credential's region is the one non-secret fact that tells two rows of that
    // type apart; an `api_key` credential has none, and an absent `details` is the shape it
    // takes rather than an empty object.
    const bedrock = {
      ...credential,
      type: 'bedrock',
      name: 'bedrock',
      last4: 'T0KN',
      details: { region: 'eu-west-1' },
    }
    expect(ProviderCredentialSchema.parse(bedrock)).toEqual(bedrock)
    const parsed = ProviderCredentialSchema.parse(credential)
    expect(parsed).not.toHaveProperty('details')
    expect(parsed).toEqual(credential)
  })

  it('carries a vertex credential’s email, project and location as its own details', () => {
    // #251: `last4` is the private key id's last four characters, which tells two Vertex
    // credentials apart only weakly; these three facts do, and none of them is key material.
    const vertex = {
      ...credential,
      type: 'vertex',
      name: 'vertex',
      details: {
        email: SERVICE_ACCOUNT.client_email,
        project: SERVICE_ACCOUNT.project_id,
        location: 'us-central1',
      },
    }
    expect(ProviderCredentialSchema.parse(vertex)).toEqual(vertex)
    // `details` is keyed by type: a key a Vertex credential does not publish is stripped, and a
    // non-string value in one it does is refused.
    expect(
      ProviderCredentialSchema.parse({
        ...vertex,
        details: { ...vertex.details, private_key: '-----BEGIN…' },
      }),
    ).toEqual(vertex)
    expect(
      ProviderCredentialSchema.safeParse({ ...vertex, details: { ...vertex.details, email: 42 } })
        .success,
    ).toBe(false)
  })

  it('rejects an unknown type, an empty name and a malformed timestamp', () => {
    expect(ProviderCredentialSchema.safeParse({ ...credential, type: 'aws' }).success).toBe(false)
    expect(ProviderCredentialSchema.safeParse({ ...credential, name: '' }).success).toBe(false)
    expect(ProviderCredentialSchema.safeParse({ ...credential, last4: 12 }).success).toBe(false)
    expect(ProviderCredentialSchema.safeParse({ ...credential, updated_at: 'never' }).success).toBe(
      false,
    )
  })

  it('keys details by type: only a type that publishes them carries the field', () => {
    const custom = {
      ...credential,
      type: 'openai_compatible',
      name: 'custom',
      details: { base_url_host: '127.0.0.1:11434' },
    }
    expect(ProviderCredentialSchema.parse(custom)).toEqual(custom)
    // The type that has a `details` is where its own shape is enforced ...
    expect(
      ProviderCredentialSchema.safeParse({ ...custom, details: { base_url_host: 42 } }).success,
    ).toBe(false)
    expect(ProviderCredentialSchema.safeParse({ ...custom, details: 'nope' }).success).toBe(false)
    // ... and a type with none has no `details` key: one smuggled onto an api_key or azure
    // credential is stripped like any unknown field, so their metadata is byte-for-byte what it
    // was before the field existed (and both variants keep the json they always had).
    expect(ProviderCredentialSchema.parse(credential)).not.toHaveProperty('details')
    expect(
      ProviderCredentialSchema.parse({
        ...credential,
        details: { base_url_host: 'api.example.com' },
      }),
    ).not.toHaveProperty('details')
  })
})

describe('ProviderCredentialTypeSchema', () => {
  it('is api_key, azure_openai, openai_compatible, bedrock and vertex today and nothing else', () => {
    expect(ProviderCredentialTypeSchema.parse('api_key')).toBe('api_key')
    expect(ProviderCredentialTypeSchema.parse('azure_openai')).toBe('azure_openai')
    expect(ProviderCredentialTypeSchema.parse('openai_compatible')).toBe('openai_compatible')
    expect(ProviderCredentialTypeSchema.parse('bedrock')).toBe('bedrock')
    expect(ProviderCredentialTypeSchema.parse('vertex')).toBe('vertex')
    // The later types — gcp_service_account — are new members of this union, not new designs,
    // but until they land the schema stays closed.
    for (const type of ['gcp_service_account', 'aws', 'azure', 'oauth', 'custom']) {
      expect(ProviderCredentialTypeSchema.safeParse(type).success, type).toBe(false)
    }
  })
})

describe('OpenAICompatibleCredentialDetailsSchema', () => {
  it('carries a base-URL host, and only a non-empty string one', () => {
    expect(
      OpenAICompatibleCredentialDetailsSchema.parse({ base_url_host: 'api.example.com' }),
    ).toEqual({ base_url_host: 'api.example.com' })
    // The host is the point of the object, so an absent one is not a shape: a type with no
    // facts has no `details` at all, rather than an empty object.
    expect(OpenAICompatibleCredentialDetailsSchema.safeParse({}).success).toBe(false)
    expect(OpenAICompatibleCredentialDetailsSchema.safeParse({ base_url_host: '' }).success).toBe(
      false,
    )
    expect(OpenAICompatibleCredentialDetailsSchema.safeParse({ base_url_host: 42 }).success).toBe(
      false,
    )
  })

  it('strips a field it does not know — details is a closed, per-type shape', () => {
    expect(
      OpenAICompatibleCredentialDetailsSchema.parse({ base_url_host: 'x', api_key: 'sk-secret' }),
    ).toEqual({ base_url_host: 'x' })
  })
})

describe('BedrockCredentialDetailsSchema', () => {
  it('carries a region, and only a non-empty string one', () => {
    expect(BedrockCredentialDetailsSchema.parse({ region: 'us-east-1' })).toEqual({
      region: 'us-east-1',
    })
    expect(BedrockCredentialDetailsSchema.safeParse({}).success).toBe(false)
    expect(BedrockCredentialDetailsSchema.safeParse({ region: '' }).success).toBe(false)
    expect(BedrockCredentialDetailsSchema.safeParse({ region: 1 }).success).toBe(false)
  })
})

describe('VertexCredentialDetailsSchema', () => {
  const details = {
    email: SERVICE_ACCOUNT.client_email,
    project: SERVICE_ACCOUNT.project_id,
    location: 'us-central1',
  }

  it('is a vertex credential’s email, project and location', () => {
    // The three facts a list shows to tell two Vertex credentials apart, and none of them is
    // key material: the private key stays inside the sealed payload.
    expect(VertexCredentialDetailsSchema.parse(details)).toEqual(details)
  })

  it('requires all three, each a non-empty string', () => {
    for (const field of ['email', 'project', 'location'] as const) {
      const { [field]: _dropped, ...partial } = details
      expect(VertexCredentialDetailsSchema.safeParse(partial).success, `without ${field}`).toBe(
        false,
      )
      expect(
        VertexCredentialDetailsSchema.safeParse({ ...details, [field]: '' }).success,
        `empty ${field}`,
      ).toBe(false)
    }
    expect(VertexCredentialDetailsSchema.safeParse({ ...details, email: 42 }).success).toBe(false)
  })

  it('strips a field it does not know — details is a closed, per-type shape', () => {
    expect(
      VertexCredentialDetailsSchema.parse({ ...details, private_key: '-----BEGIN…' }),
    ).toEqual(details)
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

  it('parses the bedrock form', () => {
    const body = {
      type: 'bedrock',
      access_key_id: 'AKIAIOSFODNN7EXAMPLE',
      secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      session_token: 'FwoGZXIvYXdzEBYa',
      region: 'eu-west-1',
    }
    expect(PutProviderCredentialRequestSchema.parse(body)).toEqual(body)
  })

  it('parses the vertex form', () => {
    const body = {
      type: 'vertex',
      service_account: SERVICE_ACCOUNT_JSON,
      project: 'openharness-vertex',
      location: 'europe-west4',
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

describe('OpenAICompatibleCredentialSchema', () => {
  const compatible = {
    type: 'openai_compatible',
    base_url: 'https://api.example.com/v1',
    api_key: 'sk-custom-4242',
  }

  it('accepts an http or https base URL, with a key', () => {
    expect(OpenAICompatibleCredentialSchema.parse(compatible)).toEqual(compatible)
    // A self-hosted endpoint is the case this type exists for, so http is allowed — the SSRF
    // guard, not the scheme, is what refuses a private address.
    expect(
      OpenAICompatibleCredentialSchema.parse({
        type: 'openai_compatible',
        base_url: 'http://127.0.0.1:11434/v1',
        api_key: 'k',
      }),
    ).toMatchObject({ base_url: 'http://127.0.0.1:11434/v1' })
  })

  it('accepts a missing key — a local server may want none — but not an empty one', () => {
    const { api_key: _key, ...keyless } = compatible
    expect(OpenAICompatibleCredentialSchema.parse(keyless)).toEqual(keyless)
    expect(OpenAICompatibleCredentialSchema.safeParse({ ...compatible, api_key: '' }).success).toBe(
      false,
    )
    expect(OpenAICompatibleCredentialSchema.safeParse({ ...compatible, api_key: 42 }).success).toBe(
      false,
    )
  })

  it('refuses a base URL that is not an absolute http(s) URL', () => {
    for (const base_url of [
      'api.example.com/v1',
      'ftp://api.example.com/v1',
      'file:///etc/passwd',
      'ws://api.example.com',
      '',
    ]) {
      expect(
        OpenAICompatibleCredentialSchema.safeParse({ ...compatible, base_url }).success,
        base_url,
      ).toBe(false)
    }
  })

  it('requires the type discriminant', () => {
    const { type: _type, ...untyped } = compatible
    expect(OpenAICompatibleCredentialSchema.safeParse(untyped).success).toBe(false)
  })
})

describe('BedrockCredentialSchema', () => {
  const bedrock = {
    type: 'bedrock',
    access_key_id: 'AKIAIOSFODNN7EXAMPLE',
    secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
  }

  it('accepts the three credentials and a region, with and without a session token', () => {
    expect(BedrockCredentialSchema.parse(bedrock)).toEqual(bedrock)
    expect(BedrockCredentialSchema.parse({ ...bedrock, session_token: 'token' })).toEqual({
      ...bedrock,
      session_token: 'token',
    })
    // A session token is optional: long-lived IAM user keys have none. An empty one is not a
    // credential, so it is refused rather than stored as a blank.
    expect(BedrockCredentialSchema.safeParse({ ...bedrock, session_token: '' }).success).toBe(false)
    expect(BedrockCredentialSchema.safeParse({ ...bedrock, session_token: 42 }).success).toBe(false)
  })

  it('refuses a region that is not one of the Bedrock regions AWS serves', () => {
    for (const region of [
      'us-east-3',
      'eu-west-4',
      'us-gov-west-1',
      'evil.example',
      'US-EAST-1',
      'us-east-1.evil.example',
      '',
      'us_east_1',
    ]) {
      expect(BedrockCredentialSchema.safeParse({ ...bedrock, region }).success, region).toBe(false)
    }
  })

  it('accepts every region of the list, and the form default', () => {
    expect(BEDROCK_REGIONS).toContain(DEFAULT_BEDROCK_REGION)
    for (const region of BEDROCK_REGIONS) {
      expect(BedrockCredentialSchema.safeParse({ ...bedrock, region }).success, region).toBe(true)
    }
  })

  it('requires every credential field to be a non-empty string, and the type', () => {
    for (const field of ['access_key_id', 'secret_access_key'] as const) {
      expect(BedrockCredentialSchema.safeParse({ ...bedrock, [field]: '' }).success, field).toBe(
        false,
      )
      const { [field]: _dropped, ...partial } = bedrock
      expect(BedrockCredentialSchema.safeParse(partial).success, `without ${field}`).toBe(false)
    }
    const { type: _type, ...untyped } = bedrock
    expect(BedrockCredentialSchema.safeParse(untyped).success).toBe(false)
    expect(BedrockCredentialSchema.safeParse({ ...bedrock, access_key_id: 42 }).success).toBe(false)
  })
})

describe('parseServiceAccountKey', () => {
  it('reads the five fields a request needs out of a service-account key', () => {
    expect(parseServiceAccountKey(SERVICE_ACCOUNT_JSON)).toEqual({
      type: 'service_account',
      project_id: SERVICE_ACCOUNT.project_id,
      private_key_id: SERVICE_ACCOUNT.private_key_id,
      private_key: SERVICE_ACCOUNT.private_key,
      client_email: SERVICE_ACCOUNT.client_email,
    })
    expect(isServiceAccountKey(SERVICE_ACCOUNT_JSON)).toBe(true)
  })

  it('does not care about the fields it does not read', () => {
    expect(isServiceAccountKey(JSON.stringify({ ...SERVICE_ACCOUNT, universe_domain: 'x' }))).toBe(
      true,
    )
  })

  it('refuses anything that is not a service-account key', () => {
    for (const value of [
      '',
      'not json at all',
      '[]',
      '"a string"',
      'null',
      // The authorized-user document Google also hands out — the one a `gcloud auth
      // application-default login` writes. It authenticates a *person*, not a service.
      JSON.stringify({ ...SERVICE_ACCOUNT, type: 'authorized_user' }),
      JSON.stringify({ ...SERVICE_ACCOUNT, type: undefined }),
      JSON.stringify({ ...SERVICE_ACCOUNT, private_key: undefined }),
      JSON.stringify({ ...SERVICE_ACCOUNT, private_key: '' }),
      JSON.stringify({ ...SERVICE_ACCOUNT, client_email: 42 }),
    ]) {
      expect(parseServiceAccountKey(value), value).toBeNull()
      expect(isServiceAccountKey(value), value).toBe(false)
    }
  })
})

describe('VertexCredentialSchema', () => {
  const vertex = {
    type: 'vertex',
    service_account: SERVICE_ACCOUNT_JSON,
    project: 'openharness-vertex',
    location: 'us-central1',
  }

  it('accepts a service-account key, a project id and a known location', () => {
    expect(VertexCredentialSchema.parse(vertex)).toEqual(vertex)
  })

  it('keeps the key text exactly as it was pasted', () => {
    // The document is sealed whole, so nothing about it may be reformatted on the way in: the
    // parser reads it, and the payload carries the string it was given.
    const spaced = JSON.stringify(SERVICE_ACCOUNT, null, 4)
    expect(
      VertexCredentialSchema.parse({ ...vertex, service_account: spaced }).service_account,
    ).toBe(spaced)
  })

  it('refuses a document that is not a service-account key', () => {
    for (const service_account of [
      '{}',
      '{"type":"service_account"}',
      JSON.stringify({ ...SERVICE_ACCOUNT, type: 'authorized_user' }),
      'not json',
    ]) {
      expect(
        VertexCredentialSchema.safeParse({ ...vertex, service_account }).success,
        service_account,
      ).toBe(false)
    }
  })

  it('refuses a project that is not a Google Cloud project id', () => {
    for (const project of ['', 'Openharness', 'ab', '1-openharness', 'openharness-', 'open harness']) {
      expect(VertexCredentialSchema.safeParse({ ...vertex, project }).success, project).toBe(false)
    }
    expect(
      VertexCredentialSchema.safeParse({ ...vertex, project: 'my-project-123456' }).success,
    ).toBe(true)
  })

  it('refuses a location it does not know, because the location is the host', () => {
    for (const location of ['', 'us-central-1', 'mars-north1', 'US-CENTRAL1']) {
      expect(VertexCredentialSchema.safeParse({ ...vertex, location }).success, location).toBe(
        false,
      )
    }
    for (const location of VERTEX_LOCATIONS) {
      expect(VertexCredentialSchema.safeParse({ ...vertex, location }).success, location).toBe(true)
    }
  })

  it('requires every field of the form', () => {
    for (const field of ['service_account', 'project', 'location'] as const) {
      const { [field]: _dropped, ...partial } = vertex
      expect(VertexCredentialSchema.safeParse(partial).success, `without ${field}`).toBe(false)
    }
    const { type: _type, ...untyped } = vertex
    expect(VertexCredentialSchema.safeParse(untyped).success).toBe(false)
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
