import { providerOf } from '@openharness/brain'
import type { UserId } from '@openharness/protocol'
import type { SessionStore } from '@openharness/session'

import type { ModelCatalog } from './catalog/catalog'
import { isChatModel } from './catalog/filter'
import type { ModelRegistry } from './catalog/registry'
import type { Logger } from './types'

/**
 * The automatic default model (epic #116, U4): the model a new chat starts with, chosen for a
 * user the moment they save their first provider key — so "New chat" can open immediately.
 *
 * The pick, in order:
 *
 * 1. **The curated recommendation table** below: the first entry for one of the user's
 *    providers that their live catalog (`GET /v1/models` logic) actually lists;
 * 2. **the catalogue fallback**: the newest chat model the user's live catalog lists that is
 *    neither expensive nor reasoning-only (paid for by name, since the installed registry
 *    carries no price or capability flags — see `catalog/registry.ts`).
 *
 * Both steps read the live catalog, so the pick is always a model the credential can run: a
 * named credential serves its own deployments, and the registry's list for the provider id
 * is a catalogue the credential does not have (epic #245, D1).
 *
 * When a saved credential is deleted, the default it carried is handled the same way:
 * re-picked from the providers that remain, or cleared when none do.
 *
 * ## What is never overridden
 *
 * A default the user chose themselves (`PUT /v1/me/preferences`) stays until they change it
 * while its provider still has a key: saving another credential never touches it. The
 * picker remembers which users it picked for — in this process only, the same trade-off the
 * catalogue cache makes (C4), because the protocol's `UserPreferences` has no field for it —
 * so the one place the distinction matters is a delete: an **automatic** default is re-picked
 * from the remaining providers (maintaining a value the server owns), while an **explicit**
 * one is only cleared (the user's chosen model cannot run any more, and silently substituting
 * a different model for a choice they made is not this server's to do).
 *
 * ## Failures never fail the credential write
 *
 * Every entry point swallows what it cannot do and logs it: the credential is already stored,
 * and a default that could not be chosen is a settings screen away from being set by hand.
 */

/**
 * The curated everyday-model recommendation per provider, most preferred first (epic #116,
 * U4). **Update this list when better everyday models ship.**
 *
 * The aim is the capable-but-affordable everyday tier — the "mini" / "flash" / "fast" class —
 * never the flagship and never the nano tier, because this is the model a brand-new chat runs
 * before anyone has chosen one. Ids are the provider's own; the full model id is the provider
 * plus this id (`anthropic/claude-haiku-4-5`). The fallback below covers providers with no
 * entry here (and a provider whose entries are all missing from the live catalog).
 */
export const RECOMMENDED_DEFAULT_MODELS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['claude-haiku-4-5', 'claude-sonnet-4-5'],
  openai: ['gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini'],
  google: ['gemini-2.5-flash', 'gemini-2.0-flash'],
  // OpenRouter ids carry the upstream provider, so a recommendation is a full `vendor/model`.
  openrouter: ['google/gemini-2.5-flash', 'openai/gpt-4.1-mini', 'anthropic/claude-haiku-4-5'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  deepseek: ['deepseek-chat'],
  mistral: ['mistral-small-latest'],
  xai: ['grok-4-fast', 'grok-3-mini'],
  cerebras: ['llama-3.3-70b'],
}

/**
 * The flagship-priced tiers: capable, but not what an everyday default should cost. Word-like
 * patterns, like the catalogue's name filter, so `pro` matches `gemini-2.5-pro` and not
 * `productivity`.
 */
const EXPENSIVE_MODEL_PATTERNS: readonly RegExp[] = [
  /(^|[-_./])(pro|opus|max|ultra|large|flagship)([-_./]|$)/i, // gpt-5-pro, claude-opus-4-1
]

/**
 * The reasoning-first models: the everyday default is a chat model, not the thinking tier.
 * `o1`/`o3`/`o4` are OpenAI's reasoning families (minis included), `r1` is DeepSeek's.
 */
const REASONING_MODEL_PATTERNS: readonly RegExp[] = [
  /(^|[-_./])(o1|o3|o4|r1)([-_./]|$)/i, // o3-mini, o4-mini, deepseek-r1
  /(^|[-_./])(reasoning|thinking)([-_./]|$)/i, // -reasoning, -thinking variants
]

