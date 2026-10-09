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
 * // extension: a user's stored preferences (epic #116, U1; theme: epic #201, X3).
 *
 * `default_model` is the `provider/model` a new chat starts with — the free-text model id
 * described above, validated for shape only — or `null` when the user has not set one (and
 * none was chosen automatically from their provider keys). `theme` is the web app's colour
 * scheme, stored beside it so the choice follows the user across browsers; it is written by
 * the settings screen, and the web app also caches it in `localStorage` so the first paint is
 * in the right theme. Anthropic has no equivalent: its API is account-scoped by the caller's
 * key, with no per-user settings.
 */
export const UserPreferencesSchema = z.object({
  default_model: z
    .string()
    .regex(DEFAULT_MODEL_PATTERN, { error: 'default_model must be a provider/model id' })
    .nullable(),
  theme: UserThemeSchema,
})

export type UserPreferences = z.infer<typeof UserPreferencesSchema>

/**
 * Response of `GET /v1/me/preferences`: the caller's preferences, unwrapped.
 *
 * Owner-only, like `GET /v1/me`: the route answers for the authenticated caller and nobody
 * else. A caller who has never saved any preferences gets `{ default_model: null, theme:
 * 'system' }` — the absence of a choice, not a 404.
 */
export const GetPreferencesResponseSchema = UserPreferencesSchema

export type GetPreferencesResponse = UserPreferences

/**
 * Body of `PUT /v1/me/preferences`: the fields to change, all of them optional. Response:
 * {@link GetPreferencesResponseSchema}.
 *
 * A write **merges**: a field the body carries is stored, a field it leaves out keeps its
 * stored value, and `default_model: null` clears the stored default. That is what keeps the
 * two settings from clearing each other — `{ default_model: 'openai/gpt-5-mini' }` from `oh`
 * leaves the theme alone, and `{ theme: 'dim' }` from the settings screen leaves the default
 * model alone — without an older client or a half-typed form having to read first. An empty
 * body is a no-op that answers what is stored.
 *
 * The default model's shape is validated (`provider/model` or `null`); whether the model
 * exists is not — the catalog answers that.
 */
export const PutPreferencesRequestSchema = z.object({
  default_model: z
    .string()
    .regex(DEFAULT_MODEL_PATTERN, { error: 'default_model must be a provider/model router id' })
    .nullable()
    .optional(),
  theme: UserThemeSchema.optional(),
})

export type PutPreferencesRequest = z.infer<typeof PutPreferencesRequestSchema>
