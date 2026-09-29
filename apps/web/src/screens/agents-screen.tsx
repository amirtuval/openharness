import type { Agent } from '@openharness/protocol'
import { Pencil } from 'lucide-react'
import { useState } from 'react'

import { AgentForm, type AgentFormValues } from '../components/agents/agent-form'
import { useClient } from '../components/client-provider'
import { ErrorBanner } from '../components/chat/error-banner'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { useAgents } from '../hooks/use-agents'
import { MAX_PAGE_ITEMS } from '../lib/paging'

/**
 * The agents: a list, and one form for creating and editing.
 *
 * A session snapshots its agent at creation, so editing here never rewrites an existing
 * conversation — the screen says so, and the code does not have to.
 */
export function AgentsScreen() {
  const client = useClient()
  const { agents, loading, truncated, error, create, update, dismissError } = useAgents(client)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [formVersion, setFormVersion] = useState(0)

  const editing = agents.find((agent) => agent.id === editingId) ?? null

  const save = async (values: AgentFormValues): Promise<void> => {
    setSubmitting(true)
    setNotice(null)
    const body = {
      name: values.name.trim(),
      model: { id: values.model.trim() },
      system: values.system.trim() === '' ? null : values.system,
    }
    const saved = editing === null ? await create(body) : await update(editing.id, body)
    setSubmitting(false)
    if (saved === null) {
      return
    }
    setNotice(editing === null ? `Created ${saved.name}.` : `Saved ${saved.name}.`)
    setEditingId(null)
    setFormVersion((current) => current + 1)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-6 px-6 py-6">
        <div className="space-y-1">
          <h1 className="text-base font-medium">Agents</h1>
          <p className="text-sm text-muted-foreground">
            An agent is a name, a model and a system prompt. Sessions copy it when they are created,
            so editing one never changes a chat that already exists.
          </p>
        </div>

        {error === null ? null : (
          <ErrorBanner title="Agent request failed" message={error} onDismiss={dismissError} />
        )}
        {notice === null ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}

        <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
          <section aria-label="Agent list" className="space-y-3">
            {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {!loading && agents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No agents yet. Create the first one.</p>
            ) : null}
            {truncated ? (
              <p className="text-sm text-muted-foreground">
                and more… only the first {MAX_PAGE_ITEMS} are listed
              </p>
            ) : null}
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                editing={agent.id === editingId}
                onEdit={() => {
                  setEditingId(agent.id)
                  setNotice(null)
                }}
              />
            ))}
          </section>

          <Card className="h-fit">
            <CardHeader>
              <CardTitle>{editing === null ? 'New agent' : `Edit ${editing.name}`}</CardTitle>
            </CardHeader>
            <CardContent>
              <AgentForm
                key={`${editing?.id ?? 'new'}-${formVersion}`}
                agent={editing}
                submitting={submitting}
                submitLabel={editing === null ? 'Create agent' : 'Save changes'}
                onSubmit={save}
                onReset={
                  editing === null
                    ? () => setFormVersion((current) => current + 1)
                    : () => {
                        setEditingId(null)
                        setFormVersion((current) => current + 1)
                      }
                }
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

/** One agent in the list. */
function AgentCard({
  agent,
  editing,
  onEdit,
}: {
  agent: Agent
  editing: boolean
  onEdit: () => void
}) {
  return (
    <Card data-slot="agent-card" className="gap-3 py-4">
      <CardHeader className="px-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-sm">{agent.name}</CardTitle>
            <p className="mt-1 truncate text-xs text-muted-foreground">{agent.model.id}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {editing ? (
              <Badge variant="secondary" className="text-[0.65rem]">
                editing
              </Badge>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Edit ${agent.name}`}
              onClick={onEdit}
            >
              <Pencil aria-hidden="true" />
              Edit
            </Button>
          </div>
        </div>
      </CardHeader>
      {agent.system === null || agent.system.trim() === '' ? null : (
        <CardContent className="px-4 text-xs whitespace-pre-wrap text-muted-foreground">
          {agent.system}
        </CardContent>
      )}
    </Card>
  )
}
