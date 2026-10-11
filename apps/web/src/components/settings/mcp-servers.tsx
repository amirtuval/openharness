import {
  MCP_CONNECTED_PARAM,
  estimatedTokensLabel,
  mcpAuthLabel,
  mcpConnectedServerId,
  mcpServerById,
  mcpServerTools,
  mcpStatusDetail,
  mcpStatusLabel,
  mcpStatusTone,
  toolPolicyLabel,
} from '@openharness/client'
import type { McpServerTool } from '@openharness/client'
import type { McpServer, ToolPermission } from '@openharness/protocol'
import { ChevronRight, PlugZap, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useMcpServers } from '../../hooks/use-mcp-servers'
import { useTools } from '../../hooks/use-tools'
import { showNotice } from '../../lib/notice'
import { useClient } from '../client-provider'
import { ErrorBanner } from '../chat/error-banner'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { McpServerDialog } from './mcp-server-dialog'

/**
 * Settings → MCP servers (epic #303, X10; the screen is #313).
 *
 * The remote servers the reader operates, and everything about one: its address, how it
 * authenticates, whether it is on by default, its connection status and the last error, the
 * verbs a server offers (Test, Connect/Reconnect, Disconnect, Edit, Delete), and — under each
 * server — the tools its last check listed, each with the permission a call is evaluated under
 * and the estimated cost of the server's whole definitions.
 *
 * The words are `@openharness/client`'s (`mcpStatusLabel`, `mcpStatusDetail`,
 * `mcpAuthLabel`, `estimatedTokensLabel`, `mcpServerTools`, `toolPolicyLabel`), so `oh` says
 * exactly the same things, and the cost is written as the **estimate** it is — the protocol's
 * cheap four-characters-per-token rule, named as one everywhere it appears.
 *
 * A permission is written where every other tool setting is (`PUT /v1/me/tools`'s `mcp` map,
 * keyed by the model-facing `<server>__<tool>` name), because a remote tool has no on/off of its
 * own: a whole server is on or off, and a mode patches that by id (`mode-form-dialog.tsx`).
 *
 * **A web OAuth flow lands back here.** The callback redirects the browser to
 * `?mcp_connected=<id>#/settings`, and this card is what confirms it — naming the server — and
 * reads the list again, so the status on screen is the one the callback just wrote. The
 * parameter is dropped from the URL so a reload does not repeat the confirmation.
 */
