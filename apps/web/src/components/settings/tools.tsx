import type { ToolPermission, ToolSettingEntry } from '@openharness/protocol'
import { useState } from 'react'

import { useTools } from '../../hooks/use-tools'
import { TOOL_PERMISSIONS } from '../../lib/tools'
import { useClient } from '../client-provider'
import { ErrorBanner } from '../chat/error-banner'
import { Badge } from '../ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Label } from '../ui/label'

/**
 * Settings → Tools (epic #303, X4; #307; the screen is #308; the remote half, #312).
 *
 * Which of the build's tools a chat may use, and the permission each call is evaluated under —
 * the reader's own choices, stored on the server (`GET`/`PUT /v1/me/tools`) so the web app and
 * `oh` agree. Each row is one tool:
 *
 * - **on or off** (`enabled`) — off means the tool is not in a request's offer at all, so the
 *   model cannot see it;
 * - **the permission** — `allow` runs a call, `ask` pauses the turn for the reader (#309 answers
 *   it; the prompt itself is #310), and `deny` refuses every call. The tool's own declared
 *   permission is the third choice, shown as "Default (allow)";
 * - **whether it is here at all** — a tool this deployment does not register (`web_search` with
 *   no operator key, say) is listed as unavailable rather than hidden, with its default named as
 *   unknown, so a reader sees why it does nothing. It is never offered whatever the switch says.
 *
 * A write is per tool: the server merges, so flipping one row never rewrites the others, and the
 * answer it returns (the effective list) replaces what the card shows.
 *
 * **The remote MCP tools are listed, grouped by the server they belong to** (#312). They are not
 * editable here yet: a remote tool has no on/off of its own — a whole server is on or off, and
 * a mode patches that — so the full remote half of this screen is #313. What this card owes a
 * reader until then is that the entries are *shown* — a tool that silently vanished from the
 * list would read as one that does not exist — which is why they get their own groups and their
 * own read-only rows rather than being passed through a control that would write the wrong map.
 */
