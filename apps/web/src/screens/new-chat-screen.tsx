import type { AgentId, Session } from '@openharness/protocol'
import { useState } from 'react'

import { useClient } from '../components/client-provider'
import { Button } from '../components/ui/button'
import { ErrorBanner } from '../components/chat/error-banner'
import { Label } from '../components/ui/label'
import { useAgents } from '../hooks/use-agents'
import { chatHash, navigate } from '../lib/router'

/**
 * Pick an agent, create the session on it, and go.
 *
 * Creating a session is the only way to start a conversation: the session snapshots the
 * agent's model and system prompt at creation, so the agent has to be chosen first. The chat
 * screen focuses the composer as it opens, which is where the cursor should be right after.
 */
export function NewChatScreen({
  createSession,
}: {
  createSession: (agentId: AgentId) => Promise<Session | null>
}) {
  const client = useClient()
  const { agents, loading, error } = useAgents(client)

  const [chosenAgentId, setChosenAgentId] = useState<AgentId | ''>('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // No explicit choice reads as "the first agent", which is what the select shows.
  const selectedAgentId = chosenAgentId === '' ? (agents[0]?.id ?? '') : chosenAgentId

  const start = async (): Promise<void> => {
    if (selectedAgentId === '' || creating) {
      return
    }
    setCreating(true)
    setCreateError(null)
    const session = await createSession(selectedAgentId)
    setCreating(false)
    if (session === null) {
      setCreateError('The session could not be created.')
      return
    }
    navigate(chatHash(session.id))
  }

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-md space-y-5">
        <div className="space-y-1">
          <h1 className="text-base font-medium">New chat</h1>
          <p className="text-sm text-muted-foreground">
            Choose an agent. The session keeps a copy of its model and system prompt.
          </p>
        </div>

        {error === null ? null : <ErrorBanner title="Could not load agents" message={error} />}
        {createError === null ? null : (
          <ErrorBanner
            title="Could not create the chat"
            message={createError}
            onDismiss={() => setCreateError(null)}
          />
        )}

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void start()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-chat-agent">Agent</Label>
            <select
              id="new-chat-agent"
              value={selectedAgentId}
              disabled={loading || agents.length === 0}
              onChange={(event) => {
                // The select's value is a plain string; the agent it names carries the
                // branded id the API wants.
                setChosenAgentId(agents.find((agent) => agent.id === event.target.value)?.id ?? '')
              }}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30"
            >
              {agents.length === 0 ? <option value="">No agents yet</option> : null}
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} · {agent.model.id}
                </option>
              ))}
            </select>
            {loading ? (
              <p className="text-xs text-muted-foreground">Loading agents…</p>
            ) : agents.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Create one on the{' '}
                <a className="underline underline-offset-2" href="#/agents">
                  agents
                </a>{' '}
                screen first.
              </p>
            ) : null}
          </div>

          <Button type="submit" disabled={selectedAgentId === '' || creating}>
            {creating ? 'Creating…' : 'Create chat'}
          </Button>
        </form>
      </div>
    </div>
  )
}
