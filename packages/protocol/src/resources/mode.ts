import { z } from 'zod'

import { TimestampSchema } from '../common'
import { McpServerIdSchema, ModeIdSchema, SkillIdSchema, type McpServerId } from '../ids'
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
 * {@link ModeToolOverrideSchema}. Since #342 a mode may also say what it is **good for**, and
 * a mode that says so is a **subagent type** a parent model may start (epic #340, S2) — see
 * {@link ModeSubagentDescriptionSchema}.
 *
 * Modes are per user and owner-scoped like every other resource (epic #65, A4): a mode is
 * listed only to its owner and answers 404 to anyone else.
 */

/** Longest mode name the API accepts. */
export const MODE_NAME_MAX_LENGTH = 64

/**
 * Longest subagent description a mode may carry (epic #340, S2; issue #342).
 *
 * The description is read by a **parent model** choosing a helper to start, so it is a
 * sentence or two rather than a paragraph — the whole list of types goes into one tool
 * description, and a page of prose per mode would be the model's context, not its choice.
 */
export const MODE_SUBAGENT_DESCRIPTION_MAX_LENGTH = 500

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
 * - **Built-in tools by name, MCP servers and skills by id.** `builtin` is keyed by tool name,
 *   `mcp_servers` by a server's `mcps_` id and `skills` by a skill's `skl_` id — a mode turns a
 *   whole server or a whole skill on or off, never one MCP tool (an MCP tool's permission and
 *   its server's presence are different things, and only the second is a mode's; #311/#312).
 *   Separate keys rather than one, so none can be mistaken for another: a tool name is free
 *   text and an id is not.
 */
/**
 * What an item a mode's map does not name does (epic #349, B8).
 *
 * - `follow` — the user's own setting. The default when the field is absent, and the value
 *   every existing mode (and every mode created from a form that does not ask) reads as.
 * - `off` — an **allowlist**: only the items the map turns on are on; anything added later
 *   stays off in this mode.
 * - `on` — every item is on except those the map turns off, even items the user turned off
 *   globally.
 *
 * An explicit map entry always wins, and a hard rule that removes an item from a context
 * (`ask_user` in a non-interactive child, the subagent tools a depth does not offer,
 * `disable-model-invocation` skills out of the model's listing) cannot be undone by any of
 * these.
 */
export const ModeItemDefaultSchema = z.enum(['follow', 'off', 'on'])

export type ModeItemDefault = z.infer<typeof ModeItemDefaultSchema>

/** The value an absent {@link ModeItemDefault} field means. */
export const MODE_ITEM_DEFAULT: ModeItemDefault = 'follow'

export const ModeToolOverrideSchema = z.object({
  /**
   * Per-tool on/off. An entry always wins over {@link builtin_default}; a tool with no entry
   * follows the section default, which is the user's own setting when that is `'follow'`.
   *
   * Optional, and absent from a mode that says nothing about built-in tools — as it is from
   * one that says something about servers or skills only (a shape written before #307, and
   * the shape a patch that does not touch this half produces now).
   */
  builtin: z.record(ToolNameSchema, z.boolean()).optional(),
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
  /**
   * // extension: per-**skill** on/off for the user's imported skills (epic #349, K8). A
   * sibling of `mcp_servers`, keyed by a skill's `skl_` id, and read exactly the same way: a
   * skill the map does not name follows the user's own `enabled` on the resource — the user's
   * default — and a mode that names one turns it on or off for every chat that follows the
   * mode, live, from the next request on. A subagent type is a mode (epic #340, S2), so this is
   * what gives one its own set of skills.
   *
   * **A skill the user no longer has is simply ignored**, like a deleted MCP server: the mode
   * routes store the map as written and do not check the ids, so deleting a skill leaves the
   * modes that named it untroubled — the entry just matches nothing.
   *
   * Optional, and absent from every mode stored before #349, so "this mode says nothing about
   * skills" and "an empty map" are the same thing.
   */
  skills: z.record(SkillIdSchema, z.boolean()).optional(),
  /**
   * // extension: what a built-in tool with **no `builtin` entry** does (epic #349, B8).
   *
   * `'follow'` — the absence of the field, and the value every mode stored before this field
   * existed reads as — is today's behaviour: the tool follows the user's own setting in
   * `/v1/me/tools`. `'off'` makes the map an **allowlist**: every tool the map does not turn on
   * is off, so a tool the build adds later stays off in this mode. `'on'` makes every tool on
   * except the ones the map turns off, **even tools the user turned off globally**.
   *
   * An explicit entry always wins. It is still **never a permission**: the default decides
   * which tools a chat has, not what a call may do, and a hard rule that removes a tool from a
   * context (`ask_user` in a non-interactive child, the subagent tools a session's depth does
   * not offer) cannot be undone by `'on'`.
   */
  builtin_default: ModeItemDefaultSchema.optional(),
  /**
   * // extension: what a remote MCP server with **no `mcp_servers` entry** does (epic #349,
   * B8) — `'follow'` (the user's `enabled`), `'off'` (only the servers the map turns on are in
   * force) or `'on'` (every server except the ones the map turns off). An explicit entry
   * always wins, and a deleted server named by the map is still ignored.
   */
  mcp_servers_default: ModeItemDefaultSchema.optional(),
  /**
   * // extension: what an imported skill with **no `skills` entry** does (epic #349, B8) —
   * `'follow'` (the skill's own `enabled`), `'off'` (only the skills the map turns on are in
   * force, so one imported later stays off in this mode) or `'on'` (every skill except the
   * ones the map turns off). An explicit entry always wins; `disable-model-invocation` still
   * keeps a skill out of the model's listing whatever this says.
   */
  skills_default: ModeItemDefaultSchema.optional(),
})

export type ModeToolOverride = z.infer<typeof ModeToolOverrideSchema>

/**
 * The one resolution rule a mode's default and map entry follow, for one item.
 *
 * **An explicit entry wins; otherwise the section default decides; `follow` falls through to
 * the user's own setting.** This is the function every consumer of a mode's override uses —
 * the built-in tool listing and the brain's offer, the in-force MCP servers, the in-force
 * skills and both frontends' `/` menus — so server, brain, child sessions, web and `oh`
 * cannot drift about what a mode turns on.
 *
 * @param entry the mode's map entry for the item, or `undefined` when it does not name it
 * @param follows what the item does when the mode says nothing (the user's own setting)
 * @param fallback the section default, or `undefined` for `follow`
 */
export function modeItemInForce(
  entry: boolean | undefined,
  follows: boolean,
  fallback: ModeItemDefault | undefined,
): boolean {
  if (entry !== undefined) {
    return entry
  }
  switch (fallback ?? MODE_ITEM_DEFAULT) {
    case 'on':
      return true
    case 'off':
      return false
    default:
      return follows
  }
}

/**
 * Whether one built-in tool is in force for a chat on `override` (epic #303, X4; #307; the
 * default: epic #349, B8).
 *
 * @param name the tool's name as the settings speak of it
 * @param follows whether the user's own setting has it on
 * @param override the resolved mode's `tools`, or `null` for no mode
 */
export function builtinToolInForce(
  name: string,
  follows: boolean,
  override: ModeToolOverride | null,
): boolean {
  return modeItemInForce(override?.builtin?.[name], follows, override?.builtin_default)
}

/**
 * Whether one remote MCP server is in force for a chat on `override` (epic #303, X10; #311;
 * the default: epic #349, B8).
 *
 * @param serverId the server's `mcps_` id
 * @param follows the server resource's own `enabled`
 * @param override the resolved mode's `tools`, or `null` for no mode
 */
export function mcpServerInForce(
  serverId: McpServerId,
  follows: boolean,
  override: ModeToolOverride | null,
): boolean {
  return modeItemInForce(override?.mcp_servers?.[serverId], follows, override?.mcp_servers_default)
}

/**
 * // extension: the description that makes a mode a **subagent type** (epic #340, S2; #342).
 *
 * A parent model starting a helper picks a *kind* of helper, and a kind is a mode: the mode
 * already says how a chat on it runs — a model, an effort, a prompt addition and a tool set —
 * and this field is the one thing it did not have, what the mode is **good for**. A mode with
 * one is offered to the parent as a type it may start; a mode without is not, because
 * `null` is the honest spelling of "this mode is not meant to be one".
 *
 * It is a description for a **model**, not for a settings screen: short sentences saying what
 * the type is for, phrased so the parent can tell it from its neighbours ("Reviews a diff for
 * correctness bugs", "Searches the web and reports sources"), and bounded to
 * {@link MODE_SUBAGENT_DESCRIPTION_MAX_LENGTH} because every one of them is part of the one
 * description of the `agent` tool.
 *
 * The type a mode becomes resolves **exactly as a chat on that mode does** — its model
 * ("my default model" included), its effort, its prompt addition and its tool and MCP-server
 * override — so a user retunes what their helpers do by editing the mode they already have.
 * Policies are not a mode's (E6): what a call may do stays the user's setting.
 *
 * Stripped like every unknown field when the API did not put it there; the empty string is
 * refused rather than read as `null`, because "no description" has one spelling.
 */
const ModeSubagentDescriptionSchema = z.string().min(1).max(MODE_SUBAGENT_DESCRIPTION_MAX_LENGTH)

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
   * What this mode is good for, when it is offered to a parent model as a subagent type
   * (epic #340, S2; #342), or `null` for a mode that is not one. See
   * {@link ModeSubagentDescriptionSchema}.
   */
  subagent_description: ModeSubagentDescriptionSchema.nullable(),
  /**
   * Which tools, remote MCP servers and skills a chat on this mode has on or off, overriding
   * the user's own settings (#307; the MCP half: #311; the skills half: epic #349, K8) — or
   * `null` for no override at all, a mode that says nothing and lets every chat follow its
   * owner. Never a permission: see {@link ModeToolOverrideSchema}.
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
  subagent_description: ModeSubagentDescriptionSchema.nullable().optional(),
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
  subagent_description: ModeSubagentDescriptionSchema.nullable().optional(),
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
