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
 * Long enough for a built-in tool's own name (`web_search`) and for the namespaced name an MCP
 * tool will take (a server's id plus its tool's, #312), and short enough that the stored key of
 * a settings map cannot be a paragraph.
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
 * // extension: a user's stored tool settings (epic #303, X4; #307).
 *
 * One map today — `builtin`, keyed by tool name — and the place the MCP half will sit: a
 * user's MCP servers are on or off as a resource of their own (#311 carries the `enabled`
 * field that is the user's default), and a permission for one MCP tool is keyed by its server
 * and its tool (#312), which will be a sibling entry of this object rather than a change to
 * this one. What #311 did land is the **mode's** view of the servers: whether one is in play at
 * all is a mode's override (`{@link ModeToolOverrideSchema}`'s `mcp_servers`), not a per-tool
 * setting here — a mode never carries a permission, and a user's tool settings never carry a
 * server.
 *
 * A tool absent from the map follows **its own declared default** — the permission its
 * `ToolDefinition` carries, which is `allow` for every built-in tool and `ask` for every MCP
 * tool — so a user who has never opened the settings screen gets the build's defaults rather
 * than a frozen copy of them.
 */
export const UserToolSettingsSchema = z.object({
  /** The built-in tools a user has chosen for, keyed by tool name. */
  builtin: z.record(ToolNameSchema, BuiltinToolSettingSchema),
})

export type UserToolSettings = z.infer<typeof UserToolSettingsSchema>

/**
 * What a user who has never saved any tool settings reads: no choices at all, so every tool
 * follows its own declaration. The absence of a choice, not a 404 and not a stored default.
 */
export const DEFAULT_USER_TOOL_SETTINGS: UserToolSettings = { builtin: {} }

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
 *   tool that is not here (a built-in whose key this deployment lacks), listed rather than
 *   hidden so a user can see why it is not working; a tool that is not here is never offered,
 *   whatever `enabled` says.
 * - `source` is where the tool comes from (`builtin` today; `mcp` when #312 puts one there).
 */
export const ToolSettingEntrySchema = z.object({
  name: ToolNameSchema,
  source: ToolSourceSchema,
  enabled: z.boolean(),
  policy: ToolPermissionSchema,
  default_policy: ToolPermissionSchema.nullable(),
  available: z.boolean(),
})

export type ToolSettingEntry = z.infer<typeof ToolSettingEntrySchema>

/**
 * Response of `GET /v1/me/tools`: the effective settings, one entry per tool.
 *
 * No pagination envelope, the shape the mode and credential lists use: the list is bounded by
 * the tools a build registers plus the settings a user has stored, so a settings screen can
 * show all of it at once. Registered tools come in the registry's order — the order a request
 * offers them in — then any stored setting for a tool that is not registered, by name.
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
 * Named `builtin` like the stored map, and every field optional: the write **merges** — a tool
 * the body names replaces that tool's whole setting, a tool it leaves out keeps what is
 * stored — so a settings screen can flip one switch without reading and rewriting the rest,
 * exactly as `PUT /v1/me/preferences` merges its fields. There is no way to delete an entry,
 * because there is nothing a deletion would say that a value does not: following a tool's own
 * declaration is `{ enabled: true, policy: <its default> }`, and a user may set that
 * deliberately.
 */
export const PutToolSettingsRequestSchema = z.object({
  builtin: z.record(ToolNameSchema, BuiltinToolSettingSchema).optional(),
})

export type PutToolSettingsRequest = z.infer<typeof PutToolSettingsRequestSchema>
