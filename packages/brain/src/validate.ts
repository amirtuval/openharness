import type { AppendableEvent } from '@openharness/session'
import type { StoredEventType } from '@openharness/protocol'
import { EVENT_TYPES, StoredEventSchema } from '@openharness/protocol'
import type { z } from 'zod'

/**
 * The protocol check every event passes before it is stored.
 *
 * The session log is the contract, and a client replays it with the protocol's schemas in hand
 * — so an event the brain stores in a shape the protocol does not describe is not a private
 * mistake: it poisons the log for *every* reader, and `@openharness/client` rejects a whole
 * events response over one bad field. That is what happened in issue #39, where a model's
 * usage report reached the log as the string `"0[object Object]"` and the session stopped
 * being readable at all, long after the turn that wrote it had ended.
 *
 * `append` in the turn loop is the one place events are handed to a store, so this is where the
 * check lives: the brain fails loudly at write time, with the field that was wrong, instead of
 * finding out from a client that cannot read the log back.
 */

/**
 * The id, `seq` and timestamp of an event a caller has not stored yet.
 *
 * The store assigns these; only the rest of the event is the caller's. Validation needs
 * *something* in their place, and a value the protocol accepts for each keeps the check free of
 * false alarms — a placeholder that failed the schema would make every append fail.
 */
const PLACEHOLDER_ID = 'sevt_00000000000000000000000000'
const PLACEHOLDER_SEQ = 1
const PLACEHOLDER_TIME = '1970-01-01T00:00:00.000Z'

/**
 * The `processed_at` an event of this type carries once stored.
 *
 * A user event is stored the moment a client sends it and processed later, so its
 * `processed_at` is `null` until the brain reaches it; everything the brain writes itself is
 * stamped when it happens.
 */
function processedAtFor(type: StoredEventType): string | null {
  return type === EVENT_TYPES.userMessage || type === EVENT_TYPES.userInterrupt
    ? null
    : PLACEHOLDER_TIME
}

/**
 * An event the brain built that is not the shape the protocol documents.
 *
 * It is never stored: the turn ends with `session.error` and `session.status_idle` instead, so
 * a bug in the brain costs one turn rather than the session's readability.
 */
export class EventValidationError extends Error {
  constructor(
    /** The event that failed, as the brain built it. */
    readonly event: AppendableEvent,
    /** The protocol fields that did not match, one `path: message` per line. */
    readonly issues: string,
  ) {
    super(`the ${event.type} event this turn built is not a valid protocol event: ${issues}`)
    this.name = 'EventValidationError'
  }
}

/**
 * Check the events a turn is about to append against the protocol, and throw when one of them
 * is not the event it claims to be.
 *
 * @throws EventValidationError when an event fails the protocol's schema
 */
export function assertValidEvents(events: readonly AppendableEvent[]): void {
  for (const event of events) {
    const stored = {
      ...event,
      id: event.id ?? PLACEHOLDER_ID,
      seq: PLACEHOLDER_SEQ,
      processed_at: processedAtFor(event.type),
    }
    const parsed = StoredEventSchema.safeParse(stored)
    if (!parsed.success) {
      throw new EventValidationError(event, issuesOf(parsed.error))
    }
  }
}

/** What the schema complained about, as the field paths a reader needs to see. */
function issuesOf(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(event)'}: ${issue.message}`)
    .join('; ')
}
