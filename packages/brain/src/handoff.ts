/**
 * Why a turn was **handed off** rather than interrupted (#378, P1).
 *
 * An abort signal says two different things in this system, and until #378 the brain could not
 * tell them apart: a **person** stopped the turn (Stop, `agent_stop`, a delete's `stopSession`,
 * a rewind), or the **scheduler** is giving this process's work to another one — a shutdown, a
 * partition given up above the instance's share, or a lease somebody else took over.
 *
 * The two must end differently. A user's interrupt is an ending: the partial reply is kept, the
 * span closes `interrupted`, and the session goes idle — nothing more will answer it. A
 * handoff is not an ending at all: the turn is left **open**, the next owner of the partition
 * finds it with `findSessionsNeedingWork`, closes the span a dead brain would have left open as
 * `brain_lost`, and runs the request again. That is the same machinery a crash uses, which is
 * why a rolling restart can be invisible to the reader.
 *
 * The reason travels on the signal itself — `controller.abort(new TurnHandoff('shutdown'))` —
 * so nothing has to be threaded beside the `AbortSignal` the loop already takes. `AbortSignal.any`
 * preserves the reason of whichever source aborted first, so a pass that combines its own
 * interrupt signal with a partition's stop signal carries the right answer either way.
 *
 * This module lives in the brain, and the server constructs it: the dependency table has server
 * depending on brain, never the other way round.
 */

/** What made the scheduler give a turn up. A label for logs and tests, never behaviour. */
export type TurnHandoffCause =
  /** The process is shutting down (`SIGTERM`): a rolling restart, a scale-down. */
  | 'shutdown'
  /** This instance held more partitions than its share and is giving this one back. */
  | 'partition_released'
  /** The lease was refused on renewal, or a fenced write proved it was somebody else's. */
  | 'lease_lost'

/**
 * The abort reason a scheduler uses when it is **not** stopping a turn for a person.
 *
 * Construct one and pass it to `AbortController.abort`; the brain recognizes it with
 * {@link isTurnHandoff} and leaves the turn open instead of ending it. A user-originated abort
 * passes no reason (or any other value), which is what keeps every existing interrupt path
 * exactly as it was.
 */
export class TurnHandoff {
  /**
   * The tag {@link isTurnHandoff} also accepts, so a reason that crossed a bundle boundary —
   * where `instanceof` can fail — is still recognised as a handoff.
   */
  readonly kind = 'turn_handoff' as const

  constructor(readonly cause: TurnHandoffCause = 'shutdown') {}
}

/** Whether a value is a {@link TurnHandoff}, by class or by its tag. */
export function isTurnHandoff(value: unknown): value is TurnHandoff {
  if (value instanceof TurnHandoff) {
    return true
  }
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly kind?: unknown }).kind === 'turn_handoff'
  )
}

/**
 * Whether an abort signal is a handoff rather than a user's interrupt.
 *
 * The one question the turn loop asks of its signal's reason: aborted **and** aborted for this
 * reason. A signal that is not aborted, and one aborted by a person, both answer `false`, so
 * the interrupt lifecycle is unchanged.
 */
export function isHandoffAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && isTurnHandoff(signal.reason)
}
