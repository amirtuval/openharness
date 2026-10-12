import { listChildren, type Client } from '@openharness/client'
import type { Session } from '@openharness/protocol'
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
 * is nested as soon as it is opened (`refresh`, which the shell calls when the open chat's tasks
 * change) or when the list is loaded again. The alternative — a probe per row of a list the cap
 * allows to reach a thousand — is a page load nothing about this screen justifies.
 *
 * A chat whose children could not be read is recorded as having none rather than retried, so a
 * server that refuses one id does not turn into a request per render. The failure says nothing on
 * screen: a sidebar that cannot nest is still a sidebar, and the reader is not blocked.
 */
export interface SessionTreeView {
  /** The children of a chat, in the order the server lists them — `[]` when it has none. */
  readonly childrenOf: (sessionId: string) => readonly Session[]
  /** Ask about one chat again now — a task started or finished under it. */
  readonly refresh: (sessionId: string) => void
}

/** How many of the newest chats a list load asks about. One page's worth, roughly. */
export const CHILD_PROBE_LIMIT = 20

/** How many of those questions are in flight at once. */
const CHILD_PROBE_CONCURRENCY = 4

export function useSessionTree(client: Client, sessions: readonly Session[]): SessionTreeView {
  const [children, setChildren] = useState<ReadonlyMap<string, readonly Session[]>>(() => new Map())
  // The chats already asked about, so a re-render — or the same list arriving again — is not a
  // second walk. A `Set` in a ref rather than state: it decides what to fetch, and nothing renders
  // from it.
  const asked = useRef(new Set<string>())
  const [revision, setRevision] = useState(0)
  // The ids to look at, newest first. Keyed by this rather than by the array, so the effect re-runs
  // when the *list* changes and not on every re-render that rebuilt the same array.
  const wanted = useMemo(
    () => sessions.slice(0, CHILD_PROBE_LIMIT).map((session) => session.id),
    [sessions],
  )

  useEffect(() => {
    const pending = wanted.filter((id) => !asked.current.has(id))
    if (pending.length === 0) {
      return
    }
    const controller = new AbortController()
    for (const id of pending) {
      asked.current.add(id)
    }
    let next = 0
    const probe = async (): Promise<void> => {
      for (;;) {
        const sessionId = pending[next]
        next += 1
        if (sessionId === undefined || controller.signal.aborted) {
          return
        }
        try {
          const found = await listChildren(client.sessions, sessionId, {
            signal: controller.signal,
          })
          if (!controller.signal.aborted) {
            setChildren((current) => new Map(current).set(sessionId, found))
          }
        } catch (caught) {
          if (!controller.signal.aborted) {
            noteAuthenticationError(client, caught)
            setChildren((current) => new Map(current).set(sessionId, []))
          }
        }
      }
    }
    void Promise.all(Array.from({ length: CHILD_PROBE_CONCURRENCY }, probe))
    return () => controller.abort()
  }, [client, wanted, revision])

  const childrenOf = useCallback(
    (sessionId: string): readonly Session[] => children.get(sessionId) ?? [],
    [children],
  )

  const refresh = useCallback((sessionId: string): void => {
    asked.current.delete(sessionId)
    setRevision((current) => current + 1)
  }, [])

  return useMemo(() => ({ childrenOf, refresh }), [childrenOf, refresh])
}
