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
  /** Called when the user gives up (Ctrl+C, or Esc with nothing to clear). */
  readonly onCancel: () => void
}

/** One selectable row: a model, or the free-text entry. */
export interface PickerRow {
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
 * The rows a query leaves, in the order the picker draws them.
 *
 * A model survives when its display name, its router id (`provider/model`) or its provider
 * name holds the query — a case-insensitive substring match, on the trimmed query — so a
 * provider's heading stays exactly where the models under it do: a provider with no match
 * contributes no rows, and the heading is derived from the rows, so it goes with them. An
 * empty query keeps everything (`''` is a substring of every string, so the unfiltered list
 * is this function's first result), and the free-text row is always there, always last,
 * because a model the catalog does not know must stay reachable however narrow the list.
 */
export function pickerRows(models: readonly ModelEntry[], query: string): readonly PickerRow[] {
  const needle = query.trim().toLowerCase()
  return [
    ...models
      .filter((model) => matchesQuery(model, needle))
      .map((model) => ({ provider: model.provider, text: modelText(model), id: model.id })),
    { provider: '', text: OTHER_MODEL_LABEL, id: OTHER_ID },
  ]
}

/** Whether a model's display name, id or provider holds `needle` — already trimmed, lower-cased. */
function matchesQuery(model: ModelEntry, needle: string): boolean {
  return (
    model.name.toLowerCase().includes(needle) ||
    model.id.toLowerCase().includes(needle) ||
    model.provider.toLowerCase().includes(needle)
  )
}

/**
 * The model picker, shown for a new chat when neither `--agent` nor `--model` said where to
 * start (epic #92), and for `/model` in a chat.
 *
 * The models come grouped by provider — a heading per provider, in the order the server
 * sorted them — each row showing the model's display name and context window, and the last
 * row, "Other model id…", takes a free-text `provider/model` id for a model the catalog does
 * not know yet (C5). A search line at the top filters the list as it is typed: the printable
 * keys add to the query, Backspace removes from it, and Esc clears it — or leaves, when there
 * is nothing to clear. Up/down move and Enter picks in the filtered list, whose cursor starts
 * at the first match again each time the query changes. Ctrl+C leaves.
 *
 * The list scrolls with the cursor, so every model can be reached however many there are; the
 * numbers name the rows of the whole list, but they are a keystroke only while the query is
 * empty and the list is short enough for one (see the handler).
 */
export function ModelPicker({ models, onSelect, onCancel }: ModelPickerProps) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  // `null` while the list is shown; the buffer while the free-text entry is being typed.
  const [typed, setTyped] = useState<string | null>(null)

  // The query, the cursor and the buffer the handlers read.
  //
  // Ink hands `useInput` a callback that sees the latest *committed* render, and a terminal
  // can deliver several keystrokes inside one render — a paste, or a fast typist pressing
  // Enter. Reading React state there would read the query (or the position, or the buffer)
  // from before those keystrokes, so a typed "gpt" would filter down to its last letter and
  // Enter could pick a row the cursor had left, or submit nothing. The refs are the values of
  // record; the state exists to render them.
  const queryRef = useRef('')
  const indexRef = useRef(0)
  const typedRef = useRef<string | null>(null)

  const rows = pickerRows(models, query)

  const moveTo = (next: number): void => {
    indexRef.current = next
    setIndex(next)
  }

  /** Set the query and put the cursor back on the first row of the list it now describes. */
  const search = (next: string): void => {
    queryRef.current = next
    setQuery(next)
    moveTo(0)
  }

  const edit = (next: string | null): void => {
    typedRef.current = next
    setTyped(next)
  }

  const choose = (row: PickerRow | undefined): void => {
    if (row === undefined) return
    if (row.id === OTHER_ID) {
      // Carry the query into the free-text entry, so a half-typed id is finished rather than
      // retyped.
      edit(queryRef.current.trim())
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

    // The rows these keys act on, built from the refs: a keystroke in front of Enter may not
    // have been rendered yet, and Enter must pick from the list it has already narrowed — not
    // from the one on screen before it.
    const current = pickerRows(models, queryRef.current)

    if (key.escape) {
      if (queryRef.current !== '') {
        search('')
        return
      }
      // Nothing to clear: Esc is the way out, as it has always been.
      onCancel()
      return
    }

    if (key.backspace || key.delete) {
      if (queryRef.current !== '') search(queryRef.current.slice(0, -1))
      return
    }

    if (key.upArrow) {
      moveTo(Math.max(indexRef.current - 1, 0))
      return
    }

    if (key.downArrow) {
      moveTo(Math.min(indexRef.current + 1, current.length - 1))
      return
    }

    if (key.return) {
      choose(current[indexRef.current])
      return
    }

    // A number picks a row by its position only while the query is empty and the whole list is
    // short enough to name with one keystroke — past nine, "12" would be a row under nine rows
    // and two digits under more. Once a query is being typed a digit is a character in it,
    // because model names are full of them (`gpt-4o`, `claude-sonnet-5`) and "gpt-4" has to
    // survive its own "4".
    if (queryRef.current === '' && current.length <= 9 && /^[1-9]$/u.test(input)) {
      choose(current[Number.parseInt(input, 10) - 1])
      return
    }

    // Printable text, or a whole paste as one chunk, narrows the list.
    if (input.length > 0 && !key.ctrl && !key.meta && input !== '\n') {
      search(`${queryRef.current}${input}`)
    }
  })

  // The window is derived from the cursor rather than kept beside it, so the two cannot get
  // out of step: the cursor sits in the middle of the window wherever it can.
  const windowRows = Math.min(rows.length, MODEL_PICKER_VISIBLE_ROWS)
  const first = clamp(index - Math.floor(windowRows / 2), 0, Math.max(rows.length - windowRows, 0))
  const visible = rows.slice(first, first + windowRows)
  const above = first
  const below = rows.length - first - visible.length

  const filtering = query.trim() !== ''
  // Everything was filtered away and only the free-text row is left.
  const noMatches = filtering && rows.length === 1

  return (
    <Box flexDirection="column">
      <Text>Which model?</Text>
      {typed === null ? (
        <>
          <Text>
            <Text dimColor>Search: </Text>
            {query === '' ? <Text dimColor>type to filter</Text> : query}
          </Text>
          {noMatches ? <Text dimColor>No models match</Text> : null}
          {renderRows(visible, first, index, above, below)}
        </>
      ) : (
        <Text>{`❯ ${typed}`}</Text>
      )}
      <Text dimColor>{hint(typed !== null, query, rows.length)}</Text>
    </Box>
  )
}

/**
 * The line under the picker: what the keys do in the view that is up.
 *
 * The numbers are offered only while they work — an empty query and a list short enough to
 * name each row with one keystroke — and "Esc to clear" only while there is a query to clear,
 * because with none Esc leaves instead.
 */
function hint(typing: boolean, query: string, rowCount: number): string {
  if (typing) return 'type a model id as provider/model, Enter to start, Esc to go back'
  const choose = query === '' && rowCount <= 9 ? '↑/↓ or a number to choose' : '↑/↓ to choose'
  const clear = query === '' ? '' : ', Esc to clear'
  return `${choose}${clear}, Enter to start, Ctrl+C to quit`
}

/** The list's rows, with a provider heading wherever the provider changes between them. */
function renderRows(
  visible: readonly PickerRow[],
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
