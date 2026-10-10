import { PutProviderCredentialRequestSchema } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { CREDENTIAL_FORMS, formForCredential, nameErrorMessage } from './credential-form'

describe('CREDENTIAL_FORMS', () => {
  it('has a form for every credential type the protocol knows (X6)', () => {
    // The protocol's union has one member today; the assertion is that the two lists are the
    // same list, so a new member with no form fails here rather than at a reader's prompt.
    expect(Object.keys(CREDENTIAL_FORMS).sort()).toEqual(['api_key', 'azure_openai'])
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
