import type { EventId } from '../ids'
import type { ToolPermission, ToolSource } from '../tools'
import { mcpToolOfferedName } from '../tools'
import type {
  AgentMcpToolResultEvent,
  AgentMcpToolUseEvent,
  AgentToolResultEvent,
  AgentToolUseEvent,
} from './agent'
import { EVENT_TYPES } from './common'
import type { StoredEvent } from './union'

/**
 * One abstraction both halves of a tool call share: a built-in tool's pair
 * (`agent.tool_use` / `agent.tool_result`, epic #303 X1) and a remote MCP tool's
 * (`agent.mcp_tool_use` / `agent.mcp_tool_result`, epic #303 X10; #312).
 *
 * The two pairs differ in exactly two things — the event type strings, and the name of the id
 * that pairs a result with its call (`tool_use_id` against `mcp_tool_use_id`) — plus the MCP
 * call's extra `mcp_server_name`. Everything else is the same, and every reader cares about
 * the same things: which calls have no answer, what a call's tool is *called* by the model,
 * which permission it was evaluated under, and what a result answers. Duplicating those
 * branches per pair is how a reader silently handles one and not the other (a cap not applied,
 * a crash repair not run, a pause not resumed), so this module is the one place they are
 * written and every reader goes through it.
 *
 * The one thing that is **not** shared is the offered name: a built-in's `name` already is the
 * name the model called, while an MCP call records the server's own names and the model-facing
 * name is recomputed with {@link toolCallOfferedName} — a pure function of the pair
 * (`mcpToolOfferedName`), which is what lets a reader of the log alone rebuild the request a
 * call came from.
 */

/** A stored event that is a tool call, built-in or MCP. */
export type ToolCallEvent = AgentToolUseEvent | AgentMcpToolUseEvent

/** A stored event that answers a tool call, built-in or MCP. */
export type ToolResultEvent = AgentToolResultEvent | AgentMcpToolResultEvent

/** Whether a stored event is a tool call. */
export function isToolCallEvent(event: StoredEvent): event is ToolCallEvent {
  return event.type === EVENT_TYPES.agentToolUse || event.type === EVENT_TYPES.agentMcpToolUse
}

/** Whether a stored event answers a tool call. */
export function isToolResultEvent(event: StoredEvent): event is ToolResultEvent {
  return event.type === EVENT_TYPES.agentToolResult || event.type === EVENT_TYPES.agentMcpToolResult
}

/** Whether a tool call is one a remote MCP server's tool — rather than this build's own. */
export function isMcpToolCall(call: ToolCallEvent): call is AgentMcpToolUseEvent {
  return call.type === EVENT_TYPES.agentMcpToolUse
}

/** The call's id, which is the event's own id — the identity a result names. */
export function toolCallId(call: ToolCallEvent): EventId {
  return call.id
}

/** The arguments the model produced, whichever pair the call belongs to. */
export function toolCallInput(call: ToolCallEvent): ToolCallEvent['input'] {
  return call.input
}

/** What the policy in force said about the call, whichever pair it belongs to. */
export function toolCallPermission(call: ToolCallEvent): ToolPermission {
  return call.evaluated_permission
}

/** Where the call's tool comes from. */
export function toolCallSource(call: ToolCallEvent): ToolSource {
  return isMcpToolCall(call) ? 'mcp' : 'builtin'
}

/** The MCP server a call's tool belongs to, by name — or `undefined` for a built-in tool. */
export function toolCallServer(call: ToolCallEvent): string | undefined {
  return isMcpToolCall(call) ? call.mcp_server_name : undefined
}

/**
 * The name the model called the tool by — what a registry, a result cap and a `remember`
 * approval are keyed by.
 *
 * A built-in's `name` is already that name; an MCP call records the server's own pair, so the
 * offered name is recomputed from it ({@link mcpToolOfferedName}). Both are pure readings of
 * the event, which is the property that makes every reader able to answer this question from
 * the log alone.
 */
export function toolCallOfferedName(call: ToolCallEvent): string {
  return isMcpToolCall(call) ? mcpToolOfferedName(call.mcp_server_name, call.name) : call.name
}

/**
 * The tool's own name as the log records it: a built-in's name, or an MCP server's name for
 * its tool — what a `user.tool_confirmation`'s reason or a summary reads it as.
 */
export function toolCallName(call: ToolCallEvent): string {
  return call.name
}

/** The call a result answers, whichever pair the result belongs to. */
export function toolResultCallId(result: ToolResultEvent): EventId {
  return result.type === EVENT_TYPES.agentMcpToolResult
    ? result.mcp_tool_use_id
    : result.tool_use_id
}

/** Whether a result reports a failed call. */
export function toolResultIsError(result: ToolResultEvent): boolean {
  return result.is_error
}
