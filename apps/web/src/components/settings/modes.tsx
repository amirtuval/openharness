import type { Mode } from '@openharness/protocol'
import { useState } from 'react'

import type { ModesView } from '../../hooks/use-modes'
import type { ModelsView } from '../../hooks/use-models'
import { useTools } from '../../hooks/use-tools'
import { modeLabel } from '../../lib/modes'
import { useClient } from '../client-provider'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { ModeFormDialog } from './mode-form-dialog'

/**
 * Settings → Modes (#245, M6): the reader's named presets.
 *
 * The list, an empty state and "Create mode", with Edit and an in-page Delete on every row —
 * the shape the Providers card uses, because a mode is the same kind of thing: a small per-user
 * resource with a name. Deleting a mode does not touch the chats that followed it: they
 * continue on the model they last ran, which is what the Delete button's confirmation says.
 *
 * Since #307 a mode may also override **which built-in tools are on** for the chats that follow
 * it, so this card reads the deployment's tool list once (the same `GET /v1/me/tools` the Tools
 * card reads) and hands it to the editor. The panel beside the modes is where those overrides
 * are made.
 */
export function ModesCard({ modes, catalog }: { modes: ModesView; catalog: ModelsView }) {
  const client = useClient()
  const { tools } = useTools(client)
  const [editing, setEditing] = useState<Mode | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const openCreate = (): void => {
    setEditing(null)
    setDialogOpen(true)
  }

  const openEdit = (mode: Mode): void => {
    setEditing(mode)
    setDialogOpen(true)
  }

  const remove = async (mode: Mode): Promise<void> => {
    setFailure(null)
    const result = await modes.remove(mode.id)
    setConfirming(null)
    if (!result.ok) {
      setFailure(result.message)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Modes</CardTitle>
          <Button type="button" variant="outline" size="sm" onClick={openCreate}>
            Create mode
          </Button>
        </div>
        <CardDescription>
          A mode is a name for a model, a reasoning effort and a system-prompt addition. Pick one
          instead of a model to run a chat the same way every time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {modes.loading ? (
          <p className="text-sm text-muted-foreground">Loading your modes…</p>
        ) : null}
        {modes.error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {modes.error}{' '}
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto p-0"
              onClick={() => void modes.reload()}
            >
              Try again
            </Button>
          </p>
        )}
        {failure === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}

        {!modes.loading && modes.modes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No modes yet. Create one to save a model, an effort and a prompt addition behind a name
            such as <code className="font-mono">smart</code>.
          </p>
        ) : null}

        <ul className="space-y-1">
          {modes.modes.map((mode) => (
            <li
              key={mode.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{mode.name}</p>
                <p className="truncate text-xs text-muted-foreground">{modeLabel(mode)}</p>
                {mode.tools === null ? null : (
                  <p className="truncate text-xs text-muted-foreground" data-slot="mode-tools">
                    tools: {describeModeTools(mode)}
                  </p>
                )}
              </div>
              {confirming === mode.id ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Delete? Chats that use it keep their model.
                  </span>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => void remove(mode)}
                  >
                    Delete
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirming(null)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <Button type="button" variant="ghost" size="sm" onClick={() => openEdit(mode)}>
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => {
                      setFailure(null)
                      setConfirming(mode.id)
                    }}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>

      <ModeFormDialog
        open={dialogOpen}
        mode={editing}
        modes={modes}
        catalog={catalog}
        tools={tools?.data ?? []}
        onSaved={() => setDialogOpen(false)}
        onClose={() => setDialogOpen(false)}
      />
    </Card>
  )
}

/**
 * What a mode's tool override says, as the row's one-line summary: "web_search on · todo_write
 * off", plus a count of the remote MCP servers it names (#312).
 *
 * A mode may also carry `mcp_servers` — a per-**server** on/off patch, keyed by an opaque
 * `mcps_` id — which this editor does not offer yet (#313). Counting them rather than printing
 * their ids is what keeps the line honest: a mode that says something about servers must not
 * read as one that "follows your settings".
 */
function describeModeTools(mode: Mode): string {
  const builtin = mode.tools?.builtin ?? {}
  const parts = Object.entries(builtin).map(([name, on]) => `${name} ${on ? 'on' : 'off'}`)
  const servers = Object.keys(mode.tools?.mcp_servers ?? {}).length
  if (servers > 0) {
    parts.push(servers === 1 ? '1 MCP server' : `${servers} MCP servers`)
  }
  return parts.length === 0 ? 'follow your settings' : parts.join(' · ')
}