/** Whether an id names the expensive tier rather than the everyday one. */
export function isExpensiveModel(rawId: string): boolean {
  return EXPENSIVE_MODEL_PATTERNS.some((pattern) => pattern.test(rawId))
}

/** Whether an id names a reasoning-first (or reasoning-only) model. */
export function isReasoningModel(rawId: string): boolean {
  return REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(rawId))
}

/**
 * The registry fallback's candidate rule: a chat model that is neither expensive nor
 * reasoning-only (epic #116, U4). "Flagged" is by name — the installed registry carries no
 * price or capability data beyond the id (see `catalog/registry.ts`) — and the class check is
 * the catalogue's own, so the fallback can never offer a model `GET /v1/models` would hide.
 */
export function isEverydayModel(rawId: string, registryChat: boolean | undefined): boolean {
  return (
    isChatModel({ rawId, registryChat }) && !isExpensiveModel(rawId) && !isReasoningModel(rawId)
  )
}

/**
 * The newest of some model ids, by the version numbers in the id.
 *
 * The registry carries no dates, so `gpt-5-mini` beating `gpt-4.1-mini` is the newest signal
 * it has: the first numeric group of the id's last segment (`gpt-4.1-mini` → `[4, 1]`,
 * `claude-haiku-4-5` → `[4]`) compared numerically. An id with no version ranks below every
 * versioned one; ties break on the id, so the answer is deterministic. `null` for no ids.
 */
export function newestModelId(ids: readonly string[]): string | null {
  const sorted = [...ids].sort((a, b) => {
    const byVersion = compareVersions(versionOf(b), versionOf(a))
    if (byVersion !== 0) {
      return byVersion
    }
    return a < b ? 1 : a > b ? -1 : 0
  })
  return sorted[0] ?? null
}

/** What {@link DefaultModelPicker} is built from. */
export interface DefaultModelPickerOptions {
  /** Where the stored preferences live (the `session` package's preferences contract). */
  readonly store: Pick<SessionStore, 'getPreferences' | 'putPreferences'>
  /** The user's live catalog: which providers have keys, and which models they list (C1–C5). */
  readonly catalog: Pick<ModelCatalog, 'list'>
  /**
   * How the fallback classifies a catalogue id as chat where the snapshot knows it (C2);
   * `emptyRegistry` when a host has none, and the name filter decides as it does elsewhere.
   */
  readonly registry: ModelRegistry
  /** Where a pick that could not be made is reported. Never thrown. */
  readonly logger?: Logger
}

/**
 * The automatic default: who the server has picked for, and what it picks next.
 *
 * One instance lives per app (`createApp` builds it), which is also the lifetime of the
 * "was this default the server's?" record — see the module comment for why that is in-process
 * and what it costs.
 */
export class DefaultModelPicker {
  readonly #store: DefaultModelPickerOptions['store']

  readonly #catalog: DefaultModelPickerOptions['catalog']

  readonly #registry: ModelRegistry

  readonly #logger: Logger | undefined

  /** The users whose stored default the server picked itself, not the user (U4). */
  readonly #automatic = new Set<UserId>()

  constructor(options: DefaultModelPickerOptions) {
    this.#store = options.store
    this.#catalog = options.catalog
    this.#registry = options.registry
    this.#logger = options.logger
  }

  /** Whether the default last stored for this user was the server's own pick. */
  isAutomatic(userId: UserId): boolean {
    return this.#automatic.has(userId)
  }

