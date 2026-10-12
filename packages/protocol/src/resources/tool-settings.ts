import { z } from 'zod'

import { ModeIdSchema } from '../ids'
import { ToolPermissionSchema, ToolSourceSchema } from '../tools'

/**
 * The per-user tool settings, and the endpoints that manage them:
 *
 * - `GET /v1/me/tools`
 * - `PUT /v1/me/tools`
 *
 * // extension: Anthropic's Managed Agents API has no user resource and no per-user settings —
 * its API is account-scoped by the key that calls it, and an agent carries a fixed `tools`
 * list. openharness has real users (epic #65) and lets each of them decide which of the
 * build's tools their chats may use, and under which permission (epic #303, X4; issue #307).
 *
 * The settings are **stored beside the log**, not on a session: a tool's on/off and its
 * permission are a user's, and a change applies from the next request on — except for the
 * parts a **mode** overrides (epic #245, M6): a mode may force built-in tools on or off for
 * every chat that follows it, and it may not touch a permission. See
 * {@link ModeToolOverrideSchema} in `./mode`.
 */

/**
 * The longest tool name this API stores.
 *
 * Long enough for a built-in tool's own name (`web_search`) and for the model-facing name an
 * MCP tool takes (`<server>__<tool>`, at most `MCP_TOOL_NAME_MAX_LENGTH` = 64, #312), and short
 * enough that the stored key of a settings map cannot be a paragraph.
 */
export const TOOL_NAME_MAX_LENGTH = 128

/**
 * A tool's name as the settings speak of it: the name the model calls it by and the registry
 * registers it under.
 *
 * Free text rather than an enum: the tools a build registers are the host's (`web_fetch` and
 * friends arrive with #305, and an MCP server's arrive with #312), and a settings row may name
 * a tool this process does not register — a `web_search` whose key is gone, say — which the
 * read reports as unavailable rather than hiding.
 */
export const ToolNameSchema = z.string().min(1).max(TOOL_NAME_MAX_LENGTH)

export type ToolName = z.infer<typeof ToolNameSchema>

/**
 * // extension: one built-in tool's setting (epic #303, X4; #307).
 *
 * `enabled` is whether the tool is offered to the model at all: a tool that is off is not in
 * the request's offer and cannot be called. `policy` is the permission a call to it is
 * evaluated under ({@link ToolPermissionSchema}): `allow` runs the call, `deny` refuses it, and
 * `ask` is the pause of [#309](https://github.com/amirtuval/openharness/issues/309) — accepted
 * and stored now, and until that lands treated as a refusal with a message that says so.
 *
 * The two are deliberately separate. A tool with `policy: 'deny'` is still offered (the model
 * may call it and be told no), while an `enabled: false` one is not; and #309's "always allow"
 * is remembered per tool, which is why a permission is a per-tool value rather than one
 * switch.
 */
export const BuiltinToolSettingSchema = z.object({
  enabled: z.boolean(),
  policy: ToolPermissionSchema,
})

export type BuiltinToolSetting = z.infer<typeof BuiltinToolSettingSchema>

/**
 * // extension: a user's stored tool settings (epic #303, X4; #307; the MCP half is #312).
 *
 * Two maps, one per source of tool. `builtin` is keyed by a built-in tool's name and carries
 * the two things a user chooses about one (on/off and a permission); `mcp` is keyed by a
 * remote tool's model-facing offered name and carries a **permission only**, because whether a
 * whole server is in play is a resource of its own (#311 carries `enabled`, and a mode overrides
 * it through {@link ModeToolOverrideSchema}'s `mcp_servers`) — a mode never carries a
 * permission, and a per-MCP-tool on/off does not exist (X6).
 *
 * A tool absent from the map follows **its own declared default** — the permission its
 * `ToolDefinition` carries, which is `allow` for every built-in tool and
 * `DEFAULT_MCP_TOOL_PERMISSION` (`ask`) for every MCP tool — so a user who has never opened the
 * settings screen gets the build's defaults rather than a frozen copy of them.
 *
 * Both maps are records of **choices**, so a user who has saved none reads
 * `DEFAULT_USER_TOOL_SETTINGS` and every tool follows its declaration.
 */
export const UserToolSettingsSchema = z.object({
  /** The built-in tools a user has chosen for, keyed by tool name. */
  builtin: z.record(ToolNameSchema, BuiltinToolSettingSchema),
  /**
   * // extension: the remote MCP tools a user has chosen a policy for (epic #303, X10; #312),
   * keyed by the model-facing offered name (`<server>__<tool>`, see `mcpToolOfferedName`).
   *
   * A **permission and nothing else**: a remote tool has no on/off of its own — whether a whole
   * server is in play is the server resource's `enabled` and a mode's override (X6) — so the
   * only thing a user chooses per tool is what a call to it means. A tool absent from the map
   * follows `DEFAULT_MCP_TOOL_PERMISSION` (`ask`).
   */
  mcp: z.record(ToolNameSchema, ToolPermissionSchema),
})

