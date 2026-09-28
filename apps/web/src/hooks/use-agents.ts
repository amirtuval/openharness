import type { Client } from '@openharness/client'
import type { Agent, CreateAgentRequest, UpdateAgentRequest } from '@openharness/protocol'
import { useCallback, useEffect, useState } from 'react'

import { describeError } from '../lib/errors'

/** Everything the agents screen needs. */
export interface AgentsView {
  /** The agents, oldest first (the order the server lists them in). */
  readonly agents: readonly Agent[]
  /** The list is still loading for the first time. */
  readonly loading: boolean
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
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const load = async (): Promise<void> => {
      setLoading(true)
      try {
        const response = await client.agents.list({}, { signal: controller.signal })
        if (controller.signal.aborted) {
          return
        }
        setAgents(response.data)
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
  }, [client])

  const create = useCallback(
    async (body: CreateAgentRequest): Promise<Agent | null> => {
      try {
        const created = await client.agents.create(body)
        setAgents((current) => [...current, created])
        setError(null)
        return created
      } catch (caught) {
        setError(describeError(caught))
        return null
      }
    },
    [client],
  )

  const update = useCallback(
    async (id: string, body: UpdateAgentRequest): Promise<Agent | null> => {
      try {
        const updated = await client.agents.update(id, body)
        setAgents((current) => current.map((agent) => (agent.id === id ? updated : agent)))
        setError(null)
        return updated
      } catch (caught) {
        setError(describeError(caught))
        return null
      }
    },
    [client],
  )

  const dismissError = useCallback(() => {
    setError(null)
  }, [])

  return { agents, loading, error, create, update, dismissError }
}
