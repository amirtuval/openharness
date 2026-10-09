import { EVENT_TYPES } from '@openharness/protocol'
import type { PartitionSignalKind } from '@openharness/session'

/**
 * What the scheduler is told after user input lands in a session's log: `interrupt` for a
 * `user.interrupt`, `work` for a `user.message`.
 *
 * The interrupt is signalled first on purpose. A batch that carries both means "stop, then
 * answer this", and signalling `work` first would start a turn only to abort it.
 *
 * An interrupt on its own still signals: if no turn is running there is nothing to abort, but
 * the event is in the log and somebody has to claim it, which is exactly what a turn does with
 * a queued `user.interrupt`.
 *
 * Both ways user input enters a session use this — `POST …/events` and the `initial_events` a
 * session is created with — so they cannot drift apart.
 */
export function signalKinds(events: readonly { readonly type: string }[]): PartitionSignalKind[] {
  const kinds: PartitionSignalKind[] = []
  if (events.some((event) => event.type === EVENT_TYPES.userInterrupt)) {
    kinds.push('interrupt')
  }
  if (events.some((event) => event.type === EVENT_TYPES.userMessage)) {
    kinds.push('work')
  }
  return kinds
}
