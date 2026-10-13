import { listChildren, type Client } from '@openharness/client'
import type { Session, SessionId } from '@openharness/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { noteAuthenticationError } from '../lib/auth-store'

/**
 * The children of the chats the sidebar lists (epic #340, S1/S3; issue #346).
 *
 * A child is a real session with a parent, and `GET /v1/sessions` lists the caller's **top-level**
 * chats only — so a subagent never appears in the sidebar as a chat of its own. Where it does
 * appear is nested under the chat that started it, and this hook is the read behind that:
 * `listChildren` asks each chat for its children, and the sidebar draws a group under the ones
 * that have some.
 *
 * **A chat is asked once, and only the newest few are asked at all.** The count and the running
 * dot have to be known *before* the group is expanded — that is what "collapsed by default, with a
 * count" means — so the read cannot wait for a click, and there is no route that answers for the
 * whole list at once. {@link CHILD_PROBE_LIMIT} therefore bounds the work to the newest page's
 * worth of chats, which is the part of the list a reader is actually working in; a chat below it
 * is nested as soon as it is opened (`refresh`) or when the list is loaded again. The alternative
 * — a probe per row of a list the cap allows to reach a thousand — is a page load nothing about
 * this screen justifies.
 *
 * A chat whose children could not be read is recorded as having none rather than retried, so a
 * server that refuses one id does not turn into a request per render. The failure says nothing on
 * screen: a sidebar that cannot nest is still a sidebar, and the reader is not blocked.
 */
export interface SessionTreeView {
  /** The children of a chat, in the order the server lists them — `[]` when it has none. */
  readonly childrenOf: (sessionId: string) => readonly Session[]
  /** Ask about one chat again now — a helper started or finished under it. */
  readonly refresh: (sessionId: string) => void
}

/** How many of the newest chats a list load asks about. One page's worth, roughly. */
export const CHILD_PROBE_LIMIT = 20

/** How many of those questions are in flight at once. */
const CHILD_PROBE_CONCURRENCY = 4

/** The chats a list load has already been asked about — the ones the *sweep* should not repeat. */
type Answered = Set<string>

export function useSessionTree(client: Client, sessions: readonly Session[]): SessionTreeView {
  const [children, setChildren] = useState<ReadonlyMap<string, readonly Session[]>>(() => new Map())
  // The chats the sweep has asked about, and the ones a read is in flight for. Both are refs:
  // they decide what to fetch, and nothing renders from either.
  const answered = useRef<Answered>(new Set())
  const inFlight = useRef<Set<string>>(new Set())
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )
  // The ids a list load sweeps, newest first. Keyed by this rather than by the array, so the
  // sweep re-runs when the *list* changes and not on every re-render that rebuilt the same array.
  const wanted = useMemo(
    () => sessions.slice(0, CHILD_PROBE_LIMIT).map((session) => session.id),
    [sessions],
  )

  /**
   * Read one chat's children and record them, unless a read for it is already in flight.
   *
   * `undefined` means "nothing changed": a chat already being read is left to that read rather
   * than answered twice, which is what keeps a refresh that lands in the middle of a sweep from
   * being a second request for the same session.
   */
  const probe = useCallback(
    async (sessionId: string): Promise<void> => {
      if (inFlight.current.has(sessionId)) {
        return
      }
      inFlight.current.add(sessionId)
      try {
        // The ids this is handed are the list's own and the open route's, which carry a `sesn_`
        // id; `listChildren` takes the protocol's branded one, and the two callers meet at the
        // string a route holds.
        const found = await listChildren(client.sessions, sessionId as SessionId)
        if (!mounted.current) {
          return
        }
        setChildren((current) => new Map(current).set(sessionId, found))
      } catch (caught) {
        if (mounted.current) {
          noteAuthenticationError(client, caught)
          setChildren((current) => new Map(current).set(sessionId, []))
        }
      } finally {
        inFlight.current.delete(sessionId)
      }
    },
    [client],
  )

  // The sweep: every chat in the newest page the list has not been asked about yet, a few at a
  // time. It is what puts a group under a chat the first time the sidebar draws it.
  useEffect(() => {
    const pending = wanted.filter((id) => !answered.current.has(id))
    if (pending.length === 0) {
      return
    }
    for (const id of pending) {
      answered.current.add(id)
    }
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const sessionId = pending[next]
        next += 1
        if (sessionId === undefined) {
          return
        }
        await probe(sessionId)
      }
    }
    void Promise.all(Array.from({ length: CHILD_PROBE_CONCURRENCY }, worker))
  }, [probe, wanted])

  const childrenOf = useCallback(
    (sessionId: string): readonly Session[] => children.get(sessionId) ?? [],
    [children],
  )

  /**
   * Read one chat's children again, now.
   *
   * The read starts here rather than being flagged for the sweep to notice: the two callers are a
   * chat whose tasks just moved and a chat that was just opened, and both want the answer now —
   * waiting for a state round trip to re-run the sweep is a race the sweep can lose (its own
   * in-flight read for the same chat answers with what was true before). The chat stays in the
   * sweep's answered set, so a refresh is one request and not one per render.
   */
  const refresh = useCallback(
    (sessionId: string): void => {
      answered.current.add(sessionId)
      void probe(sessionId)
    },
    [probe],
  )

  return useMemo(() => ({ childrenOf, refresh }), [childrenOf, refresh])
}