export function McpServersCard() {
  const client = useClient()
  const servers = useMcpServers(client)
  const tools = useTools(client)
  const [dialog, setDialog] = useState<{
    readonly open: boolean
    readonly server: McpServer | null
  }>({ open: false, server: null })
  const [failure, setFailure] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [connected, setConnected] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<string | null>(null)

  // The OAuth callback's landing (epic #303, X10; #311): read once, and take the parameter off
  // the URL so a reload does not confirm it a second time.
  useEffect(() => {
    const id = mcpConnectedServerId(window.location.search)
    if (id === null) {
      return
    }
    dropConnectedParam()
    setConnected(id)
  }, [])

  // The list this card reads was fetched after the redirect, so it already carries the status
  // the callback wrote; the confirmation just has to name the server.
  useEffect(() => {
    if (connected === null || servers.loading) {
      return
    }
    const server = mcpServerById(servers.servers, connected)
    setConfirmation(server === null ? 'A server finished connecting.' : `Connected ${server.name}.`)
    setConnected(null)
  }, [connected, servers.loading, servers.servers])

  const openCreate = (): void => {
    setFailure(null)
    setDialog({ open: true, server: null })
  }

  const openEdit = (server: McpServer): void => {
    setFailure(null)
    setDialog({ open: true, server })
  }

  const run = async (action: Promise<{ ok: boolean; message?: string }>): Promise<void> => {
    setFailure(null)
    const result = await action
    if (!result.ok) {
      setFailure(result.message ?? 'The request failed.')
    }
    setConfirming(null)
  }

  const connect = async (server: McpServer): Promise<void> => {
    setFailure(null)
    const started = await servers.connect(server.id, 'web')
    if (!started.ok) {
      setFailure(started.message)
      return
    }
    if (openAuthorization(started.authorizationUrl)) {
      showNotice(`Approve the sign-in for ${server.name} in the new tab.`)
    } else {
      // A pop-up blocker is the one reason a click opens nothing, and the flow cannot continue
      // without the page: say so rather than leaving a reader waiting for a tab that never came.
      showNotice('Allow pop-ups for this site, then press Reconnect again.')
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">MCP servers</CardTitle>
          <Button type="button" variant="outline" size="sm" onClick={openCreate}>
            Add server
          </Button>
        </div>
        <CardDescription>
          Remote MCP servers you operate. While a server is on, its tools are offered to your chats;
          every call to one asks you first until you say otherwise.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {servers.error === null ? null : (
          <ErrorBanner
            title="Could not load your MCP servers"
            message={servers.error}
            onDismiss={servers.dismissError}
          />
        )}
        {failure === null ? null : (
          <ErrorBanner
            title="The MCP server request failed"
            message={failure}
            onDismiss={() => setFailure(null)}
          />
        )}
        {confirmation === null ? null : (
          <p
            role="status"
            data-slot="mcp-connected"
            className="rounded-md border border-coral/40 bg-coral/10 px-3 py-2 text-xs text-coral-ink"
          >
            {confirmation}
          </p>
        )}

        {servers.loading ? (
          <p className="text-sm text-muted-foreground">Loading your MCP servers…</p>
        ) : servers.servers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No servers yet. Add one and its tools join your chats — the helper server
            <code className="font-mono"> https://mcp.example.com/mcp</code> is a good place to
            start.
          </p>
        ) : (
          <ul className="space-y-3" data-slot="mcp-server-list">
            {servers.servers.map((server) => (
              <McpServerRow
                key={server.id}
                server={server}
                tools={mcpServerTools(server, tools.tools?.data ?? [])}
                busy={servers.busy || tools.saving}
                confirming={confirming === server.id}
                onConfirming={(next) => {
                  setFailure(null)
                  setConfirming(next ? server.id : null)
                }}
                onTest={() => void run(servers.test(server.id))}
                onConnect={() => void connect(server)}
                onDisconnect={() => void run(servers.disconnect(server.id))}
                onEdit={() => openEdit(server)}
                onToggle={(enabled) => void run(servers.update(server.id, { enabled }))}
                onRemove={() => void run(servers.remove(server.id))}
                onPolicy={(tool, policy) => {
                  setFailure(null)
                  void tools.savePolicy(tool.offeredName, policy).then((result) => {
                    if (!result.ok) {
                      setFailure(result.message)
                    }
                  })
                }}
              />
            ))}
          </ul>
        )}

        {servers.busy ? (
          <p role="status" className="text-xs text-muted-foreground">
            Working…
          </p>
        ) : null}
      </CardContent>

      <McpServerDialog
        open={dialog.open}
        server={dialog.server}
        servers={servers}
        onSaved={() => setDialog({ open: false, server: null })}
        onClose={() => setDialog({ open: false, server: null })}
      />
    </Card>
  )
}

