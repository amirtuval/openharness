import { z } from 'zod'

import { ContentBlocksSchema } from '../content'
import { EventIdSchema } from '../ids'
import type { DeepReadonly } from '../readonly'
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
   * Optional only for the transition: a reply whose chunks were never stored (anything the
   * brain wrote before D9) has no range to carry, and so does a message stored after an
   * interrupt *before* phase P3 starts storing chunks. From P3 on it is always present.
   */
  supersedes: SupersedesSchema.optional(),
})

export type AgentMessageEvent = z.infer<typeof AgentMessageEventSchema>

/** {@link AgentMessageEvent}, deep-readonly: the shape a store returns (D9). */
export type ImmutableAgentMessageEvent = DeepReadonly<AgentMessageEvent>

/** Any stored agent event. */
export const AgentEventSchema = z.discriminatedUnion('type', [AgentMessageEventSchema])

export type AgentEvent = z.infer<typeof AgentEventSchema>
