import type { McpServer, Mode, Skill } from '@openharness/protocol'
import { useState } from 'react'

import type { ModesView } from '../../hooks/use-modes'
import type { SkillsView } from '../../hooks/use-skills'
import { useMcpServers } from '../../hooks/use-mcp-servers'
import type { ModelsView } from '../../hooks/use-models'
import { useTools } from '../../hooks/use-tools'
import { modeLabel } from '../../lib/modes'
import { useClient } from '../client-provider'
import { Badge } from '../ui/badge'
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
 * card reads) and hands it to the editor. A mode may also turn a whole remote MCP server
 * (#311/#313) or a whole imported skill (epic #349, K8; #353) on or off, so the editor gets
 * those two lists — the reader's servers and the shell's skills — as well. The panel beside the
 * modes is where all of those overrides are made.
 */
export function ModesCard({
  modes,
  catalog,
  skills,
}: {
  modes: ModesView
  catalog: ModelsView
  /** The shell's skills (epic #349, K8; #353): a mode may turn a whole skill on or off. */
  skills: SkillsView
}) {
  const client = useClient()
  const { tools } = useTools(client)
  // A mode may also turn a whole remote MCP server on or off (#311; #313), so the editor needs
  // the reader's servers to offer them — the same list the MCP servers card reads.
  const { servers } = useMcpServers(client)
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
          instead of a model to run a chat the same way every time. A mode with a{' '}
          <strong>subagent description</strong> is also a kind of helper a chat&apos;s model can
          start.
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
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <span className="truncate">{mode.name}</span>
                  {/* A mode with a description is a **subagent type** (#342; #346): the mark is
                      what tells the two kinds of mode apart at a glance in a list where the
                      difference is otherwise one empty field. */}
                  {mode.subagent_description === null ? null : (
                    <Badge variant="coral" className="text-2xs" data-slot="mode-subagent">
                      subagent type
                    </Badge>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">{modeLabel(mode)}</p>
                {mode.subagent_description === null ? null : (
                  <p
                    data-slot="mode-subagent-description"
                    className="line-clamp-2 text-xs text-muted-foreground italic"
                  >
                    {mode.subagent_description}
                  </p>
                )}
                {mode.tools === null ? null : (
                  <p className="truncate text-xs text-muted-foreground" data-slot="mode-tools">
                    tools: {describeModeTools(mode, servers, skills.skills)}
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
        mcpServers={servers}
        skills={skills.skills}
        onSaved={() => setDialogOpen(false)}
        onClose={() => setDialogOpen(false)}
      />
    </Card>
  )
}

/**
 * What a mode's tool override says, as the row's one-line summary: "web_search on · todo_write
 * off · notes on".
 *
 * Every half is named: a built-in tool by its own name, and a remote MCP server (#311/#313) or
 * an imported skill (epic #349, K8; #353) by the name the reader gave it — a patch keyed by an
 * opaque `mcps_`/`skl_` id is not something a row can show, and a mode that says something about
 * one must not read as one that "follows your settings". An entry the mode names and the reader
 * has since deleted is called what it is rather than dropped: the patch still names it, and the
 * server ignores it.
 *
 * @param mode the mode whose override is described
 * @param servers the reader's servers, for the names
 * @param skills the reader's skills, for the names
 */
function describeModeTools(
  mode: Mode,
  servers: readonly McpServer[],
  skills: readonly Skill[],
): string {
  const builtin = mode.tools?.builtin ?? {}
  const parts = Object.entries(builtin).map(([name, on]) => `${name} ${on ? 'on' : 'off'}`)
  const ids: Record<string, boolean> = {
    ...(mode.tools?.mcp_servers ?? {}),
    ...(mode.tools?.skills ?? {}),
  }
  for (const [id, on] of Object.entries(ids)) {
    // One lookup across both id-keyed halves: a server and a skill are told apart by their id
    // prefix (`mcps_` against `skl_`), so a name cannot be read from the wrong list.
    const name =
      servers.find((server) => server.id === id)?.name ??
      skills.find((skill) => skill.id === id)?.name ??
      (id.startsWith('skl_') ? 'a removed skill' : 'a removed server')
    parts.push(`${name} ${on ? 'on' : 'off'}`)
  }
  return parts.length === 0 ? 'follow your settings' : parts.join(' · ')
}
