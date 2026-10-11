import { z } from 'zod'

/**
 * The tool vocabulary both halves of a tool call share: what the model may do, what the log
 * says about it, and what a call's input looks like on the wire.
 *
 * The shapes follow Anthropic's Managed Agents API — `agent.tool_use`/`agent.tool_result` and
 * `agent.mcp_tool_use`/`agent.mcp_tool_result` in `events/agent.ts`, and an
 * `evaluated_permission` on each call — for the subset epic #303 builds. This module also holds
 * the one spelling both halves of an MCP tool call share: the model-facing name a remote tool
 * is offered under ({@link mcpToolOfferedName}).
 */

/**
 * What the policy in force said about one tool call.
 *
 * `allow` runs the call, `deny` refuses it without running it, and `ask` is a pause: the turn
 * stops and waits for the user's `user.tool_confirmation`. The value is what the loop
 * **evaluated** — not what the tool's own default says — so the log records the decision the
 * call was actually made under, and a settings change later does not rewrite it.
 *
 * `ask` is the pausing half of epic #303 (#309) and is not honoured yet: nothing produces it
 * today, and a policy resolver that answers it is treated as a refusal until #309 lands (see
 * `packages/brain/AGENTS.md`).
 */
export const ToolPermissionSchema = z.enum(['allow', 'ask', 'deny'])

export type ToolPermission = z.infer<typeof ToolPermissionSchema>

/**
 * Where a tool comes from.
 *
 * `builtin` is a tool this build runs itself (epic #305); `mcp` is a tool of a remote MCP
 * server the user added (epic #303, X10; #312). The two are the epic's decision X6: an MCP
 * tool is the server's, not this build's, and the only thing a user chooses about one is the
 * permission a call to it is evaluated under.
 */
export const ToolSourceSchema = z.enum(['builtin', 'mcp'])

export type ToolSource = z.infer<typeof ToolSourceSchema>

/**
 * The permission a call to an MCP tool is evaluated under when the user has chosen nothing.
 *
 * `ask` rather than a built-in's `allow`: a remote server is somebody else's code doing
 * something this build cannot see, so the epic's default (X6) is that the user is asked the
 * first time — and the answer can be remembered per tool (#309). It is the `permission` a
 * remote tool's definition carries, which is what makes the default live in one place.
 */
export const DEFAULT_MCP_TOOL_PERMISSION: ToolPermission = 'ask'

/**
 * One tool a model request offered: its name, where it comes from, and which MCP server it is
 * the tool of.
 *
 * Recorded on `span.model_request_start` rather than left to be inferred from the registry,
 * because the registry is the deployment's and moves: a request's span has to say what *it*
 * offered, the way it says which model and which mode it ran.
 */
export const ToolReferenceSchema = z.object({
  /** The name the model calls it by, e.g. `web_fetch` or `notes__search`. */
  name: z.string().min(1),
  /** Where the tool comes from. */
  source: ToolSourceSchema,
  /**
   * // extension: the MCP server the tool belongs to, by **name** — the same name the call
   * event carries as `mcp_server_name` (epic #303, X10; #312).
   *
   * Absent for a built-in tool, whose `name` already says everything. Present so a reader of
   * the span can tell two servers' tools apart without parsing the offered name, which is this
   * protocol's own spelling of a pair and not a fact either side owns.
   */
  server: z.string().min(1).optional(),
})

export type ToolReference = z.infer<typeof ToolReferenceSchema>

/**
 * The characters a model-facing MCP tool name may use.
 *
 * The rule every provider's tool-name check has in common: a name of letters, digits,
 * underscores and dashes. It is stated here because the offered name has to satisfy it
 * *before* it reaches a provider, and the sanitizer below is where that happens.
 */
export const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

/**
 * The most characters a model-facing MCP tool name may have.
 *
 * 64 is the tightest of the providers' limits (Anthropic and OpenAI both cap at 64), so a name
 * this long is one every provider accepts. A server's name is at most
 * `MCP_SERVER_NAME_MAX_LENGTH` (32) and the separator two more, leaving at least 30 characters
 * of the tool's own name.
 */
export const MCP_TOOL_NAME_MAX_LENGTH = 64

/**
 * The separator between an MCP server's name and a tool's own name in the offered name.
 *
 * A double underscore because neither half may contain one: a server name is lowercase
 * letters, digits and dashes (`MCP_SERVER_NAME_PATTERN`), and a single underscore is common in
 * a tool's own name. It also means an MCP tool can never collide with a built-in, whose names
 * (`web_fetch`, `todo_write`, `ask_user`) carry single underscores only.
 */
export const MCP_TOOL_NAME_SEPARATOR = '__'

/**
 * The name a model is offered an MCP tool under: the server's name, the separator, and the
 * tool's own name, sanitized to what every provider's tool-name rule accepts.
 *
 * It is a **pure** function of the pair, and deliberately so: a reader that has only the log —
 * `agent.mcp_tool_use` records the server's name and the tool's own name — recomputes exactly
 * the name the request offered, which is what lets a tool result be capped by its tool's
 * declaration, a `remember: session` approval be matched to the tool it remembered, and a
 * model request be rebuilt from the log, all without a second lookup. Characters outside
 * {@link MCP_TOOL_NAME_PATTERN} are replaced by `_`, and the result is truncated to
 * {@link MCP_TOOL_NAME_MAX_LENGTH}.
 *
 * Two pairs that sanitize to the same name are a **collision**, and the offer drops the later
 * one rather than renaming it (see `@openharness/brain`): a rename would make the name depend
 * on what else was offered, and the name has to be recomputable from the log alone. A dropped
 * tool is not offered, so no call to it can exist and nothing is lost but the second spelling.
 */
export function mcpToolOfferedName(serverName: string, toolName: string): string {
  const raw = `${serverName}${MCP_TOOL_NAME_SEPARATOR}${toolName}`
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_')
  return sanitized.length > MCP_TOOL_NAME_MAX_LENGTH
    ? sanitized.slice(0, MCP_TOOL_NAME_MAX_LENGTH)
    : sanitized
}

/** Whether `value` is a model-facing MCP tool name — the rule {@link MCP_TOOL_NAME_PATTERN} states. */
export function isMcpToolOfferedName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MCP_TOOL_NAME_MAX_LENGTH &&
    MCP_TOOL_NAME_PATTERN.test(value)
  )
}

/**
 * A JSON value: what a tool call's input may hold, and nothing else.
 *
 * The log is read back by other processes and by clients, and every reader of it goes through
 * JSON — so a value that only survives in this process (a function, a `Date`, a `BigInt`, a
 * cycle) would be stored as something no reader can parse back. Being this narrow is what
 * makes `agent.tool_use.input` round-trip, the same reason `ModelUsageSchema` demands integers
 * (see the note in `packages/protocol/AGENTS.md` about issue #39).
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
)

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * The input of a tool call: a JSON object, as a model is asked for one.
 *
 * An object rather than any JSON value because a tool's input is described by an object
 * schema — a call whose arguments are a bare string or an array is not a call any registered
 * tool can be run with, and the loop answers it with an `is_error` result rather than storing
 * a shape nothing can read.
 */
export const ToolInputSchema = z.record(z.string(), JsonValueSchema)

export type ToolInput = z.infer<typeof ToolInputSchema>
