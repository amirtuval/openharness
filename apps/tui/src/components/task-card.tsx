import {
  taskActivityLabel,
  taskCardStatus,
  taskIsLive,
  watchTaskActivity,
} from '@openharness/client'
import type {
  TaskActivityLog,
  TaskActivityState,
  TaskCard,
  TaskCardStatus,
  ModelPriceLookup,
} from '@openharness/client'
import { Box, Text, useStdout } from 'ink'
import { useEffect, useMemo, useSyncExternalStore } from 'react'

import { PALETTE, paint, type TerminalTheme } from '../markdown/theme'
import { truncateSpans, type Line, type Span } from '../markdown/text'
import { formatCostTotal, formatTokens } from './reply-meta'
import { CURSOR_COLUMNS } from './message-view'
import { RESULT_MARK } from './tool-call'
import { useTerminalTheme } from './theme'

/**
 * One background task in the transcript (epic #340, S9; issue #347).
 *
 * The terminal's half of the web app's task card, and the same card: the task's type and
 * description, its status (`running · waiting · done · failed · stopped`), a live activity line
 * — the child's current tool call, its task list as `2 of 5`, or `writing…` — and what the child
 * has spent. The lines between a parent and its helper are drawn inline in the card, in the two
 * directions the epic names (`→ researcher: …`, `researcher →: …`), and the task's latest result
 * folds in under them.
 *
 * **A card draws where its `agent` call was.** The call is not a tool line at all (S9): the
 * transcript keeps the four `agent*` tools as task machinery, so the only thing drawn there is
 * this card, merged among the messages by the position the client derives
 * (`TranscriptView`'s `mergeTasks`).
 *
 * **Its activity line and its cost are the child's own.** A task does not report progress (S4),
 * so what the child is doing right now comes from the child's stream, through the client's
 * `watchTaskActivity` — a reference-counted follower, so a card that is not on screen holds no
 * connection. {@link useTaskActivity} is that follower as a hook.
 */

/**
 * What the terminal falls back to when it will not say how wide it is — the same number
 * `message-view.tsx`, `tool-call.tsx` and `status-line.tsx` use, so the blocks agree.
 */
const FALLBACK_COLUMNS = 80

/**
 * The marks a card's status is drawn with, so the state is readable before the words are.
 *
 * The same glyphs the tool-call line uses for the states the two share, so a reader who has
 * learned one has learned the other; `stopped` is the call line's denial mark, which is what
 * "this ended because something said no" looks like in both places.
 */
export const TASK_STATUS_MARKS: Readonly<Record<TaskCardStatus, string>> = {
  running: '◐',
  waiting: '◔',
  done: '●',
  failed: '✗',
  stopped: '⊘',
}

/**
 * How many of a task's messages the card draws before it starts counting them.
 *
 * A helper steered a dozen times would otherwise push a dozen lines into the transcript for
 * every reader who never asked about it. The newest ones are the ones worth reading, and the
 * count says how many are behind them.
 */
export const TASK_MESSAGE_MAX_LINES = 3

/** How far a card's activity line, its messages and its result are indented under its head. */
const CARD_INDENT = '  '

