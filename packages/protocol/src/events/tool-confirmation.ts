import { z } from 'zod'

import { AskUserAnswersSchema, type AskUserAnswers } from '../ask-user'
import { EventIdSchema } from '../ids'
import type { DeepReadonly } from '../readonly'
import { EVENT_TYPES, EventSeqSchema, ProcessedAtSchema } from './common'

/**
 * `user.tool_confirmation`: the one event that answers a pause (epic #303, X6; #309).
 *
 * Every pause a session is in is answered by **one** client event, whatever is being waited
 * for: an approval the settings demanded (`result: allow | deny`), or the answers to an
 * `ask_user` call (`result: allow` with `answers`). Nothing else — a client never writes a
 * tool result, and the brain is the one that turns this event into the
 * `agent.tool_result` the call is owed.
 *
 * It is a `user.*` event because that is whose act it is, and Anthropic's name for it — but
 * unlike `user.message` and `user.interrupt` it is **not queued**: the server writes it, with
 * a real `processed_at`, only after checking that the call it names is really waiting. So it
 * is not a member of {@link UserEventSchema} and nothing ever claims it: the event itself is
 * the record, which is exactly what makes an approval a fact of the log — a reader (and the
 * brain) answers "was this call allowed?" by finding the confirmation that named it, and a
 * `session.rewind` past one removes it along with the rest of the branch it covered.
 *
 * `@openharness/brain`'s `./pausing` owns what a waiting call is and what its confirmation
 * means; this module owns the wire shape and the two extensions.
 */

/** What the user decided about a call that was waiting on them. */
export const ToolConfirmationResultSchema = z.enum(['allow', 'deny'])

export type ToolConfirmationResult = z.infer<typeof ToolConfirmationResultSchema>

/**
 * // extension: how long an approval is remembered (epic #303, X6; #309).
 *
 * - `once` — this call only.
 * - `session` — every later call to the same tool in this chat is allowed, for as long as the
 *   confirmation is part of the log: the event **is** the record, so the answer survives
 *   compaction and replay, and an edit that rewinds past it takes it back with the branch.
 * - `always` — the same, and the user's stored setting for that tool becomes `allow`, which
 *   is what makes the next chat inherit it (that write is the server's, on the append).
 *
 * Absent means `once`: the field is an extension, and every confirmation stored before it
 * existed means what it always meant.
 */
export const ToolConfirmationRememberSchema = z.enum(['once', 'session', 'always'])

export type ToolConfirmationRemember = z.infer<typeof ToolConfirmationRememberSchema>

/** The fields both the stored and the client-sent confirmation carry. */
const confirmationBody = {
  /** The `agent.tool_use` this answers — its event id, which is the call's id. */
  tool_use_id: EventIdSchema,
  /** What the user decided: `allow` runs the call (or carries its answers), `deny` refuses it. */
  result: ToolConfirmationResultSchema,
  /** Why the call was refused, when the user said so. Only a `deny` carries one. */
  deny_message: z.string().min(1).optional(),
  /** How long the approval is remembered; see {@link ToolConfirmationRememberSchema}. */
  remember: ToolConfirmationRememberSchema.optional(),
  /** The answers to an `ask_user` call; see `AskUserAnswersSchema`. Only an `allow` carries them. */
  answers: AskUserAnswersSchema.optional(),
}

/** What a confirmation's fields must hold together, whichever side wrote it. */
interface ConfirmationRules {
  readonly result: ToolConfirmationResult
  readonly deny_message?: string | undefined
  readonly remember?: ToolConfirmationRemember | undefined
  readonly answers?: AskUserAnswers | undefined
}

/**
 * The rules the fields hold between them: a denial explains itself and remembers nothing, and
 * an approval that carries `answers` is answering a question rather than authorizing a run.
 */
function confirmationRules<T extends ConfirmationRules>(value: T, ctx: z.RefinementCtx): void {
  if (value.deny_message !== undefined && value.result !== 'deny') {
    ctx.addIssue({
      code: 'custom',
      path: ['deny_message'],
      message: 'only a denial carries a `deny_message`: an approval has nothing to excuse',
    })
  }
  if (value.remember !== undefined && value.result !== 'allow') {
    ctx.addIssue({
      code: 'custom',
      path: ['remember'],
      message: 'only an approval is remembered: a denial cannot allow the next call',
    })
  }
  if (value.answers !== undefined && value.result !== 'allow') {
    ctx.addIssue({
      code: 'custom',
      path: ['answers'],
      message: 'only an approval carries `answers`: a denial says nothing about the questions',
    })
  }
}

/**
 * A stored `user.tool_confirmation`.
 *
 * `processed_at` is never null: the server writes it once the call it names has been checked,
 * so the event is a fact of the log the moment it exists rather than work waiting to be picked
 * up. An event naming a call that is not waiting is refused before it is stored (the 400 the
 * route answers), never stored and ignored.
 */
export const UserToolConfirmationEventSchema = z
  .object({
    id: EventIdSchema,
    type: z.literal(EVENT_TYPES.userToolConfirmation),
    seq: EventSeqSchema,
    processed_at: ProcessedAtSchema,
    ...confirmationBody,
  })
  .superRefine(confirmationRules)

/** A stored `user.tool_confirmation`, deep-readonly like every event. */
export type UserToolConfirmationEvent = DeepReadonly<
  z.infer<typeof UserToolConfirmationEventSchema>
>

/**
 * A `user.tool_confirmation` as a client sends it: the same shape without the fields the
 * server assigns (`id`, `seq`, `processed_at`).
 *
 * It travels on `POST /v1/sessions/{session_id}/events`, like a `user.message`, and the
 * server answers it as the protocol's 400 when the call it names is not waiting, when the
 * answers do not fit the questions the call asked, or when the fields contradict each other
 * (`remember` on a denial, say).
 */
export const UserToolConfirmationEventInputSchema = z
  .object({
    type: z.literal(EVENT_TYPES.userToolConfirmation),
    ...confirmationBody,
  })
  .superRefine(confirmationRules)

export type UserToolConfirmationEventInput = z.infer<typeof UserToolConfirmationEventInputSchema>
