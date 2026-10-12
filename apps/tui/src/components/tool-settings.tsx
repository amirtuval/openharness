import {
  cycleToolPolicy,
  toolAvailabilityNote,
  toolPolicyNote,
  type Client,
} from '@openharness/client'
import type { ToolPermission, ToolSettingEntry } from '@openharness/protocol'
import { Box, Text, useInput, useStdout } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import { describeError, type ErrorContext } from '../errors'
import { listJump, ScrollingList, VIEWPORT_HINT, viewportRows } from './list-viewport'

/**
 * This build's own tools, in the terminal (epic #303, X4; #335) — `/tools`, the counterpart of
 * the web app's Settings → Tools.
 *
 * Until now the only way to set a tool's permission from a terminal was the shell's
 * `oh tools <name> --policy <…>`, which means leaving the chat, knowing the name and writing the
 * whole thing again for the next tool. The reader's report was exactly that: there was no way to
 * set ask/deny/allow for the built-in tools from inside `oh`.
 *
 * One flat list, the shape a keyboard drives, with the two keys the `/mcp` tools face already
 * uses so nothing new has to be learned:
 *
 * | key                 | what it does                                                 |
 * | ------------------- | ------------------------------------------------------------ |
 * | ↑/↓                 | move the cursor                                              |
 * | ←/→                 | cycle the permission: allow → ask → deny (`ask` skipped for a provider-executed search) |
 * | space               | turn the highlighted tool on or off                          |
 * | PgUp/PgDn, Home/End | jump a screen, or to an end                                  |
 * | Esc                 | done                                                         |
 *
 * **One change is one write.** Each key that changes something sends a single
 * `PUT /v1/me/tools` naming that one tool — the merge the route is built on, so a second tool's
 * setting is never touched — and the list is then read back, because availability is a
 * **per-model** fact (`?model_id=`) that the write's own answer does not carry (#335). A refusal
 * is shown inline, on the screen, with the list where it was.
 *
 * **Only this build's tools are here.** A remote MCP tool belongs to a server, has no on/off of
 * its own and has its permission set per server on `/mcp`'s tools face (#313), so a line says
 * where they went rather than leaving a reader to wonder.
 */
