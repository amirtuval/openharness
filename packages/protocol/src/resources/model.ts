import { z } from 'zod'

import { TimestampSchema } from '../common'

/**
 * The model catalog — `GET /v1/models` (epic #92, wave 1) — and the entries it lists: the
 * chat models the caller's own provider credentials can use.
 *
 * ```
 * GET /v1/models   -> { data: model entry[], providers: provider status[] }
 * ```
 *
 * Only providers the caller has a credential for appear (C5). For each of them the server
 * calls the provider's own list-models endpoint with that credential, joined with the Mastra
 * registry for display names, context windows and output limits (C1, C2), and `providers`
 * reports how each list was obtained: `ok` for the provider's own answer, `fallback` when the
 * call failed or timed out (5 s) — or the provider has no list endpoint — and the registry's
 * chat models stood in (C3). The server caches the answer in memory per user and provider for
 * an hour (C4); `refresh=true` bypasses the cache.
 *
 * // extension: the shape is openharness's own, and so is the endpoint's scope. Anthropic's
 * `GET /v1/models` lists Anthropic's models; this one lists the models the caller's keys can
 * use, merges each provider's own list with the registry, and reports a per-provider status,
 * so a registry-only fallback is a visible state rather than a silent one.
 */

/**
 * One chat model the caller can use.
 *
 * `id` is the Mastra router string an agent's `model.id` takes, `provider/model`, and
 * `provider` is its prefix. Non-chat models (embeddings, image, TTS, …) are never listed.
 */
export const ModelEntrySchema = z.object({
  /** The router id, e.g. `openai/gpt-4.1-mini`. */
  id: z.string().min(1),
  /** The provider that serves it: the prefix of `id`, e.g. `openai`. */
  provider: z.string().min(1),
  /** Display name: the registry's, or the provider's, or `id` when neither has one. */
  name: z.string().min(1),
  /** The context window in tokens, when it is known; `null` when it is not (C6). */
  context_window: z.number().int().nonnegative().nullable(),
  /** The largest output the model accepts, when it is known; `null` when it is not. */
  max_output_tokens: z.number().int().nonnegative().nullable(),
  /**
   * // extension: where this entry's listing came from — `provider` when the provider's own
   * list carried it, `registry` when it came from the registry alone (C3).
   */
  source: z.enum(['provider', 'registry']),
})

export type ModelEntry = z.infer<typeof ModelEntrySchema>

/**
 * How one provider's catalog was obtained, one entry per provider the caller has a credential
 * for (C5).
 *
 * `ok` — the provider's list endpoint answered within its 5-second budget and its models are
 * in `data` with `source: 'provider'`. `fallback` — the call failed, timed out, or the
 * provider has no known list endpoint, and its chat models came from the registry instead
 * (C3).
 */
export const ProviderCatalogStatusSchema = z.object({
  /** The Mastra router provider name, e.g. `anthropic`, `openai`. */
  provider: z.string().min(1),
  /** `ok` or `fallback`; see the schema's description. */
  status: z.enum(['ok', 'fallback']),
  /** When the provider's list was fetched. `null` on a fallback: nothing was fetched. */
  fetched_at: TimestampSchema.nullable(),
  /** Why it fell back — never any part of a credential (C3); `null` when it did not. */
  message: z.string().nullable(),
})

export type ProviderCatalogStatus = z.infer<typeof ProviderCatalogStatusSchema>

/**
 * Response of `GET /v1/models`: the caller's chat models and one status per provider.
 *
 * No pagination envelope: the response is bounded by the caller's own credentials and each
 * provider's model list, and the agent form needs every provider at once. `data` is sorted by
 * provider, then by name; both arrays are empty, never absent, for an account with no
 * credentials at all.
 */
export const ListModelsResponseSchema = z.object({
  /** The chat models, sorted by `provider`, then `name`. */
  data: z.array(ModelEntrySchema),
  /** One status per provider the caller has a credential for. */
  providers: z.array(ProviderCatalogStatusSchema),
})

export type ListModelsResponse = z.infer<typeof ListModelsResponseSchema>

/**
 * Query parameters of `GET /v1/models`.
 */
export const ListModelsQuerySchema = z.object({
  /**
   * Bypass the per-user, per-provider cache and re-fetch from the providers (C4).
   *
   * The wire spelling is `refresh=true`; a query string arrives as text, so the schema accepts
   * `'true'` / `'false'` as well as a real boolean. Refreshing is rate-limited to once a
   * minute per user: a request inside that window is answered 429 `rate_limit_error` instead
   * of refreshing.
   */
  refresh: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .optional(),
})

export type ListModelsQuery = z.infer<typeof ListModelsQuerySchema>
