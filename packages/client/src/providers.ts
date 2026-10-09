import {
  CREDENTIAL_TYPES,
  PROVIDERS as SHARED_PROVIDERS,
  bedrockRegionOf,
  type ProviderCredentialDetails,
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

/**
 * One thing a reader may add in an Add-provider surface: a fixed provider, or a **named**
 * credential type (epic #245, A3a).
 *
 * The eleven providers are one each, under their own id. A named type — Azure OpenAI, Amazon
 * Bedrock — may be added more than once, each under a name the reader chooses or the type's
 * default (`azure`, `bedrock`), and that name is the `provider` half of the model ids it
 * serves. `named` is the one thing a form needs to know beyond the tile's text: only a named
 * target asks for a name, and only when one of that type is already stored.
 */
export interface CredentialTarget {
  /** The credential name a first save uses: a fixed provider id, or the type's default name. */
  readonly name: string
  /** What a reader calls it. */
  readonly displayName: string
  /** Which form collects it — the key of the frontends' form table (#201, X6). */
  readonly credential: ProviderCredentialType
  /**
   * Where a reader creates the secret. Opened in a new tab. Absent for a target with no single
   * console — a custom OpenAI-compatible endpoint is the user's own, so its form offers no
   * link rather than guessing one (#249).
   */
  readonly keyUrl?: string
  /** Whether the reader may keep more than one, each under a name they choose. */
  readonly named: boolean
  /** The free-tier hint, where the target has one (X8). */
  readonly freeTier?: string
  /** The key-format hint for an input's placeholder, where the provider has a distinctive one. */
  readonly keyHint?: string
  /**
   * What the second half of this target's model ids is — `deployment` for Azure OpenAI,
   * `model id` for Bedrock, `model` for a fixed provider — for the sentence a form puts under
   * its name field. It comes from the credential type's own definition, so the two frontends
   * cannot describe one type differently.
   */
  readonly modelIdHint: string
}

/**
 * Everything the Add-provider surfaces offer, in order: the eleven providers (the shared
 * list's order) and then the named credential types.
 *
 * A tile is drawn per entry, and which form collects the secret is
 * {@link CredentialTarget.credential} — so a new credential type with no form is a compile
 * error in the frontend's form table rather than a tile that does nothing.
 */
export const CREDENTIAL_TARGETS: readonly CredentialTarget[] = [
  ...PROVIDERS.map((provider) => ({
    name: provider.id,
    displayName: provider.name,
    credential: provider.credential,
    keyUrl: provider.keyUrl,
    named: false,
    // A fixed provider's models are `anthropic/claude-sonnet-5`: the second half is a model.
    modelIdHint: 'model',
    ...(provider.freeTier === undefined ? {} : { freeTier: provider.freeTier }),
    ...(provider.keyHint === undefined ? {} : { keyHint: provider.keyHint }),
  })),
  ...CREDENTIAL_TYPES.map((entry) => ({
    name: entry.defaultName,
    displayName: entry.name,
    credential: entry.type,
    named: true,
    // A type with no single console — a custom endpoint is the user's own — carries no
    // `keyUrl`, and the form simply offers no link (#249).
    ...(entry.keyUrl === undefined ? {} : { keyUrl: entry.keyUrl }),
    modelIdHint: entry.modelIdHint,
  })),
]

/**
 * What to call a **stored** credential in a sentence: the provider's display name where the
 * name is a provider id, the type's display name where the name is its default, and the
 * reader's own label otherwise.
 *
 * A second Azure credential is stored as `azure-eu`, and that is what it is called — the label
 * is the reader's, and a row that hid it would leave two identical-looking rows. A **list row**
 * leads with something else for a default-named credential: {@link credentialRowLabel}, which
 * keeps the model-id prefix visible (#271).
 */
export function credentialDisplayName(credential: {
  readonly name: string
  readonly type: ProviderCredentialType
}): string {
  const known = providerInfo(credential.name)
  if (known !== undefined) {
    return known.name
  }
  const entry = CREDENTIAL_TYPES.find((candidate) => candidate.type === credential.type)
  return entry !== undefined && entry.defaultName === credential.name ? entry.name : credential.name
}

/**
 * How a list row names a stored credential (#271): what leads the row, and the credential
 * type's display name beside it when the two differ.
 *
 * A row is what tells the reader what to type as the `provider` half of a model id (#245, A3a),
 * so the two parts are kept apart rather than joined here: the terminal draws them as one
 * string (`azure (Azure OpenAI)`), and the web draws the second as secondary text. The rule for
 * *when* there is a second part is in one place — {@link credentialRowLabel} — so the two
 * frontends cannot disagree about it.
 */
export interface CredentialRowLabel {
  /**
   * What leads the row: a fixed provider's display name (`Anthropic`), or a named credential's
   * own name (`azure`), which is the `provider` half of the model ids it serves.
   */
  readonly primary: string
  /**
   * The credential type's display name, shown beside `primary` when it would otherwise hide the
   * prefix: a credential called `azure` reads `azure (Azure OpenAI)`, not `Azure OpenAI`.
   * Absent for a fixed provider and for a credential the reader named (`azure-eu`), which
   * already reads as itself.
   */
  readonly secondary?: string
}

/**
 * The label a list row leads with, and the credential type's display name beside it when that
 * name would hide the model-id prefix (#271).
 *
 * `credentialDisplayName` answers what to *call* a credential, and it is right for a sentence
 * ("Saved the Azure OpenAI credential"); it is not what a row may lead with, because for a
 * default-named credential it answers the type's display name — and the reader typing `/model`
 * never types `Azure OpenAI`. A fixed provider is unchanged, and a reader-named credential
 * already reads as itself, so two Azure credentials keep the names they were saved under.
 */
export function credentialRowLabel(credential: {
  readonly name: string
  readonly type: ProviderCredentialType
}): CredentialRowLabel {
  const displayName = credentialDisplayName(credential)
  if (credential.type === 'api_key' || displayName === credential.name) {
    return { primary: displayName }
  }
  return { primary: credential.name, secondary: displayName }
}

/**
 * The Add-provider target a **stored** credential belongs to: the provider it names, or the
 * named type it is.
 *
 * A row's Replace opens the form on this target, and the credential's own name is what the form
 * saves under — which is how a second Azure credential's row reopens *its* form rather than the
 * first one's.
 */
export function credentialTargetFor(credential: {
  readonly name: string
  readonly type: ProviderCredentialType
}): CredentialTarget | undefined {
  if (providerInfo(credential.name) !== undefined) {
    return CREDENTIAL_TARGETS.find((target) => target.name === credential.name)
  }
  return CREDENTIAL_TARGETS.find((target) => target.named && target.credential === credential.type)
}

/** What a list row reads beyond a credential's name and `last4`. */
interface CredentialFacts {
  readonly type: ProviderCredentialType
  readonly details?: ProviderCredentialDetails | undefined
}

/**
 * The non-secret facts a credential's row shows beside its name, in the order every side lists
 * them (epic #245, A3c).
 *
 * `last4` tells two credentials of one type apart but not which service one *is*: a Bedrock key
 * belongs to a region, and an account with `bedrock` and `bedrock-us` needs to see which is
 * which. The facts come from the credential's `details` — the per-type object the server
 * reports and never the secret — and a type with nothing to add returns none.
 *
 * The table is a `Record<ProviderCredentialType, …>` on purpose: a new credential type is a
 * compile error here until someone decides what its row says, in one place both frontends read,
 * rather than a row that silently shows nothing.
 */
const CREDENTIAL_FACT_RENDERERS: Readonly<
  Record<ProviderCredentialType, (credential: CredentialFacts) => readonly string[]>
> = {
  api_key: () => [],
  // Azure's endpoint is not on the wire yet; when it is, this is where its host goes.
  azure_openai: () => [],
  // A custom endpoint's public fact is its base URL's host, which the web list shows as the
  // row's endpoint; the CLI's extra column is for facts `last4` cannot carry, and this one is
  // already rendered. Its `details` is typed for that type, so it is read where it is shown.
  openai_compatible: () => [],
  bedrock: (credential) => {
    const details = credential.details
    const region =
      details !== undefined && 'region' in details ? bedrockRegionOf(details) : undefined
    return region === undefined ? [] : [region]
  },
  vertex: (credential) => {
    // The three things that tell two Vertex credentials apart: whose key it is, which project
    // and which region. Nothing of the private key is among them, ever — `last4` is the key
    // id's tail, and these are the document's public facts (#251).
    const details = credential.details
    if (details === undefined || !('email' in details)) {
      return []
    }
    return [details.email, details.project, details.location]
  },
}

/** The facts one stored credential's row shows beside its name and `last4`. */
export function credentialFacts(credential: CredentialFacts): readonly string[] {
  return CREDENTIAL_FACT_RENDERERS[credential.type](credential)
}
