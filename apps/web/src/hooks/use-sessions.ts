import type { Client } from '@openharness/client'
import type { AgentId, Session } from '@openharness/protocol'
import { useCallback, useEffect, useState } from 'react'

import { describeError } from '../lib/errors'

/** How many sessions the sidebar loads. The server lists newest first. */
const SESSION_PAGE_SIZE = 50

/** Everything the session list needs, plus creating one. */
export interface SessionsView {
  /** The sessions, newest first. */
  readonly sessions: readonly Session[]
  /** The list is still loading for the first time. */
  readonly loading: boolean
  /** A failed list or create, as shown inline. */
  readonly error: string | null
  /** Create a session on `agentId`, refresh the list, and return it (`null` on failure). */
  readonly create: (agentId: AgentId) => Promise<Session | null>
  /** Load the list again. */
  readonly refresh: () => void
}

/** The session list, and creating a session on an agent. */
export function useSessions(client: Client): SessionsView {
  const [sessions, setSessions] = useState<readonly Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const load = async (): Promise<void> => {
      setLoading(true)
      try {
        const response = await client.sessions.list(
          { limit: SESSION_PAGE_SIZE },
          { signal: controller.signal },
        )
        if (controller.signal.aborted) {
          return
        }
        setSessions(response.data)
        setError(null)
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(describeError(caught))
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    }

    void load()
    return () => controller.abort()
  }, [client, revision])

  const refresh = useCallback(() => {
    setRevision((current) => current + 1)
  }, [])

  const create = useCallback(
    async (agentId: AgentId): Promise<Session | null> => {
      try {
        const session = await client.sessions.create({ agent: agentId })
        setSessions((current) => [session, ...current])
        setError(null)
        return session
      } catch (caught) {
        setError(describeError(caught))
        return null
      }
    },
    [client],
  )

  return { sessions, loading, error, create, refresh }
}
