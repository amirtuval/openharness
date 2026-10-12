import { listChildren, selectTasks } from '@openharness/client'
import type { Client, TaskCard, TaskCardStatus } from '@openharness/client'
import type { Session } from '@openharness/protocol'
import { Box, Text, useInput, useStdout } from 'ink'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import type { ChatSession } from '../chat/session'
import { describeError, type ErrorContext } from '../errors'
import { PALETTE, paint, type TerminalTheme } from '../markdown/theme'
import { truncateSpans, type Span } from '../markdown/text'
import {
  listJump,
  ScrollingList,
  useTerminalRows,
  VIEWPORT_HINT,
  viewportRows,
} from './list-viewport'
import { sessionLabel } from './breadcrumb'
import { TASK_STATUS_MARKS, taskStatusColor } from './task-card'
import { useTerminalTheme } from './theme'

/**
 * The chat's tasks, and the way into one — `/agents` (epic #340, S9; issue #347).
 *
 * The card in the transcript says what a task is and what it is doing; this is where a reader
 * goes to **act** on one: switch into a task's own chat (`Enter`), or stop a task that is still
 * working (`s`). It is the same statement the web app's sidebar makes with a click, made with a
 * keyboard because a terminal has no pointer.
 *
 * One flat list, the shape every screen in `oh` has (see `tool-settings.tsx`): the rows are the
 * current chat's tasks, in the order their cards sit in the transcript, and — when this chat is
 * itself a task's child — a **back** row at the top that returns to the chat above it. That is
 * the whole of the navigation: a child is a real session (S3), so the way down is switching into
 * one, and the way back up is `/agents` again from inside it, where its own parent is the row.
 * A task whose child has children of its own says so (`› 2 subtasks`), so a reader can tell
 * there is another level before opening it.
 *
 * | key                 | what it does                                     |
 * | ------------------- | ------------------------------------------------ |
 * | ↑/↓                 | move the cursor                                  |
 * | PgUp/PgDn, Home/End | jump a screen, or to an end                      |
 * | Enter               | open the highlighted task's chat, or go back     |
 * | s                   | stop the highlighted task (interrupt its child)  |
 * | Esc                 | done — back to the prompt                        |
 *
 * **The rows show the parent's log's status**, which is four words: `running`, `done`, `failed`
 * and `stopped`. The fifth — `waiting` — is the child's own fact and is drawn on the card in the
 * transcript, which watches the child; a list that reads one child per row to find it would be a
 * request per row for a word the reader is about to see anyway.
 *
 * **Stop is one `user.interrupt` to the child session**, which is the only stop the API gives a
 * person: `agent_stop` is the parent *model's* tool, and a reader cannot call one. It ends the
 * child's turn where it got to and leaves the child's chat to be continued from, and the card
 * then says whatever the log says that turn ended as — this screen writes no status, and could
 * not.
 */

/** What a row of the list is: one of this chat's tasks, or the chat this one hangs off. */
export interface AgentsRow {
  /** A task of this chat, or the chat above it. */
  readonly kind: 'task' | 'back'
  /** The `task_` id for a task, the parent's `sesn_` id for the back row. */
  readonly id: string
  /** The task's type, or the word for a chat with no name — the row's own name. */
  readonly name: string
  /** What the task is for, in the starter's words; empty for the back row. */
  readonly detail: string
  /** The status the row leads with, or `null` for the back row, which has none. */
  readonly status: TaskCardStatus | null
  /** How many lines the parent and the child have exchanged. */
  readonly notes: number
  /** Whether the task has delivered a result yet. */
  readonly hasResult: boolean
  /** How many tasks the child session itself has started. */
  readonly subtasks: number
  /** The card itself, for a task row. */
  readonly card: TaskCard | null
}