export function ToolsCard() {
  const client = useClient()
  const { tools, loading, error, saving, save, dismissError } = useTools(client)
  const [failure, setFailure] = useState<string | null>(null)

  const write = async (name: string, setting: ToolSettingEntry): Promise<void> => {
    setFailure(null)
    const result = await save(name, { enabled: setting.enabled, policy: setting.policy })
    if (!result.ok) {
      setFailure(result.message)
    }
  }

  const builtin = tools?.data.filter((entry) => entry.source !== 'mcp') ?? []
  const servers = mcpServerGroups(tools?.data ?? [])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Tools</CardTitle>
        <CardDescription>
          What your chats may do on their own. A tool that is off is never offered to the model; the
          permission decides what happens when one is called — run it, ask you first, or refuse it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error === null ? null : (
          <ErrorBanner title="Could not load your tools" message={error} onDismiss={dismissError} />
        )}
        {failure === null ? null : (
          <ErrorBanner
            title="Could not save the tool setting"
            message={failure}
            onDismiss={() => setFailure(null)}
          />
        )}

        {loading || tools === null ? (
          <p className="text-sm text-muted-foreground">Loading your tools…</p>
        ) : (
          <ul className="space-y-3" data-slot="tools-list">
            {builtin.map((entry) => (
              <ToolRow
                key={entry.name}
                entry={entry}
                saving={saving}
                onChange={(next) => void write(entry.name, next)}
              />
            ))}
          </ul>
        )}

        {servers.map((group) => (
          <section
            key={group.server}
            data-slot="mcp-server-group"
            data-server={group.server}
            className="space-y-3"
          >
            <div>
              <h4 className="text-sm font-medium">MCP · {group.server}</h4>
              <p className="text-xs text-muted-foreground">
                This server&rsquo;s tools are on while the server is. Editing them is coming.
              </p>
            </div>
            <ul className="space-y-3">
              {group.entries.map((entry) => (
                <McpToolRow key={entry.name} entry={entry} />
              ))}
            </ul>
          </section>
        ))}

        {saving ? (
          <p role="status" className="text-xs text-muted-foreground">
            Saving…
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

/** One server's remote tools, in the order the list reported them. */
interface McpServerGroup {
  readonly server: string
  readonly entries: readonly ToolSettingEntry[]
}

/**
 * The remote entries, grouped by server in first-appearance order.
 *
 * A remote entry that names no server — a stored policy for a tool nothing offers — is grouped
 * under a heading of its own rather than dropped, the same "listed rather than hidden" rule the
 * unavailable built-in tools follow.
 */
function mcpServerGroups(entries: readonly ToolSettingEntry[]): readonly McpServerGroup[] {
  const groups = new Map<string, ToolSettingEntry[]>()
  for (const entry of entries) {
    if (entry.source !== 'mcp') {
      continue
    }
    const server = entry.mcp_server ?? 'Remote tools'
    const group = groups.get(server)
    if (group === undefined) {
      groups.set(server, [entry])
    } else {
      group.push(entry)
    }
  }
  return [...groups].map(([server, groupEntries]) => ({ server, entries: groupEntries }))
}

/**
 * One remote tool's row: what it is called, and the permission a call to it is evaluated under.
 *
 * Read-only by design (#313 owns the editing): the offered name and the server group already say
 * which server a tool belongs to, and there is no per-tool on/off to draw, so a control here
 * would offer a choice the API has nowhere to put for an on/off and put a permission in the
 * wrong map for a select.
 */
function McpToolRow({ entry }: { entry: ToolSettingEntry }) {
  return (
    <li
      data-slot="tool-row"
      data-tool={entry.name}
      data-source="mcp"
      data-available={entry.available}
      className="flex flex-col gap-2 rounded-lg border px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm">{entry.name}</span>
        <Badge variant="outline" className="text-2xs">
          MCP
        </Badge>
        {entry.available ? null : (
          <Badge variant="secondary" className="text-2xs" data-slot="tool-unavailable">
            not available
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground" data-slot="tool-policy">
          When called: {entry.policy}
          {entry.default_policy === null
            ? ''
            : entry.policy === entry.default_policy
              ? ' (default)'
              : ` (default ${entry.default_policy})`}
        </span>
        {entry.available ? null : (
          <span className="text-xs text-muted-foreground">
            Its server is not connected, so a chat never offers it.
          </span>
        )}
      </div>
    </li>
  )
}

/** One tool's row: its name and state, the on/off switch, and the permission. */
function ToolRow({
  entry,
  saving,
  onChange,
}: {
  entry: ToolSettingEntry
  saving: boolean
  onChange: (next: ToolSettingEntry) => void
}) {
  const unavailable = !entry.available
  return (
    <li
      data-slot="tool-row"
      data-tool={entry.name}
      data-available={entry.available}
      className="flex flex-col gap-2 rounded-lg border px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm">{entry.name}</span>
        {entry.source === 'mcp' ? (
          <Badge variant="outline" className="text-2xs">
            MCP
          </Badge>
        ) : null}
        {unavailable ? (
          <Badge variant="secondary" className="text-2xs" data-slot="tool-unavailable">
            not available
          </Badge>
        ) : null}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            // The visible word flips between On and Off, which would be the checkbox's
            // accessible name if it were left to the wrapping label; the stable name is the
            // tool, so a screen reader (and a test) can address one row's switch.
            aria-label={`Enable ${entry.name}`}
            className="size-4 accent-primary"
            checked={entry.enabled}
            disabled={saving || unavailable}
            onChange={(event) => onChange({ ...entry, enabled: event.target.checked })}
          />
          {entry.enabled ? 'On' : 'Off'}
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`tool-policy-${entry.name}`} className="text-xs text-muted-foreground">
          When called
        </Label>
        <select
          id={`tool-policy-${entry.name}`}
          data-slot="tool-policy"
          className="h-8 rounded-md border bg-transparent px-2 text-xs"
          value={entry.policy}
          disabled={saving || unavailable}
          onChange={(event) => onChange({ ...entry, policy: event.target.value as ToolPermission })}
        >
          {TOOL_PERMISSIONS.map((permission) => (
            <option key={permission.value} value={permission.value}>
              {permission.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground" data-slot="tool-default">
          {entry.default_policy === null
            ? 'No default — this server does not register it.'
            : entry.policy === entry.default_policy
              ? `Default (${entry.default_policy}).`
              : `Default is ${entry.default_policy}.`}
        </span>
        {unavailable ? (
          <span className="text-xs text-muted-foreground">
            A chat never offers it, whatever the switch says.
          </span>
        ) : null}
      </div>
    </li>
  )
}
