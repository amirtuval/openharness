import { MCP_AUTH_TYPES, mcpAuthHint, mcpAuthLabel } from '@openharness/client'
import type { McpAuthType, McpHeaders, McpServer } from '@openharness/protocol'
import {
  MAX_MCP_HEADERS,
  MCP_SERVER_NAME_MAX_LENGTH,
  isMcpServerName,
  isMcpServerUrl,
} from '@openharness/protocol'
import { useEffect, useState } from 'react'

import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import type { McpFailureKind, McpWriteResult, McpServersView } from '../../hooks/use-mcp-servers'

/** One header pair the reader is typing; the value is write-only and never comes back. */
interface HeaderDraft {
  readonly name: string
  readonly value: string
}

/** The form's values, before they become a request body. */
interface FormState {
  readonly name: string
  readonly url: string
  readonly auth: McpAuthType
  readonly enabled: boolean
  /**
   * The header pairs to send, or `null` to leave the stored map alone.
   *
   * A `headers` server's values are write-only — the resource reports the header **names** only
   * — so editing a server must be able to say "keep what is sealed": the draft starts as `null`
   * (nothing typed) and only a pair the reader actually writes makes the map travel.
   */
  readonly headers: readonly HeaderDraft[] | null
}

const EMPTY: FormState = { name: '', url: '', auth: 'none', enabled: true, headers: null }

/** The form's values from a server being edited, or the empty form for a new one. */
function formOf(server: McpServer | null): FormState {
  if (server === null) {
    return EMPTY
  }
  return {
    name: server.name,
    url: server.url,
    auth: server.auth,
    enabled: server.enabled,
    headers: null,
  }
}

/**
 * Register or edit one remote MCP server (epic #303, X10; the screen is #313).
 *
 * One dialog for both writes, the way the mode form is: `server` is the server being edited, or
 * `null` for a new one. The fields are the resource's — a name, the Streamable HTTP URL, and how
 * requests authenticate:
 *
 * - **`none`** — the server is open, or trusts the network;
 * - **`headers`** — a name/value map sent on every request, sealed by the server and never
 *   returned: an edit shows the header **names** it already holds and starts the map empty, so
 *   saving without typing anything keeps them;
 * - **`oauth`** — the flow is started from the row's Connect/Reconnect action, not from here.
 *
 * The two shape rules are the protocol's own — {@link isMcpServerName} and
 * {@link isMcpServerUrl} — checked inline so a reader sees what is wrong beside the field rather
 * than as a failed request. What the server is the one to decide (a name already taken, the
 * twenty-first server) lands under the fields as its 409.
 */
