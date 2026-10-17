import { z } from 'zod'

import { ContentBlocksSchema, SourcesSchema } from '../content'
import { EventIdSchema } from '../ids'
import type { DeepReadonly } from '../readonly'
import { JsonValueSchema, ToolInputSchema, ToolPermissionSchema, ToolSourceSchema } from '../tools'
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
  /**
   * // extension: where this call's tool comes from (epic #303, X14; issue #335).
   *
   * Absent is `builtin` — every call this event carried before #335 — so a log stored then
   * replays exactly as it did. `provider` is a call the model's own provider ran inside the
   * request, which this build neither offered through `@openharness/hands` nor could have run:
   * it is stored for the reader, and the request is rebuilt from `agent.opaque_content`
   * instead (§ `@openharness/brain`'s `./context`, `./opaque`).
   */
  source: ToolSourceSchema.optional(),
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
  /**
   * // extension: the web sources a provider-executed search answered with (epic #303, X14;
   * issue #335).
   *
   * Present only on the result of a `source: 'provider'` call, and only for a search: the
   * provider's citations normalized to one list (`SourceSchema`), so a client renders where a
   * reply got its facts without knowing which provider produced them. Absent everywhere else —
   * every result stored before #335, every result of a tool this build ran, every remote tool's
   * — so a reader that does not know the field sees the shape it always did.
   *
   * It is a **reading**, not the request's material: what goes back to the provider is the
   * provider's own opaque content, never this.
   */
  sources: SourcesSchema.optional(),
  /**
   * // extension: the queued events this result answers (epic #340, S5; issue #343).
   *
   * A claim belongs on the event that ends the work it consumed (P4), and one case has no other
   * event to carry it: a **task wait** whose result *is* the notifications that resolved it. A
   * `session.task_notification` is a queued event, so "the model has been told" must be a claim
   * — and the append that resolves the wait writes the notifications into the result's content
   * and lists their ids here, which is what stops the parent's next request from being handed
   * the same notification a second time as steering.
   *
   * Absent for every other result this build writes, which is why the field is optional and why
   * the remote pair ({@link AgentMcpToolResultEventSchema}) has none: the tool that waits is a
   * built-in of this deployment, so only the built-in pair ever carries the list.
   */
  consumes: z.array(EventIdSchema).optional(),
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

/**
 * // extension: one part of a step, kept exactly as the provider that produced it sent it
 * (epic #303, X13; issue #334).
 *
 * The AI SDK's own assistant part, plus the provider's payload for it: a reasoning part's text
 * and whatever metadata its provider attached (`signature`, `redactedData`, `itemId`,
 * `reasoningEncryptedContent`). The payload is the part's *whole* opaque half — nothing is
 * summarized, re-encoded or cut — because a signature or an encrypted payload the provider
 * cannot verify is not one it accepts.
 */
export const OpaquePartSchema = z.object({
  /**
   * The AI SDK assistant-part type: `reasoning` (#334), or `tool-call` / `tool-result` for a
   * call the provider ran itself inside the request (#335). See
   * `@openharness/brain`'s `./opaque` for which types a family captures and how each goes back
   * out.
   */
  type: z.string().min(1),
  /**
   * The part's text: a reasoning part's thinking, or `''` when the provider withheld it.
   *
   * Empty for the tool parts #335 captures — what a tool call says is its id, its name and its
   * arguments ({@link OpaquePartSchema.shape.payload}), not prose.
   */
  text: z.string(),
  /**
   * // extension: how much of the step's own text was streamed **before** this part — in
   * characters — which is where the part goes in the assistant turn it is replayed on
   * (epic #303, X14; issue #335).
   *
   * A provider's assistant content has an order, and one this build must rebuild exactly: a
   * Claude step that wrote "Let me look that up." then called `server_tool_use` then answered
   * from the results is text → call → result → text, and a request that sent the parts first
   * would be asking Anthropic to read a turn it never wrote. A part's place is therefore its
   * own offset into that step's text, and the strategy splits the step's `agent.message` text
   * at those offsets and lays the parts between the pieces.
   *
   * Absent reads as `0`: every part of a step streamed before any of its text, which is the
   * order this event was written with before the offsets existed (#334 — parts ahead of the
   * text), so a log stored then replays exactly as it did.
   */
  text_before: z.number().int().nonnegative().optional(),
  /**
   * // extension: the provider's own metadata for the part, exactly as it sent it — the AI
   * SDK's `providerOptions` key for that provider (`signature` for Anthropic, `itemId` and
   * `reasoningEncryptedContent` for OpenAI and xAI, `thoughtSignature` for Gemini, the
   * `encryptedIndex` of a citation or the `encryptedContent` of a search result).
   *
   * Absent for a family whose reasoning is replayed as plain text and carries no payload
   * (DeepSeek thinking mode through an OpenAI-compatible endpoint). See
   * `@openharness/brain`'s `./opaque` for which key each family files it under.
   */
  provider_options: JsonValueSchema.optional(),
  /**
   * // extension: the part's own data, for a part that is more than text (#335).
   *
   * A provider-executed tool call and its result are the AI SDK's own part shapes — a call's
   * `toolCallId`, `toolName` and arguments, a result's `toolCallId`, `toolName` and output —
   * and there is no place in `text` or in the provider's metadata for any of it: the metadata
   * is the provider's key namespace, and cramming a call's arguments into it would put them
   * under a name the provider's client reads for something else.
   *
   * Stored exactly as the AI SDK delivered it, because that is the only form the provider will
   * accept back (a search result's `encryptedContent` is opaque to this build). Absent for a
   * `reasoning` part, which is its text and its metadata and nothing else.
   */
  payload: JsonValueSchema.optional(),
})

