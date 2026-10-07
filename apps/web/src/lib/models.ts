import type { ModelEntry, ProviderCatalogStatus } from '@openharness/protocol'

/**
 * The model catalog, as the app reads it: helpers over the `ModelEntry[]` that
 * `client.models.list()` hands back (epic #92, wave 1).
 *
 * The web app no longer hardcodes model suggestions (the old `MODEL_SUGGESTIONS` list is
 * gone, #91): the catalog is whatever the caller's own keys can use, and the only model list
 * the UI offers is that one — plus the picker's free-text "Other model ID…" escape hatch,
 * because the router understands models the catalog may not know yet.
 */

/** A catalog lookup: the display name of a model id, or `null` when the catalog does not know it. */
export type ModelNameLookup = (modelId: string) => string | null

/** One provider's models, with that provider's catalog status when it reported one. */
export interface ProviderGroup {
  /** The Mastra router provider name, e.g. `openai`. */
  readonly provider: string
  /** The provider's chat models, in catalog order (the server sorts by provider, then name). */
  readonly models: readonly ModelEntry[]
  /** How the provider's list was obtained; `null` when the response had no status for it. */
  readonly status: ProviderCatalogStatus | null
}

/** A lookup over a catalog, built once per list so the label code does not scan per row. */
export function modelNameLookup(models: readonly ModelEntry[]): ModelNameLookup {
  const byId = new Map(models.map((entry) => [entry.id, entry.name]))
  return (modelId) => byId.get(modelId) ?? null
}

/**
 * The provider half of a `provider/model` id, or `null` when the id has no slash.
 *
 * The same split the server makes when it looks a model's credential up (`providerOf`), which
 * is why the missing-key message can name a provider this app then offers to collect a key for
 * (#209).
 */
export function providerOf(modelId: string | null): string | null {
  if (modelId === null) {
    return null
  }
  const slash = modelId.indexOf('/')
  return slash <= 0 ? null : modelId.slice(0, slash)
}

/**
 * The catalog grouped by provider, in the order the server sent it (provider, then name).
 *
 * Only what `data` names appears: the server lists models for providers the caller has a key
 * for and nothing else (C5), so grouping is all the picker has to do.
 */
export function groupModelsByProvider(
  models: readonly ModelEntry[],
  providers: readonly ProviderCatalogStatus[],
): readonly ProviderGroup[] {
  const statusByProvider = new Map(providers.map((status) => [status.provider, status]))
  const groups = new Map<string, ModelEntry[]>()
  for (const entry of models) {
    const group = groups.get(entry.provider)
    if (group === undefined) {
      groups.set(entry.provider, [entry])
    } else {
      group.push(entry)
    }
  }
  return [...groups].map(([provider, entries]) => ({
    provider,
    models: entries,
    status: statusByProvider.get(provider) ?? null,
  }))
}
