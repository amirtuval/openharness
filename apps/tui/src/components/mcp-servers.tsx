import {
  estimatedTokensLabel,
  mcpAuthLabel,
  mcpServerPolicyBody,
  mcpServerTools,
  mcpTestOutcome,
  mcpStatusDetail,
  mcpStatusLabel,
  mcpStatusTone,
  mcpToolPolicyState,
  mcpToolPolicyStateLabel,
  toolPolicyLabel,
  waitForMcpConnection,
  type Client,
  type McpServerTool,
  type McpServerTone,
} from '@openharness/client'
import type { McpServer, ToolPermission, ToolSettingEntry } from '@openharness/protocol'
import { Box, Text, useInput, useStdout } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import { describeError, type ErrorContext } from '../errors'
import {
  MCP_URL_FIELD,
  mcpHeaderProblem,
  mcpServerBody,
  mcpServerFields,
  mcpServerValues,
  type McpField,
} from '../mcp/form'
import { listJump, ScrollingList, VIEWPORT_HINT, viewportRows } from './list-viewport'
import { SecretInput } from './secret-input'

/** The permissions a remote tool's row cycles through, in the order the key walks them. */
const POLICY_ORDER: readonly ToolPermission[] = ['allow', 'ask', 'deny']

/**
 * The reader's remote MCP servers, in the terminal (epic #303, X10; the screen is #313).
 *
 * One screen with three faces, because a terminal has no pointer and one flat thing at a time
 * is what a keyboard can drive:
 *
 * - **the list** — one line per server with its auth, its status and whether it is on, the
 *   status detail under it (the last error, or what its tools cost), and every verb on a key:
 *   Enter edits, `n` registers one, space turns it on or off, `t` tests, `c` connects (or
 *   reconnects) an OAuth server, `x` drops its tokens, `d` deletes it after a `y/N`, and `p`
 *   opens its tools;
 * - **the form** — one prompt per field, the shape `/providers` uses, with the header value
 *   masked and a `headers` server asked for one pair;
 * - **the tools** — a first row for the server's tools **taken together** (`all tools · Ask
 *   (all)`, or `Mixed` when they differ), then one row per tool with the permission a call is
 *   evaluated under and what its definition costs. ←/→ cycles allow/ask/deny on the highlighted
 *   row; on the all-tools row the same key sets **every** one of them, in **one** `PUT` naming
 *   them all, which is the batch #313 asks for — a reader who wants "ask me about all of these"
 *   should not have to walk a dozen rows. That is the whole of what a reader chooses about a
 *   remote tool: a server is on or off, and a tool's permission is theirs, written to
 *   `PUT /v1/me/tools`'s `mcp` map under the offered name.
 *
 * The words are `@openharness/client`'s (`mcpStatusLabel`, `mcpStatusDetail`, `mcpAuthLabel`,
 * `estimatedTokensLabel`, `toolPolicyLabel`), so the page and the terminal say the same things.
 *
 * **Connect opens the authorization page in the reader's browser and then waits**, polling the
 * server's status until it stops needing a sign-in (`waitForMcpConnection`). That is the `oh`
 * ending decision X10 asks for: the callback lands in a browser that may never have signed in
 * here (`oh` authenticates with a bearer token from the device flow), so there is nothing to
 * read back from it — the server's own status is the answer. Esc stops the waiting; the sign-in
 * itself is the browser's, and a reader who leaves it half-done can connect again.
 */