export function AgentsScreen({
  client,
  session,
  current,
  context,
  onOpen,
  onDone,
}: {
  readonly client: Client
  /** The running chat: its transcript is the task list. */
  readonly session: ChatSession
  /** The session this chat is, so a row can go back up and a task can be stopped. */
  readonly current: Session
  readonly context: ErrorContext
  /** Open a session in place of this chat — the app swaps the screen. */
  readonly onOpen: (session: Session) => void
  /** The reader is done: Esc, or Ctrl+C. */
  readonly onDone: () => void
}) {
  const terminalRows = useTerminalRows()
  const { stdout } = useStdout()
  const theme = useTerminalTheme()
  const [parent, setParent] = useState<Session | null>(null)
  const [subtasks, setSubtasks] = useState<ReadonlyMap<string, number>>(new Map())
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The cursor and the busy flag the key handler reads. Ink hands `useInput` the latest
  // *committed* render, so two keys inside one render would both act on the state from before
  // them — the trap every screen here keeps a ref for.
  const indexRef = useRef(0)
  const busyRef = useRef(false)

  // The tasks are the chat's own state, read live: a task that finishes while this list is up
  // moves to `done` under the reader without a key having been pressed.
  const view = useSyncExternalStore(session.subscribe, session.getState, session.getState)
  const cards = selectTasks(view.transcript)

  // The chat above this one, when there is one: a child is a real session with a parent (S1/S3),
  // so this is one read of the id the session names.
  useEffect(() => {
    if (current.parent_session_id === null) {
      setParent(null)
      return undefined
    }
    let live = true
    void client.sessions
      .get(current.parent_session_id)
      .then((read) => {
        if (live) setParent(read)
      })
      .catch(() => {
        // A parent that cannot be read is a chat that cannot be gone back to; the reader still
        // gets the tasks, and the breadcrumb above the prompt says where they are.
      })
    return () => {
      live = false
    }
  }, [client, current.parent_session_id])

  // One read per task, once, for the marker that says there is another level under a row. Best
  // effort by design: a task whose children cannot be listed is a row with no count, never a
  // screen that fails to open.
  useEffect(() => {
    if (!cards.some((card) => card.childSessionId !== null)) {
      setSubtasks(new Map())
      return undefined
    }
    let live = true
    void (async () => {
      const counts = new Map<string, number>()
      for (const card of cards) {
        if (card.childSessionId === null) continue
        try {
          const children = await listChildren(client.sessions, card.childSessionId)
          counts.set(card.id, children.length)
        } catch {
          // A child that cannot be listed is one with nothing to show; the row stays.
        }
      }
      if (live) setSubtasks(counts)
    })()
    return () => {
      live = false
    }
    // Once, when the screen opens: which tasks exist is what the list is for, and re-reading the
    // tree on every transcript change would be a request per turn.
  }, [client])

  const rows = agentsRows(cards, parent, subtasks, current)
  const at = Math.min(index, Math.max(rows.length - 1, 0))
  // The title, one line for a note or an error, and the key hints.
  const chrome = 4
  const capacity = viewportRows(terminalRows, chrome)

  const moveTo = (next: number): void => {
    const clamped = Math.min(Math.max(next, 0), Math.max(rows.length - 1, 0))
    indexRef.current = clamped
    setIndex(clamped)
  }

  /** Open the highlighted row in place of this chat: a task's own session, or the parent's. */
  const open = useCallback(
    async (row: AgentsRow): Promise<void> => {
      busyRef.current = true
      setBusy(true)
      setError(null)
      try {
        onOpen(
          await client.sessions.get(
            row.kind === 'back' ? row.id : (row.card?.childSessionId ?? row.id),
          ),
        )
      } catch (failure) {
        setError(describeError(failure, context).message)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [client, context, onOpen],
  )

  /** Stop the highlighted task: one `user.interrupt` to the child session it runs in. */
  const stop = useCallback(
    async (row: AgentsRow): Promise<void> => {
      const childSessionId = row.card?.childSessionId ?? null
      if (row.kind !== 'task' || childSessionId === null) return
      busyRef.current = true
      setBusy(true)
      setError(null)
      setNote(null)
      try {
        await client.interrupt(childSessionId)
        setNote(`Stopped ${row.name} — its turn ended where it got to.`)
      } catch (failure) {
        setError(describeError(failure, context).message)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [client, context],
  )

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

    const row = rows[indexRef.current]
    if (row === undefined) return
    if (key.return) {
      void open(row)
      return
    }
    if (input === 's') {
      void stop(row)
    }
  })

  const columns = stdout.columns ?? 80

  return (
    <Box flexDirection="column">
      <Text>Agents</Text>
      {error !== null && <Text color="red">{error}</Text>}
      {note !== null && <Text dimColor>{note}</Text>}
      {busy && <Text dimColor>working…</Text>}
      {rows.length === 0 ? (
        <Text dimColor>A model starts one by calling `agent`.</Text>
      ) : (
        <ScrollingList
          items={rows}
          index={at}
          rows={terminalRows}
          chrome={chrome}
          renderRow={(row, position, marker) => (
            <Text>
              {truncateSpans(rowSpans(row, marker, theme), Math.max(1, columns - 1)).map(
                (span, at) => (
                  <Text key={at} color={span.color} dimColor={span.dim} bold={span.bold}>
                    {span.text}
                  </Text>
                ),
              )}
            </Text>
          )}
        />
      )}
      <Text dimColor>↑/↓ choose · Enter open · s stop · {VIEWPORT_HINT} · Esc done</Text>
    </Box>
  )
}

/**
 * The rows the list draws: this chat's tasks in the transcript's order, under the row that goes
 * back to the chat above when there is one.
 */
export function agentsRows(
  cards: readonly TaskCard[],
  parent: Session | null,
  subtasks: ReadonlyMap<string, number>,
  current: Session,
): readonly AgentsRow[] {
  const rows: AgentsRow[] = []
  if (current.parent_session_id !== null) {
    rows.push({
      kind: 'back',
      id: current.parent_session_id,
      name: parent === null ? 'the chat above' : sessionLabel(parent),
      detail: '',
      status: null,
      notes: 0,
      hasResult: false,
      subtasks: 0,
      card: null,
    })
  }
  for (const card of cards) {
    rows.push({
      kind: 'task',
      id: card.id,
      name: card.type ?? card.kind,
      detail: card.description,
      status: card.status,
      notes: card.messages.length,
      hasResult: card.result !== null,
      subtasks: subtasks.get(card.id) ?? 0,
      card,
    })
  }
  return rows
}

/**
 * One row's words.
 *
 * The status leads, the same reading order the card uses and for the same reason: it is what a
 * reader scans for, and it is what a narrow terminal must not lose. The back row is a `‹` and
 * the chat above it, because that is what Enter does to it.
 */
export function agentRowLabel(row: AgentsRow): string {
  if (row.kind === 'back') {
    return `‹ back to ${row.name}`
  }
  const parts = [`${row.status ?? 'running'}`, `${row.name}: ${row.detail}`]
  if (row.notes > 0) {
    parts.push(row.notes === 1 ? '1 note' : `${row.notes} notes`)
  }
  if (row.hasResult) {
    parts.push('has a result')
  }
  if (row.subtasks > 0) {
    parts.push(`› ${row.subtasks} subtask${row.subtasks === 1 ? '' : 's'}`)
  }
  return parts.join(' · ')
}

/** The spans one row is drawn from, so a status and its mark carry the status' colour. */
function rowSpans(row: AgentsRow, marker: string, theme: TerminalTheme): Span[] {
  const selected: Span = { text: `${marker} `, color: marker === '❯' ? 'cyan' : undefined }
  const label = agentRowLabel(row)
  const chrome: Omit<Span, 'text'> = { color: paint(theme, PALETTE.chrome), dim: true }

  if (row.status === null) {
    return [selected, { text: label, ...chrome }]
  }
  // The mark and the status' own word are the row's one coloured part; the rest is chrome, so
  // the state reads first in a list where everything else is uniformly dim.
  const mark = TASK_STATUS_MARKS[row.status]
  return [
    selected,
    { text: `${mark} `, color: paint(theme, taskStatusColor(row.status)) },
    { text: label, ...chrome },
  ]
}
