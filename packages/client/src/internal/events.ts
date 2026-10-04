import type { UserEventInput } from '@openharness/protocol'

/**
 * Small event helpers the client and the fake client both need.
 *
 * `send` takes one user event or a list of them — the wire always carries the list — and both
 * the real client and the fake have to tell the two call shapes apart without guessing from the
 * contents of a single event. One implementation, because two would drift (#105).
 */

/** One user event or a list of them, without guessing from the contents of one. */
export function isEventList(
  events: UserEventInput | readonly UserEventInput[],
): events is readonly UserEventInput[] {
  return Array.isArray(events)
}