export function ToolSettingsScreen({
  client,
  context,
  modelId,
  onDone,
}: {
  readonly client: Client
  /** The chat's current model, for the availability the server reports (`?model_id=`). */
  readonly modelId: string | undefined
  readonly context: ErrorContext
  /** Called when the reader leaves: Esc, or Ctrl+C. */
  readonly onDone: () => void
}) {
  const { stdout } = useStdout()
  const [entries, setEntries] = useState<readonly ToolSettingEntry[] | null>(null)
  const [remote, setRemote] = useState(0)
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The cursor, the rows and the busy flag the key handler reads: Ink hands `useInput` the
  // latest *committed* render, so two keystrokes inside one render would both read the state
  // from before them — and a cycling key read that way would send the *same* permission twice
  // (the write's answer arrives after the keypress, the render after that again). The rows are
  // kept in a ref, patched the moment a write succeeds and replaced by the read that follows.
  const indexRef = useRef(0)
  const rowsRef = useRef<readonly ToolSettingEntry[]>([])
  const busyRef = useRef(false)

  const read = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const options = signal === undefined ? undefined : { signal }
      try {
        const list = await client.tools.list({ model_id: modelId }, options)
        const builtin = list.data.filter((entry) => entry.source !== 'mcp')
        rowsRef.current = builtin
        setEntries(builtin)
        setRemote(list.data.filter((entry) => entry.source === 'mcp').length)
        setError(null)
      } catch (failure) {
        if (signal?.aborted === true) return
        setError(describeError(failure, context).message)
        setEntries((current) => current ?? [])
      }
    },
    [client, context, modelId],
  )

  useEffect(() => {
    const controller = new AbortController()
    void read(controller.signal)
    return () => {
      controller.abort()
    }
  }, [read])

  const rows = entries ?? []
  const at = Math.min(index, Math.max(rows.length - 1, 0))
  const current = rows[at]

  // The title, the key hints and one line for a note or an error, fixed: the window must not
  // move under a keystroke because a note appeared or went away.
  const chrome = 5
  const capacity = viewportRows(stdout.rows, chrome)

  /**
   * Write one tool's whole setting — `enabled` and `policy` together, which is what the schema
   * takes — then read the list back, so the per-model notes stay right. `done` is the note the
   * change leaves, and it is written only when the write really happened.
   */
  const save = useCallback(
    async (
      entry: ToolSettingEntry,
      next: { enabled?: boolean; policy?: ToolPermission },
      done: string,
    ): Promise<void> => {
      busyRef.current = true
      setBusy(true)
      setError(null)
      setNote(null)
      try {
        await client.tools.put({
          builtin: {
            [entry.name]: {
              enabled: next.enabled ?? entry.enabled,
              policy: next.policy ?? entry.policy,
            },
          },
        })
        // The value the write left behind, kept where the key handler looks: a second press
        // that arrives before the read-back has rendered cycles from **this** permission and
        // not from the one before the write.
        const patched = rowsRef.current.map((row) =>
          row.name === entry.name ? { ...row, enabled: next.enabled ?? row.enabled, policy: next.policy ?? row.policy } : row,
        )
        rowsRef.current = patched
        setEntries(patched)
        await read()
        setNote(done)
      } catch (failure) {
        setError(describeError(failure, context).message)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [client, context, read],
  )

  const moveTo = (next: number): void => {
    const clamped = Math.min(Math.max(next, 0), Math.max(rows.length - 1, 0))
    indexRef.current = clamped
    setIndex(clamped)
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onDone()
      return
    }
    if (key.escape) {
      onDone()
      return
    }
    if (busyRef.current) return

    if (key.upArrow) {
      moveTo(indexRef.current - 1)
      return
    }
    if (key.downArrow) {
      moveTo(indexRef.current + 1)
      return
    }
    const jumped = listJump(indexRef.current, rows.length, key, capacity)
    if (jumped !== null) {
      moveTo(jumped)
      return
    }

    // The row the keys act on, read from the ref: a keystroke in front of a render must act on
    // the permission the last write left, not on the one it replaced.
    const row = rowsRef.current[indexRef.current]
    if (row === undefined) return
    // ←/→ (and Enter, for a reader who expects it to do something) walk the permissions — the
    // same key the `/mcp` tools face puts a remote tool's permission on (#313).
    if (key.leftArrow || key.rightArrow || key.return) {
      const delta = key.leftArrow ? -1 : 1
      const policy = cycleToolPolicy(row.name, row.policy, delta)
      void save(row, { policy }, `${row.name}: ${policy}.`)
      return
    }
    if (input === ' ') {
      const enabled = !row.enabled
      void save(row, { enabled }, `${row.name} turned ${enabled ? 'on' : 'off'}.`)
    }
  })

  const nameWidth = rows.reduce((widest, entry) => Math.max(widest, entry.name.length), 0)

  return (
    <Box flexDirection="column">
      <Text>Tools</Text>
      {error !== null && <Text color="red">{error}</Text>}
      {note !== null && <Text dimColor>{note}</Text>}
      {busy && <Text dimColor>working…</Text>}
      {entries === null ? (
        <Text dimColor>reading your tools…</Text>
      ) : rows.length === 0 ? (
        <Text dimColor>No tools are registered on this server.</Text>
      ) : (
        <ScrollingList
          items={rows}
          index={at}
          rows={stdout.rows}
          chrome={chrome}
          renderRow={(entry, position, marker) => {
            const availability = toolAvailabilityNote(entry)
            return (
              <Text>
                <Text color={position === at ? 'cyan' : undefined}>
                  {`${marker} ${entry.name.padEnd(nameWidth)}  ${
                    entry.enabled ? 'on ' : 'off'
                  }  ${toolPolicyNote(entry)}`}
                </Text>
                {availability === null ? null : <Text dimColor>{` · ${availability}`}</Text>}
              </Text>
            )
          }}
        />
      )}
      <Text dimColor>{mcpToolsNote(remote)}</Text>
      <Text dimColor>
        ←/→ permission · space on/off · ↑/↓ choose · {VIEWPORT_HINT} · Esc done
      </Text>
    </Box>
  )
}

/**
 * Where the MCP tools went: a remote tool is its server's, and `/mcp` is where its permission is
 * set (#313). The count is named so a tool that is missing from this list reads as one that is
 * set elsewhere rather than lost.
 */
function mcpToolsNote(remote: number): string {
  if (remote === 0) return 'MCP tools are not listed here; /mcp sets them, per server.'
  return `${remote === 1 ? '1 MCP tool is' : `${remote} MCP tools are`} not listed here; /mcp sets them, per server.`
}