/** One part of a step, deep-readonly like every event. */
export type OpaquePart = DeepReadonly<z.infer<typeof OpaquePartSchema>>

/**
 * // extension: the parts of one step only the provider that produced them can read back
 * (epic #303, X13; issue #334).
 *
 * One event per model request — **one step's worth of parts**, in the order the provider
 * produced them — written by the brain and never shown as the reply. It is stored whether or
 * not the step streamed text, because the step this exists for is the one with no text at all:
 * a thinking model's call. A step that produced nothing opaque writes no event, which is every
 * step of every session stored before #334, so those logs replay unchanged.
 *
 * `provider` and `model` are what the parts may be replayed to, and they are both recorded
 * because both are required: a signature, an encrypted payload and an item id are all bound to
 * the conversation *and* the model that produced them, so the brain's context strategy
 * re-attaches a step's parts only when the next request goes to the same family **and** the
 * same model, and drops them on any switch (the AI SDK's provider clients then write the
 * assistant message without them, which is what a provider that cannot read them wants).
 *
 * A step's assistant turn has an **order**, and this event is where the parts' place in it is
 * recorded: each part carries {@link OpaquePartSchema.shape.text_before}, the characters of the
 * step's own `agent.message` text that came before it, and the strategy rebuilds the turn by
 * splitting that text at those offsets and laying the parts between the pieces. Text → a
 * provider's call → its answer → the text that answers from it is a step's real shape, and a
 * request that sent the parts ahead of the text would be a turn the provider never wrote.
 * Absent reads as `0`, so a log written before the offsets existed (#334's parts-ahead-of-text
 * order) replays exactly as it did.
 *
 * Nothing here is summarized, and a rewind takes it back with the step it belongs to —
 * `session.rewind` covers every event in the tail it restarts, this one included. It is never
 * sent to another provider: see `@openharness/brain`'s `./opaque`, the one place the rule
 * lives.
 */
export const AgentOpaqueContentEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal(EVENT_TYPES.agentOpaqueContent),
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
  /**
   * // extension: the client family the parts must be replayed to.
   *
   * The name the family's AI SDK client reads its per-part options under — `anthropic`,
   * `bedrock`, `openai`, `xai` — or `openai-compatible` for the chat-completions families
   * whose reasoning is plain text. It is the key an entry's `provider_options` is filed under
   * on the way back out.
   */
  provider: z.string().min(1),
  /** The `provider/model` that produced the parts — the other half of "where may this go?". */
  model: z.string().min(1),
  /** The parts, in the order the provider produced them. Empty only when all were dropped. */
  parts: z.array(OpaquePartSchema),
  /**
   * // extension: how many of the step's parts were too large to keep, when any were.
   *
   * A part is kept whole or not at all: no family in the table may replay a truncated payload
   * (an Anthropic signature and an OpenAI encrypted payload are opaque to this build, and a
   * DeepSeek step's reasoning is one string whose value is in being whole), so an oversized
   * part is dropped instead of cut and the count says the step had reasoning the log does not
   * carry. Absent when nothing was dropped.
   */
  dropped: z.number().int().nonnegative().optional(),
})

/**
 * A stored `agent.opaque_content`, deep-readonly like every event.
 *
 * Its `parts` are the provider's payloads, so a reader must treat them as opaque: they are
 * never rendered, and nothing but the model's own provider may be handed them.
 */
export type AgentOpaqueContentEvent = DeepReadonly<z.infer<typeof AgentOpaqueContentEventSchema>>

/** Any stored agent event. */
export const AgentEventSchema = z.discriminatedUnion('type', [
  AgentMessageEventSchema,
  AgentToolUseEventSchema,
  AgentToolResultEventSchema,
  AgentMcpToolUseEventSchema,
  AgentMcpToolResultEventSchema,
  AgentOpaqueContentEventSchema,
])

/** Any stored agent event, deep-readonly (D9, issue #46). */
export type AgentEvent = DeepReadonly<z.infer<typeof AgentEventSchema>>
