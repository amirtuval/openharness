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
 * // extension: the shape of a `default_model`: a Mastra router string, `provider/model`
 * (epic #116, U1).
 *
 * The first path segment names the provider; the rest is the model, so a provider's own id
 * may itself contain a slash. Whitespace and empty segments are refused. The id does not
 * have to be in the caller's catalog — a free-text id for a model the provider list has not
 * caught up with is allowed, exactly like an agent's `model.id`.
 */
export const DEFAULT_MODEL_PATTERN = /^[^\s/]+\/[^\s/]+(?:\/[^\s/]+)*$/

/**
 * // extension: a user's stored preferences (epic #116, U1).
 *
 * `default_model` is the `provider/model` a new chat starts with — the free-text router id
 * described above, validated for shape only — or `null` when the user has not set one (and
 * none was chosen automatically from their provider keys). Anthropic has no equivalent: its
 * API is account-scoped by the caller's key, with no per-user settings.
 */
export const UserPreferencesSchema = z.object({
  default_model: z
    .string()
    .regex(DEFAULT_MODEL_PATTERN, { error: 'default_model must be a provider/model router id' })
    .nullable(),
})

export type UserPreferences = z.infer<typeof UserPreferencesSchema>

/**
 * Response of `GET /v1/me/preferences`: the caller's preferences, unwrapped.
 *
 * Owner-only, like `GET /v1/me`: the route answers for the authenticated caller and nobody
 * else. A caller who has never saved any preferences gets `{ default_model: null }` — the
 * absence of a choice, not a 404.
 */
export const GetPreferencesResponseSchema = UserPreferencesSchema

export type GetPreferencesResponse = UserPreferences

/**
 * Body of `PUT /v1/me/preferences`: the caller's preferences, written whole. Response:
 * {@link GetPreferencesResponseSchema}.
 *
 * `default_model` is required and `null` clears the stored default; there is no partial
 * update, so a caller always sets the complete value it wants. The shape is validated
 * (`provider/model` or `null`); whether the model exists is not — the catalog answers that.
 */
export const PutPreferencesRequestSchema = UserPreferencesSchema

export type PutPreferencesRequest = UserPreferences
