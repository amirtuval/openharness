import type { Client } from '@openharness/client'
import type { AgentId, Session } from '@openharness/protocol'
import { useCallback, useEffect, useState } from 'react'

import { describeError } from '../lib/errors'
import { appendUnseen, listAllPages } from '../lib/paging'
import { useSettings } from './use-settings'

/** Everything the session list needs, plus creating one. */
export interface SessionsView {
  /** The sessions, newest first. */
  readonly sessions: readonly Session[]
  /** The list is still loading for the first time. */
  readonly loading: boolean
  /** The list hit the safety cap; the server has more sessions than are shown. */
  readonly truncated: boolean
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
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  // A failure of our own is described with the server the client is pointed at, so a request
  // that never arrived can say where it did not arrive.
  const { serverUrl } = useSettings()

  useEffect(() => {
    const controller = new AbortController()
    const load = async (): Promise<void> => {
      setLoading(true)
      // All of them, one page at a time: the sidebar is the only way to an older chat, so a
      // list that stops after the first page hides those chats for good.
      let firstPage = true
      try {
        const result = await listAllPages(
          (query, options) => client.sessions.list(query, options),
          {
            signal: controller.signal,
            onPage: (page) => {
              if (controller.signal.aborted) {
                return
              }
              // The first page shows as soon as it arrives — the sidebar stays usable while
              // the rest of a long list loads behind it.
              if (firstPage) {
                firstPage = false
                setSessions(page)
              } else {
                setSessions((current) => appendUnseen(current, page))
              }
            },
          },
        )
        if (controller.signal.aborted) {
          return
        }
        setTruncated(result.truncated)
        setError(null)
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(describeError(caught, { serverUrl }))
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    }

    void load()
    return () => controller.abort()
  }, [client, revision, serverUrl])

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
        setError(describeError(caught, { serverUrl }))
        return null
      }
    },
    [client, serverUrl],
  )

  return { sessions, loading, truncated, error, create, refresh }
}
