/**
 * Amazon Bedrock inference profiles, as the catalogue reads them (issue #274).
 *
 * Bedrock serves a model in one of two ways. An **on-demand foundation model** answers a
 * Converse request under its own model id, in the region that model is enabled in — the list
 * `ListFoundationModels` answers, and the one this server has always offered. A **cross-region
 * inference profile** is the other: a named wrapper that fans a request out over a geography,
 * whose id carries that geography's prefix — `us.anthropic.claude-…`, `eu.…`, `apac.…`,
 * `global.…`, and the single-region groups (`jp.…`, `au.…`, `ca.…`, `in.…`, `us-gov.…`). In
 * many regions the newest Claude and Nova models are callable **only** through a profile, so a
 * catalogue built from `ListFoundationModels?byInferenceType=ON_DEMAND` alone hides the models
 * a user most wants.
 *
 * `ListInferenceProfiles` is the read that names them. This module is the shape half — the
 * request AWS serves (`GET /inference-profiles`, paged by `nextToken`) and the response it
 * returns (`inferenceProfileSummaries[]`, each with `inferenceProfileId`,
 * `inferenceProfileArn`, `inferenceProfileName`, `models[].modelArn`, `status` and `type`) —
 * taken from the AWS Bedrock API reference and the AWS SDK for JavaScript v3
 * (`@aws-sdk/client-bedrock`) types, which agree:
 *
 * - {@link BedrockInferenceProfile} is one summary, reduced to what the catalogue needs.
 * - {@link bedrockInferenceProfilePage} parses one page, and never throws: a payload that is
 *   not the documented shape answers an empty page, which the catalogue reads as "no profiles
 *   here" — the on-demand models stand, with a warning — rather than as a 500.
 * - {@link bedrockProfileScope} and {@link bedrockUnderlyingModelId} turn the id's geography
 *   prefix into the scope a reader sees and back into the foundation model id the profile
 *   wraps; {@link bedrockProfileDisplayName} names the entry.
 *
 * Nothing here reads a network or a credential, and nothing here decides what the catalogue
 * lists — that is `catalog.ts`, which is where the chat filter lives.
 */

/** One inference profile summary, as far as the catalogue reads it. */
export interface BedrockInferenceProfile {
  /**
   * The profile's id — `us.anthropic.claude-sonnet-4-5-20250929-v1:0` for a system-defined
   * cross-region profile, or a user's own id for an application profile.
   *
   * This is what a Converse request names (`modelId`), so it is the whole of the entry's
   * `<credential name>/<id>` model id.
   */
  readonly profileId: string
  /** AWS's display name for the profile, when it carried one. */
  readonly profileName?: string
  /**
   * The **underlying foundation model** the profile wraps, from `models[].modelArn`.
   *
   * A system-defined cross-region profile wraps exactly one foundation model, which is the
   * stable identity models.dev files metadata under — the profile id itself is
   * geography-scoped and, for an application profile, account-scoped. A profile whose summary
   * carries no usable `modelArn` is skipped by the parser: without the model it wraps there is
   * nothing to read a name, a window or a price from, and nothing to tell a text model from an
   * embeddings one.
   */
  readonly modelId: string
  /** `SYSTEM_DEFINED` or `APPLICATION`, as AWS spelled it, when it carried one. */
  readonly type?: string
}

/** One page of `ListInferenceProfiles`, as the catalogue consumes it. */
export interface BedrockInferenceProfilePage {
  /** The usable profiles this page carried; summaries without an id, a model or a live status are already gone. */
  readonly profiles: readonly BedrockInferenceProfile[]
  /** The cursor for the next page, or `null` when this was the last one. */
  readonly nextToken: string | null
}

/**
 * The `foundation-model/` marker a foundation-model ARN carries before the model id
 * (`arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-…`; the account segment beside
 * the region is empty for a foundation model).
 */
const FOUNDATION_MODEL_ARN_MARKER = 'foundation-model/'

/**
 * The geography prefixes AWS gives a system-defined cross-region profile, and the label this
 * catalogue shows for each: `us.anthropic.…` is a US profile, `global.…` one that routes
 * anywhere AWS serves the model.
 *
 * The prefixes are AWS's geography groups (`us`, `eu`, `apac`, `us-gov`) plus the single-region
 * groups it added later (`jp`, `au`, `ca`, `in`); a check of models.dev's Amazon Bedrock entry
 * at the time of writing finds all nine in use. The labels are ours and short — a picker shows
 * them in parentheses beside the model's name.
 */
const PROFILE_SCOPES: Readonly<Record<string, string>> = {
  us: 'US',
  eu: 'EU',
  apac: 'APAC',
  global: 'Global',
  'us-gov': 'US Gov',
  jp: 'JP',
  au: 'AU',
  ca: 'CA',
  in: 'IN',
}

/**
 * One page of AWS's `ListInferenceProfiles` answer, as the catalogue reads it.
 *
 * Three summaries are dropped, each for a reason that would otherwise be a broken entry:
 *
 * - **One without an `inferenceProfileId`** — the id is the whole of the model id this list
 *   produces, so there is nothing to offer.
 * - **One AWS has not marked `ACTIVE`.** A profile that is still being created, or one AWS
 *   retired, would fail the first message. An **absent** `status` is not read as "not active":
 *   AWS always sets it, and dropping a usable model over a field the parser could not see is
 *   the failure this issue is about — the same asymmetry {@link bedrockModels} in `catalog.ts`
 *   applies to a missing `inferenceTypesSupported`.
 * - **One whose `models[].modelArn` yields no foundation model id**, per
 *   {@link BedrockInferenceProfile.modelId}.
 *
 * `nextToken` is the page's non-empty token, or `null`: an absent or empty token is the end of
 * the list, exactly as AWS documents it.
 */