export function McpServersScreen({
  client,
  context,
  openUrl,
  onDone,
}: {
  readonly client: Client
  readonly context: ErrorContext
  /** Open a URL in the system browser, answering whether it opened. */
  readonly openUrl: (url: string) => boolean
  /** Called when the reader leaves: Esc on the list, or Ctrl+C. */
  readonly onDone: () => void
}) {
  const { stdout } = useStdout()
  const [servers, setServers] = useState<readonly McpServer[] | null>(null)
  const [tools, setTools] = useState<readonly ToolSettingEntry[]>([])
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Which face is on screen: the list, or one server's tools. */
  const [face, setFace] = useState<'list' | 'tools'>('list')
  /** The server being registered or edited; `undefined` when no form is up. */
  const [editing, setEditing] = useState<McpServer | null | undefined>(undefined)
  const [confirming, setConfirming] = useState(false)
  const [step, setStep] = useState(0)
  const [choice, setChoice] = useState(0)
  const [values, setValues] = useState<Record<string, string>>(() => mcpServerValues(null))
  const [toolCursor, setToolCursor] = useState(0)

  // The cursor, the values and the flags the key handler reads: Ink hands `useInput` the latest
  // *committed* render, so two keystrokes inside one render would both read the state from
  // before them (the same reason the model picker and the provider flow keep refs).
  const indexRef = useRef(0)
  const valuesRef = useRef(values)
  const stepRef = useRef(0)
  const choiceRef = useRef(0)
  const busyRef = useRef(false)
  const toolCursorRef = useRef(0)
  const waitRef = useRef<AbortController | null>(null)

  const read = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const options = signal === undefined ? undefined : { signal }
      try {
        const [list, settings] = await Promise.all([
          client.mcpServers.list(options),
          client.tools.list({}, options),
        ])
        setServers(list.data)
        setTools(settings.data)
        setError(null)
      } catch (failure) {
        if (signal?.aborted === true) return
        setError(describeError(failure, context).message)
        setServers((current) => current ?? [])
      }
    },
    [client, context],
  )

  useEffect(() => {
    const controller = new AbortController()
    void read(controller.signal)
    return () => {
      controller.abort()
      waitRef.current?.abort()
    }
  }, [read])

  const list = servers ?? []
  const current = list[Math.min(index, Math.max(list.length - 1, 0))]
  const editingServer = editing ?? null

  const moveTo = (next: number): void => {
    const clamped = Math.min(Math.max(next, 0), Math.max(list.length - 1, 0))
    indexRef.current = clamped
    setIndex(clamped)
  }

  const setValuesRef = (next: Record<string, string>): void => {
    valuesRef.current = next
    setValues(next)
  }

  /** Open a form, on a server or on nothing (a create). */
  const openForm = (server: McpServer | null): void => {
    setEditing(server)
    setStep(0)
    stepRef.current = 0
    setChoice(0)
    choiceRef.current = 0
    setValuesRef(mcpServerValues(server))
    setError(null)
    setNote(null)
  }

  /** Register or edit, then read back: a create changes the list, and the server owns its order. */
  const save = useCallback(async (): Promise<void> => {
    const target = editing
    // No auth is chosen here (issue #314): the server probes the URL, and a header the reader
    // typed implies `headers`.
    const problem = mcpHeaderProblem(valuesRef.current)
    if (problem !== null) {
      setError(problem)
      return
    }
    const built = mcpServerBody(
      { editing: target !== null && target !== undefined },
      valuesRef.current,
    )
    busyRef.current = true
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      if (built.kind === 'create') {
        const created = await client.mcpServers.create(built.body)
        setNote(`${created.name}: ${mcpStatusDetail(created)}`)
      } else if (target !== null && target !== undefined) {
        await client.mcpServers.update(target.id, built.body)
        setNote(`${target.name} saved.`)
      }
      setEditing(undefined)
      await read()
    } catch (failure) {
      setError(describeError(failure, context).message)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [client, context, editing, read])

  /** Run one action that answers with the server it touched, and keep the row in step. */
  const act = useCallback(
    async (
      target: McpServer,
      run: () => Promise<McpServer>,
      done: string | ((server: McpServer) => string),
    ): Promise<void> => {
      busyRef.current = true
      setBusy(true)
      setError(null)
      setNote(null)
      try {
        const updated = await run()
        setServers((all) => (all ?? []).map((each) => (each.id === updated.id ? updated : each)))
        setNote(`${target.name}: ${typeof done === 'function' ? done(updated) : done}`)
      } catch (failure) {
        setError(describeError(failure, context).message)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [context],
  )

  /**
   * Start the OAuth flow, open the page, and wait for the server to stop needing a sign-in.
   *
   * The wait is the point: the callback lands in the reader's browser, so watching the server's
   * status is the only way `oh` can know. A flow that fails, or one the reader leaves half-done,
   * is a **note** rather than an error — the servers are all still there and Test says what the
   * server thinks now.
   */
  const connect = useCallback(
    async (target: McpServer): Promise<void> => {
      busyRef.current = true
      setBusy(true)
      setError(null)
      setNote(null)
      try {
        const started = await client.mcpServers.connect(target.id, { client: 'cli' })
        setNote(
          openUrl(started.authorization_url)
            ? `Approve the sign-in for ${target.name} in your browser — Esc stops waiting.`
            : `Open this URL and approve, then come back: ${started.authorization_url}`,
        )
        const controller = new AbortController()
        waitRef.current = controller
        const wait = await waitForMcpConnection({
          get: async (options) => client.mcpServers.get(target.id, options),
          signal: controller.signal,
        })
        setServers((all) =>
          (all ?? []).map((each) => (each.id === wait.server.id ? wait.server : each)),
        )
        setNote(connectNote(target.name, wait.outcome, wait.server))
      } catch (failure) {
        setError(describeError(failure, context).message)
      } finally {
        waitRef.current = null
        busyRef.current = false
        setBusy(false)
      }
    },
    [client, context, openUrl],
  )

  /**
   * Write one permission for the tools given, and keep the settings list in step with the answer.
   *
   * One tool is the per-row key's call and a whole server's is the all-tools row's, and both go
   * through the client's own body builders (`mcpServerPolicyBody`) — so a batch is **one** `PUT`
   * naming every tool of the server, never one write per row, and neither path can put a
   * permission in the wrong map.
   */
  const writePolicies = useCallback(
    async (
      targets: readonly McpServerTool[],
      policy: ToolPermission,
      done: string,
    ): Promise<void> => {
      const body = mcpServerPolicyBody(targets, policy)
      if (body === null) {
        return
      }
      busyRef.current = true
      setBusy(true)
      setError(null)
      try {
        const saved = await client.tools.put(body)
        setTools(saved.data)
        setNote(done)
      } catch (failure) {
        setError(describeError(failure, context).message)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [client, context],
  )

  /** Delete one server, after the `y/N` the reader was asked for. */
  const remove = useCallback(
    async (target: McpServer): Promise<void> => {
      busyRef.current = true
      setBusy(true)
      setError(null)
      try {
        await client.mcpServers.delete(target.id)
        await read()
        setNote(`${target.name} was deleted.`)
      } catch (failure) {
        setError(describeError(failure, context).message)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [client, context, read],
  )

  // The form's fields: the URL, an optional name, an optional custom header, and on/off.
  const fields: readonly McpField[] =
    editing === undefined
      ? []
      : mcpServerFields({
          editing: editingServer !== null,
          storedHeaderNames: editingServer?.header_names ?? [],
        })
  const currentField = fields[Math.min(step, Math.max(fields.length - 1, 0))]

  const serverTools: readonly McpServerTool[] =
    current === undefined ? [] : mcpServerTools(current, tools)
  /** What the server's tools say together: `Ask (all)`, `Mixed`, or nothing to say (#313). */
  const toolState = mcpToolPolicyState(serverTools)
  /** The permission every one of them shares, or `null` when they differ or there are none. */
  const sharedPolicy = toolState?.kind === 'uniform' ? toolState.policy : null
  /** The rows the tools face draws: the all-tools row, then one per tool. */
  const toolRows = serverTools.length === 0 ? 0 : serverTools.length + 1
  // What the two faces draw around their lists: title, error, note, "working…" and the key
  // hint, plus — on the tools face — the all-tools row pinned above the window, and, on the
  // list, the `y/N` line a delete asks with. A server row is two lines, so its list holds half
  // as many of them.
  const TOOLS_CHROME = 6
  const SERVERS_CHROME = 7
  const toolPage = viewportRows(stdout.rows, TOOLS_CHROME)
  const serverPage = Math.max(1, Math.floor(viewportRows(stdout.rows, SERVERS_CHROME) / 2))

  /** One prompt answered: remember it, and move on — or save on the last one. */
  const answer = async (value: string): Promise<void> => {
    const field = fields[stepRef.current]
    if (field === undefined) return
    const skipped = field.optional === true && value.trim() === ''
    const fieldError = skipped ? null : (field.validate?.(value) ?? null)
    if (fieldError !== null) {
      setError(fieldError)
      return
    }
    setError(null)
    setValuesRef({ ...valuesRef.current, [field.name]: value })
    if (stepRef.current >= fields.length - 1) {
      await save()
      return
    }
    stepRef.current += 1
    setStep(stepRef.current)
    choiceRef.current = 0
    setChoice(0)
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (editing !== undefined) {
        openFormBack()
        return
      }
      onDone()
      return
    }

    // The form owns the keyboard while it is up; a choice field is the form's own list.
    if (editing !== undefined) {
      if (key.escape) {
        openFormBack()
        return
      }
      const options = currentField?.options
      if (options !== undefined && options.length > 0) {
        if (key.upArrow) {
          const next = Math.max(choiceRef.current - 1, 0)
          choiceRef.current = next
          setChoice(next)
          return
        }
        if (key.downArrow) {
          const next = Math.min(choiceRef.current + 1, options.length - 1)
          choiceRef.current = next
          setChoice(next)
          return
        }
        if (key.return) {
          const picked = options[choiceRef.current]
          if (picked !== undefined) void answer(picked)
        }
      }
      return
    }

    // Esc backs out one layer at a time, and stops a connect wait rather than leaving the screen.
    if (key.escape) {
      if (waitRef.current !== null) {
        waitRef.current.abort()
        return
      }
      if (face === 'tools') {
        setFace('list')
        return
      }
      if (confirming) {
        setConfirming(false)
        return
      }
      onDone()
      return
    }

    if (face === 'tools') {
      if (key.upArrow) {
        const next = Math.max(toolCursorRef.current - 1, 0)
        toolCursorRef.current = next
        setToolCursor(next)
        return
      }
      if (key.downArrow) {
        const next = Math.min(toolCursorRef.current + 1, Math.max(toolRows - 1, 0))
        toolCursorRef.current = next
        setToolCursor(next)
        return
      }
      // PgUp/PgDn/Home/End, over the whole tools face — the all-tools row included, so Home is
      // the batch row and End is the server's last tool.
      const jumped = listJump(toolCursorRef.current, toolRows, key, toolPage)
      if (jumped !== null) {
        toolCursorRef.current = jumped
        setToolCursor(jumped)
        return
      }
      // ←/→ (and Enter, for a reader who expects it to do something) walk the three permissions
      // — the one thing a reader chooses about a remote tool. Row 0 is the server's tools taken
      // together (#313): the same keys set **every** one of them in a single write, which is what
      // a reader who wants "all of these ask me first" is owed without a key per tool.
      if (key.leftArrow || key.rightArrow || key.return) {
        if (busyRef.current || serverTools.length === 0) return
        const cursor = toolCursorRef.current
        const delta = key.leftArrow ? -1 : 1
        // A mixed set starts the walk at `allow`, the first of the three (−1 + 1): the row then
        // reads the permission the write really left behind, so a second press is never a
        // surprise.
        const from = cursor === 0 ? sharedPolicy : (serverTools[cursor - 1]?.policy ?? null)
        const at = from === null ? -1 : POLICY_ORDER.indexOf(from)
        const next = POLICY_ORDER[(at + delta + POLICY_ORDER.length) % POLICY_ORDER.length] ?? 'ask'
        if (cursor === 0) {
          const count = serverTools.length
          void writePolicies(
            serverTools,
            next,
            `all ${count === 1 ? 'tool' : `${count} tools`} set to ${toolPolicyLabel(next)}.`,
          )
          return
        }
        const tool = serverTools[cursor - 1]
        if (tool !== undefined) {
          void writePolicies([tool], next, `${tool.offeredName}: ${toolPolicyLabel(next)}.`)
        }
      }
      return
    }

    if (confirming) {
      if (input === 'y' || key.return) {
        const target = current
        setConfirming(false)
        if (target !== undefined) void remove(target)
        return
      }
      if (input === 'n') setConfirming(false)
      return
    }

    if (key.upArrow) {
      moveTo(indexRef.current - 1)
      return
    }
    if (key.downArrow) {
      moveTo(indexRef.current + 1)
      return
    }
    // A list that grew past the screen is walked a page at a time (#335): ↓ one server is fine
    // for three of them, and hopeless for twenty.
    const serverJump = listJump(indexRef.current, list.length, key, serverPage)
    if (serverJump !== null) {
      moveTo(serverJump)
      return
    }
    if (busyRef.current) return

    if (key.return) {
      if (current !== undefined) openForm(current)
      return
    }
    if (input === 'n') {
      openForm(null)
      return
    }
    if (current === undefined) return
    if (input === ' ') {
      void act(
        current,
        () => client.mcpServers.update(current.id, { enabled: !current.enabled }),
        current.enabled ? 'turned off.' : 'turned on.',
      )
      return
    }
    if (input === 't') {
      // The check's own answer, in the words both frontends use (`mcpTestOutcome`, issue #314):
      // the tool count when it listed, and — for an `oauth` server with no token, which cannot
      // be checked at all — "Connect first" rather than the row's own status read back.
      void act(
        current,
        () => client.mcpServers.test(current.id),
        (checked) => mcpTestOutcome(checked).message,
      )
      return
    }
    if (input === 'c') {
      void connect(current)
      return
    }
    if (input === 'x') {
      void act(
        current,
        () => client.mcpServers.disconnect(current.id),
        'signed out — connect again to use it.',
      )
      return
    }
    if (input === 'd') {
      setConfirming(true)
      return
    }
    if (input === 'p') {
      toolCursorRef.current = 0
      setToolCursor(0)
      setFace('tools')
    }
  })

  /** Leave the form without writing anything. */
  function openFormBack(): void {
    setEditing(undefined)
    setError(null)
  }

  if (editing !== undefined) {
    return (
      <Box flexDirection="column">
        <Text>{editingServer === null ? 'Add an MCP server' : `Edit ${editingServer.name}`}</Text>
        <Text dimColor>
          Its secrets are sealed by the server; nothing is written to this machine.
        </Text>
        {error !== null && <Text color="red">{error}</Text>}
        {busy && <Text dimColor>working…</Text>}
        {currentField === undefined ? null : (
          <Box flexDirection="column" marginTop={1}>
            <Text>{currentField.label}</Text>
            {currentField.name === MCP_URL_FIELD ? (
              <Text dimColor>We check the URL on save and work out how it authenticates.</Text>
            ) : null}
            {currentField.options === undefined ? (
              <SecretInput
                // A new prompt is a new input, so a value from the previous field is never
                // carried into this one — and an **edit** opens each field on the value it
                // already holds, so Enter keeps it and only what the reader retypes changes
                // (issue #314: with no auth prompt, the URL is the one field an edit always
                // needs, and retyping it to change nothing would be absurd). A secret field is
                // never prefilled: the value is sealed and never came back.
                key={`${String(editingServer?.id)}:${currentField.name}:${step}`}
                placeholder={currentField.secret ? 'paste it' : 'type it'}
                mask={currentField.secret}
                optional={currentField.optional}
                initialValue={currentField.secret ? undefined : values[currentField.name]}
                busy={busy}
                onSubmit={(value) => {
                  void answer(value)
                }}
                onCancel={openFormBack}
              />
            ) : (
              <Box flexDirection="column">
                {currentField.options.map((option, position) => (
                  <Text key={option} color={position === choice ? 'cyan' : undefined}>
                    {`${position === choice ? '❯' : ' '} ${option}`}
                  </Text>
                ))}
              </Box>
            )}
          </Box>
        )}
        <Text dimColor>
          {currentField?.options === undefined
            ? 'Enter takes the answer, Esc leaves the form.'
            : '↑/↓ to choose, Enter to take it, Esc to leave the form.'}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>
        {face === 'tools' && current !== undefined ? `${current.name} · tools` : 'MCP servers'}
      </Text>
      {error !== null && <Text color="red">{error}</Text>}
      {note !== null && <Text dimColor>{note}</Text>}
      {busy && <Text dimColor>working…</Text>}

      {servers === null ? (
        <Text dimColor>reading your MCP servers…</Text>
      ) : face === 'tools' ? (
        <Box flexDirection="column">
          {serverTools.length === 0 || toolState === null ? (
            <Text dimColor>
              No tools listed. Test the server to list them and price their definitions.
            </Text>
          ) : (
            <>
              {/* The all-tools row is **pinned**: it is the server's whole tool set taken
                  together, and a server with sixty tools must not scroll it away (the reader's
                  report of #335). The window below holds the tools themselves. */}
              <ScrollingList
                items={serverTools}
                index={Math.max(toolCursor - 1, 0)}
                selected={toolCursor > 0}
                rows={stdout.rows}
                chrome={TOOLS_CHROME}
                pinned={
                  <Text color={toolCursor === 0 ? 'cyan' : undefined}>
                    {`${toolCursor === 0 ? '❯' : ' '} all tools · ${mcpToolPolicyStateLabel(toolState)}`}
                  </Text>
                }
                renderRow={(tool, position, marker) => (
                  <Text color={position + 1 === toolCursor ? 'cyan' : undefined}>
                    {`${marker} ${tool.offeredName} · ${toolPolicyLabel(tool.policy)}${
                      tool.definitionTokens === null
                        ? ' · not listed'
                        : ` · ${estimatedTokensLabel(tool.definitionTokens)}`
                    }`}
                  </Text>
                )}
              />
            </>
          )}
          <Text dimColor>
            {toolState === null
              ? 'Esc back to the list.'
              : `←/→ permission (all-tools row: every one). ${VIEWPORT_HINT}. Esc back.`}
          </Text>
        </Box>
      ) : list.length === 0 ? (
        <Text dimColor>
          No servers yet. Press n to register one — its tools join your chats once it is on.
        </Text>
      ) : (
        <ScrollingList
          items={list}
          index={index}
          rows={stdout.rows}
          chrome={SERVERS_CHROME}
          rowLines={2}
          renderRow={(server, position, marker) => (
            <Box flexDirection="column">
              <Text color={position === index ? 'cyan' : undefined}>
                <Text>{`${marker} ${server.name} · ${mcpAuthLabel(server.auth)} · `}</Text>
                <Text color={statusColour(mcpStatusTone(server.status))}>
                  {mcpStatusLabel(server.status)}
                </Text>
                <Text>{server.enabled ? '' : ' · off'}</Text>
              </Text>
              <Text dimColor>{`    ${mcpStatusDetail(server)}`}</Text>
            </Box>
          )}
        />
      )}

      {confirming && current !== undefined ? (
        <Text color="red">{`Delete ${current.name}? Its tools leave every chat that had them. y/N`}</Text>
      ) : face === 'tools' ? null : (
        <Text dimColor>
          ↑/↓ choose · Enter edit · n new · space on/off · t Test · c Connect/Reconnect · x
          Disconnect · d Delete · p tools · Esc done
        </Text>
      )}
    </Box>
  )
}

/** The colour a status tone asks for, in the terminal's own named colours. */
function statusColour(tone: McpServerTone): string | undefined {
  if (tone === 'error') return 'red'
  if (tone === 'warning') return 'yellow'
  return 'green'
}

/** The one line a finished connect leaves, whatever it came to. */
function connectNote(
  name: string,
  outcome: 'connected' | 'failed' | 'timeout' | 'stopped',
  server: McpServer,
): string {
  switch (outcome) {
    case 'connected':
      return `${name} is connected.`
    case 'failed':
      return `${name} could not be connected: ${server.last_error ?? 'the sign-in failed'}.`
    case 'stopped':
      return `${name}: stopped waiting. Finish the sign-in in your browser, then press t to test it.`
    default:
      return `${name}: still waiting for the sign-in. When it is done, press t to test it.`
  }
}
