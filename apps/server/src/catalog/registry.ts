/**
 * The provider registry: what `@mastra/core` bundles (epic #92, C2; issue #90), behind a seam.
 *
 * The catalogue reads it for two things: to join metadata onto the models a provider listed
 * (`name`, context window, max output, chat capability — the fields the provider's own list
 * may not carry), and to serve a provider's chat models when its own list failed or does not
 * exist (C3's `fallback`). Nothing here touches the network: the registry is the data bundled
 * in the installed package, read through the API that version exports.
 *
 * ## What the installed version carries
 *
 * `@mastra/core@1.71.0` exports the registry as data (`PROVIDER_REGISTRY`, `getProviderConfig`,
 * `PROVIDER_MODELS`): per provider, its display name, base URL, API-key environment variable
 * and **model ids**. It carries no per-model metadata — no display names, context windows,
 * output limits or chat flag (the models.dev payload it is generated from has them, but the
 * package reduces it to ids and a handful of capability lists). So in this version the join
 * contributes the chat-*independent* facts and the id list, and the fields it cannot fill stay
 * `null` on the wire (the protocol allows that) unless the provider's own list carried them —
 * Gemini and OpenRouter do. Metadata a richer registry version carries is read here when it
 * appears; the extraction below is written to make that a one-line change.
 *
 * The registry is deliberately read through `getProviderConfig` rather than the raw exported
 * object: the accessor is the package's documented entry point, it answers `undefined` for an
 * unknown provider (the raw object would answer a type error at author time and `undefined` at
 * run time), and it is what a future version would keep working.
 */

import { PROVIDER_REGISTRY, getProviderConfig } from '@mastra/core/llm'

/** One model the registry knows, as much of it as the registry carries. */
export interface RegistryModel {
  /** The raw model id, without the `provider/` prefix. */
  readonly id: string
  /** The registry's display name for it, when the registry has one. */
  readonly name?: string
  /** The context window in tokens, when the registry has one. */
  readonly contextWindow?: number
  /** The largest output in tokens, when the registry has one. */
  readonly maxOutput?: number
  /** The registry's chat verdict, when the registry classifies models at all. */
  readonly chat?: boolean
}

/**
 * Where the catalogue's metadata comes from. One method, because the two uses — joining
 * metadata onto a provider-listed model, and listing a provider's chat models on a fallback —
 * are the same read at different granularity.
 */
export interface ModelRegistry {
  /**
   * Every model the registry knows for a provider, or an empty list when it knows none.
   *
   * A read, never a fetch: an implementation must not reach the network (C2).
   */
  models(provider: string): readonly RegistryModel[]
}

/** A registry that knows nothing: what a host (or a test) gets when it wants no data at all. */
export const emptyRegistry: ModelRegistry = {
  models: () => [],
}

/**
 * Router provider names whose registry entry is spelled differently. models.dev — and so the
 * bundled registry generated from it — keys these two by their product names, while the
 * router (and this server's `VALIDATABLE_PROVIDERS`) use the short spellings; without the
 * mapping, a `fireworks` or `together` credential would fall back to an empty model list.
 */
const REGISTRY_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  fireworks: 'fireworks-ai',
  together: 'togetherai',
}

/** The registry model list for a provider, resolved through the alias map. */
function rawModels(provider: string): readonly string[] | undefined {
  const name = REGISTRY_PROVIDER_ALIASES[provider] ?? provider
  const config =
    getProviderConfig(name) ?? PROVIDER_REGISTRY[name as keyof typeof PROVIDER_REGISTRY]
  return config?.models
}

/**
 * The `ModelRegistry` over the installed `@mastra/core`'s bundled data.
 *
 * Sync and network-free: the data is a module-level constant in the package. The metadata the
 * installed version does not carry stays `undefined`, which the catalogue reads as "the
 * registry says nothing" — the name falls back to the provider's or the model id, the limits
 * stay `null`, and the chat filter's heuristic decides.
 */
export function createMastraRegistry(): ModelRegistry {
  return {
    models(provider) {
      const models = rawModels(provider)
      if (models === undefined) {
        return []
      }
      // This version's entries are ids alone; nothing to read out of them beyond the id. A
      // registry version that attaches per-model data is handled where `RegistryModel` gains
      // the fields: read them here, keep the rest unchanged.
      return models.map((id) => ({ id }))
    },
  }
}