export function TaskCardView({
  card,
  log,
  prices,
  width,
}: {
  readonly card: TaskCard
  /**
   * The log a child's activity is followed on — `client.sessions.events`. Omitted, the card
   * draws what the parent's log alone says (its status, its description, its messages and its
   * result) and no activity line: a card that cannot watch its child is a card with nothing
   * live to report, never a chat that stops working.
   */
  readonly log?: TaskActivityLog | undefined
  /** The catalog's prices, for what the child has spent so far; omitted, no cost is drawn. */
  readonly prices?: ModelPriceLookup | undefined
  /**
   * How wide the terminal is, when the caller knows better than Ink does — the test seam the
   * frame tests draw at a width they can read, as `MessageView` and `ToolCallView` have.
   */
  readonly width?: number | undefined
}) {
  const theme = useTerminalTheme()
  const { stdout } = useStdout()
  // **A finished task is not followed** (issue #368; the line the web card already drew). The
  // child's stream is what the activity line and the cost come from, and a task that has
  // finished is doing nothing — so a card for one would hold an SSE connection open, with the
  // server's 15 s keepalive, for as long as the screen holds its transcript. `useTaskActivity`
  // takes `log: undefined` as "there is nothing to follow", which is what the gate is.
  const live = useTaskActivity(
    taskIsLive(card.status) ? log : undefined,
    card.childSessionId,
    prices,
  )
  const lines = taskCardLines(card, live, width ?? stdout.columns ?? FALLBACK_COLUMNS, theme)

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        // A card's lines have no identity of their own; their order is it.
        <Text key={index}>
          {line.map((span, position) => (
            <Text key={position} color={span.color} dimColor={span.dim} bold={span.bold}>
              {span.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

/**
 * The lines one card is drawn from — the whole decision, in one place and without a terminal,
 * so a test can hold the words still (the shape `toolCallLines` and `todoLines` have).
 *
 * The first line is the task: the status mark, the status' own word, the type, the description,
 * and what the child has spent. The status leads the line because it is what a reader scans for,
 * and a card on a narrow terminal therefore loses its cost before it loses its state.
 *
 * Under it, in order: the child's **activity** (`web_fetch: https://…`, `2 of 5`, `writing…`),
 * the **conversation** between the parent and the child, and the task's **latest result** —
 * each drawn only when there is one, so a task that has said nothing is one line.
 *
 * @param card the task, from the parent's transcript
 * @param live what the child's own stream says, or `null` when nothing is watching it
 * @param columns how wide the terminal is
 * @param theme the terminal's colours, for `NO_COLOR` and the colour level
 */
export function taskCardLines(
  card: TaskCard,
  live: TaskActivityState | null,
  columns: number,
  theme: TerminalTheme,
): Line[] {
  const width = Math.max(1, columns - CURSOR_COLUMNS)
  // The card's status is the parent's four words refined by the one fact only the child can
  // say (S9): a task paused in its own `agent_wait` is **waiting**, not running.
  const status = taskCardStatus(card.status, live?.waiting === true)

  const head: Span[] = [
    { text: `${TASK_STATUS_MARKS[status]} `, color: paint(theme, taskStatusColor(status)) },
    { text: status, color: paint(theme, taskStatusColor(status)) },
    { text: ' · ', ...dimChrome(theme) },
    // The kind of helper this is — a subagent type (#342) — or the task's own kind when the
    // starter named no type. Bold, because it is the one word a reader uses to talk about it.
    { text: card.type ?? card.kind, bold: true },
  ]
  if (card.description !== '') {
    head.push({ text: ' · ', ...dimChrome(theme) })
    head.push({ text: card.description, ...dimChrome(theme) })
  }
  const spent = spentLabel(live)
  if (spent !== null) {
    head.push({ text: ' · ', ...dimChrome(theme) })
    head.push({ text: spent, ...dimChrome(theme) })
  }

  const lines: Line[] = [truncateSpans(head, width)]

  // What the child is doing right now: its current tool call, its task list as `2 of 5`, or
  // `writing…`. The words are the client's, so the page and the terminal say the same thing.
  const activity = live === null ? null : taskActivityLabel(live.activity)
  if (activity !== null) {
    lines.push(truncateSpans([{ text: `${CARD_INDENT}${activity}`, ...dimChrome(theme) }], width))
  }

  // The two directions of the conversation, oldest first, with the ones the card does not draw
  // counted above them.
  const shown = card.messages.slice(-TASK_MESSAGE_MAX_LINES)
  const hidden = card.messages.length - shown.length
  if (hidden > 0) {
    lines.push(
      truncateSpans([{ text: `${CARD_INDENT}… ${hidden} earlier`, ...dimChrome(theme) }], width),
    )
  }
  const name = card.type ?? card.kind
  for (const message of shown) {
    const said =
      message.from === 'parent' ? `→ ${name}: ${message.text}` : `${name} →: ${message.text}`
    lines.push(truncateSpans([{ text: `${CARD_INDENT}${said}`, ...dimChrome(theme) }], width))
  }

  // What the task last produced, folded in the way a call's answer is — one line of it, the
  // whole of it being in the log (the child's own chat is a `/agents` switch away).
  const result = card.result === null ? null : firstLine(card.result.text)
  if (result !== null) {
    lines.push(
      truncateSpans(
        [{ text: `${CARD_INDENT}${RESULT_MARK} ${result}`, ...dimChrome(theme) }],
        width,
      ),
    )
  }

  return lines
}

/**
 * What a child has spent, as the card's own line says it: its tokens, and its money when the
 * caller has a catalog to price them with.
 *
 * Both halves are dropped rather than guessed: a child whose log has reported nothing shows
 * neither, and one whose model nobody prices shows its tokens and no `—`, which is the same
 * statement the status line makes about a session.
 */
function spentLabel(live: TaskActivityState | null): string | null {
  const usage = live?.usage ?? null
  if (usage === null) {
    return null
  }
  // The four counters are disjoint, and the sum is the volume a reader is asking about: what
  // the child's requests cost in tokens. `sessionCost` prices exactly the same set.
  const tokens = usage.input + usage.output + usage.cacheCreation + usage.cacheRead
  const parts = [`${formatTokens(tokens)} tokens`]
  if (live?.cost != null) {
    parts.push(formatCostTotal(live.cost))
  }
  return parts.join(' · ')
}

/**
 * The colour a status is drawn in.
 *
 * Green for a task that finished, the palette's busy yellow while it works, red for one that
 * failed, and chrome for one that was stopped — an end that is neither a success nor a
 * failure, and never the reader's alarm. **Waiting is cyan**, and deliberately not the alarm
 * colour a *tool call* waiting on the reader is drawn in: a task parked in its own `agent_wait`
 * is not asking this reader for anything, it is waiting on work it started.
 */
export function taskStatusColor(status: TaskCardStatus): string {
  switch (status) {
    case 'done':
      return 'green'
    case 'running':
      return PALETTE.busy
    case 'waiting':
      return 'cyan'
    case 'failed':
      return PALETTE.alarm
    case 'stopped':
      return PALETTE.chrome
  }
}

/** The dim chrome style, which is what everything that is not the type or the status is. */
function dimChrome(theme: TerminalTheme): Omit<Span, 'text'> {
  return { color: paint(theme, PALETTE.chrome), dim: true }
}

/** The first line of a task's result, or `null` when it says nothing at all. */
function firstLine(text: string): string | null {
  const line = text.split('\n')[0]?.trim() ?? ''
  return line === '' ? null : line
}

/** Nothing is followed, and nothing has been read: what a card with no log draws. */
const NOTHING: TaskActivityState = {
  activity: { kind: 'idle' },
  waiting: false,
  status: 'idle',
  model: null,
  usage: null,
  cost: null,
}

/** The subscription of a card that is following nothing, so `useSyncExternalStore` is stable. */
function noSubscribe(): () => void {
  return () => {
    // Nothing is followed: a card with no child session, or no log to follow it on.
  }
}

/**
 * What the child of a card is doing, as a hook (epic #340, S9; issue #347).
 *
 * The client's `watchTaskActivity` is a reference-counted store: the first subscriber starts
 * following the child (its history, then its live stream) and the last one to leave drops the
 * connection, so a chat with six finished helpers holds no streams. A card **is** that
 * subscriber — it subscribes while it is on screen and closes on unmount — and `null` means
 * there is nothing to follow: a task with no session, or a card with no log.
 *
 * The watcher is rebuilt when the prices change, which is once per chat (the catalog arrives in
 * the background): a cost nobody could compute yet becomes one the next read can, and the
 * child's log is read once more for it. Nothing else about the card depends on that read.
 */
export function useTaskActivity(
  log: TaskActivityLog | undefined,
  childSessionId: string | null,
  prices: ModelPriceLookup | undefined,
): TaskActivityState | null {
  const watcher = useMemo(
    () =>
      log === undefined || childSessionId === null
        ? null
        : watchTaskActivity(log, childSessionId, prices === undefined ? {} : { prices }),
    [log, childSessionId, prices],
  )

  // The follower is dropped when the card goes away, whatever the listener bookkeeping says —
  // the same statement `close()` makes, and the one thing a component owns that a store cannot.
  useEffect(
    () => () => {
      watcher?.close()
    },
    [watcher],
  )

  // The pair is built once per watcher rather than handing `watcher.subscribe` itself over: a
  // method read off its object is unbound, and the store compares `subscribe` by identity.
  const subscribe = useMemo(
    () =>
      watcher === null
        ? noSubscribe
        : (listener: (state: TaskActivityState) => void): (() => void) =>
            watcher.subscribe(listener),
    [watcher],
  )
  const snapshot = useMemo(
    () => (watcher === null ? nothing : (): TaskActivityState => watcher.getState()),
    [watcher],
  )

  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** The snapshot a card with nothing to follow draws. */
function nothing(): TaskActivityState {
  return NOTHING
}
