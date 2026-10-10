import { z } from 'zod'

import { TimestampSchema } from '../common'
import { ModeIdSchema } from '../ids'
import { ReasoningEffortSchema } from '../reasoning'
import { DEFAULT_MODEL_PATTERN, UserIdSchema } from './user'

/**
 * The `mode` resource and the endpoints that manage it:
 *
 * - `POST   /v1/me/modes`
 * - `GET    /v1/me/modes`
 * - `GET    /v1/me/modes/{mode_id}`
 * - `POST   /v1/me/modes/{mode_id}` (update)
 * - `DELETE /v1/me/modes/{mode_id}`
 *
 * // extension: Anthropic's Managed Agents API has no per-user presets — a session there runs
 * one agent, fixed at creation. A mode is a named preset a user saves once (`smart`, `fast`,
 * `deep`) and picks instead of a raw `provider/model`: it bundles a model, a reasoning effort
 * and a system-prompt addition behind a stable name. A chat that starts from a mode follows
 * it live — the next request uses the mode as it is now — which is what lets a user retune a
 * mode without touching every chat that runs it. This is the first step of the modes design
 * (epic #245, decision M6); a tool set is deliberately not part of it yet.
 *
 * Modes are per user and owner-scoped like every other resource (epic #65, A4): a mode is
 * listed only to its owner and answers 404 to anyone else.
 */

/** Longest mode name the API accepts. */
export const MODE_NAME_MAX_LENGTH = 64

/** How many modes one user may have. */
export const MAX_MODES_PER_USER = 20

/**
 * The value a mode's `model` takes when it should follow the user's default model.
 *
 * It is deliberately not `provider/model`-shaped (`DEFAULT_MODEL_PATTERN` requires a slash),
 * so a real model id can never collide with it. A mode on it resolves to the user's
 * `default_model` at request time, so it follows a changed default; with no default set it is
 * an unavailable model and a chat on the mode is refused.
 */
export const MODE_DEFAULT_MODEL = 'my-default-model'

/** The model a mode runs: a `provider/model` id, or {@link MODE_DEFAULT_MODEL}. */
export const ModeModelSchema = z.union([
  z.literal(MODE_DEFAULT_MODEL),
  z.string().regex(DEFAULT_MODEL_PATTERN, { error: 'model must be a `provider/model` id' }),
])

export type ModeModel = z.infer<typeof ModeModelSchema>

/**
 * A mode as a request that ran under it records it: the id it is referenced by, and the name
 * it had when the request ran (#245, M6). Recorded on `span.model_request_start` beside the
 * resolved model and effort, so a log stays accurate after the mode is renamed or edited.
 */
export const ModeReferenceSchema = z.object({
  id: ModeIdSchema,
  name: z.string().min(1).max(MODE_NAME_MAX_LENGTH),
})

export type ModeReference = z.infer<typeof ModeReferenceSchema>

/** The `mode` resource. */
export const ModeSchema = z.object({
  id: ModeIdSchema,
  type: z.literal('mode'),
  /**
   * // extension: the user this mode belongs to (epic #65, A4). Read-only: the server sets it
   * from the caller, no request carries it, and another user's mode is answered as missing.
   */
  owner_id: UserIdSchema,
  /** The mode's name, unique among its owner's modes. */
  name: z.string().min(1).max(MODE_NAME_MAX_LENGTH),
  /** The model a chat on this mode runs, or {@link MODE_DEFAULT_MODEL} to follow the default. */
  model: ModeModelSchema,
  /**
   * The reasoning effort a chat on this mode runs at (#252), or `null` for the model's
   * provider default. A `user.message` carrying an explicit `reasoning_effort` overrides it.
   */
  reasoning_effort: ReasoningEffortSchema.nullable(),
  /**
   * Appended to the session's own system prompt for every request the mode runs, or `null`
   * for no addition. Appended after it, never in place of it.
   */
  system_prompt_addition: z.string().nullable(),
  created_at: TimestampSchema,
  /** When the mode was last changed. Set on update; equal to `created_at` at creation. */
  updated_at: TimestampSchema,
})

export type Mode = z.infer<typeof ModeSchema>

/**
 * Body of `POST /v1/me/modes`. Response: {@link ModeSchema}.
 *
 * A mode whose model the user cannot use yet is still valid to store — the key may come
 * later, and "my default model" may be unset today — so creation never checks availability;
 * a *chat* on an unavailable mode is refused instead.
 */
export const CreateModeRequestSchema = z.object({
  name: z.string().min(1).max(MODE_NAME_MAX_LENGTH),
  model: ModeModelSchema,
  reasoning_effort: ReasoningEffortSchema.nullable().optional(),
  system_prompt_addition: z.string().nullable().optional(),
})

export type CreateModeRequest = z.infer<typeof CreateModeRequestSchema>

/**
 * Body of `POST /v1/me/modes/{mode_id}`. Every field is optional; omitted fields keep their
 * stored value, and `null` clears a nullable one. Response: {@link ModeSchema}.
 */
export const UpdateModeRequestSchema = z.object({
  name: z.string().min(1).max(MODE_NAME_MAX_LENGTH).optional(),
  model: ModeModelSchema.optional(),
  reasoning_effort: ReasoningEffortSchema.nullable().optional(),
  system_prompt_addition: z.string().nullable().optional(),
})

export type UpdateModeRequest = z.infer<typeof UpdateModeRequestSchema>

/**
 * Response of `GET /v1/me/modes`.
 *
 * No pagination envelope, the shape the provider-credential list uses: a user's modes are
 * capped at {@link MAX_MODES_PER_USER}, so the response is bounded and a picker can show them
 * all at once.
 */
export const ListModesResponseSchema = z.object({
  data: z.array(ModeSchema),
})

export type ListModesResponse = z.infer<typeof ListModesResponseSchema>
