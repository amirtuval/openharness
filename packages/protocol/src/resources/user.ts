import { z } from 'zod'

import { TimestampSchema } from '../common'

/**
 * The `user` resource and the endpoints around it:
 *
 * - `GET /v1/me`
 * - `GET /v1/me/preferences`
 * - `PUT /v1/me/preferences`
 *
 * // extension: Anthropic's Managed Agents API has no user resource. Authentication itself is
 * also not part of this protocol: sign-in and the session/bearer credentials that prove who
 * is calling are Better Auth's own `/api/auth/*` surface (the authentication epic, #65). What
 * the API needs from all of that is an identity to hang ownership on, and this is it.
 */

/**
 * A user id.
 *
 * // extension: opaquely minted by Better Auth, not an openharness ULID — there is no
 * `user_` prefix and no time ordering to read out of it. It is what an `Agent`'s and a
 * `Session`'s `owner_id` holds.
 */
export const UserIdSchema = z.string().min(1)

export type UserId = z.infer<typeof UserIdSchema>

/**
 * The signed-in user, as `GET /v1/me` returns them.
 *
 * `name` and `image` are the profile fields the identity providers supply; both are absent
 * when the provider did not give one. `email` is the identity — a user *is* a verified email
 * address (epic #65, A3) — so it is always present and always verified by the provider that
 * proved it.
 */
export const UserSchema = z.object({
  id: UserIdSchema,
  email: z.email(),
  name: z.string().optional(),
  image: z.string().optional(),
  created_at: TimestampSchema,
})

export type User = z.infer<typeof UserSchema>

/**
 * Response of `GET /v1/me`: the signed-in user, unwrapped.
 *
 * Not a list envelope and not a resource wrapper — the route answers with the `user` object
 * itself. There is exactly one of it per caller, so there is nothing to paginate.
 */
export const GetMeResponseSchema = UserSchema

export type GetMeResponse = User

/**
 * // extension: the shape of a `default_model`: a model id, `provider/model`
 * (epic #116, U1).
 *
 * The first path segment names the provider; the rest is the model, so a provider's own id
 * may itself contain a slash. Whitespace and empty segments are refused. The id does not
 * have to be in the caller's catalog — a free-text id for a model the provider list has not
 * caught up with is allowed, exactly like an agent's `model.id`.
 */
export const DEFAULT_MODEL_PATTERN = /^[^\s/]+\/[^\s/]+(?:\/[^\s/]+)*$/

/**
 * // extension: the theme a user has chosen for the web app (epic #201, X3).
 *
 * `system` follows the operating system and is the default, so a caller that never saved a
 * theme gets the browser's own preference. `light`, `dim` and `dark` are explicit choices —
 * `dim` a soft dark palette, darker than light and easier on the eye than near-black.
 *
 * The preference is a *choice*, not a resolved value: a `system` user is not rewritten to
 * `light` or `dark` when their OS changes. There is no TUI equivalent: the terminal's own
 * theme is the TUI's theme (epic #201, X4).
 */
export const UserThemeSchema = z.enum(['system', 'light', 'dim', 'dark'])

export type UserTheme = z.infer<typeof UserThemeSchema>

/** The theme a user who has never chosen one gets, as {@link UserPreferencesSchema} holds it. */
export const DEFAULT_USER_THEME: UserTheme = 'system'

/**
 * // extension: "let the chat's own model write the summary" (epic #277, K3; C3, #282).
 *
 * A `summary_model` is this sentinel or a `provider/model` id, exactly as a mode's model is
 * `my-default-model` or an id (#253, M6). The sentinel is the default: compaction summarizes
 * with the chat model unless the reader names another one, and the engine reads it as "no
 * summary model" (`null` in `ContextCompactionConfig`).
 */
export const SUMMARY_MODEL_SAME_AS_CHAT = 'same-as-chat'

/**
 * // extension: which model writes a summary (epic #277, K3; C3, #282).
 *
 * {@link SUMMARY_MODEL_SAME_AS_CHAT}, or a model id of the same `provider/model` shape a
 * `default_model` has — free text, validated for shape only, because whether the model exists
 * is the catalog's to answer.
 */
export const SummaryModelSchema = z.union([
  z.literal(SUMMARY_MODEL_SAME_AS_CHAT),
  z.string().regex(DEFAULT_MODEL_PATTERN, { error: 'summary_model must be a provider/model id' }),
])

export type SummaryModel = z.infer<typeof SummaryModelSchema>

/**
 * // extension: the share of the chat model's budget a user may trigger compaction at
 * (epic #277, K2; C3, #282): 30% to 95%.
 *
 * Below the floor a chat would summarize constantly and forget what it was just told; at or
 * above the ceiling there is no room left for the trigger to fire before a provider refuses
 * the request. The engine's own default share (70%) is the server's setting, not a constant
 * here, so a user who has not chosen one follows it.
 */
export const COMPACTION_THRESHOLD_MIN = 0.3

/** The top of the compaction share's range (epic #277, K2; C3, #282). */
export const COMPACTION_THRESHOLD_MAX = 0.95

/**
 * // extension: how many passes a summary model may take before the chat model takes over
 * (epic #277, K5; C3, #282): 1 to 10.
 *
 * One is the floor — a limit of zero would refuse every summary — and ten is where the
 * control stops meaning anything: at the engine's half-the-budget slice, ten passes fold far
 * more history than any model's window holds, so a larger limit is "unlimited" with a longer
 * worst case. The default is the engine's own (3), reported in `defaults` when unset.
 */
