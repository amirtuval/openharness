import { sessionBreadcrumb, type Client } from '@openharness/client'
import type { Session } from '@openharness/protocol'
import { useEffect, useRef, useState } from 'react'

import { noteAuthenticationError } from '../lib/auth-store'

/**
 * The chain from a session up to the top-level chat it hangs off, **root first** (epic #340,
 * S1/S3; issue #346).
 *
 * A child is a real session with a `parent_session_id`, so the breadcrumb is a walk of ordinary
 * reads — `sessionBreadcrumb` in `@openharness/client`, which stops on a parent it has already
 * seen rather than trusting a server that answered a cycle. This hook is the React binding: it
 * walks when the session is a child, and answers `null` for a top-level chat (nothing to
 * breadcrumb) and while the walk is in flight.
 *
 * **Nothing is fetched for a top-level chat**, which is what keeps the walk from being a read on
 * every chat a reader opens. A chain that cannot be read (the parent was deleted, the request was
 * refused) answers `null` as well: a breadcrumb is navigation, not content, and a failure banner
 * over somebody's conversation would be worse than none. The chat's own header still names the
 * session, and the reader got here from a card, so nothing is lost.
 *
 * @param client the app's client
 * @param session the open session, or `null` while it is still loading
 */
export function useSessionBreadcrumb(
  client: Client,
  session: Session | null,
): readonly Session[] | null {
  const [chain, setChain] = useState<readonly Session[] | null>(null)
  // The freshest session, so the walk can be keyed by the two fields it reads rather than by an
  // object a re-read rebuilds (the title arriving, a re-read after the first message).
  const latest = useRef<Session | null>(session)
  latest.current = session
  const sessionId = session?.id ?? null
  const parentId = session?.parent_session_id ?? null

  useEffect(() => {
    const opened = latest.current
    // A top-level chat has nothing above it, and a session that has not loaded yet has nothing to
    // walk from: both answer no breadcrumb rather than starting a read.
    if (opened === null || sessionId === null || parentId === null) {
      setChain(null)
      return
    }
    const controller = new AbortController()
    const walk = async (): Promise<void> => {
      try {
        const walked = await sessionBreadcrumb(client.sessions, opened, {
          signal: controller.signal,
        })
        if (!controller.signal.aborted) {
          setChain(walked)
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          // A 401 still signs the app out; anything else is swallowed on purpose (see above).
          noteAuthenticationError(client, caught)
          setChain(null)
        }
      }
    }
    void walk()
    return () => controller.abort()
  }, [client, sessionId, parentId])

  return chain
}
