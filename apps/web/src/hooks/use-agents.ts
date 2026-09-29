import type { Client } from '@openharness/client'
import type { Agent, CreateAgentRequest, UpdateAgentRequest } from '@openharness/protocol'
import { useCallback, useEffect, useState } from 'react'

import { describeError } from '../lib/errors'
import { appendUnseen, listAllPages } from '../lib/paging'
import { useSettings } from './use-settings'

/** Everything the agents screen needs. */
export interface AgentsView {
  /** The agents, oldest first (the order the server lists them in). */
  readonly agents: readonly Agent[]
  /** The list is still loading for the first time. */
  readonly loading: boolean
  /** The list hit the safety cap; the server has more agents than are shown. */
  readonly truncated: boolean
  /** A failed list, create or update, as shown inline. */
  readonly error: string | null
  /** Create an agent; returns it, or `null` when it failed. */
  readonly create: (body: CreateAgentRequest) => Promise<Agent | null>
  /** Update an agent; returns it, or `null` when it failed. */
  readonly update: (id: string, body: UpdateAgentRequest) => Promise<Agent | null>
  /** Clear the inline error. */
  readonly dismissError: () => void
}

/** The agent list, and creating and editing agents. */
export function useAgents(client: Client): AgentsView {
  const [agents, setAgents] = useState<readonly Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A failure of our own is described with the server the client is pointed at, so a request
  // that never arrived can say where it did not arrive.
  const { serverUrl } = useSettings()

  useEffect(() => {
    const controller = new AbortController()
    const load = async (): Promise<void> => {
      setLoading(true)
      // Every page of the list, not just the first one: an agent that is never rendered is an
      // agent whose system prompt cannot be reached from this screen at all.
      let firstPage = true
      try {
        const result = await listAllPages((query, options) => client.agents.list(query, options), {
          signal: controller.signal,
          onPage: (page) => {
            if (controller.signal.aborted) {
              return
            }
            // The first page is set as it arrives; the rest are appended, so a long list
            // renders while the remaining pages are still in flight.
            if (firstPage) {
              firstPage = false
              setAgents(page)
            } else {
              setAgents((current) => appendUnseen(current, page))
            }
          },
        })
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
  }, [client, serverUrl])

  const create = useCallback(
    async (body: CreateAgentRequest): Promise<Agent | null> => {
      try {
        const created = await client.agents.create(body)
        setAgents((current) => [...current, created])
        setError(null)
        return created
      } catch (caught) {
        setError(describeError(caught, { serverUrl }))
        return null
      }
    },
    [client, serverUrl],
  )

  const update = useCallback(
    async (id: string, body: UpdateAgentRequest): Promise<Agent | null> => {
      try {
        const updated = await client.agents.update(id, body)
        setAgents((current) => current.map((agent) => (agent.id === id ? updated : agent)))
        setError(null)
        return updated
      } catch (caught) {
        setError(describeError(caught, { serverUrl }))
        return null
      }
    },
    [client, serverUrl],
  )

  const dismissError = useCallback(() => {
    setError(null)
  }, [])

  return { agents, loading, truncated, error, create, update, dismissError }
}
