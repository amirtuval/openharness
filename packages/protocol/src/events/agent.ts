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

/** Any stored agent event. */
export const AgentEventSchema = z.discriminatedUnion('type', [AgentMessageEventSchema])

/** Any stored agent event, deep-readonly (D9, issue #46). */
export type AgentEvent = DeepReadonly<z.infer<typeof AgentEventSchema>>
