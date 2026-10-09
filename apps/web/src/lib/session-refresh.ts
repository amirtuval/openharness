import type { Client } from '@openharness/client'
import type { Session } from '@openharness/protocol'

/**
 * The one re-read of a session that its new title needs (issue #35).
 *
 * A session has no title at creation: the server derives one from the first `user.message`,
 * inside the request that stores the message (`apps/server/src/titles.ts`, PR #32). Nothing
 * announces it — the request answers with the stored events rather than the session, and the
 * stream carries log events, not session fields — so a client that loaded the session before
 * that message holds a title that was never there. The chat header and the sidebar row kept
 * showing the agent's name until something reloaded the page.
 *
 * This module is where the one re-read that fixes it happens. It is keyed by client and
 * shared by every {@link sessionRefresh} caller, which is what makes the two surfaces agree:
 * a read answers, subscribers re-render, and each merges the fresh copy into what it already
 * had — the sidebar's list and the open chat's header, without two fetches and without a
 * second copy of the session in a second store.
 *
 * The rules live here, in one place:
 *
 * - **one read per session** — an answered read marks the session done, so nothing polls: a
 *   session the server declined to name (a message with no text to name it after) is not read
 *   again, and neither is one whose title has arrived;
 * - **one read in flight** — a `refresh` while the first is unanswered is dropped, so a burst
 *   of messages is still one request;
 * - **a failed read is not the reader's problem** — the chat itself loaded, and a row showing
 *   the agent's name is the state this app knew before #35 existed. The session is left open
 *   for a later refresh rather than marked done, and nothing is shown.
 */

/** What this store knows about one session. */
interface Entry {
  /** The freshest copy a read has answered with. */
  readonly session?: Session
  /** A read is on its way. */
  readonly reading: boolean
  /** A read has answered; the session is not read again. */
  readonly done: boolean
}

/** The shared store of re-read sessions, one per client. */
export interface SessionRefresh {
  /**
   * The sessions re-read so far, by id.
   *
   * Replaced rather than mutated when a read answers, so `useSyncExternalStore` can compare
   * snapshots by identity and a component only re-renders when there is something new.
   */
  readonly sessions: ReadonlyMap<string, Session>
  /**
   * Read `sessionId` again, unless a read is in flight or has already answered.
   *
   * Fire-and-forget: a caller says "this session may have been named by now — look", and the
   * store decides whether that costs a request. Repeat calls are free.
   */
  readonly refresh: (sessionId: string) => void
  /** Watch for a read to answer. */
  readonly subscribe: (listener: () => void) => () => void
}

/** One store per client: the same fake in a test, or the same server, shares its reads. */
const stores = new WeakMap<Client, SessionRefresh>()

/** The store for `client`, made on first use. */
export function sessionRefresh(client: Client): SessionRefresh {
  const existing = stores.get(client)
  if (existing !== undefined) {
    return existing
  }
  const created = createSessionRefresh(client)
  stores.set(client, created)
  return created
}

/**
 * `sessions`, with every one the store has re-read replaced by the fresh copy.
 *
 * The list keeps its order, and keeps its identity when nothing has been re-read — which is
 * the common case, and the one that must not re-render the sidebar.
 */
export function withFreshSessions(
  sessions: readonly Session[],
  fresh: ReadonlyMap<string, Session>,
): readonly Session[] {
  if (fresh.size === 0) {
    return sessions
  }
  return sessions.map((session) => fresh.get(session.id) ?? session)
}

function createSessionRefresh(client: Client): SessionRefresh {
  const entries = new Map<string, Entry>()
  const listeners = new Set<() => void>()
  let sessions: ReadonlyMap<string, Session> = new Map()

  const refresh = (sessionId: string): void => {
    const entry = entries.get(sessionId)
    if (entry !== undefined && (entry.reading || entry.done)) {
      return
    }
    if (entry?.session !== undefined && entry.session.title !== null) {
      return
    }
    entries.set(sessionId, { reading: true, done: false })
    void client.sessions.get(sessionId).then(
      (session) => {
        entries.set(sessionId, { session, reading: false, done: true })
        const next = new Map(sessions)
        next.set(sessionId, session)
        sessions = next
        for (const listener of listeners) {
          listener()
        }
      },
      () => {
        // Left undone rather than done: a later refresh (the next message, a session
        // reopened) may try once more. Nothing re-triggers one on its own, so this is not
        // a retry loop.
        entries.delete(sessionId)
      },
    )
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  return {
    get sessions(): ReadonlyMap<string, Session> {
      return sessions
    },
    refresh,
    subscribe,
  }
}
