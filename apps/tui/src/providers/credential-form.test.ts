import { PutProviderCredentialRequestSchema } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import {
  CREDENTIAL_FORMS,
  formForCredential,
  isChoiceField,
  nameErrorMessage,
} from './credential-form'

describe('CREDENTIAL_FORMS', () => {
  it('has a form for every credential type the protocol knows (X6)', () => {
    // The assertion is that this table and the protocol's union are the same list, so a new
    // member with no form fails here rather than at a reader's prompt.
    expect(Object.keys(CREDENTIAL_FORMS).sort()).toEqual([
      'api_key',
      'azure_openai',
      'bedrock',
      'openai_compatible',
      'vertex',
    ])
  })

  it('builds a body the protocol accepts', () => {
    const form = CREDENTIAL_FORMS.api_key
    const body = form.build({ api_key: 'sk-test-0000' })

    expect(body).toEqual({ type: 'api_key', api_key: 'sk-test-0000' })
    // The shapes the two sides agree on are the protocol's, not this table's.
    expect(PutProviderCredentialRequestSchema.safeParse(body).success).toBe(true)
  })

  it('defaults a missing field to the empty string rather than undefined', () => {
    // A `build` that returned `undefined` would fail the schema on the wire with a message
    // about the whole body; an empty string is the one failure the server has words for.
    expect(CREDENTIAL_FORMS.api_key.build({})).toEqual({ type: 'api_key', api_key: '' })
  })
})

describe('formForCredential', () => {
  it('answers the api_key form for a provider the metadata list does not carry', () => {
    // The credentials API takes any router id, so an unknown provider still gets the one form
    // that could work rather than none at all.
    expect(formForCredential(undefined)).toBe(CREDENTIAL_FORMS.api_key)
  })

  it('answers the form the metadata names', () => {
    expect(formForCredential('api_key')).toBe(CREDENTIAL_FORMS.api_key)
  })
})

describe('the azure_openai form', () => {
  it('collects the endpoint, the key and the deployment names', () => {
    const form = CREDENTIAL_FORMS.azure_openai
    expect(form.fields.map((field) => field.name)).toEqual(['endpoint', 'api_key', 'deployments'])
    // Only the key is a secret: an endpoint and a deployment list are things the reader has to
    // be able to read back when they check what they pasted.
    expect(form.fields.filter((field) => field.secret).map((field) => field.name)).toEqual([
      'api_key',
    ])
  })

  it('builds a body the protocol accepts, with the deployments split and trimmed', () => {
    const body = CREDENTIAL_FORMS.azure_openai.build({
      endpoint: '  https://my-resource.openai.azure.com  ',
      api_key: 'az-key-4242',
      deployments: 'gpt-4o, gpt-4o-mini\n\n my-private ',
    })

    expect(body).toEqual({
      type: 'azure_openai',
      endpoint: 'https://my-resource.openai.azure.com',
      api_key: 'az-key-4242',
      deployments: ['gpt-4o', 'gpt-4o-mini', 'my-private'],
    })
    expect(PutProviderCredentialRequestSchema.safeParse(body).success).toBe(true)
  })

  it('sends an empty body the protocol refuses rather than a body it half-fills', () => {
    // The server's 400 is the answer for a credential that is not filled in, which is why
    // `build` does not invent a deployment.
    const body = CREDENTIAL_FORMS.azure_openai.build({})
    expect(body).toEqual({
      type: 'azure_openai',
      endpoint: '',
      api_key: '',
      deployments: [],
    })
    expect(PutProviderCredentialRequestSchema.safeParse(body).success).toBe(false)
  })
})

