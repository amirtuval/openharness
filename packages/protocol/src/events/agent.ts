import { z } from 'zod'

import { ContentBlocksSchema } from '../content'
import { EventIdSchema } from '../ids'
import type { DeepReadonly } from '../readonly'
import { ToolInputSchema, ToolPermissionSchema } from '../tools'
import { EVENT_TYPES, EventSeqSchema, ProcessedAtSchema, SupersedesSchema } from './common'

/**
 * Events the agent produces.
 *
 * Written by the brain, never by a client. The `id` of an `agent.message` is the same `sevt_`
 * id its stream preview carried in `event_start.event.id` / `event_delta.event_id`, which is
 * how a client reconciles an accumulated preview with the authoritative message.
 */

/**
 * The agent's reply.
 *
 * `content` holds the text blocks the model produced for this model request. Anthropic also
 * allows a `redacted` block here, a placeholder for content withheld by model policy;
 * openharness does not produce one (see `AGENTS.md`).
 */
export const AgentMessageEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal(EVENT_TYPES.agentMessage),
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
  content: ContentBlocksSchema,
  /**
   * // extension: the chunk range this message replaces (D9, issue #46).
   *
   * Since D9 the streamed chunks are stored events, and the finished message supersedes them:
   * the range runs from its own `event_start` to its last `event_delta`. Replay skips the
   * chunks in the range; a reader that saw them live does not need to — it reconciles them by
   * id, as it always has. See {@link SupersedesSchema}.
   *
   * Optional only so a log stored before D9 (issue #46) keeps validating: a reply whose chunks
   * were never stored has no range to carry. Every reply the brain stores from phase P3 on has
   * one; a reader without one falls back to the position of the preview it replaces.
   */
  supersedes: SupersedesSchema.optional(),
})

/** A stored `agent.message`, deep-readonly (D9, issue #46). */
export type AgentMessageEvent = DeepReadonly<z.infer<typeof AgentMessageEventSchema>>

/** @deprecated The plain name is deep-readonly now (D9, issue #46); use {@link AgentMessageEvent}. */
export type ImmutableAgentMessageEvent = AgentMessageEvent

/**
 * The agent asked for a tool (epic #303, X1).
 *
 * The model's call, stored as an event of its own so the log says what was asked for and when
 * — not streamed (tool input is stored when the call is complete, X1), and not a content block
 * of `agent.message`, so a step that produced four calls and no text still reads as four
 * calls. The **event's own id is the call's id**: `agent.tool_result.tool_use_id` names it,
 * and a reader pairing the two has one identity to key on, the way an `agent.message` and its
 * chunks share the `sevt_` id the preview announced.
 *
 * `input` is the arguments the model produced, validated by nobody here: whether they match the
 * tool's own schema is the registry's business (`@openharness/hands`), and a call that does not
 * match is answered with an `is_error` result rather than refused at the log's door — the log
 * records what the model asked for, including a call that cannot be run.
 *
 * `evaluated_permission` is what the policy in force said about **this** call: recorded per
 * call, so a later settings change does not rewrite what happened.
 */
export const AgentToolUseEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal(EVENT_TYPES.agentToolUse),
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
  /** The tool's name, as it was offered to the model. */
  name: z.string().min(1),
  /** The arguments the model produced: a JSON object; see `ToolInputSchema`. */
  input: ToolInputSchema,
  /** What the policy in force said about this call: `allow`, `ask` or `deny`. */
  evaluated_permission: ToolPermissionSchema,
})

/** A stored `agent.tool_use`, deep-readonly like every event. */
export type AgentToolUseEvent = DeepReadonly<z.infer<typeof AgentToolUseEventSchema>>

/**
 * What a tool call produced (epic #303, X1).
 *
 * Always written, and always by the brain: a call the model made is answered exactly once, by
 * the loop that ran it — a result, a refusal under a `deny` policy, a timeout, an interrupt, or
 * the `execution lost` a turn that crashed before running it leaves for its successor (X3).
 * A client never writes one, so "the model asked and nothing answered" is always a brain that
 * died, never a shape a reader has to guess at.
 *
 * `content` is text blocks, the same shape a message's content has; `is_error: true` is what
 * says the model should read it as a failed call rather than an answer.
 */