export const SUMMARY_MAX_PASSES_MIN = 1

/** The top of the summary pass limit's range (epic #277, K5; C3, #282). */
export const SUMMARY_MAX_PASSES_MAX = 10

/**
 * // extension: a user's stored preferences (epic #116, U1; theme: epic #201, X3; compaction:
 * epic #277, C3, #282).
 *
 * `default_model` is the `provider/model` a new chat starts with — the free-text model id
 * described above, validated for shape only — or `null` when the user has not set one (and
 * none was chosen automatically from their provider keys). `theme` is the web app's colour
 * scheme, stored beside it so the choice follows the user across browsers; it is written by
 * the settings screen, and the web app also caches it in `localStorage` so the first paint is
 * in the right theme.
 *
 * The three compaction fields are the epic #277 controls. `compaction_threshold` is the share
 * of the chat model's budget at which older history is summarized, within
 * {@link COMPACTION_THRESHOLD_MIN}..{@link COMPACTION_THRESHOLD_MAX}, or `null` for the
 * server's own setting. `summary_model` is the model that writes summaries
 * ({@link SummaryModelSchema}), defaulting to {@link SUMMARY_MODEL_SAME_AS_CHAT}. And
 * `summary_max_passes` bounds how many passes that model may take before the chat model takes
 * over, or `null` for the engine's default. Anthropic has no equivalent: its API is
 * account-scoped by the caller's key, with no per-user settings.
 */
export const UserPreferencesSchema = z.object({
  default_model: z
    .string()
    .regex(DEFAULT_MODEL_PATTERN, { error: 'default_model must be a provider/model id' })
    .nullable(),
  theme: UserThemeSchema,
  compaction_threshold: z
    .number()
    .min(COMPACTION_THRESHOLD_MIN)
    .max(COMPACTION_THRESHOLD_MAX)
    .nullable(),
  summary_model: SummaryModelSchema,
  summary_max_passes: z
    .number()
    .int()
    .min(SUMMARY_MAX_PASSES_MIN)
    .max(SUMMARY_MAX_PASSES_MAX)
    .nullable(),
})

export type UserPreferences = z.infer<typeof UserPreferencesSchema>

/**
 * The values a preference of `null` falls back to, so a client can show the effective setting
 * (epic #277, C3; #282).
 *
 * `compaction_threshold` is the server's own share (`OPENHARNESS_COMPACTION_THRESHOLD`), which
 * a deployment may set differently, so it has to travel with the response rather than be a
 * constant a client could know. `summary_max_passes` is the engine's default, reported here for
 * the same reason: the client shows "3 (default)" without hard-coding the number.
 */
export const PreferencesDefaultsSchema = z.object({
  compaction_threshold: z.number(),
  summary_max_passes: z.number().int(),
})

export type PreferencesDefaults = z.infer<typeof PreferencesDefaultsSchema>

/**
 * Response of `GET /v1/me/preferences`: the caller's preferences, unwrapped, plus the defaults
 * their `null`s mean.
 *
 * Owner-only, like `GET /v1/me`: the route answers for the authenticated caller and nobody
 * else. A caller who has never saved any preferences gets the defaults and no choices — the
 * absence of a choice, not a 404. `PUT` answers the same shape, so a client that has just
 * written a preference reads the effective defaults back in one round trip.
 */
export const GetPreferencesResponseSchema = UserPreferencesSchema.extend({
  defaults: PreferencesDefaultsSchema,
})

export type GetPreferencesResponse = z.infer<typeof GetPreferencesResponseSchema>

/**
 * Body of `PUT /v1/me/preferences`: the fields to change, all of them optional. Response:
 * {@link GetPreferencesResponseSchema}.
 *
 * A write **merges**: a field the body carries is stored, a field it leaves out keeps its
 * stored value, and `default_model: null` clears the stored default. That is what keeps the
 * settings from clearing each other — `{ default_model: 'openai/gpt-5-mini' }` from `oh` leaves
 * the theme alone, and `{ theme: 'dim' }` from the settings screen leaves the default model
 * alone — without an older client or a half-typed form having to read first. An empty body is a
 * no-op that answers what is stored.
 *
 * `compaction_threshold: null` and `summary_max_passes: null` mean "follow the default" the
 * response's `defaults` reports, the way `default_model: null` means "no choice".
 *
 * The model ids and the numbers are shape-checked (`provider/model`, the threshold's range, the
 * pass limit's range); whether a model exists is not — the catalog answers that.
 */
export const PutPreferencesRequestSchema = z.object({
  default_model: z
    .string()
    .regex(DEFAULT_MODEL_PATTERN, { error: 'default_model must be a provider/model router id' })
    .nullable()
    .optional(),
  theme: UserThemeSchema.optional(),
  compaction_threshold: z
    .number()
    .min(COMPACTION_THRESHOLD_MIN)
    .max(COMPACTION_THRESHOLD_MAX)
    .nullable()
    .optional(),
  summary_model: SummaryModelSchema.optional(),
  summary_max_passes: z
    .number()
    .int()
    .min(SUMMARY_MAX_PASSES_MIN)
    .max(SUMMARY_MAX_PASSES_MAX)
    .nullable()
    .optional(),
})

export type PutPreferencesRequest = z.infer<typeof PutPreferencesRequestSchema>
