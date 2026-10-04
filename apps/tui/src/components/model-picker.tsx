import type { ModelEntry } from '@openharness/protocol'
import { Box, Text, useInput } from 'ink'
import { useRef, useState, type ReactElement } from 'react'

/**
 * How many models the picker draws at once.
 *
 * The catalog can hold hundreds of models — every chat model of every provider the user has
 * a key for — and a frame that tall does not fit a terminal and is slow to redraw for every
 * keystroke. So the list is windowed: at most this many rows, following the cursor, with a
 * count of what is out of sight above and below. Ten rows plus the headings, the counts and
 * the hint fits a 24-row terminal with room to spare.
 */
export const MODEL_PICKER_VISIBLE_ROWS = 10

/** The free-text entry's label: a model the catalog does not know can still be typed (C5). */
export const OTHER_MODEL_LABEL = 'Other model id…'

export interface ModelPickerProps {
  /** The catalog, as `client.models.list()` returned it: sorted by provider, then name. */
  readonly models: readonly ModelEntry[]
  /** Called with the chosen model's router id (`provider/model`). */
  readonly onSelect: (modelId: string) => void
  /** Called when the user gives up (Ctrl+C). */
  readonly onCancel: () => void
}

/** One selectable row: a model, or the free-text entry. */
interface Row {
  /** The provider the row is grouped under; `''` for the free-text row. */
  readonly provider: string
  /** What the row says. */
  readonly text: string
  /** The id to start a session with — the model's, or {@link OTHER_ID} for free text. */
  readonly id: string
}

/** The sentinel the free-text row selects; not a router id any model could have. */
const OTHER_ID = '\u0000other'

/**
 * The model picker, shown for a new chat when neither `--agent` nor `--model` said where to
 * start (epic #92).
 *
 * The models come grouped by provider — a heading per provider, in the order the server
 * sorted them — each row showing the model's display name and context window, and the last
 * row, "Other model id…", takes a free-text `provider/model` id for a model the catalog does
 * not know yet (C5). Up/down move, Enter picks, the number keys pick directly, Ctrl+C
 * leaves. The list scrolls with the cursor, so every model can be reached however many there
 * are; the numbers are the positions in the whole list, not in the window.
 */