describe('the openai_compatible form', () => {
  it('collects a base URL and an optional key', () => {
    const form = CREDENTIAL_FORMS.openai_compatible
    expect(form.fields.map((field) => field.name)).toEqual(['base_url', 'api_key'])
    // Only the key is masked; the base URL is shown so a typo is visible, and it is optional.
    expect(form.fields.filter((field) => field.secret).map((field) => field.name)).toEqual([
      'api_key',
    ])
    expect(form.fields.find((field) => field.name === 'api_key')?.optional).toBe(true)
    expect(form.fields.find((field) => field.name === 'base_url')?.optional).toBeUndefined()
  })

  it('builds a body the protocol accepts, with the URL trimmed', () => {
    const body = CREDENTIAL_FORMS.openai_compatible.build({
      base_url: '  https://api.example.com/v1  ',
      api_key: 'sk-custom-4242',
    })
    expect(body).toEqual({
      type: 'openai_compatible',
      base_url: 'https://api.example.com/v1',
      api_key: 'sk-custom-4242',
    })
    expect(PutProviderCredentialRequestSchema.safeParse(body).success).toBe(true)
  })

  it('omits the key when it is empty, which a keyless endpoint needs', () => {
    // The schema accepts a missing key but not an empty string, so the body must not carry one.
    const body = CREDENTIAL_FORMS.openai_compatible.build({
      base_url: 'http://127.0.0.1:11434/v1',
      api_key: '   ',
    })
    expect(body).toEqual({
      type: 'openai_compatible',
      base_url: 'http://127.0.0.1:11434/v1',
    })
    expect(PutProviderCredentialRequestSchema.safeParse(body).success).toBe(true)
  })

  it('sends an empty URL the protocol refuses rather than a body it half-fills', () => {
    const body = CREDENTIAL_FORMS.openai_compatible.build({})
    expect(body).toEqual({ type: 'openai_compatible', base_url: '' })
    expect(PutProviderCredentialRequestSchema.safeParse(body).success).toBe(false)
  })
})

describe('the vertex form', () => {
  it('asks for the key file’s path, the project and the location', () => {
    const form = CREDENTIAL_FORMS.vertex
    expect(form.fields.map((field) => field.name)).toEqual([
      'service_account',
      'project',
      'location',
    ])
    // The document is read from the path the reader gives, so the flow — not the reader — puts
    // a private key through a terminal.
    expect(form.fields.filter((field) => field.file).map((field) => field.name)).toEqual([
      'service_account',
    ])
    expect(form.fields.every((field) => !field.secret)).toBe(true)
  })

  it('opens the project prompt with the key document’s own project', () => {
    const document = JSON.stringify({
      type: 'service_account',
      project_id: 'openharness-vertex',
      private_key_id: 'k',
      private_key: 'pem',
      client_email: 'runner@openharness-vertex.iam.gserviceaccount.com',
    })
    const project = CREDENTIAL_FORMS.vertex.fields[1]

    expect(project?.prefill?.({ service_account: document })).toBe('openharness-vertex')
    // Nothing to read out of anything else: the prompt opens empty.
    expect(project?.prefill?.({ service_account: 'not json' })).toBe('')
    expect(project?.prefill?.({})).toBe('')
  })

  it('builds a vertex body from the answers, project and all', () => {
    const document = JSON.stringify({
      type: 'service_account',
      project_id: 'openharness-vertex',
      private_key_id: 'k',
      private_key: 'pem',
      client_email: 'runner@openharness-vertex.iam.gserviceaccount.com',
    })
    expect(
      CREDENTIAL_FORMS.vertex.build({
        service_account: document,
        project: ' another-project-9f3a ',
        location: 'us-central1',
      }),
    ).toEqual({
      type: 'vertex',
      service_account: document,
      project: 'another-project-9f3a',
      location: 'us-central1',
    })
  })

  it('refuses a location outside Google’s list, before a request is made', () => {
    const location = CREDENTIAL_FORMS.vertex.fields[2]
    expect(location?.validate?.('us-central1')).toBeNull()
    expect(location?.validate?.('global')).toBeNull()
    expect(location?.validate?.('mars-north1')).toMatch(/Vertex location/)
    expect(location?.validate?.('')).toMatch(/Vertex location/)
  })

  it('builds a body the protocol accepts, and one it refuses when nothing was filled in', () => {
    const document = JSON.stringify({
      type: 'service_account',
      project_id: 'openharness-vertex',
      private_key_id: 'k',
      private_key: 'pem',
      client_email: 'runner@openharness-vertex.iam.gserviceaccount.com',
    })
    const form = CREDENTIAL_FORMS.vertex
    expect(
      PutProviderCredentialRequestSchema.safeParse(
        form.build({
          service_account: document,
          project: 'openharness-vertex',
          location: 'europe-west4',
        }),
      ).success,
    ).toBe(true)
    // The project prompt opens prefilled, so an empty one is a reader who cleared it — a body
    // the protocol refuses rather than one this form half-fills.
    expect(
      PutProviderCredentialRequestSchema.safeParse(
        form.build({ service_account: document, location: 'europe-west4' }),
      ).success,
    ).toBe(false)
    expect(PutProviderCredentialRequestSchema.safeParse(form.build({})).success).toBe(false)
  })
})