export const AgentToolResultEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal(EVENT_TYPES.agentToolResult),
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
  /** The `agent.tool_use` this answers — its event id, which is the call's id. */
  tool_use_id: EventIdSchema,
  /** What the call produced, as text blocks. */
  content: ContentBlocksSchema,
  /** Whether the call failed — a refusal, a timeout, an interrupt or the tool's own error. */
  is_error: z.boolean(),
})

/** A stored `agent.tool_result`, deep-readonly like every event. */
export type AgentToolResultEvent = DeepReadonly<z.infer<typeof AgentToolResultEventSchema>>

/**
 * The agent asked a remote MCP server's tool (epic #303, X1/X10; #312).
 *
 * The same shape as {@link AgentToolUseEventSchema} — the event's id **is** the call's id, and
 * `evaluated_permission` is what the policy in force said about *this* call — plus the one
 * field the built-in pair has no use for: `mcp_server_name`, the server the tool belongs to.
 *
 * `name` is the tool's own name **as the MCP server named it**, not the name the model was
 * offered it under. The two differ: a chat offers a remote tool as `<server>__<tool>` so a
 * model can tell two servers' `search` apart, and that spelling is openharness's invention —
 * a reader recomputes it from this pair with `mcpToolOfferedName` whenever it needs the name a
 * registry or a cap is keyed by. Recording the server's own names is what keeps the log true
 * to what happened even if that spelling ever changes.
 *
 * A tool-level failure is not special here: as with a built-in, the call is stored and then
 * answered with an `is_error` result, because the log records what the model asked for.
 */
export const AgentMcpToolUseEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal(EVENT_TYPES.agentMcpToolUse),
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
  /** The MCP server's name — the user-unique name it was configured under. */
  mcp_server_name: z.string().min(1),
  /** The tool's own name on that server, e.g. `search`. */
  name: z.string().min(1),
  /** The arguments the model produced: a JSON object; see `ToolInputSchema`. */
  input: ToolInputSchema,
  /** What the policy in force said about this call: `allow`, `ask` or `deny`. */
  evaluated_permission: ToolPermissionSchema,
})

/** A stored `agent.mcp_tool_use`, deep-readonly like every event. */
export type AgentMcpToolUseEvent = DeepReadonly<z.infer<typeof AgentMcpToolUseEventSchema>>

/**
 * What a remote MCP tool call produced (epic #303, X1/X10; #312).
 *
 * Always written, and always by the brain — the same rule as {@link AgentToolResultEventSchema},
 * with the id field named for the MCP pair (`mcp_tool_use_id`).
 *
 * `content` is text blocks, whatever the server sent: the answer's text and its structured
 * content become text, and content this protocol cannot carry as text — an image, an embedded
 * resource — becomes a marker naming it, so a model is told something was there rather than
 * shown a shape no reader accepts. `is_error: true` is the tool's own `isError`, or the loop's
 * report of a call that failed to run.
 */
export const AgentMcpToolResultEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal(EVENT_TYPES.agentMcpToolResult),
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
  /** The `agent.mcp_tool_use` this answers — its event id, which is the call's id. */
  mcp_tool_use_id: EventIdSchema,
  /** What the call produced, as text blocks. */
  content: ContentBlocksSchema,
  /** Whether the call failed — the tool's own error, a timeout, an interrupt or a lost turn. */
  is_error: z.boolean(),
})

/** A stored `agent.mcp_tool_result`, deep-readonly like every event. */
export type AgentMcpToolResultEvent = DeepReadonly<z.infer<typeof AgentMcpToolResultEventSchema>>

/** Any stored agent event. */
export const AgentEventSchema = z.discriminatedUnion('type', [
  AgentMessageEventSchema,
  AgentToolUseEventSchema,
  AgentToolResultEventSchema,
  AgentMcpToolUseEventSchema,
  AgentMcpToolResultEventSchema,
])

/** Any stored agent event, deep-readonly (D9, issue #46). */
export type AgentEvent = DeepReadonly<z.infer<typeof AgentEventSchema>>
