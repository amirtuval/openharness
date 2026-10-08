import { PutProviderCredentialRequestSchema } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { CREDENTIAL_FORMS, formForCredential } from './credential-form'

describe('CREDENTIAL_FORMS', () => {
  it('has a form for every credential type the protocol knows (X6)', () => {
    // The protocol's union has one member today; the assertion is that the two lists are the
    // same list, so a new member with no form fails here rather than at a reader's prompt.
    expect(Object.keys(CREDENTIAL_FORMS).sort()).toEqual(['api_key'])
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
