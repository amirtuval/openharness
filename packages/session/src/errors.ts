import type { AgentId, SessionId } from '@openharness/protocol'

/**
 * The errors a {@link SessionStore} throws.
 *
 * They are thrown, not returned, because none of them is a normal outcome: a fenced write is
 * a write the caller was not allowed to make, and a missing session is a caller bug rather
 * than an empty log.
 *
 * Each class carries a stable `code` in addition to its `name`, so a caller that received the
 * error from another copy of this package — a store built against a different bundle, a
 * duplicated `node_modules` — can still recognise it. That is what {@link isFencedError} is
 * for; `instanceof` remains the first thing to try.
 */

/** The `code` of a {@link FencedError}. Stable across builds. */
export const FENCED_ERROR_CODE = 'fenced'

/** The `code` of a {@link SessionNotFoundError}. Stable across builds. */
export const SESSION_NOT_FOUND_ERROR_CODE = 'session_not_found'

/** The `code` of a {@link AgentNotFoundError}. Stable across builds. */
export const AGENT_NOT_FOUND_ERROR_CODE = 'agent_not_found'

/** What a {@link FencedError} reports: which write, which partition, and why it was refused. */
export interface FencedErrorDetails {
  /** The partition the write carried a fence for. */
  readonly partition: number
  /** The epoch the caller's fence claimed. */
  readonly epoch: number
  /** The partition's current epoch — the one a fence would have had to carry; `0` when the partition has never been leased. */
  readonly currentEpoch: number
  /** The method that refused the write, e.g. `appendEvents`. */
  readonly operation: string
}

/**
 * A write was refused because its fence is no longer current.
 *
 * A `SessionStore` write carrying `fence: { partition, epoch }` is accepted only while the
 * partition lease it names is live and still holds that epoch. A brain whose partition was
 * taken over — its lease expired, or it was released, or another owner acquired it — writes
 * with a stale epoch and gets this error, which is what stops a zombie brain from appending to
 * a session somebody else now owns. See {@link SessionStore.acquirePartition}.
 */
export class FencedError extends Error {
  /** Stable, machine-readable code; see {@link FENCED_ERROR_CODE}. */
  readonly code = FENCED_ERROR_CODE

  /** The partition the write carried a fence for. */
  readonly partition: number

  /** The epoch the caller's fence claimed. */
  readonly epoch: number

  /** The partition's current epoch; `0` when the partition has never been leased. */
  readonly currentEpoch: number

  /** The method that refused the write. */
  readonly operation: string

  constructor(details: FencedErrorDetails) {
    // Deliberately not "the epoch is stale": a lease that expired without anyone taking it over
    // leaves the epoch current and the partition unowned, and that has to read as clearly as a
    // takeover does.
    super(
      `${details.operation} fenced: partition ${details.partition} is not held at epoch ` +
        `${details.epoch} (the partition's epoch is ${details.currentEpoch})`,
    )
    this.name = 'FencedError'
    this.partition = details.partition
    this.epoch = details.epoch
    this.currentEpoch = details.currentEpoch
    this.operation = details.operation
  }
}

/**
 * Whether `value` is a {@link FencedError}.
 *
 * `instanceof` first, then the stable `name`/`code` pair: a store reached through a second
 * copy of this package would throw that copy's class, which no `instanceof` check here can
 * match, and the brain and the server have to detect a fenced write either way.
 */
export function isFencedError(value: unknown): value is FencedError {
  if (value instanceof FencedError) {
    return true
  }
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate: Partial<FencedError> = value
  return candidate.name === 'FencedError' && candidate.code === FENCED_ERROR_CODE
}

/** A session-scoped method was called with an id no session has. */
export class SessionNotFoundError extends Error {
  /** Stable, machine-readable code; see {@link SESSION_NOT_FOUND_ERROR_CODE}. */
  readonly code = SESSION_NOT_FOUND_ERROR_CODE

  /** The `sesn_` id that does not name a session. */
  readonly sessionId: SessionId

  constructor(sessionId: SessionId) {
    super(`session not found: ${sessionId}`)
    this.name = 'SessionNotFoundError'
    this.sessionId = sessionId
  }
}

/** A session was created with an agent id no agent has. */
export class AgentNotFoundError extends Error {
  /** Stable, machine-readable code; see {@link AGENT_NOT_FOUND_ERROR_CODE}. */
  readonly code = AGENT_NOT_FOUND_ERROR_CODE

  /** The `agent_` id that does not name an agent. */
  readonly agentId: AgentId

  constructor(agentId: AgentId) {
    super(`agent not found: ${agentId}`)
    this.name = 'AgentNotFoundError'
    this.agentId = agentId
  }
}