export function McpServerDialog({
  open,
  server,
  servers,
  onSaved,
  onClose,
}: {
  open: boolean
  /** The server being edited, or `null` to register one. */
  server: McpServer | null
  /** Where the write goes: the screen's servers view. */
  servers: McpServersView
  /** Called after a successful write, with what the server answered. */
  onSaved: (saved: McpServer) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [failure, setFailure] = useState<{ kind: McpFailureKind; message: string } | null>(null)
  const [saving, setSaving] = useState(false)

  // Every open starts from the server being edited (or the empty form): a dialog left mounted
  // between uses must not carry the last write's values into the next one.
  useEffect(() => {
    if (open) {
      setForm(formOf(server))
      setFailure(null)
      setSaving(false)
    }
  }, [open, server])

  const patch = (change: Partial<FormState>): void => {
    setForm((current) => ({ ...current, ...change }))
  }

  const nameProblem =
    form.name.trim() === ''
      ? 'A name is required.'
      : isMcpServerName(form.name.trim())
        ? null
        : `A name is 1–${MCP_SERVER_NAME_MAX_LENGTH} lowercase letters, digits and interior dashes.`
  const urlProblem =
    form.url.trim() === ''
      ? 'A URL is required.'
      : isMcpServerUrl(form.url.trim())
        ? null
        : 'An absolute http or https URL with a host, no userinfo and no fragment.'
  const headerProblem = headerDraftProblem(form, { required: server === null })
  const canSave = nameProblem === null && urlProblem === null && headerProblem === null && !saving

  const headers = (): McpHeaders | undefined => {
    if (form.auth !== 'headers' || form.headers === null) {
      return undefined
    }
    const map: Record<string, string> = {}
    for (const pair of form.headers) {
      if (pair.name.trim() !== '' && pair.value !== '') {
        map[pair.name.trim()] = pair.value
      }
    }
    return map
  }

  const save = async (): Promise<void> => {
    if (!canSave) {
      return
    }
    setSaving(true)
    setFailure(null)
    const name = form.name.trim()
    const url = form.url.trim()
    // An edit keeps the sealed map when the reader typed nothing: `headers` is carried only when
    // there is something to replace it with, because the map is write-only and an omitted field
    // means "keep what is stored". A new server is different — a `headers` one with no map is a
    // `none` server that says otherwise, which the protocol refuses — so a create requires one.
    const wrote = headers()
    const result: McpWriteResult =
      server === null
        ? await servers.create(
            wrote === undefined
              ? { auth: form.auth as 'none' | 'oauth', name, url, enabled: form.enabled }
              : { auth: 'headers', name, url, enabled: form.enabled, headers: wrote },
          )
        : await servers.update(server.id, {
            name,
            url,
            auth: form.auth,
            enabled: form.enabled,
            ...(wrote === undefined ? {} : { headers: wrote }),
          })
    setSaving(false)
    if (!result.ok) {
      setFailure({ kind: result.kind, message: result.message })
      return
    }
    onSaved(result.server)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{server === null ? 'Add an MCP server' : `Edit ${server.name}`}</DialogTitle>
          <DialogDescription>
            A remote MCP server you operate. Its tools join a chat&rsquo;s offer while the server is
            on, and every call to one asks you first until you change it under its tools.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-block">
          <div className="space-y-1">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              autoComplete="off"
              spellCheck={false}
              placeholder="notes"
              value={form.name}
              onChange={(event) => patch({ name: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Short and lowercase. It prefixes every tool name a model sees (
              <code className="font-mono">notes__search</code>).
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="mcp-url">URL</Label>
            <Input
              id="mcp-url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://mcp.example.com/mcp"
              value={form.url}
              onChange={(event) => patch({ url: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              The server&rsquo;s Streamable HTTP endpoint. A private or loopback address needs the
              deployment&rsquo;s self-host setting.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="mcp-auth">Authentication</Label>
            <select
              id="mcp-auth"
              className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
              value={form.auth}
              onChange={(event) => patch({ auth: event.target.value as McpAuthType })}
            >
              {MCP_AUTH_TYPES.map((auth) => (
                <option key={auth} value={auth}>
                  {mcpAuthLabel(auth)}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground" data-slot="mcp-auth-hint">
              {mcpAuthHint(form.auth)}
            </p>
          </div>

          {form.auth === 'headers' ? (
            <HeaderFields
              server={server}
              headers={form.headers}
              onChange={(next) => patch({ headers: next })}
            />
          ) : null}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={form.enabled}
              onChange={(event) => patch({ enabled: event.target.checked })}
            />
            On by default for my chats
          </label>

          {nameProblem === null ? null : (
            <p role="alert" className="text-xs text-destructive" data-slot="mcp-name-problem">
              {nameProblem}
            </p>
          )}
          {urlProblem === null ? null : (
            <p role="alert" className="text-xs text-destructive" data-slot="mcp-url-problem">
              {urlProblem}
            </p>
          )}
          {headerProblem === null ? null : (
            <p role="alert" className="text-xs text-destructive" data-slot="mcp-headers-problem">
              {headerProblem}
            </p>
          )}
          {failure === null ? null : (
            <p
              role="alert"
              className="text-sm text-destructive"
              data-slot="mcp-save-failure"
              data-kind={failure.kind}
            >
              {failure.message}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!canSave}>
            {saving ? 'Saving…' : server === null ? 'Add server' : 'Save changes'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The header pairs a `headers` server sends.
 *
 * The stored map is sealed and never returned, so an edit shows the **names** it already holds
 * and leaves the draft empty: saving without typing a pair keeps what is there, and typing one
 * replaces the whole map (the update's rule). A value is a secret, so it is a password field.
 */
function HeaderFields({
  server,
  headers,
  onChange,
}: {
  server: McpServer | null
  headers: readonly HeaderDraft[] | null
  onChange: (next: readonly HeaderDraft[]) => void
}) {
  const rows = headers ?? []
  const setRow = (index: number, row: Partial<HeaderDraft>): void => {
    onChange(rows.map((each, at) => (at === index ? { ...each, ...row } : each)))
  }

  return (
    <div className="space-y-2">
      <Label>Headers</Label>
      {server === null || server.header_names.length === 0 ? null : (
        <p className="text-xs text-muted-foreground" data-slot="mcp-stored-headers">
          Stored: {server.header_names.join(', ')}. Their values are hidden — type a pair to replace
          the whole map, or leave these fields empty to keep them.
        </p>
      )}
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2" data-slot="mcp-header-row">
          <Input
            aria-label={`Header ${index + 1} name`}
            autoComplete="off"
            spellCheck={false}
            placeholder="Authorization"
            value={row.name}
            onChange={(event) => setRow(index, { name: event.target.value })}
          />
          <Input
            aria-label={`Header ${index + 1} value`}
            type="password"
            autoComplete="off"
            placeholder="Bearer …"
            value={row.value}
            onChange={(event) => setRow(index, { value: event.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(rows.filter((_each, at) => at !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={rows.length >= MAX_MCP_HEADERS}
        onClick={() => onChange([...rows, { name: '', value: '' }])}
      >
        Add header
      </Button>
    </div>
  )
}

/**
 * What is wrong with the header pairs, or `null`.
 *
 * A pair is sent only when both halves are filled in — a half-typed row is not a request body —
 * but a row with a name and no value (or the other way) is refused rather than quietly dropped,
 * because that is a reader who thinks they configured something. `required` is a **new** server:
 * its map is the whole of what it authenticates with, and the protocol refuses an empty one,
 * while an edit may leave the fields empty and keep what is sealed.
 */
function headerDraftProblem(
  form: FormState,
  options: { readonly required: boolean },
): string | null {
  if (form.auth !== 'headers') {
    return null
  }
  const rows = form.headers ?? []
  for (const row of rows) {
    const named = row.name.trim() !== ''
    const valued = row.value !== ''
    if (named !== valued) {
      return 'Every header needs both a name and a value.'
    }
  }
  const filled = rows.filter((row) => row.name.trim() !== '' && row.value !== '')
  if (filled.length === 0) {
    return options.required ? 'A headers-authenticated server needs at least one header.' : null
  }
  if (filled.length > MAX_MCP_HEADERS) {
    return `At most ${MAX_MCP_HEADERS} headers.`
  }
  return null
}
