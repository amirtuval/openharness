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
   *
   * Absent for a type whose endpoints the user chooses — a custom OpenAI-compatible base URL
   * names no single models.dev provider, so there is no entry to file its models under. Such a
   * type may still borrow a model's metadata when the raw id matches exactly one registry
   * model, and gets none otherwise.
   */
  readonly modelsDevKey?: string
  /**
   * Where a reader creates the secret. Opened in a new tab, and never a page whose path is a
   * guess — the same rule the provider list's `keyUrl` follows. A named type talks to a
   * service the reader reaches through its own console, so this is that console's entry page.
   *
   * Absent for a type with no single console — a self-hosted endpoint the user's own operator
   * runs has no page to send a reader to, and the form simply offers no link.
   */
  readonly keyUrl?: string
  /**
   * What the second half of this type's model ids is, for the sentence a form puts under its
   * name field: Azure OpenAI serves **deployments** (`azure/gpt-4o` names the deployment
   * `gpt-4o`), Bedrock serves **model ids** (`bedrock/anthropic.claude-…-v1:0`) and a custom
   * OpenAI-compatible endpoint serves **models** (`custom/llama3.3`).
   *
   * It is a fact about the type's model ids rather than a form's business — the same reason
   * the two halves of a model id are `provider` and `model` everywhere else — and it lives
   * here so the two frontends' name prompts cannot say different things about one type.
   */
  readonly modelIdHint: string
}

/**
 * The named credential types, in the order every side lists them. Today: Azure OpenAI, a
 * custom OpenAI-compatible endpoint, Amazon Bedrock and Google Vertex.
 *
 * `credential-types.test.ts` holds this list against the request union's members, so a type
 * added to the schema without its facts here — or the reverse — fails a named test rather than
 * reaching a form with nothing to render.
 */
const CREDENTIAL_TYPE_DEFINITIONS = [
  {
    type: 'azure_openai',
    name: 'Azure OpenAI',
    defaultName: 'azure',
    // models.dev files Azure OpenAI under `azure`.
    modelsDevKey: 'azure',
    // The Azure portal's home: the resource's own page is under a subscription and a resource
    // group, so its path is a guess and the portal root is the honest link.
    keyUrl: 'https://portal.azure.com/',
    // An Azure OpenAI credential's models are its deployments: `azure/gpt-4o`.
    modelIdHint: 'deployment',
  },
  {
    type: 'openai_compatible',
    name: 'Custom (OpenAI-compatible)',
    defaultName: 'custom',
    // No `modelsDevKey`: the base URL is the user's, so there is no single models.dev provider
    // to file its models under. No `keyUrl`: a self-hosted endpoint has no console to link to.
    // A custom endpoint's models are whatever its `/models` lists: `custom/llama3.3`.
    modelIdHint: 'model',
  },
  {
    type: 'bedrock',
    name: 'Amazon Bedrock',
    defaultName: 'bedrock',
    // models.dev files Bedrock under the full product name, `amazon-bedrock`.
    modelsDevKey: 'amazon-bedrock',
    // IAM's Security credentials page: the documented place an access key is created, and the
    // one page of the IAM console a reader with no key yet needs. Base URL, not a per-key path.
    keyUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    // A Bedrock credential's models are the Bedrock model ids: `bedrock/anthropic.claude-…-v1:0`.
    modelIdHint: 'model id',
  },
  {
    type: 'vertex',
    name: 'Google Vertex',
    defaultName: 'vertex',
    // models.dev files Vertex under `google-vertex`, and that entry carries the Anthropic
    // models served there too — so one key covers everything a Vertex credential can run.
    modelsDevKey: 'google-vertex',
    // A service-account key is not created on a page of its own: it is issued from a service
    // account, under IAM → Service Accounts. That list is where the reader starts, and the
    // page's path is stable, so it is the honest link rather than a guessed one for one
    // account.
    keyUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    // A Vertex credential's models are `vertex/gemini-2.5-pro`: the second half is a model.
    modelIdHint: 'model',
  },
] as const satisfies readonly CredentialTypeDefinition[]

/**
 * The named credential types, in the order every side lists them — the list above, widened to
 * {@link CredentialTypeDefinition} so a caller reads an optional fact (`keyUrl`, `modelsDevKey`)
 * without the literal union refusing the member that omits it.
 */
export const CREDENTIAL_TYPES: readonly CredentialTypeDefinition[] = CREDENTIAL_TYPE_DEFINITIONS

/** A credential type that is not one of the eleven fixed provider ids. */
export type NamedCredentialType = (typeof CREDENTIAL_TYPE_DEFINITIONS)[number]['type']

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
