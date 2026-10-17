import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  decodePageCursor,
  isEventId,
  type EventId,
  type KeyCursor,
  type ModelConfig,
  type SeqCursor,
  type SessionId,
  type TaskId,
} from '@openharness/protocol'

import { DuplicateEventIdError, SessionNotFoundError } from './errors'

/**
 * The checks every store applies to a caller's arguments before it touches its own state.
 *
 * Both stores — the in-memory fake and the Postgres one — clamp a `limit`, decode an opaque
 * `page` cursor and reject a lease ttl the same way, so a client sees the same answer
 * whichever store it is talking to. What stays with each store is the *order* of the lists
 * and how a keyset cursor is compared: in memory that is an array comparison, in Postgres an
 * `ORDER BY` and a row comparison (the `C` collation is what makes the two agree).
 */

/** The page size to use: `limit` clamped into `[1, MAX_PAGE_LIMIT]`, or the protocol default. */
export function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_PAGE_LIMIT
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_LIMIT)
}

/** Decode the `page` of an events list, which is a `seq` position. */
export function decodeSeqPage(page: string): SeqCursor {
  const cursor = decodePageCursor(page)
  if (cursor.kind !== 'seq') {
    throw new RangeError(`listEvents takes a seq cursor, but got a ${cursor.kind} cursor`)
  }
  return cursor
}

/** Decode the `page` of an agent or session list, which is a keyset position. */
export function decodeKeyPage(page: string): KeyCursor {
  const cursor = decodePageCursor(page)
  if (cursor.kind !== 'key') {
    throw new RangeError(`this list takes a key cursor, but got a ${cursor.kind} cursor`)
  }
  return cursor
}

/**
 * The effective `model` and `system` a new session runs, from the agent it snapshots (if any)
 * and the options the caller gave (issue #93).
 *
 * A session is created from an agent, a model, or both. What it *runs* is one model and one
 * system prompt, always: an explicit `model`/`system` in the options overrides what the agent
 * contributes, and what is omitted falls back to the agent's — `system` to `null` when there
 * is no agent. A `model` with nothing to fall back to cannot be resolved, so it is a
 * `RangeError`: the protocol's `CreateSessionRequest` refinement is what keeps a caller from
 * getting here without one, and this is the same rule one layer down.
 *
 * @throws RangeError when there is no agent and no explicit `model` to fall back to
 */
export function effectiveSessionConfig(
  agent: { readonly model: ModelConfig; readonly system: string | null } | null,
  options: { readonly model?: ModelConfig; readonly system?: string | null },
): { model: ModelConfig; system: string | null } {
  const model = options.model ?? agent?.model
  if (model === undefined) {
    throw new RangeError(
      'a session without an agent needs a model: pass "model", or create it from an agent',
    )
  }
  return {
    model: { id: model.id },
    system: options.system === undefined ? (agent?.system ?? null) : options.system,
  }
}

/** The four tree fields a created session carries (epic #340, S3). */
export interface SessionTreeFields {
  /** The session this one belongs to, or `null` for a top-level chat. */
  readonly parent_session_id: SessionId | null
  /** The `task_` id the parent started it for, or `null`. */
  readonly parent_task_id: TaskId | null
  /** The top-level chat the whole tree hangs off — the session's own id when it is that chat. */
  readonly root_session_id: SessionId
  /** `0` for a top-level chat, one more than the parent's for a child. */
  readonly depth: number
}

/**
 * Where a new session sits in the tree (epic #340, S3), from the options the caller gave and
 * the parent it looked up — or `null` when it looked and found none.
 *
 * A top-level chat is its own root at depth `0`, and a child takes the parent's root, one
 * level deeper, with the task id the parent named. The caller does the lookup — in memory a
 * map, in Postgres a row read inside the creation transaction — and passes `null` when it
 * found nothing, so the one rule about what a tree means lives here rather than in two
 * implementations that could disagree, the split {@link effectiveSessionConfig} uses.
 *
 * The parent must be **the caller's own**: hanging a child off a session somebody else owns
 * would leak that it exists, so it is refused exactly as an agent of another owner is (A4),
 * and which the owner check is the caller's to make (both stores pass `null` for a parent
 * that is not theirs).
 *
 * @param id the id the new session will be stored under: its own root when it is top-level
 * @throws SessionNotFoundError when `options.parentSessionId` names no session the caller owns
 * @throws RangeError when a task id is given with no parent session beside it
 */
