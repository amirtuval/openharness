import { z } from 'zod'

import { ContentBlocksSchema } from '../content'
import { EventIdSchema } from '../ids'
import { EVENT_TYPES, EventSeqSchema, ProcessedAtSchema } from './common'

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
})

export type AgentMessageEvent = z.infer<typeof AgentMessageEventSchema>

/** Any stored agent event. */
export const AgentEventSchema = z.discriminatedUnion('type', [AgentMessageEventSchema])

export type AgentEvent = z.infer<typeof AgentEventSchema>
