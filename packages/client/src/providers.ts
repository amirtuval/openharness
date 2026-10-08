import type { ProviderCredentialType } from '@openharness/protocol'

/**
 * The model providers the frontends offer, and what a form needs to know about each.
 *
 * This is **presentation metadata**, not a capability list: it says what to call a provider, how
 * a reader gets a key for it, and which credential form collects that key. Authorization is
 * still the server's (`PUT /v1/provider-credentials/{provider}`, epic #65 A5) — the server's
 * `VALIDATABLE_PROVIDERS` is the list of providers whose key it can check, and the two have to
 * agree: a tile a reader can pick and then not save is worse than no tile. `e2e`'s
 * `provider-metadata.test.ts` is what holds them together, because the server may not depend on
 * this package.
 *
 * The ids are **Mastra router names** — the first half of a `provider/model` string, which is
 * what `GET /v1/models` reports and what a session's `model.id` takes. The *credentials* form
 * has always been a convenience rather than a limit (an unknown provider can still be typed in
 * Settings), and this list stays that: a provider missing from it is reachable, it just has no
 * tile of its own.
 *
 * Both frontends read it: the web app builds its onboarding tiles, its Add-provider dialog and
 * its Settings list from it (#209), and `oh` will offer the same providers in the terminal
 * (#210, epic #201 X7).
 */
export interface ProviderInfo {
  /** The Mastra router id: the `provider` half of a `provider/model` string. */
  readonly id: string
  /** What a reader calls it. Never the raw id, which is a router detail. */
  readonly name: string
  /**
   * Which credential form collects the key (epic #201, X6).
   *
   * Always `api_key` today — every provider here authenticates with one secret. The credential
   * types the protocol leaves room for (`aws`, `gcp_service_account`, `azure`) would arrive as
   * new values here, and the web app's form table is keyed by this field, so a new one is a
   * compile error there until it has a form.
   */
  readonly credential: ProviderCredentialType
  /** Where a reader creates a key. Opened in a new tab; never a link to a sign-in page. */
  readonly keyUrl: string
  /**
   * How a free tier is described, where the provider has one (epic #201, X8). Absent means
   * "no free tier we can promise", which is not the same as "paid only" — the tile simply
   * says nothing.
   */
  readonly freeTier?: string
  /**
   * What a key of this provider usually looks like, for the input's placeholder. Presentational
   * only: a key that does not match is still sent, because a provider may change its format and
   * the server's validating call is the one that decides. Omitted where the format is not
   * distinctive enough to help.
   */
  readonly keyHint?: string
}

/**
 * The providers, in the order the frontends offer them.
 *
 * The order is the one the credentials form has always used, with the server-validatable
 * providers that list never carried appended: the common ones a reader is likeliest to have
 * first, then the rest.
 */
export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    credential: 'api_key',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-…',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    credential: 'api_key',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-…',
  },
  {
    id: 'google',
    name: 'Google',
    credential: 'api_key',
    keyUrl: 'https://aistudio.google.com/apikey',
    freeTier: 'Free tier in Google AI Studio',
    keyHint: 'AIza…',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    credential: 'api_key',
    keyUrl: 'https://openrouter.ai/keys',
    freeTier: 'Free models available',
    keyHint: 'sk-or-…',
  },
  {
    id: 'groq',
    name: 'Groq',
    credential: 'api_key',
    keyUrl: 'https://console.groq.com/keys',
    freeTier: 'Free tier available',
    keyHint: 'gsk_…',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    credential: 'api_key',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyHint: 'sk-…',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    credential: 'api_key',
    // The account home, not the keys page: Fireworks' key path has moved between
    // `fireworks.ai/account/api-keys` and `fireworks.ai/api-keys`, and a link that 404s is
    // worse than one that lands a click short (#209).
    keyUrl: 'https://fireworks.ai/',
    keyHint: 'fw_…',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    credential: 'api_key',
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'together',
    name: 'Together AI',
    credential: 'api_key',
    // The console root: Together's key page lives under `/settings/api-keys` on a host that has
    // been `api.together.xyz` and `api.together.ai`, and the console is the half that is sure.
    keyUrl: 'https://api.together.ai/',
  },
  {
    id: 'xai',
    name: 'xAI',
    credential: 'api_key',
    keyUrl: 'https://console.x.ai/',
    keyHint: 'xai-…',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    credential: 'api_key',
    keyUrl: 'https://cloud.cerebras.ai/',
  },
]

/** Metadata for a provider id, or `undefined` for one this list has never heard of. */
export function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((provider) => provider.id === id)
}

/**
 * A provider's display name, falling back to the id.
 *
 * The fallback is the documented behaviour rather than an error: the credential API takes any
 * provider string, so a reader who typed one this list does not carry sees what they typed.
 */
export function providerName(id: string): string {
  return providerInfo(id)?.name ?? id
}
