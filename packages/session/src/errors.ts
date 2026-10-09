import type { AgentId, EventId, SessionId, UserId } from '@openharness/protocol'

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

/** The `code` of a {@link DuplicateEventIdError}. Stable across builds. */
export const DUPLICATE_EVENT_ID_ERROR_CODE = 'duplicate_event_id'

/** The `code` of a {@link ClaimConflictError}. Stable across builds. */
export const CLAIM_CONFLICT_ERROR_CODE = 'claim_conflict'

/** The `code` of a {@link DuplicateModeNameError}. Stable across builds. */
export const DUPLICATE_MODE_NAME_ERROR_CODE = 'duplicate_mode_name'

/** The `code` of a {@link ModeLimitReachedError}. Stable across builds. */
export const MODE_LIMIT_REACHED_ERROR_CODE = 'mode_limit_reached'

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

/**
 * An append was refused because one of its events carries an id the log already holds.
 *
 * An event id is the identity of one event in the whole store, not just in one session: it is
 * what a client replaces a stream-only `event_start`/`event_delta` preview with. So an append
 * that supplies an id may only do so if nothing is stored under it, and if it does not appear
 * twice in the same batch. Either way the whole append is refused — nothing from that batch is
 * stored — and the caller has to pick another id. See {@link SessionStore.appendEvents}.
 */
export class DuplicateEventIdError extends Error {
  /** Stable, machine-readable code; see {@link DUPLICATE_EVENT_ID_ERROR_CODE}. */
  readonly code = DUPLICATE_EVENT_ID_ERROR_CODE

  /** The session the refused append named. */
  readonly sessionId: SessionId

  /** The `sevt_` id the append tried to write a second event under. */
  readonly eventId: EventId

  constructor(sessionId: SessionId, eventId: EventId) {
    super(`event id already exists: ${eventId}`)
    this.name = 'DuplicateEventIdError'
    this.sessionId = sessionId
    this.eventId = eventId
  }
}

/**
 * An append was refused because a `span.model_request_start` could not take the claims it
 * carried (D9, issue #46).
 *
 * A claim is the append of the span start itself — atomic and fenced like any other write —
 * and it can only name user events of the same session that no earlier claim took. The append
 * is refused **whole** when any id it consumes is not a pending `user.message` /
 * `user.interrupt` of this session: a foreign id, an event of another type, an id that names
 * nothing, one that is already claimed (including one this same batch lists twice), and one
 * whose claim was taken by a concurrent write in the moment between this append's validation
 * and its insert. Nothing from that batch is appended, so the caller re-reads the pending
 * events and tries again. See {@link SessionStore.appendEvents}.
 */
export class ClaimConflictError extends Error {
  /** Stable, machine-readable code; see {@link CLAIM_CONFLICT_ERROR_CODE}. */
  readonly code = CLAIM_CONFLICT_ERROR_CODE

  /** The session the refused append named. */
  readonly sessionId: SessionId

  /**
   * The ids that could not be claimed — the pending user events shared with the log and this
   * batch, in the order the batch named them.
   */
  readonly eventIds: readonly EventId[]

  constructor(sessionId: SessionId, eventIds: readonly EventId[]) {
    super(
      `cannot claim ${eventIds.length === 1 ? 'event' : 'events'} in ${sessionId}: ` +
        `${eventIds.join(', ')} ${eventIds.length === 1 ? 'is' : 'are'} not pending user events of this session`,
    )
    this.name = 'ClaimConflictError'
    this.sessionId = sessionId
    this.eventIds = [...eventIds]
  }
}

/**
 * A create was refused because the user already has a mode with that name (epic #245, M6).
 *
 * A mode's name is unique among its owner's modes — it is what a user types (`--mode smart`)
 * and what a mode is picked by — and the uniqueness is enforced by the store (a unique
 * constraint in Postgres), not only checked by the caller, so two concurrent creates cannot
 * both take the same name. The update path raises this too, when a rename would collide.
 */
export class DuplicateModeNameError extends Error {
  /** Stable, machine-readable code; see {@link DUPLICATE_MODE_NAME_ERROR_CODE}. */
  readonly code = DUPLICATE_MODE_NAME_ERROR_CODE

  /** The owner whose modes already include the name. */
  readonly ownerId: UserId

  /** The name that was already taken. */
  readonly modeName: string

  constructor(ownerId: UserId, name: string) {
    super(`a mode named ${JSON.stringify(name)} already exists`)
    this.name = 'DuplicateModeNameError'
    this.ownerId = ownerId
    this.modeName = name
  }
}

/**
 * A create was refused because the user is at {@link MAX_MODES_PER_USER} (epic #245, M6).
 *
 * The cap is a store rule rather than the caller's, because only the store can count a user's
 * modes and insert one without a race between the two.
 */
export class ModeLimitReachedError extends Error {
  /** Stable, machine-readable code; see {@link MODE_LIMIT_REACHED_ERROR_CODE}. */
  readonly code = MODE_LIMIT_REACHED_ERROR_CODE

  /** The owner who is at the limit. */
  readonly ownerId: UserId

  /** The limit that was reached. */
  readonly limit: number

  constructor(ownerId: UserId, limit: number) {
    super(`cannot create a mode: ${ownerId} already has the limit of ${limit}`)
    this.name = 'ModeLimitReachedError'
    this.ownerId = ownerId
    this.limit = limit
  }
}
