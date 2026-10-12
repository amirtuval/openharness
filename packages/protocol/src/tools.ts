import { z } from 'zod'

/**
 * The tool vocabulary both halves of a tool call share: what the model may do, what the log
 * says about it, and what a call's input looks like on the wire.
 *
 * The shapes follow Anthropic's Managed Agents API — `agent.tool_use` and `agent.tool_result`
 * in `events/agent.ts`, and an `evaluated_permission` on each call — for the subset epic #303
 * builds. Built-in tools are here; MCP tools are named in {@link ToolSource} and arrive with
 * #312, which is why the field exists before its second value is produced.
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
 * server the user added. The second member is not produced yet — #312 puts it on the wire —
 * and it is part of the vocabulary now because a request's offer has to say which kind each
 * tool is, and a schema that grows a value later would be a wire change rather than a new
 * producer.
 */
export const ToolSourceSchema = z.enum(['builtin', 'mcp'])

export type ToolSource = z.infer<typeof ToolSourceSchema>

/**
 * One tool a model request offered: its name, and where it comes from.
 *
 * Recorded on `span.model_request_start` rather than left to be inferred from the registry,
 * because the registry is the deployment's and moves: a request's span has to say what *it*
 * offered, the way it says which model and which mode it ran.
 */
export const ToolReferenceSchema = z.object({
  /** The name the model calls it by, e.g. `web_fetch`. */
  name: z.string().min(1),
  /** Where the tool comes from. */
  source: ToolSourceSchema,
})

export type ToolReference = z.infer<typeof ToolReferenceSchema>

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
