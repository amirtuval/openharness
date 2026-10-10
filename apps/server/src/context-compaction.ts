import type { ContextCompactionConfig, ContextCompactionResolver } from '@openharness/brain'
import { SUMMARY_MODEL_SAME_AS_CHAT } from '@openharness/protocol'
import type { SessionStore } from '@openharness/session'

/**
 * The compaction a request runs with, resolved per session owner (epic #277, C3; issue #282).
 *
 * The engine's three controls — the share of the chat model's budget that triggers a summary
 * (K2), the model that writes it (K3) and the passes it may take before the chat model takes
 * over (K5) — are per-user preferences, stored beside `default_model` and `theme` on the
 * `user_preferences` row (`@openharness/session`). The brain asks for them per request, at the
 * boundary where it has just read the session and so knows its `owner_id` — the same seam the
 * mode resolver uses (#245, M6) — which is what makes a settings change apply from the next
 * request on and keeps one user's choices out of another's chat.
 *
 * The store read is one per model request, which is the price of resolving here rather than
 * once per deployment. A preference a user never set is `null`, and each `null` falls back the
 * way the protocol documents: the threshold to the **server's** `OPENHARNESS_COMPACTION_THRESHOLD`
 * (a deployment's value, so it cannot be a constant a client knows), the pass limit to the
 * engine's own default (left out of the answer, which `resolveContextCompaction` fills in), and
 * the summary model to the chat's (`null` in the engine's vocabulary, spelled `same-as-chat` on
 * the wire).
 */

/** What {@link createContextCompactionResolver} needs to answer for one owner. */
export interface ContextCompactionDeps {
  /** The store the per-user preferences live in. */
  readonly store: SessionStore
  /**
   * The server's own trigger share, `OPENHARNESS_COMPACTION_THRESHOLD` — what a user who has
   * not chosen one gets, and what the preferences response reports as the default.
   */
  readonly threshold: number
  /** The per-model history budget, the same resolver the context strategy trims with (#246). */
  readonly tokenBudgetFor: (modelId: string) => number | undefined
  /**
   * The per-model output ceiling the summary-size cap reads (K5), or omitted when the host has
   * no registry to answer from — the cap then has one bound fewer.
   */
  readonly maxOutputFor?: (modelId: string) => number | undefined
}

/**
 * Build the resolver `runTurn` asks once per request.
 *
 * @param deps the store, the server's threshold and the registry-derived resolvers
 */
export function createContextCompactionResolver(
  deps: ContextCompactionDeps,
): ContextCompactionResolver {
  return async (ownerId) => {
    const preferences = await deps.store.getPreferences(ownerId)
    const config: ContextCompactionConfig = {
      // The stored share, or the server's own — never the engine's 0.7, which a deployment may
      // have changed.
      threshold: preferences.compaction_threshold ?? deps.threshold,
      // A sentinel on the wire, `null` in the engine's vocabulary.
      summaryModel:
        preferences.summary_model === SUMMARY_MODEL_SAME_AS_CHAT ? null : preferences.summary_model,
      tokenBudgetFor: deps.tokenBudgetFor,
      ...(deps.maxOutputFor === undefined ? {} : { maxOutputFor: deps.maxOutputFor }),
      // A `null` pass limit is left out, so the engine's own `DEFAULT_MAX_SUMMARY_PASSES`
      // applies in the one place that defines it.
      ...(preferences.summary_max_passes === null
        ? {}
        : { maxPasses: preferences.summary_max_passes }),
    }
    return config
  }
}
