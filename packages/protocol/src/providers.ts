import type { ProviderCredentialType } from './resources/provider-credential'

/**
 * The model providers openharness knows: one list, referenced by every side (epic #245, A0).
 *
 * A **provider id** is the first half of a `provider/model` model id — what the server stores
 * a credential under, what the brain resolves a request's client from, and what both
 * frontends offer a key for. Before #245 each of those carried its own copy of the list and a
 * test held the copies together; now there is one list, and a side that leaves a provider out
 * of its own table is a compile error (`satisfies Record<ProviderId, …>`) rather than a test
 * failure.
 *
 * // extension: Anthropic's Managed Agents API has no provider registry — Anthropic holds the
 * model-provider keys. This list is openharness's: it carries the facts every side of the
 * boundary shares, and nothing more.
 *
 * What is here is what every side shares: the id, what to call it, the credential type it
 * authenticates with, the key models.dev files it under, and where a reader gets a key.
 * Everything one side needs on top of that stays with that side — the server's validating
 * request and its model-list adapter, the brain's AI SDK client, the frontends' free-tier and
 * key-format hints.
 *
 * **A provider id and a credential type are two different things.** The id is the fixed name
 * of one of the providers below, and it is what a model id's first half is. The credential
 * type says how a credential authenticates — `api_key` for all of them today, and later
 * `azure_openai`, `aws`, `gcp_service_account` for the credentials-phase work (#245). A
 * *named* credential (say `azure-eu`) will carry a type without being a new id here: the name
 * becomes the provider half of a model id, while these eleven keep their fixed ids. Keeping
 * the two concepts apart is what leaves room for that.
 */

/** One provider, as every side of the boundary needs it. */
export interface ProviderDefinition {
  /** The provider id: the `provider` half of a `provider/model` string. */
  readonly id: string
  /** What a reader calls it. Never the raw id, which is a wire detail. */
  readonly name: string
  /** How its credential authenticates; selects the form a frontend renders (epic #201, X6). */
  readonly credential: ProviderCredentialType
  /** The key this provider's models are filed under in the models.dev registry payload. */
  readonly modelsDevKey: string
  /**
   * Where a reader creates a key. Opened in a new tab; never a link to a sign-in page, and
   * never a page whose path is a guess — a link that 404s is worse than one that lands on the
   * provider's account home.
   */
  readonly keyUrl: string
}

/**
 * The providers, in the order every side lists them: the common ones a reader is likeliest to
 * have first, then the rest. The order is the one the credentials flow has always used, and
 * the catalogue and the frontends keep it rather than retyping it.
 */
export const PROVIDERS = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    credential: 'api_key',
    modelsDevKey: 'anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    credential: 'api_key',
    modelsDevKey: 'openai',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'google',
    name: 'Google',
    credential: 'api_key',
    modelsDevKey: 'google',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    credential: 'api_key',
    modelsDevKey: 'openrouter',
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'groq',
    name: 'Groq',
    credential: 'api_key',
    modelsDevKey: 'groq',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    credential: 'api_key',
    modelsDevKey: 'deepseek',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    credential: 'api_key',
    // models.dev files Fireworks under `fireworks-ai`.
    modelsDevKey: 'fireworks-ai',
    // The account home, not the keys page: Fireworks' key path has moved between
    // `fireworks.ai/account/api-keys` and `fireworks.ai/api-keys`.
    keyUrl: 'https://fireworks.ai/',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    credential: 'api_key',
    modelsDevKey: 'mistral',
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'together',
    name: 'Together AI',
    credential: 'api_key',
    // models.dev files Together under `togetherai`.
    modelsDevKey: 'togetherai',
    // The console root: Together's key page lives under `/settings/api-keys` on a host that
    // has been `api.together.xyz` and `api.together.ai`, and the console is the half that is
    // sure.
    keyUrl: 'https://api.together.ai/',
  },
  {
    id: 'xai',
    name: 'xAI',
    credential: 'api_key',
    modelsDevKey: 'xai',
    keyUrl: 'https://console.x.ai/',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    credential: 'api_key',
    modelsDevKey: 'cerebras',
    keyUrl: 'https://cloud.cerebras.ai/',
  },
] as const satisfies readonly ProviderDefinition[]

/**
 * A provider id {@link PROVIDERS} carries.
 *
 * Use it for a table keyed by provider: `satisfies Record<ProviderId, …>` or
 * `Record<ProviderId, …>` makes a missing provider a compile error.
 */
export type ProviderId = (typeof PROVIDERS)[number]['id']

/** Every provider id, in {@link PROVIDERS} order. */
export const PROVIDER_IDS: readonly ProviderId[] = PROVIDERS.map((provider) => provider.id)
