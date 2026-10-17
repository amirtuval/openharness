import { NO_ASK_TOOL_NAMES, SUBAGENT_ASK_NOTE, toolPolicyChoices } from '@openharness/client'
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
 * Settings → Tools (epic #303, X4; #307; the screen is #308; the remote half, #312; #313).
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
 * - **whether it can be offered at all** — a tool the server cannot give a chat is listed as
 *   unavailable rather than hidden, so a reader sees why it does nothing, and the server's own
 *   `reason` is what says it (`web_search` on a model whose provider has none, #335) — or, when
 *   it has none to give, `No default — this server does not register it.` for a tool nothing
 *   declares. It is never offered whatever the switch says.
 *
 * A write is per tool: the server merges, so flipping one row never rewrites the others, and the
 * answer it returns (the effective list) replaces what the card shows.
 *
 * **This card lists the build's own tools and nothing else** (#313). A remote MCP tool belongs
 * to a server — a whole server is on or off, its tools have no on/off of their own, and the
 * permission a call runs under is set per server — so its rows live in Settings → MCP servers,
 * where the server and every one of its tools are one screen. Listing them here as well made
 * this card as long as the servers' tool lists put together, and none of the rows could be
 * honestly edited: a switch would write a `builtin` setting the server never applies, and a
 * select would put a permission in the wrong map. The card **says where they are** rather than
 * dropping them silently, because a tool that vanishes from a list reads as one that does not
 * exist.
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
  const remoteCount = (tools?.data.length ?? 0) - builtin.length

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

        {remoteCount === 0 ? null : (
          <p className="text-xs text-muted-foreground" data-slot="tools-mcp-hint">
            {remoteCount === 1
              ? 'One tool comes from an MCP server.'
              : `${remoteCount} tools come from MCP servers.`}{' '}
            Tools from MCP servers are set below, per server.
          </p>
        )}

        {saving ? (
          <p role="status" className="text-xs text-muted-foreground">
            Saving…
          </p>
        ) : null}
      </CardContent>
    </Card>
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
          {TOOL_PERMISSIONS.filter((permission) =>
            toolPolicyChoices(entry.name).includes(permission.value),
          ).map((permission) => (
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
        {/* Why "Ask me first" is not in the list (issue #368, epic #340 S9). The five subagent
            tools are listed here like any other built-in, but a call to four of them is kept out
            of the transcript's tool calls — a card stands in for it — so there is no prompt a
            client could draw and an `ask` would pause the turn with nothing to answer it. The
            server refuses the write; saying so here is what keeps a reader from looking for it. */}
        {NO_ASK_TOOL_NAMES.includes(entry.name) ? (
          <span className="text-xs text-muted-foreground" data-slot="tool-ask-note">
            {SUBAGENT_ASK_NOTE}
          </span>
        ) : null}
        {unavailable ? (
          <span className="text-xs text-muted-foreground" data-slot="tool-unavailable-reason">
            {entry.reason ?? 'A chat never offers it, whatever the switch says.'}
          </span>
        ) : null}
      </div>
    </li>
  )
}
