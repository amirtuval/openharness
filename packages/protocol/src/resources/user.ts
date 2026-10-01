import { z } from 'zod'

import { TimestampSchema } from '../common'

/**
 * The `user` resource, and the one endpoint that returns it:
 *
 * - `GET /v1/me`
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
