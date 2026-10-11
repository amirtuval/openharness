import { z } from 'zod'

import { TimestampSchema } from '../common'
import { McpServerIdSchema, ModeIdSchema } from '../ids'
import { ReasoningEffortSchema } from '../reasoning'
import { ToolNameSchema } from './tool-settings'
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
 * (epic #245, decision M6). Since #307 a mode may also override which tools a chat has —
 * the built-in ones by name, and the user's remote MCP servers by id (#311) — see
 * {@link ModeToolOverrideSchema}.
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

/**
 * // extension: a mode's override of which built-in tools are on (epic #303, X4; issue #307).
 *
 * A mode's job is to make a chat behave a certain way — the same one that bundles a model and
 * an effort bundles a tool set — so `deep` may want `web_search` on and `todo_write` off, and
 * every chat that follows it gets that from its next request on, live, exactly as it gets the
 * mode's model.
 *
 * Three things about it are deliberate:
 *
 * - **A per-tool patch, not a set.** A tool the mode does not name follows the user's own
 *   setting, so a mode expresses "this one differently" rather than restating the whole tool
 *   list — and a tool added to the build later is not silently turned off by a mode written
 *   before it existed.
 * - **On and off, never a permission.** A mode decides *which* tools a chat has, not what a
 *   call to one may do: a permission is the user's (E6), and "always allow" (#309) is
 *   remembered per tool.
 * - **Built-in tools by name, MCP servers by id.** `builtin` is keyed by tool name and
 *   `mcp_servers` by a server's `mcps_` id — a mode turns a whole server on or off, never one
 *   MCP tool, because an MCP tool's permission and its server's presence are different things
 *   and only the second is a mode's (#311/#312). Two keys rather than one, so neither can be
 *   mistaken for the other: a tool name is free text and a server id is not.
 */
export const ModeToolOverrideSchema = z.object({
  /** Per-tool on/off; a tool not named follows the user's own setting. */
  builtin: z.record(ToolNameSchema, z.boolean()),
  /**
   * // extension: per-**server** on/off for the user's remote MCP servers (epic #303, X10;
   * #311). A server the map does not name follows the user's own `enabled` on the resource —
   * which is the user's default — and a mode that names one turns it on or off for every chat
   * that follows the mode, live, exactly as it decides a built-in tool.
   *
   * **Never per MCP tool, and never a permission.** A mode says whether a server is in play;
   * which of its tools a request offers and under which permission is the server's own
   * listing and the user's settings (#312), not a mode's.
   *
   * **A server the user no longer has is simply ignored.** A mode is stored by id, and the
   * server may be deleted afterwards — or the id may name nothing at all, because the mode
   * routes do not check it — so a map entry is an instruction about a server that is still
   * there and has no effect on one that is not.
   *
   * Optional, and absent from every mode stored before #311, so "this mode says nothing about
   * MCP servers" and "an empty map" are the same thing.
   */
  mcp_servers: z.record(McpServerIdSchema, z.boolean()).optional(),
})

export type ModeToolOverride = z.infer<typeof ModeToolOverrideSchema>

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
  /**
   * Which built-in tools a chat on this mode has on or off, overriding the user's own settings
   * (#307), or `null` for no override at all — a mode that says nothing about tools and lets
   * every chat follow its owner. Never a permission: see {@link ModeToolOverrideSchema}.
   */
  tools: ModeToolOverrideSchema.nullable(),
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
  tools: ModeToolOverrideSchema.nullable().optional(),
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
  tools: ModeToolOverrideSchema.nullable().optional(),
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
