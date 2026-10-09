import { z } from 'zod'

/**
 * How much thinking a model is asked to do before it answers (epic #245, A4a; epic decision M5).
 *
 * // extension: Anthropic's Managed Agents API carries an `effort` on the model config of a
 * session's agent. openharness makes the effort a capability of the **request** instead, because
 * every side of its boundary has one: it is what a session asks for, what the brain maps onto
 * each provider's own knob, and what the request's span records. That is what lets the same
 * three levels mean the same thing across eleven providers whose APIs spell them differently.
 *
 * Three levels, deliberately: the ones the providers' own knobs have in common. A provider that
 * has more (`minimal`, `xhigh`, `max`) is asked for the closest level it takes, and a model that
 * takes none runs the provider's default — which is exactly what an absent effort means
 * everywhere. Nothing here is a promise that a model reasons: that is the model's business, and
 * the span records what actually happened (see {@link ReasoningEffortRunSchema}).
 */
export const ReasoningEffortSchema = z.enum(['low', 'medium', 'high'])

export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>

/** The three levels, ascending: what a picker offers and the order it offers them in. */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ReasoningEffortSchema.options

/**
 * What a model request was asked for and what it ran with, recorded on its span.
 *
 * Two facts rather than one, because they differ: a model that takes no effort runs the
 * provider's default, and the log has to be able to say "an effort was asked for, none was
 * applied" — which a single field could not distinguish from "nothing was asked for". A reader
 * that wants what a request cost wants `applied`; one that wants what the session asked for
 * wants `requested`. `applied` equals `requested` in every other case: the levels are the same
 * three on both sides, so a provider that takes a level takes it unchanged.
 *
 * The record is written only when an effort was asked for, so a session that never set one
 * keeps the log it always had.
 */
export const ReasoningEffortRunSchema = z.object({
  /** What the request was asked to run with. */
  requested: ReasoningEffortSchema,
  /**
   * What the request actually ran with, or `null` when the model takes no effort and the
   * provider's own default was used.
   */
  applied: ReasoningEffortSchema.nullable(),
})

export type ReasoningEffortRun = z.infer<typeof ReasoningEffortRunSchema>
