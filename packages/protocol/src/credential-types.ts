import { PROVIDER_IDS } from './providers'
import type { ProviderCredentialType } from './resources/provider-credential'

/**
 * The credential types beyond the eleven fixed provider ids (epic #245, decision M4).
 *
 * A credential's **type** says how it authenticates, and the eleven providers of `providers.ts`
 * are all `api_key`. A type that is *not* one of those eleven is a **named credential**: the
 * user keeps as many as they like, each under a short name they choose (`azure`, `azure-eu`) or
 * the type's default (`azure` when they are adding the first). The name — never the type — is
 * the `provider` half of the model ids the credential serves, so `azure-eu/<deployment>` is a
 * model id and `azure_openai` is not. Keeping "provider id/name" and "credential type" apart is
 * what leaves room for these (A0).
 *
 * // extension: Anthropic holds its users' model-provider keys and has no credential registry.
 * openharness's named credentials are its own, like the provider list beside this file.
 */

/** One credential type that is not a fixed provider id, and the facts every side shares. */
export interface CredentialTypeDefinition {
  /** The `type` discriminant its payload schema carries. */
  readonly type: ProviderCredentialType
  /** What a reader calls it, e.g. `Azure OpenAI`. Never the raw type. */
  readonly name: string
  /**
   * The name a credential of this type takes when a user adds their first one. Short, lowercase
   * and unique per user; a second credential of the same type asks for a different name.
   */
  readonly defaultName: string
  /**
   * The key this type's models are filed under in the models.dev registry payload. Distinct
   * from {@link defaultName}: it names the *registry* entry, not the user's credential, so a
   * `azure-eu` credential still reads models.dev's single `azure` entry.
   */
  readonly modelsDevKey: string
}

/**
 * The named credential types, in the order every side lists them. Today: Azure OpenAI.
 *
 * `credential-types.test.ts` holds this list against the request union's members, so a type
 * added to the schema without its facts here — or the reverse — fails a named test rather than
 * reaching a form with nothing to render.
 */
export const CREDENTIAL_TYPES = [
  {
    type: 'azure_openai',
    name: 'Azure OpenAI',
    defaultName: 'azure',
    // models.dev files Azure OpenAI under `azure`.
    modelsDevKey: 'azure',
  },
] as const satisfies readonly CredentialTypeDefinition[]

/** A credential type that is not one of the eleven fixed provider ids. */
export type NamedCredentialType = (typeof CREDENTIAL_TYPES)[number]['type']

/**
 * The character shape a credential name must have: lowercase letters, digits and single dashes.
 *
 * The name is the `provider` half of a model id, so it has to survive being typed, sent in a
 * URL path and matched against a `provider/model` string. Lowercase-only keeps two spellings
 * from meaning the same credential; the 11 fixed provider ids are already lowercase and fit it.
 */
export const CREDENTIAL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** How long a credential name may be. Short is the point: it prefixes every model id. */
export const CREDENTIAL_NAME_MAX_LENGTH = 32

/** The facts for a credential type, or `undefined` for `api_key` (which has no default name). */
export function credentialTypeInfo(
  type: ProviderCredentialType,
): CredentialTypeDefinition | undefined {
  return CREDENTIAL_TYPES.find((entry) => entry.type === type)
}

/** What to call a credential type, or `undefined` for one this list does not carry. */
export function credentialTypeName(type: ProviderCredentialType): string | undefined {
  return credentialTypeInfo(type)?.name
}

/**
 * The name a credential of `type` defaults to when the user is adding their first one, or
 * `undefined` for `api_key` — whose name is always the fixed provider id, never a default.
 */
export function defaultCredentialName(type: ProviderCredentialType): string | undefined {
  return credentialTypeInfo(type)?.defaultName
}

/**
 * Whether `name` is a legal credential name in isolation: short, lowercase, dash-separated.
 *
 * This says nothing about collisions — see {@link isReservedCredentialName} — because which
 * names are taken is a per-user question the server answers against the store.
 */
export function isValidCredentialName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= CREDENTIAL_NAME_MAX_LENGTH &&
    CREDENTIAL_NAME_PATTERN.test(name)
  )
}

/**
 * Whether `name` is one the eleven fixed provider ids already own.
 *
 * A named credential may not take one: `openai` names the OpenAI provider, and a second
 * credential calling itself `openai` would make `openai/gpt-5` ambiguous between them. The
 * server refuses such a name on save.
 */
export function isReservedCredentialName(name: string): boolean {
  return (PROVIDER_IDS as readonly string[]).includes(name)
}