export function bedrockInferenceProfilePage(payload: unknown): BedrockInferenceProfilePage {
  const summaries = profileSummariesOf(payload)
  const profiles = summaries.flatMap((summary) => {
    const profile = parseProfile(summary)
    return profile === null ? [] : [profile]
  })
  return { profiles, nextToken: nextTokenOf(payload) }
}

/** The `inferenceProfileSummaries` array of a payload, or nothing when there is not one. */
function profileSummariesOf(payload: unknown): readonly unknown[] {
  if (typeof payload !== 'object' || payload === null) {
    return []
  }
  const value = (payload as Record<string, unknown>).inferenceProfileSummaries
  return Array.isArray(value) ? (value as readonly unknown[]) : []
}

/** The `nextToken` of a payload, when it is a non-empty string. */
function nextTokenOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const value = (payload as Record<string, unknown>).nextToken
  return typeof value === 'string' && value !== '' ? value : null
}

/** One summary, or `null` when it is not something the catalogue can offer. */
function parseProfile(summary: unknown): BedrockInferenceProfile | null {
  if (typeof summary !== 'object' || summary === null) {
    return null
  }
  const record = summary as Record<string, unknown>
  const profileId = record.inferenceProfileId
  if (typeof profileId !== 'string' || profileId === '') {
    return null
  }
  const status = record.status
  if (status !== undefined && status !== 'ACTIVE') {
    return null
  }
  const modelId = underlyingModelIdOf(record.models)
  if (modelId === null) {
    return null
  }
  const profileName = record.inferenceProfileName
  const type = record.type
  return {
    profileId,
    ...(typeof profileName === 'string' && profileName.trim() !== '' ? { profileName } : {}),
    modelId,
    ...(typeof type === 'string' && type !== '' ? { type } : {}),
  }
}

/** The foundation model id the first usable `models[].modelArn` names, or `null`. */
function underlyingModelIdOf(models: unknown): string | null {
  if (!Array.isArray(models)) {
    return null
  }
  for (const model of models) {
    if (typeof model !== 'object' || model === null) {
      continue
    }
    const arn = (model as Record<string, unknown>).modelArn
    if (typeof arn !== 'string') {
      continue
    }
    const modelId = bedrockFoundationModelId(arn)
    if (modelId !== null) {
      return modelId
    }
  }
  return null
}

/**
 * The foundation model id inside a `models[].modelArn` — everything after the
 * `foundation-model/` marker (`arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-…`
 * answers `anthropic.claude-…`).
 *
 * A string without the marker answers `null` rather than a guess: an ARN for the profile
 * itself (`…:inference-profile/us.anthropic.claude-…`) names no foundation model, and slicing
 * the last path segment off it would invent one.
 */
export function bedrockFoundationModelId(modelArn: string): string | null {
  const index = modelArn.indexOf(FOUNDATION_MODEL_ARN_MARKER)
  if (index === -1) {
    return null
  }
  const modelId = modelArn.slice(index + FOUNDATION_MODEL_ARN_MARKER.length)
  return modelId === '' ? null : modelId
}

/**
 * The scope a profile id names — `US`, `EU`, `APAC`, `Global`, `US Gov`, `JP`, `AU`, `CA` or
 * `IN` — or `null` when it carries no recognised geography prefix.
 *
 * Only AWS's system-defined geography prefixes are read ({@link PROFILE_SCOPES}). An
 * **application** profile's id is the user's own (`my-claude-profile`, or any string AWS
 * accepts), so it has no scope to show, and a prefix this module does not know is not one
 * either.
 */
export function bedrockProfileScope(profileId: string): string | null {
  const separator = profileId.indexOf('.')
  if (separator <= 0) {
    return null
  }
  return PROFILE_SCOPES[profileId.slice(0, separator)] ?? null
}

/**
 * The foundation model id a cross-region profile id wraps — the profile id with its geography
 * prefix removed (`us.anthropic.claude-sonnet-4-5-20250929-v1:0` →
 * `anthropic.claude-sonnet-4-5-20250929-v1:0`) — or `undefined` for an id with no recognised
 * scope.
 *
 * This is what lets the reasoning-effort resolver (`reasoning-support.ts`) answer for a profile
 * whose own id models.dev has not filed yet, by reading the metadata of the model it wraps.
 * `undefined` means "this is not a cross-region profile id", not "no model": only the
 * geography-prefixed ids are stripped, because stripping a prefix from an arbitrary id would
 * turn one model into another.
 */
export function bedrockUnderlyingModelId(profileId: string): string | undefined {
  if (bedrockProfileScope(profileId) === null) {
    return undefined
  }
  return profileId.slice(profileId.indexOf('.') + 1)
}

/**
 * How a profile reads in a picker: the underlying foundation model's name (from models.dev
 * where it has one, else the foundation model id) with the profile's scope in parentheses —
 * `Claude Sonnet 4.5 (US)` beside the on-demand `Claude Sonnet 4.5`, so a reader can tell the
 * two apart and see which geography a request routes through.
 *
 * An **application** profile has no scope to show, so it reads as the name the user gave it
 * (AWS's `inferenceProfileName`), else the underlying model's name, else the foundation model
 * id. Its id is a string the user chose, which is already the reader's own label for it.
 */
export function bedrockProfileDisplayName(
  profile: BedrockInferenceProfile,
  registryName?: string,
): string {
  if (bedrockProfileScope(profile.profileId) === null) {
    return profile.profileName ?? registryName ?? profile.modelId
  }
  const base = registryName ?? profile.modelId
  return `${base} (${bedrockProfileScope(profile.profileId)})`
}