export function sessionTree(
  id: SessionId,
  options: { readonly parentSessionId?: SessionId; readonly parentTaskId?: TaskId | null },
  parent: {
    readonly id: SessionId
    readonly root_session_id: SessionId
    readonly depth: number
  } | null,
): SessionTreeFields {
  if (options.parentSessionId === undefined) {
    if (options.parentTaskId !== undefined && options.parentTaskId !== null) {
      throw new RangeError('a task id needs a parent session: pass "parentSessionId" too')
    }
    return { parent_session_id: null, parent_task_id: null, root_session_id: id, depth: 0 }
  }
  if (parent === null || parent.id !== options.parentSessionId) {
    throw new SessionNotFoundError(options.parentSessionId)
  }
  return {
    parent_session_id: parent.id,
    parent_task_id: options.parentTaskId ?? null,
    root_session_id: parent.root_session_id,
    depth: parent.depth + 1,
  }
}

/** A lease only lasts a positive amount of time; anything else is a caller bug, not a lease. */
export function assertTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError(`ttlMs must be a positive, finite number of milliseconds, got ${ttlMs}`)
  }
}

/** A liveness window only makes sense as a positive amount of time, like a lease ttl. */
export function assertLivenessWindow(withinMs: number): void {
  if (!Number.isFinite(withinMs) || withinMs <= 0) {
    throw new RangeError(
      `withinMs must be a positive, finite number of milliseconds, got ${withinMs}`,
    )
  }
}

/**
 * A UTC window's two bounds as milliseconds, checked.
 *
 * {@link SessionStore.listModelRequests} reads between two instants — a caller's local days
 * converted into a half-open UTC window — and a bound that is not an instant, or a window that
 * ends before it starts, is a caller bug and a `RangeError` rather than a silently empty or
 * silently too-large answer. Both stores check it here, so they refuse the same arguments.
 *
 * @throws RangeError when a bound is not a valid instant, or `from` is after `to`
 */
export function usageWindowOf(options: { readonly from: Date; readonly to: Date }): {
  fromMs: number
  toMs: number
} {
  const fromMs = options.from.getTime()
  const toMs = options.to.getTime()
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new RangeError(
      `a usage window must be two instants, got from ${String(options.from)} and to ${String(options.to)}`,
    )
  }
  if (fromMs > toMs) {
    throw new RangeError(
      `a usage window must not end before it starts, got from ${options.from.toISOString()} to ${options.to.toISOString()}`,
    )
  }
  return { fromMs, toMs }
}

/**
 * Check the ids an append is carrying before the store writes anything.
 *
 * An event may bring its own id (see `AppendableEvent`), and the id has to be one the store
 * can use: a valid `sevt_` id, and not the same id twice in one batch. Both stores check that
 * here, and both check it before the first write, because an append is all-or-nothing — a
 * batch the store cannot write is a batch that stores nothing.
 *
 * Whether an id is *free* is each store's own question: it is state, and the two stores keep
 * it in different places (a set of ids in memory, a unique constraint on the table).
 *
 * @throws RangeError when a supplied id is not a valid event id
 * @throws DuplicateEventIdError when the same id is supplied twice in one batch
 */
export function assertEventIds(
  sessionId: SessionId,
  events: readonly { readonly id?: EventId }[],
): void {
  const seen = new Set<EventId>()
  for (const event of events) {
    const id = event.id
    if (id === undefined) {
      continue
    }
    if (!isEventId(id)) {
      throw new RangeError(`not a valid event id: ${JSON.stringify(id)}`)
    }
    if (seen.has(id)) {
      throw new DuplicateEventIdError(sessionId, id)
    }
    seen.add(id)
  }
}