export type UserToolSettings = z.infer<typeof UserToolSettingsSchema>

/**
 * What a user who has never saved any tool settings reads: no choices at all, so every tool
 * follows its own declaration. The absence of a choice, not a 404 and not a stored default.
 */
export const DEFAULT_USER_TOOL_SETTINGS: UserToolSettings = { builtin: {}, mcp: {} }

/**
 * // extension: one tool, as `GET /v1/me/tools` reports it (epic #303, X4; #307).
 *
 * The **effective** state a chat would get, and the facts a settings screen needs to show it:
 *
 * - `enabled` is the user's choice, overridden by the mode's when the read named one — what
 *   decides whether the tool is offered at all.
 * - `policy` is the permission a call is evaluated under: the user's choice, or the tool's own
 *   declaration when they made none. A mode never changes it.
 * - `default_policy` is that declaration, so a client can show "default" beside a choice that
 *   happens to equal it — and `null` for a tool this process does not register, which has no
 *   declaration to report.
 * - `available` is whether this server registers the tool. `false` is a stored setting for a
 *   tool that is not here (a built-in whose key this deployment lacks, or a remote tool of a
 *   server that is gone), listed rather than hidden so a user can see why it is not working; a
 *   tool that is not here is never offered, whatever `enabled` says.
 * - `source` is where the tool comes from: `builtin` for this build's own, `mcp` for a remote
 *   server's (#312).
 * - `mcp_server` is the MCP server a remote tool belongs to, by name — absent for a built-in
 *   tool. It is what a settings screen groups remote tools by, and it is the same server name
 *   the log records on a call.
 *
 * For a remote tool `enabled` is the **effective** on/off of the server it belongs to (the
 * server's own `enabled`, with the mode's override applied), not a per-tool choice — there is
 * none (X6) — and `default_policy` is `'ask'`.
 */
export const ToolSettingEntrySchema = z.object({
  name: ToolNameSchema,
  source: ToolSourceSchema,
  enabled: z.boolean(),
  policy: ToolPermissionSchema,
  default_policy: ToolPermissionSchema.nullable(),
  available: z.boolean(),
  /**
   * // extension: the remote MCP server this tool belongs to, by name (#312). Absent for a
   * built-in tool, and for a stored setting that names no tool this or any server offers.
   */
  mcp_server: z.string().min(1).optional(),
})

export type ToolSettingEntry = z.infer<typeof ToolSettingEntrySchema>

/**
 * Response of `GET /v1/me/tools`: the effective settings, one entry per tool.
 *
 * No pagination envelope, the shape the mode and credential lists use: the list is bounded by
 * the tools a build registers plus the settings a user has stored, so a settings screen can
 * show all of it at once. Registered tools come in the registry's order — the order a request
 * offers them in — then the tools of the user's in-force remote MCP servers (#312), then any
 * stored setting for a tool that is neither, by name.
 */
export const ListToolSettingsResponseSchema = z.object({
  data: z.array(ToolSettingEntrySchema),
})

export type ListToolSettingsResponse = z.infer<typeof ListToolSettingsResponseSchema>

/**
 * Query of `GET /v1/me/tools`.
 *
 * `mode_id` answers the read as a chat on that mode would see it: the mode's override applied
 * over the user's own choices (a mode may force built-in tools on or off, never a permission).
 * It is how a composer shows "the tools this chat would get" for a chat that follows a mode
 * without the client having to merge the two itself. A `mode_` id the caller does not own is
 * the 404 every other mode read gives (A4).
 */
export const ListToolSettingsQuerySchema = z.object({
  mode_id: ModeIdSchema.optional(),
})

export type ListToolSettingsQuery = z.infer<typeof ListToolSettingsQuerySchema>

/**
 * Body of `PUT /v1/me/tools`. Response: {@link ListToolSettingsResponseSchema}.
 *
 * Named `builtin` and `mcp` like the stored maps, and every field optional: the write **merges**
 * — a tool the body names replaces that tool's whole setting, a tool it leaves out keeps what is
 * stored — so a settings screen can flip one switch without reading and rewriting the rest,
 * exactly as `PUT /v1/me/preferences` merges its fields. There is no way to delete an entry,
 * because there is nothing a deletion would say that a value does not: following a tool's own
 * declaration is `{ enabled: true, policy: <its default> }` for a built-in and its default
 * policy (`ask`) for a remote one, and a user may set that deliberately.
 */
export const PutToolSettingsRequestSchema = z.object({
  builtin: z.record(ToolNameSchema, BuiltinToolSettingSchema).optional(),
  /** The policy a remote MCP tool's calls are evaluated under, keyed by offered name (#312). */
  mcp: z.record(ToolNameSchema, ToolPermissionSchema).optional(),
})

export type PutToolSettingsRequest = z.infer<typeof PutToolSettingsRequestSchema>