  /**
   * A credential was saved: pick a default when the user has none (U4), from the provider
   * they just configured first.
   *
   * A default that exists is left exactly as it is — the user's own choice while its
   * provider still has a key, and an automatic pick whose provider still has one too.
   */
  async onCredentialAdded(userId: UserId, provider: string): Promise<void> {
    await this.#guarded(async () => {
      const preferences = await this.#store.getPreferences(userId)
      if (preferences.default_model !== null) {
        return
      }
      const picked = await this.#pick(userId, provider)
      if (picked === null) {
        return
      }
      // Every other field is carried through: the store writes preferences whole, and the
      // server's own pick must not clear a choice the user made — the theme (epic #201, X3),
      // or any of the compaction controls (epic #277, C3; #282).
      await this.#store.putPreferences(userId, { ...preferences, default_model: picked })
      this.#automatic.add(userId)
    })
  }

  /**
   * A credential was deleted: handle a default whose provider just lost its last key (U4).
   *
   * An automatic default is re-picked from the providers that remain (and cleared when none
   * does); an explicit one is cleared — see the module comment. A default whose provider
   * still has a key is untouched, whatever kind it is.
   */
  async onCredentialRemoved(userId: UserId, provider: string): Promise<void> {
    await this.#guarded(async () => {
      const preferences = await this.#store.getPreferences(userId)
      const current = preferences.default_model
      if (current === null || providerOf(current) !== provider) {
        return
      }
      const automatic = this.#automatic.delete(userId)
      if (!automatic) {
        // The user's own choice: without its provider's key the model cannot run, and
        // substituting another one for it would be overriding the choice that was made.
        await this.#store.putPreferences(userId, { ...preferences, default_model: null })
        return
      }
      const picked = await this.#pick(userId)
      await this.#store.putPreferences(userId, { ...preferences, default_model: picked })
      if (picked !== null) {
        this.#automatic.add(userId)
      }
    })
  }

  /**
   * The user wrote their preferences (`PUT /v1/me/preferences`): whatever is stored is their
   * choice now, so no delete re-picks it from under them.
   */
  markExplicit(userId: UserId): void {
    this.#automatic.delete(userId)
  }

  /**
   * Pick a default for a user: the recommendation table against their live catalog first,
   * the newest everyday model the catalog lists second (U4). `preferred` is tried before the
   * other providers — the provider a credential was just saved for.
   */
  async #pick(userId: UserId, preferred?: string): Promise<string | null> {
    const listed = await this.#catalog.list(userId)
    const providers = listed.providers.map((status) => status.provider)
    const order =
      preferred === undefined
        ? providers
        : [preferred, ...providers.filter((provider) => provider !== preferred)]
    const live = new Set(listed.data.map((entry) => entry.id))
    for (const provider of order) {
      for (const model of RECOMMENDED_DEFAULT_MODELS[provider] ?? []) {
        if (live.has(`${provider}/${model}`)) {
          return `${provider}/${model}`
        }
      }
    }
    // The fallback ranks what the user's **catalogue** lists, never the registry's own list for
    // the provider id. A named credential's models are the deployments (or models) it serves —
    // `azure/gpt-4o` — while the registry files models.dev's catalogue for the *type* under the
    // credential's default name (`azure`), so ranking that list would offer a model the
    // credential cannot run (epic #245, D1). The registry still classifies an id as chat where
    // it knows, exactly as the catalogue's own join does.
    const registryChat = new Map<string, boolean | undefined>()
    for (const provider of order) {
      for (const model of this.#registry.models(provider)) {
        registryChat.set(`${provider}/${model.id}`, model.chat)
      }
    }
    return newestModelId(
      order.flatMap((provider) =>
        listed.data
          .filter((entry) => entry.provider === provider)
          .filter((entry) =>
            isEverydayModel(entry.id.slice(provider.length + 1), registryChat.get(entry.id)),
          )
          .map((entry) => entry.id),
      ),
    )
  }

  /** Run a pick, and never let it fail the credential write that triggered it. */
  async #guarded(work: () => Promise<void>): Promise<void> {
    try {
      await work()
    } catch (error) {
      this.#logger?.warn('choosing an automatic default model failed', error)
    }
  }
}

/** The version numbers an id starts with, as a comparable tuple; `[]` for none. */
function versionOf(modelId: string): number[] {
  const tail = modelId.slice(modelId.lastIndexOf('/') + 1)
  const match = /\d+(?:\.\d+)*/.exec(tail)
  return match === null ? [] : match[0].split('.').map(Number)
}

/** Compare version tuples numerically; a missing version ranks below every real one. */
function compareVersions(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (left !== right) {
      return left - right
    }
  }
  return 0
}