export function ModelPicker({ models, onSelect, onCancel }: ModelPickerProps) {
  const [index, setIndex] = useState(0)
  // `null` while the list is shown; the buffer while the free-text entry is being typed.
  const [typed, setTyped] = useState<string | null>(null)

  // The cursor and the buffer the handlers read.
  //
  // Ink hands `useInput` a callback that sees the latest *committed* render, and a terminal
  // can deliver several keystrokes inside one render — a paste, or a fast typist pressing
  // Enter. Reading React state there would read the position (or the buffer) from before
  // those keystrokes, so Enter could pick the row the cursor had left, or submit nothing.
  // The refs are the values of record; the state exists to render them.
  const indexRef = useRef(0)
  const typedRef = useRef<string | null>(null)

  const rows: readonly Row[] = [
    ...models.map((model) => ({
      provider: model.provider,
      text: modelText(model),
      id: model.id,
    })),
    { provider: '', text: OTHER_MODEL_LABEL, id: OTHER_ID },
  ]

  const moveTo = (next: number): void => {
    indexRef.current = next
    setIndex(next)
  }

  const edit = (next: string | null): void => {
    typedRef.current = next
    setTyped(next)
  }

  const choose = (row: Row | undefined): void => {
    if (row === undefined) return
    if (row.id === OTHER_ID) {
      edit('')
      return
    }
    onSelect(row.id)
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onCancel()
      return
    }

    if (typedRef.current !== null) {
      if (key.escape) {
        edit(null)
        return
      }
      if (key.return) {
        const id = typedRef.current.trim()
        if (id !== '') onSelect(id)
        return
      }
      if (key.backspace || key.delete) {
        edit(typedRef.current.slice(0, -1))
        return
      }
      // One character, or a whole paste as a single chunk; Ctrl+J's line feed is not text a
      // model id can hold.
      if (input.length > 0 && !key.ctrl && !key.meta && input !== '\n') {
        edit(`${typedRef.current}${input}`)
      }
      return
    }

    if (key.upArrow) {
      moveTo(Math.max(indexRef.current - 1, 0))
      return
    }

    if (key.downArrow) {
      moveTo(Math.min(indexRef.current + 1, rows.length - 1))
      return
    }

    if (key.return) {
      choose(rows[indexRef.current])
      return
    }

    // Only a list of at most nine can be picked by a single keystroke. Beyond that "12" would
    // choose 1 — a chat on the wrong model — so numbers are left to the arrows, which reach
    // every model anyway.
    if (rows.length > 9 || !/^[1-9]$/u.test(input)) return
    choose(rows[Number.parseInt(input, 10) - 1])
  })

  // The window is derived from the cursor rather than kept beside it, so the two cannot get
  // out of step: the cursor sits in the middle of the window wherever it can.
  const windowRows = Math.min(rows.length, MODEL_PICKER_VISIBLE_ROWS)
  const first = clamp(index - Math.floor(windowRows / 2), 0, Math.max(rows.length - windowRows, 0))
  const visible = rows.slice(first, first + windowRows)
  const above = first
  const below = rows.length - first - visible.length

  return (
    <Box flexDirection="column">
      <Text>Which model?</Text>
      {typed === null ? (
        renderRows(visible, first, index, above, below)
      ) : (
        <Text>{`❯ ${typed}`}</Text>
      )}
      <Text dimColor>
        {typed !== null
          ? 'type a model id as provider/model, Enter to start, Esc to go back'
          : `${rows.length > 9 ? '↑/↓ to choose' : '↑/↓ or a number to choose'}, Enter to start, Ctrl+C to quit`}
      </Text>
    </Box>
  )
}

/** The list's rows, with a provider heading wherever the provider changes between them. */
function renderRows(
  visible: readonly Row[],
  first: number,
  index: number,
  above: number,
  below: number,
): ReactElement[] {
  const items: ReactElement[] = []
  if (above > 0) {
    items.push(<Text key="above" dimColor>{`  ↑ ${above} more`}</Text>)
  }

  let heading: string | undefined
  visible.forEach((row, position) => {
    const number = first + position + 1
    if (row.provider !== '' && row.provider !== heading) {
      heading = row.provider
      items.push(
        <Text key={`provider-${row.provider}-${String(number)}`} dimColor>
          {`  ${row.provider}`}
        </Text>,
      )
    }
    const selected = first + position === index
    items.push(
      <Text key={`row-${String(number)}`} color={selected ? 'cyan' : undefined}>
        {`${selected ? '❯' : ' '} ${String(number)}. ${row.text}`}
      </Text>,
    )
  })

  if (below > 0) {
    items.push(<Text key="below" dimColor>{`  ↓ ${below} more`}</Text>)
  }

  return items
}

/** A row's line: the model's name, and its context window when it has one (C6). */
function modelText(model: ModelEntry): string {
  const context = formatContextWindow(model.context_window)
  return context === null ? model.name : `${model.name} · ${context} context`
}

/** Keep a number inside `[low, high]`. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

/**
 * A context window as a short human string: `200k`, `1M`, `1.5M`, or the plain number below
 * a thousand. `null` — the provider and the registry both lack it — has no string: the row
 * simply does not mention one.
 */
export function formatContextWindow(tokens: number | null): string | null {
  if (tokens === null || tokens <= 0) return null
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    const rounded = Number.isInteger(millions) ? String(millions) : millions.toFixed(1)
    return `${rounded.replace(/\.0$/u, '')}M`
  }
  if (tokens >= 1000) return `${String(Math.round(tokens / 1000))}k`
  return String(tokens)
}
