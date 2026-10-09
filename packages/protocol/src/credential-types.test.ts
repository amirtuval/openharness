import { describe, expect, it } from 'vitest'

import {
  CREDENTIAL_NAME_MAX_LENGTH,
  CREDENTIAL_TYPES,
  credentialTypeInfo,
  credentialTypeName,
  defaultCredentialName,
  isReservedCredentialName,
  isValidCredentialName,
} from './credential-types'
import { PROVIDER_IDS } from './providers'
import { PROVIDER_CREDENTIAL_TYPES } from './resources/provider-credential'

/**
 * The named credential types (epic #245, A3a).
 *
 * `CREDENTIAL_TYPES` is the facts every side reads about a type that is not a fixed provider
 * id: its display name, its default credential name and its models.dev key. It has to agree
 * with the credential schema's union, so the two lists are held together here rather than in a
 * form that would simply not compile.
 */
describe('CREDENTIAL_TYPES', () => {
  it('covers exactly the credential types that are not api_key', () => {
    const named = CREDENTIAL_TYPES.map((entry) => entry.type).sort()
    const nonApiKey = PROVIDER_CREDENTIAL_TYPES.filter((type) => type !== 'api_key').sort()

    expect(named).toEqual(nonApiKey)
  })

  it('carries azure_openai with a display name, a default name and a models.dev key', () => {
    expect(credentialTypeInfo('azure_openai')).toEqual({
      type: 'azure_openai',
      name: 'Azure OpenAI',
      defaultName: 'azure',
      modelsDevKey: 'azure',
      keyUrl: 'https://portal.azure.com/',
    })
    expect(credentialTypeName('azure_openai')).toBe('Azure OpenAI')
    expect(defaultCredentialName('azure_openai')).toBe('azure')
  })

  it('carries openai_compatible, with no models.dev key and no key page', () => {
    // A custom base URL names no single models.dev provider and no single console, so both
    // facts are absent rather than guessed — the forms render without a link.
    expect(credentialTypeInfo('openai_compatible')).toEqual({
      type: 'openai_compatible',
      name: 'Custom (OpenAI-compatible)',
      defaultName: 'custom',
    })
    expect(credentialTypeName('openai_compatible')).toBe('Custom (OpenAI-compatible)')
    expect(defaultCredentialName('openai_compatible')).toBe('custom')
  })

  it('carries bedrock with a display name, a default name and its models.dev key', () => {
    expect(credentialTypeInfo('bedrock')).toEqual({
      type: 'bedrock',
      name: 'Amazon Bedrock',
      defaultName: 'bedrock',
      // models.dev files Bedrock's models under the product's full name.
      modelsDevKey: 'amazon-bedrock',
      keyUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    })
    expect(credentialTypeName('bedrock')).toBe('Amazon Bedrock')
    expect(defaultCredentialName('bedrock')).toBe('bedrock')
  })

  it('has no facts for api_key — its name is always the fixed provider id', () => {
    expect(credentialTypeInfo('api_key')).toBeUndefined()
    expect(credentialTypeName('api_key')).toBeUndefined()
    expect(defaultCredentialName('api_key')).toBeUndefined()
  })

  it('gives every default name a legal, unreserved credential name', () => {
    for (const entry of CREDENTIAL_TYPES) {
      expect(isValidCredentialName(entry.defaultName), entry.defaultName).toBe(true)
      expect(isReservedCredentialName(entry.defaultName), entry.defaultName).toBe(false)
    }
  })

  it('sends every reader that has a key page to an https one', () => {
    for (const entry of CREDENTIAL_TYPES) {
      if (entry.keyUrl !== undefined) {
        expect(entry.keyUrl, entry.type).toMatch(/^https:\/\/[^/]+/)
      }
    }
    // A type with no console to link to omits it; only a custom endpoint does today.
    expect(credentialTypeInfo('openai_compatible')?.keyUrl).toBeUndefined()
    expect(credentialTypeInfo('azure_openai')?.keyUrl).toBe('https://portal.azure.com/')
  })

  it('files each type that has one under its own models.dev key', () => {
    const keys = CREDENTIAL_TYPES.flatMap((entry) =>
      entry.modelsDevKey === undefined ? [] : [entry.modelsDevKey],
    )
    expect(new Set(keys).size).toBe(keys.length)
    expect(credentialTypeInfo('openai_compatible')?.modelsDevKey).toBeUndefined()
  })
})

describe('credential names', () => {
  it('accepts short lowercase dash-separated names', () => {
    for (const name of ['azure', 'azure-eu', 'a', 'my-azure-2', 'a1-b2-c3']) {
      expect(isValidCredentialName(name), name).toBe(true)
    }
  })

  it('refuses an empty, over-long, uppercase, spaced or leading-dash name', () => {
    for (const name of [
      '',
      'Azure',
      'azure_eu',
      'azure eu',
      '-azure',
      'azure-',
      'azure.openai',
      'a'.repeat(CREDENTIAL_NAME_MAX_LENGTH + 1),
    ]) {
      expect(isValidCredentialName(name), name).toBe(false)
    }
  })

  it('accepts a name at exactly the length cap', () => {
    expect(isValidCredentialName('a'.repeat(CREDENTIAL_NAME_MAX_LENGTH))).toBe(true)
  })

  it('reserves every fixed provider id', () => {
    for (const id of PROVIDER_IDS) {
      expect(isReservedCredentialName(id), id).toBe(true)
    }
    expect(isReservedCredentialName('azure')).toBe(false)
    expect(isReservedCredentialName('azure-eu')).toBe(false)
  })
})