/** One server: what it is, what state it is in, what can be done, and the tools it offers. */
function McpServerRow({
  server,
  tools,
  busy,
  confirming,
  onConfirming,
  onTest,
  onConnect,
  onDisconnect,
  onEdit,
  onToggle,
  onRemove,
  onPolicy,
}: {
  server: McpServer
  tools: readonly McpServerTool[]
  busy: boolean
  confirming: boolean
  onConfirming: (next: boolean) => void
  onTest: () => void
  onConnect: () => void
  onDisconnect: () => void
  onEdit: () => void
  onToggle: (enabled: boolean) => void
  onRemove: () => void
  onPolicy: (tool: McpServerTool, policy: ToolPermission) => void
}) {
  const tone = mcpStatusTone(server.status)
  const oauth = server.auth === 'oauth'
  // A server that needs a sign-in offers the flow; one that has tokens offers the way to drop
  // them. A `none`/`headers` server has neither — there is nothing to connect or disconnect.
  const showsDisconnect = oauth && server.status === 'connected'

  return (
    <li
      data-slot="mcp-server-row"
      data-server={server.name}
      data-status={server.status}
      data-auth={server.auth}
      className="space-y-2 rounded-lg border px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{server.name}</span>
        <Badge variant="outline" className="text-2xs">
          {mcpAuthLabel(server.auth)}
        </Badge>
        <Badge
          variant={tone === 'ok' ? 'secondary' : tone === 'warning' ? 'coral' : 'destructive'}
          className="text-2xs"
          data-slot="mcp-status"
        >
          {mcpStatusLabel(server.status)}
        </Badge>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            aria-label={`Enable ${server.name}`}
            className="size-4 accent-primary"
            checked={server.enabled}
            disabled={busy}
            onChange={(event) => onToggle(event.target.checked)}
          />
          On
        </label>
      </div>

      <p className="break-words text-xs text-muted-foreground" data-slot="mcp-status-detail">
        {mcpStatusDetail(server)}
      </p>
      <p className="truncate text-xs text-muted-foreground" title={server.url}>
        {server.url}
      </p>

      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            Delete {server.name}? Its tools leave every chat that had them.
          </span>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            aria-label={`Delete ${server.name}`}
            onClick={onRemove}
            disabled={busy}
          >
            Delete
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onConfirming(false)}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Test ${server.name}`}
            onClick={onTest}
            disabled={busy}
          >
            Test
          </Button>
          {oauth ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`${server.status === 'connected' ? 'Reconnect' : 'Connect'} ${server.name}`}
              onClick={onConnect}
              disabled={busy}
            >
              <PlugZap aria-hidden="true" />
              {server.status === 'connected' ? 'Reconnect' : 'Connect'}
            </Button>
          ) : null}
          {showsDisconnect ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Disconnect ${server.name}`}
              onClick={onDisconnect}
              disabled={busy}
            >
              <RefreshCw aria-hidden="true" />
              Disconnect
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Edit ${server.name}`}
            onClick={onEdit}
            disabled={busy}
          >
            Edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive"
            aria-label={`Delete ${server.name}`}
            onClick={() => onConfirming(true)}
            disabled={busy}
          >
            Delete
          </Button>
        </div>
      )}

      <ServerTools server={server} tools={tools} busy={busy} onPolicy={onPolicy} />
    </li>
  )
}

/**
 * A server's tools, each with the permission a call runs under and what its definitions cost.
 *
 * Collapsed to one line — the count and the estimate — because a server may offer a dozen tools
 * and the list is about the permission a reader wants to change, not about reading every
 * schema. A tool the last check did not list (a stored permission for a tool the server no
 * longer offers) is shown beside them, marked, rather than dropped: it is the reader's own
 * choice, and it comes back with the tool.
 */
function ServerTools({
  server,
  tools,
  busy,
  onPolicy,
}: {
  server: McpServer
  tools: readonly McpServerTool[]
  busy: boolean
  onPolicy: (tool: McpServerTool, policy: ToolPermission) => void
}) {
  const total = server.tools.length
  return (
    <Collapsible>
      <CollapsibleTrigger
        data-slot="mcp-tools-trigger"
        className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 transition-transform [[data-state=open]_&]:rotate-90"
        />
        {total === 0
          ? 'No tools listed yet'
          : `${total === 1 ? '1 tool' : `${total} tools`} · ${estimatedTokensLabel(server.definition_tokens)}`}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        {tools.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Test the server to list its tools and price their definitions.
          </p>
        ) : (
          <ul className="space-y-1.5" data-slot="mcp-tools">
            {tools.map((tool) => (
              <li
                key={tool.offeredName}
                data-slot="mcp-tool-row"
                data-tool={tool.offeredName}
                data-listed={tool.listed}
                className="flex flex-wrap items-center gap-2"
              >
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs"
                  title={tool.offeredName}
                >
                  {tool.offeredName}
                </span>
                {tool.listed ? (
                  <span className="text-2xs text-muted-foreground" data-slot="mcp-tool-cost">
                    {tool.definitionTokens === null
                      ? ''
                      : estimatedTokensLabel(tool.definitionTokens)}
                  </span>
                ) : (
                  <Badge variant="secondary" className="text-2xs">
                    not listed
                  </Badge>
                )}
                <select
                  aria-label={`${tool.offeredName} when called`}
                  data-slot="mcp-tool-policy"
                  className="h-8 rounded-md border bg-transparent px-2 text-xs"
                  value={tool.policy}
                  disabled={busy}
                  onChange={(event) => onPolicy(tool, event.target.value as ToolPermission)}
                >
                  {(['allow', 'ask', 'deny'] as const).map((policy) => (
                    <option key={policy} value={policy}>
                      {toolPolicyLabel(policy)}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Open the authorization page in a new tab, and answer whether it opened.
 *
 * `window.open` answers `null` when a pop-up blocker refused it, which is the one case a reader
 * has to act on; `noopener` keeps the provider's page from reaching back into this one.
 *
 * @param url the authorization URL the server built
 */
function openAuthorization(url: string): boolean {
  return window.open(url, '_blank', 'noopener,noreferrer') !== null
}

/** Take `?mcp_connected=…` off the URL, so a reload does not confirm the flow again. */
function dropConnectedParam(): void {
  const url = new URL(window.location.href)
  url.searchParams.delete(MCP_CONNECTED_PARAM)
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}
