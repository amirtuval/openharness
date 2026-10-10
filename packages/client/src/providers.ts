import {
  PROVIDERS as SHARED_PROVIDERS,
  type ProviderCredentialType,
  type ProviderId,
} from '@openharness/protocol'

/**
 * The model providers the frontends offer, and what a form needs to know about each.
 *
 * This is **presentation metadata**, not a capability list: it says what to call a provider, how
 * a reader gets a key for it, and which credential form collects that key. Authorization is
 * still the server's (`PUT /v1/provider-credentials/{provider}`, epic #65 A5).
 *
 * The providers themselves — the ids, their order, the display name, the credential type and
 * the "get a key" URL — are the shared list's (`@openharness/protocol`, epic #245, A0), and
 * this module is the frontends' view of it: the same rows, plus the two things only a form or a
 * tile needs, the free-tier hint and the key-format hint. The list used to be its own copy held
 * against the server's by `e2e`'s `provider-metadata.test.ts` (the server may not depend on this
 * package); there is one list now, so nothing has to hold them together.
 *
 * The ids are **provider ids** — the first half of a `provider/model` string, which is
 * what `GET /v1/models` reports and what a session's `model.id` takes.
 *
 * Both frontends read it: the web app builds its onboarding tiles, its Add-provider dialog and
 * its Settings list from it (#209), and `oh` will offer the same providers in the terminal
 * (#210, epic #201 X7).
 */
export interface ProviderInfo {
  /** The provider id: the `provider` half of a `provider/model` string. */
  readonly id: ProviderId
  /** What a reader calls it. Never the raw id, which is a wire detail. */
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
 * The presentation-only half, keyed by provider id: what a form or a tile adds to the shared
 * facts. A `Record<ProviderId, …>`, so a provider that arrives in the shared list without a
 * decision here is a compile error — and a provider that leaves it is one too.
 */
const PRESENTATION: Readonly<
  Record<ProviderId, { readonly freeTier?: string; readonly keyHint?: string }>
> = {
  anthropic: { keyHint: 'sk-ant-…' },
  openai: { keyHint: 'sk-…' },
  google: { freeTier: 'Free tier in Google AI Studio', keyHint: 'AIza…' },
  openrouter: { freeTier: 'Free models available', keyHint: 'sk-or-…' },
  groq: { freeTier: 'Free tier available', keyHint: 'gsk_…' },
  deepseek: { keyHint: 'sk-…' },
  fireworks: { keyHint: 'fw_…' },
  mistral: {},
  together: {},
  xai: { keyHint: 'xai-…' },
  cerebras: {},
}

/**
 * The providers, in the order the shared list carries them.
 *
 * Built from that list rather than restated: the id, the name, the credential type and the key
 * URL come from it, and {@link PRESENTATION} adds the free-tier and key-format hints. The order
 * is the list's — the common providers a reader is likeliest to have first.
 */
export const PROVIDERS: readonly ProviderInfo[] = SHARED_PROVIDERS.map((provider) => ({
  id: provider.id,
  name: provider.name,
  credential: provider.credential,
  keyUrl: provider.keyUrl,
  ...PRESENTATION[provider.id],
}))

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
