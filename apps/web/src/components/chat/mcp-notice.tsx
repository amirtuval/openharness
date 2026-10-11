import { mcpServerByName, type McpFailureNotice } from '@openharness/client'
import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import { navigate, settingsHash } from '../../lib/router'
import { showNotice } from '../../lib/notice'
import { describeError } from '../../lib/errors'
import { useSettings } from '../../hooks/use-settings'
import { useClient } from '../client-provider'
import { Button } from '../ui/button'

/**
 * A turn's MCP failure, with the one action that helps (epic #303, X10; #313).
 *
 * An MCP server that cannot be used is **not** a failed turn: the brain writes one
 * `session.error` per server per turn (`mcp_connection_failed_error` or
 * `mcp_authentication_failed_error`) and the chat carries on without that server's tools. So
 * this is a warning drawn in place of the red error banner — the same treatment the step limit
 * gets — with the brain's own sentence and, because the usual reason is a token that expired or
 * was revoked, a **Reconnect** action.
 *
 * The action is late-bound on purpose. The name is all the log carries, so acting on it means
 * reading the reader's servers once to find the one it names — and only when the reader asks:
 * a chat that never trips over a server pays nothing for the feature. An `oauth` server is
 * connected again (the flow opens in a new tab, and the callback lands on Settings with the
 * confirmation); a `none` or `headers` server has no flow to run, so the reader is taken to
 * Settings → MCP servers, where Test and Edit live.
 */
export function McpNotice({
  failure,
  onDismiss,
}: {
  failure: McpFailureNotice
  onDismiss: () => void
}) {
  const client = useClient()
  const { serverUrl } = useSettings()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reconnect = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const { data } = await client.mcpServers.list()
      const server = mcpServerByName(data, failure.server ?? undefined)
      if (server === null) {
        // Nothing to reconnect: the server was renamed or deleted since the turn ran, and the
        // log's sentence about it is all that is left to show.
        showNotice('That MCP server is no longer registered.')
        return
      }
      if (server.auth !== 'oauth') {
        showNotice(`${server.name} does not use OAuth — check it in Settings.`)
        navigate(settingsHash())
        return
      }
      const started = await client.mcpServers.connect(server.id, { client: 'web' })
      if (window.open(started.authorization_url, '_blank', 'noopener,noreferrer') === null) {
        showNotice('Allow pop-ups for this site, then press Reconnect again.')
        return
      }
      showNotice(`Approve the sign-in for ${server.name} in the new tab.`)
    } catch (caught) {
      setError(describeError(caught, { serverUrl }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="status"
      data-slot="mcp-notice"
      data-server={failure.server ?? undefined}
      data-tone="warning"
      className="flex flex-col gap-1 rounded-md border border-coral/40 bg-coral/10 px-3 py-2 text-xs text-coral-ink"
    >
      <div className="flex items-start gap-inline">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span className="break-words">{failure.message}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-5">
        {failure.reconnectable ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto p-0 text-coral-ink"
            disabled={busy}
            onClick={() => void reconnect()}
          >
            {busy ? 'Connecting…' : 'Reconnect'}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto p-0 text-coral-ink"
          onClick={() => navigate(settingsHash())}
        >
          MCP servers in Settings
        </Button>
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto p-0 text-muted-foreground"
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      </div>
      {error === null ? null : (
        <p role="alert" className="pl-5 text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
