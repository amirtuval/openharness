import type { McpHeaders, McpServer } from '@openharness/protocol'
import {
  MAX_MCP_HEADERS,
  MCP_HEADER_NAME_MAX_LENGTH,
  MCP_SERVER_NAME_MAX_LENGTH,
  isMcpServerName,
  isMcpServerUrl,
  mcpServerNameFromUrl,
} from '@openharness/protocol'
import { useEffect, useId, useState } from 'react'

import type { McpFailureKind, McpWriteResult, McpServersView } from '../../hooks/use-mcp-servers'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

/** One header pair the reader is typing; the value is write-only and never comes back. */
interface HeaderDraft {
  readonly name: string
  readonly value: string
}

/** The form's values, before they become a request body. */
interface FormState {
  readonly url: string
  readonly name: string
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

const EMPTY: FormState = { url: '', name: '', enabled: true, headers: null }

/** The form's values from a server being edited, or the empty form for a new one. */
function formOf(server: McpServer | null): FormState {
  if (server === null) {
    return EMPTY
  }
  return {
    url: server.url,
    name: server.name,
    enabled: server.enabled,
    headers: null,
  }
}

/**
 * Register or edit one remote MCP server (epic #303, X10; the screen is #313; detection: #314).
 *
 * One dialog for both writes, the way the mode form is: `server` is the server being edited, or
 * `null` for a new one. **There is no auth-type field** (issue #314): a reader types a URL, and
 * the server works out how to authenticate — an unauthenticated probe that comes back `401`
 * from something advertising an OAuth authorization server means Connect, and one that
 * initializes cleanly means none. Custom headers are the escape hatch, behind a disclosure,
 * because supplying one is the reader saying "this server wants an API key" and nothing else
 * has to be chosen for that to work.
 *
 * The fields are in the order the reader answers them — the **URL first**, since it decides
 * everything, then an optional name whose placeholder is the one the server would derive from
 * that URL. The two shape rules are the protocol's own (`isMcpServerName`, `isMcpServerUrl`),
 * checked inline so a reader sees what is wrong beside the field rather than as a failed
 * request. Saving runs a real network probe, so the dialog says so while it waits, and the
 * server's own refusals (a name already taken, the twenty-first server, a URL the guard
 * refuses) land under the fields.
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
  const urlId = useId()
  const nameId = useId()
  const advancedId = useId()
  const [form, setForm] = useState<FormState>(EMPTY)
  const [advanced, setAdvanced] = useState(false)
  const [failure, setFailure] = useState<{ kind: McpFailureKind; message: string } | null>(null)
  const [saving, setSaving] = useState(false)

  // Every open starts from the server being edited (or the empty form): a dialog left mounted
  // between uses must not carry the last write's values into the next one. A server that already
  // holds headers opens with the disclosure showing, because that is a fact about it.
  useEffect(() => {
    if (open) {
      setForm(formOf(server))
      setAdvanced((server?.header_names.length ?? 0) > 0)
      setFailure(null)
      setSaving(false)
    }
  }, [open, server])

  const patch = (change: Partial<FormState>): void => {
    setForm((current) => ({ ...current, ...change }))
  }

  const trimmedUrl = form.url.trim()
  const typedName = form.name.trim()
  const derivedName = trimmedUrl === '' ? '' : mcpServerNameFromUrl(trimmedUrl)

  const urlProblem =
    trimmedUrl === ''
      ? 'A URL is required.'
      : isMcpServerUrl(trimmedUrl)
        ? null
        : 'Enter an absolute http or https URL with a host, no userinfo and no fragment.'
  // A name is optional on a create — the server derives one from the URL — and required on an
  // edit, because there is already a name and clearing it would rename the server to nothing.
  const nameProblem =
    typedName === ''
      ? server === null
        ? null
        : 'A name is required.'
      : isMcpServerName(typedName)
        ? null
        : `Use 1–${MCP_SERVER_NAME_MAX_LENGTH} lowercase letters, digits and interior dashes.`
  const headerProblem = headerDraftProblem(form, { required: false })
  const canSave = urlProblem === null && nameProblem === null && headerProblem === null && !saving

  const headers = (): McpHeaders | undefined => {
    if (form.headers === null) {
      return undefined
    }
    const map: Record<string, string> = {}
    for (const pair of form.headers) {
      if (pair.name.trim() !== '' && pair.value !== '') {
        map[pair.name.trim()] = pair.value
      }
    }
    return Object.keys(map).length === 0 ? undefined : map
  }

  const save = async (): Promise<void> => {
    if (!canSave) {
      return
    }
    setSaving(true)
    setFailure(null)
    const name = typedName === '' ? undefined : typedName
    // An edit keeps the sealed map when the reader typed nothing: `headers` travels only when
    // there is something to replace it with, because the map is write-only and an omitted field
    // means "keep what is stored". A header a reader typed implies `headers` server-side, so no
    // auth type is sent either way.
    const wrote = headers()
    const result: McpWriteResult =
      server === null
        ? await servers.create({
            url: trimmedUrl,
            enabled: form.enabled,
            ...(name === undefined ? {} : { name }),
            ...(wrote === undefined ? {} : { headers: wrote }),
          })
        : await servers.update(server.id, {
            url: trimmedUrl,
            enabled: form.enabled,
            ...(name === undefined ? {} : { name }),
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
          <div className="space-y-control">
            <Label htmlFor={urlId}>Server URL</Label>
            <Input
              id={urlId}
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              aria-invalid={urlProblem === null ? undefined : true}
              placeholder="https://mcp.example.com/mcp"
              value={form.url}
              disabled={saving}
              onChange={(event) => patch({ url: event.target.value })}
            />
            {urlProblem === null ? (
              <p className="text-xs text-muted-foreground">
                The server&rsquo;s Streamable HTTP endpoint. On save we check it and work out how it
                authenticates — sign-in or none — so there is no type to pick.
              </p>
            ) : (
              <p role="alert" className="text-xs text-destructive" data-slot="mcp-url-problem">
                {urlProblem}
              </p>
            )}
          </div>

          <div className="space-y-control">
            <Label htmlFor={nameId}>
              Name <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id={nameId}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={nameProblem === null ? undefined : true}
              placeholder={derivedName === '' ? 'notes' : derivedName}
              value={form.name}
              disabled={saving}
              onChange={(event) => patch({ name: event.target.value })}
            />
            {nameProblem === null ? (
              <p className="text-xs text-muted-foreground">
                Prefixes every tool name a model sees (
                <code className="font-mono">notes__search</code>
                ). Leave it blank to use{' '}
                <code className="font-mono">{derivedName === '' ? 'the URL' : derivedName}</code>.
              </p>
            ) : (
              <p role="alert" className="text-xs text-destructive" data-slot="mcp-name-problem">
                {nameProblem}
              </p>
            )}
          </div>

          <Collapsible open={advanced} onOpenChange={setAdvanced}>
            <CollapsibleTrigger
              id={advancedId}
              data-slot="mcp-advanced-trigger"
              className="flex w-full items-center gap-1 rounded-sm text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              Advanced: custom headers
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-control pt-2">
              <p className="text-xs text-muted-foreground">
                For a server that authenticates with an API key header. Adding one stores this
                server as header-authenticated; leave it empty for sign-in or no authentication.
                Values are write-only — you will have to retype them to change them.
              </p>
              <HeaderFields
                server={server}
                headers={form.headers}
                disabled={saving}
                onChange={(next) => patch({ headers: next })}
              />
              {headerProblem === null ? null : (
                <p
                  role="alert"
                  className="text-xs text-destructive"
                  data-slot="mcp-headers-problem"
                >
                  {headerProblem}
                </p>
              )}
            </CollapsibleContent>
          </Collapsible>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={form.enabled}
              disabled={saving}
              onChange={(event) => patch({ enabled: event.target.checked })}
            />
            On by default for my chats
          </label>

          {failure === null ? null : (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              data-slot="mcp-save-failure"
              data-kind={failure.kind}
            >
              {failure.message}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-control">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!canSave}>
            {saving ? 'Checking the server…' : server === null ? 'Add server' : 'Save changes'}
          </Button>
        </div>
        {saving ? (
          <p role="status" className="text-right text-xs text-muted-foreground">
            Connecting to the server to find out what it offers…
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The header pairs a server sends.
 *
 * The stored map is sealed and never returned, so an edit shows the **names** it already holds
 * and leaves the draft empty: saving without typing a pair keeps what is there, and typing one
 * replaces the whole map (the update's rule). A value is a secret, so it is a password field.
 */
function HeaderFields({
  server,
  headers,
  disabled,
  onChange,
}: {
  server: McpServer | null
  headers: readonly HeaderDraft[] | null
  disabled: boolean
  onChange: (next: readonly HeaderDraft[]) => void
}) {
  const rows = headers ?? []
  const setRow = (index: number, row: Partial<HeaderDraft>): void => {
    onChange(rows.map((each, at) => (at === index ? { ...each, ...row } : each)))
  }

  return (
    <div className="space-y-control">
      {server === null || server.header_names.length === 0 ? null : (
        <p className="text-xs text-muted-foreground" data-slot="mcp-stored-headers">
          Stored: <span className="font-mono">{server.header_names.join(', ')}</span>. Values are
          hidden — type a pair to replace the whole map, or leave these empty to keep them.
        </p>
      )}
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-inline" data-slot="mcp-header-row">
          <Input
            aria-label={`Header ${index + 1} name`}
            autoComplete="off"
            spellCheck={false}
            maxLength={MCP_HEADER_NAME_MAX_LENGTH}
            placeholder="Authorization"
            value={row.name}
            disabled={disabled}
            onChange={(event) => setRow(index, { name: event.target.value })}
          />
          <Input
            aria-label={`Header ${index + 1} value`}
            type="password"
            autoComplete="off"
            placeholder="Bearer …"
            value={row.value}
            disabled={disabled}
            onChange={(event) => setRow(index, { value: event.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove header ${index + 1}`}
            disabled={disabled}
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
        disabled={disabled || rows.length >= MAX_MCP_HEADERS}
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
 * because that is a reader who thinks they configured something.
 */
function headerDraftProblem(
  form: FormState,
  options: { readonly required: boolean },
): string | null {
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