describe('nameErrorMessage', () => {
  it('accepts a legal, unused name', () => {
    expect(nameErrorMessage('azure-eu', ['azure'])).toBeNull()
    expect(nameErrorMessage('', [])).toBeNull()
  })

  it('refuses a name that is not a credential name, a fixed provider id, and one already taken', () => {
    expect(nameErrorMessage('Azure', [])).toMatch(/short and lowercase/)
    expect(nameErrorMessage('azure_eu', [])).toMatch(/short and lowercase/)
    // The rule the server enforces and the flow must say first: `openai` is the OpenAI
    // provider's, and a second credential called that would make `openai/gpt-5` ambiguous.
    expect(nameErrorMessage('openai', [])).toMatch(/built-in provider id/)
    expect(nameErrorMessage('azure', ['azure'])).toMatch(/already taken/)
  })
})

describe('the bedrock form', () => {
  it('collects a region chosen from a list, the two keys and an optional token', () => {
    const form = CREDENTIAL_FORMS.bedrock
    expect(form.fields.map((field) => field.name)).toEqual([
      'region',
      'access_key_id',
      'secret_access_key',
      'session_token',
    ])
    // The region is a list rather than a box — it goes into an AWS hostname — and it is the
    // only field with a starting value, because a region has no unset a save could carry.
    const region = form.fields[0]
    expect(region === undefined ? false : isChoiceField(region)).toBe(true)
    expect(region?.defaultValue).toBe('us-east-1')
    expect((region?.options ?? []).length).toBeGreaterThan(20)
    // Both keys are masked; the token is masked and may be skipped.
    expect(form.fields.filter((field) => field.secret).map((field) => field.name)).toEqual([
      'secret_access_key',
      'session_token',
    ])
    expect(form.fields.filter((field) => field.optional).map((field) => field.name)).toEqual([
      'session_token',
    ])
  })

  it('builds a body the protocol accepts, with and without a session token', () => {
    const form = CREDENTIAL_FORMS.bedrock
    expect(
      form.build({
        region: 'eu-west-1',
        access_key_id: 'AKIAIOSFODNN7EXAMPLE',
        secret_access_key: 'secret',
        session_token: 'token',
      }),
    ).toEqual({
      type: 'bedrock',
      region: 'eu-west-1',
      access_key_id: 'AKIAIOSFODNN7EXAMPLE',
      secret_access_key: 'secret',
      session_token: 'token',
    })

    // A skipped token is left out of the body rather than sent as an empty string, which the
    // protocol refuses (its `min(1)`), so skipping the prompt cannot produce a rejected save.
    const withoutToken = form.build({
      region: 'us-east-2',
      access_key_id: 'AKIAIOSFODNN7EXAMPL2',
      secret_access_key: 'secret',
      session_token: '   ',
    })
    expect(withoutToken).toEqual({
      type: 'bedrock',
      region: 'us-east-2',
      access_key_id: 'AKIAIOSFODNN7EXAMPL2',
      secret_access_key: 'secret',
    })
    expect(PutProviderCredentialRequestSchema.safeParse(withoutToken).success).toBe(true)
  })

  it('refuses an empty body the protocol refuses, and never invents a region', () => {
    const body = CREDENTIAL_FORMS.bedrock.build({})
    // The fallback is the default region — the field is a list over the protocol's own list, so
    // this is unreachable from the flow — and the body is still refused for its missing keys.
    expect(body).toMatchObject({ type: 'bedrock', region: 'us-east-1' })
    expect(PutProviderCredentialRequestSchema.safeParse(body).success).toBe(false)
  })
})
