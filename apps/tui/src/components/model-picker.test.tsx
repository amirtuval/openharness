import { makeMode, makeModelEntry } from '@openharness/protocol/fixtures'
import type { Mode, ModelEntry } from '@openharness/protocol'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { frameOf, pressKey, typeText, waitFor, waitForScreen } from '../test-support/input'
import {
  formatContextWindow,
  MODES_HEADING,
  ModelPicker,
  OTHER_MODEL_LABEL,
  pickerRows,
} from './model-picker'

/** A catalog as the server sorts it: by provider, then name. */
const CATALOG: readonly ModelEntry[] = [
  makeModelEntry({
    id: 'anthropic/claude-opus-5-5',
    provider: 'anthropic',
    name: 'Claude Opus 5.5',
    context_window: 200_000,
  }),
  makeModelEntry({ id: 'anthropic/claude-sonnet-5', provider: 'anthropic' }),
  makeModelEntry({
    id: 'openai/gpt-4.1-mini',
    provider: 'openai',
    name: 'GPT-4.1 Mini',
    context_window: 1_000_000,
  }),
]

/** Render the picker and record what it answered. */
function renderPicker(models: readonly ModelEntry[] = CATALOG, modes: readonly Mode[] = []) {
  const selected: string[] = []
  const selectedModes: Mode[] = []
  let cancelled = false
  const instance = render(
    <ModelPicker
      models={models}
      modes={modes}
      onSelect={(modelId) => {
        selected.push(modelId)
      }}
      onSelectMode={(mode) => {
        selectedModes.push(mode)
      }}
      onCancel={() => {
        cancelled = true
      }}
    />,
  )

  return {
    ...instance,
    selected,
    selectedModes,
    wasCancelled: () => cancelled,
  }
}

/** A catalog of `count` models that differ only in their number, under one provider. */
function numberedModels(count: number): readonly ModelEntry[] {
  return Array.from({ length: count }, (_unused, index) =>
    makeModelEntry({
      id: `openai/model-${String(index)}`,
      provider: 'openai',
      name: `Model ${String(index)}`,
    }),
  )
}

afterEach(() => {
  cleanup()
})

describe('pickerRows', () => {
  /** The model rows' ids, in order — the free-text row, always last, left off. */
  const modelIds = (models: readonly ModelEntry[], query: string): readonly string[] =>
    pickerRows(models, query)
      .slice(0, -1)
      .map((row) => row.id)

  it('keeps every model, in the catalog order, for an empty query', () => {
    const rows = pickerRows(CATALOG, '')
    expect(rows).toHaveLength(CATALOG.length + 1)
    expect(modelIds(CATALOG, '')).toEqual([
      'anthropic/claude-opus-5-5',
      'anthropic/claude-sonnet-5',
      'openai/gpt-4.1-mini',
    ])
    expect(rows.at(-1)?.text).toBe(OTHER_MODEL_LABEL)
  })

  it('matches a display name, ignoring case', () => {
    expect(modelIds(CATALOG, 'OPUS')).toEqual(['anthropic/claude-opus-5-5'])
    expect(modelIds(CATALOG, 'mini')).toEqual(['openai/gpt-4.1-mini'])
  })

  it('matches a router id', () => {
    expect(modelIds(CATALOG, 'claude-sonnet')).toEqual(['anthropic/claude-sonnet-5'])
  })

  it('matches the provider name too', () => {
    // A real catalog spells the provider as the id's prefix, so a provider match is also an id
    // match; this entry, whose id names no provider, is what exercises the branch on its own.
    const exotic = makeModelEntry({ id: 'vendor/gizmo-2', provider: 'acme', name: 'Gizmo' })
    expect(modelIds([exotic], 'acme')).toEqual(['vendor/gizmo-2'])
    expect(modelIds([exotic], 'gizmo')).toEqual(['vendor/gizmo-2'])
    expect(pickerRows([exotic], 'nothing')).toHaveLength(1)
  })

  it('trims the query and drops the models it leaves out', () => {
    expect(modelIds(CATALOG, '  gemini  ')).toEqual([])
    expect(modelIds(CATALOG, '  claude  ')).toEqual([
      'anthropic/claude-opus-5-5',
      'anthropic/claude-sonnet-5',
    ])
  })

  it('leaves the free-text row, alone, when nothing matches', () => {
    const rows = pickerRows(CATALOG, 'zzz')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text).toBe(OTHER_MODEL_LABEL)
  })
})

describe('ModelPicker', () => {
  it('draws the catalog grouped by provider, with the context windows', async () => {
    const picker = renderPicker()
    await waitForScreen(picker, 'Which model?')

    const frame = frameOf(picker)
    // The provider headings come in the server's order, and each model sits under its own.
    expect(frame).toContain('anthropic')
    expect(frame.indexOf('anthropic')).toBeLessThan(frame.indexOf('openai'))
    expect(frame.indexOf('❯ 1. Claude Opus 5.5 · 200k context')).toBeLessThan(
      frame.indexOf('openai'),
    )
    expect(frame).toContain(' 2. Claude Sonnet 5')
    expect(frame).toContain(' 3. GPT-4.1 Mini · 1M context')
    // A model with no known context window says nothing about one.
    expect(frame).not.toContain('Claude Sonnet 5 · null')
    // The search line starts empty, and says what to do with it.
    expect(frame).toContain('Search: type to filter')
  })

  it('moves with the arrows and picks with Enter', async () => {
    const picker = renderPicker()
    await waitForScreen(picker, 'Which model?')

    pressKey(picker, 'down')
    await waitForScreen(picker, '❯ 2. Claude Sonnet 5 · 200k context')

    pressKey(picker, 'enter')
    await waitFor(() => picker.selected.length === 1)
    expect(picker.selected).toEqual(['anthropic/claude-sonnet-5'])
  })

  it('picks by number while the list is short enough', async () => {
    const picker = renderPicker()
    await waitForScreen(picker, 'Which model?')

    typeText(picker, '3')

    await waitFor(() => picker.selected.length === 1)
    expect(picker.selected).toEqual(['openai/gpt-4.1-mini'])
  })

  it('types a digit into the query when the list is too long to number', async () => {
    const picker = renderPicker(numberedModels(10))
    await waitForScreen(picker, 'Which model?')

    typeText(picker, '1')
    // "1" is a row number only while the whole list can be named with one keystroke; past nine
    // it is just the first character of a query, and nothing is picked.
    await waitForScreen(picker, 'Search: 1')
    expect(picker.selected).toEqual([])
    expect(frameOf(picker)).toContain('Model 1')
    expect(frameOf(picker)).not.toContain('Model 0')
  })

  it('filters the list as the query is typed, heading and all', async () => {
    const picker = renderPicker()
    await waitForScreen(picker, 'Which model?')

    typeText(picker, 'gpt')
    await waitForScreen(picker, 'Search: gpt')

    const frame = frameOf(picker)
    expect(frame).toContain('GPT-4.1 Mini · 1M context')
    expect(frame).not.toContain('Claude Opus 5.5')
    expect(frame).not.toContain('Claude Sonnet 5')
    // The provider whose models all dropped out takes its heading with it.
    expect(frame).not.toContain('anthropic')
    expect(frame).toContain('openai')
  })

  it('matches the router id and the provider name as well as the display name', async () => {
    const picker = renderPicker()
    await waitForScreen(picker, 'Which model?')

    typeText(picker, 'claude-sonnet')
    await waitForScreen(picker, 'Search: claude-sonnet')

    expect(frameOf(picker)).toContain('Claude Sonnet 5')
    expect(frameOf(picker)).not.toContain('Claude Opus 5.5')
  })

  it('starts the cursor at the first match again whenever the query changes', async () => {
    const picker = renderPicker()
    await waitForScreen(picker, 'Which model?')

    typeText(picker, 'cla')
    await waitForScreen(picker, 'Search: cla')
    pressKey(picker, 'down')
    await waitForScreen(picker, '❯ 2. Claude Sonnet 5 · 200k context')

    // One more letter is a new list, and the cursor goes back to its first row.
    typeText(picker, 'u')
    await waitForScreen(picker, 'Search: clau')
    expect(frameOf(picker)).toContain('❯ 1. Claude Opus 5.5 · 200k context')
  })

  it('puts a digit in the query rather than picking a row once a query is up', async () => {
    const picker = renderPicker()
    await waitForScreen(picker, 'Which model?')

    typeText(picker, 'c')
    await waitForScreen(picker, 'Search: c')
    // "2" would pick the second row while the query is empty; with one, it is a character —
    // which is the whole point of the rule, since model names are full of digits.
    typeText(picker, '2')
    await waitForScreen(picker, 'Search: c2')
    expect(picker.selected).toEqual([])
  })

  it('keeps every keystroke of a burst, not just the last', async () => {
    const picker = renderPicker()
    await waitForScreen(picker, 'Which model?')

    // No await between the writes: a terminal can deliver the whole burst inside one render,
    // and the query has to be the word, not its last letter.
    typeText(picker, 'claude')
    await waitForScreen(picker, 'Search: claude')
    expect(frameOf(picker)).toContain('❯ 1. Claude Opus 5.5 · 200k context')
  })

  it('removes the last character from the query with Backspace', async () => {
    const picker = renderPicker()
    await waitForScreen(picker, 'Which model?')

    typeText(picker, 'gpt')
    await waitForScreen(picker, 'Search: gpt')
    pressKey(picker, 'backspace')
    await waitForScreen(picker, 'Search: gp')
    expect(frameOf(picker)).toContain('GPT-4.1 Mini')

    pressKey(picker, 'backspace')
    pressKey(picker, 'backspace')
    await waitForScreen(picker, 'Search: type to filter')
    expect(frameOf(picker)).toContain('Claude Opus 5.5')
  })

  it('clears the query with Esc, and leaves when there is nothing to clear', async () => {
    const picker = renderPicker()
    await waitForScreen(picker, 'Which model?')

    typeText(picker, 'gpt')
    await waitForScreen(picker, 'Search: gpt')

    pressKey(picker, 'escape')
    await waitForScreen(picker, 'Search: type to filter')
    expect(picker.wasCancelled()).toBe(false)
    expect(frameOf(picker)).toContain('Claude Opus 5.5')

    pressKey(picker, 'escape')
    await waitFor(() => picker.wasCancelled())
  })

  it('counts the "more" lines from the filtered list', async () => {
    const picker = renderPicker(numberedModels(12))
    await waitForScreen(picker, '↓ 3 more')

    typeText(picker, 'model-1')
    await waitForScreen(picker, 'Search: model-1')

    const frame = frameOf(picker)
    // Models 1, 10 and 11 match, and they fit the window: nothing is out of sight any more.
    expect(frame).not.toContain('more')
    expect(frame).toContain('Model 1')
    expect(frame).not.toContain('Model 0')
  })

  it('shows "No models match" with only the free-text row left', async () => {
    const picker = renderPicker()
    await waitForScreen(picker, 'Which model?')

    typeText(picker, 'zzz')
    await waitForScreen(picker, 'No models match')

    const frame = frameOf(picker)
    expect(frame).toContain('Other model id…')
    expect(frame).not.toContain('Claude Opus 5.5')
    expect(frame).not.toContain('anthropic')
    expect(frame).not.toContain('openai')
  })

  it('carries the query into the free-text entry when "Other" is chosen', async () => {
    const picker = renderPicker()
    await waitForScreen(picker, 'Which model?')

    typeText(picker, 'meta/llama')
    await waitForScreen(picker, 'Search: meta/llama')
    pressKey(picker, 'enter')
    await waitForScreen(picker, '❯ meta/llama')

    // The carried query is a prefix, not a selection — the entry takes the rest.
    typeText(picker, '-4')
    await waitForScreen(picker, '❯ meta/llama-4')
    pressKey(picker, 'enter')

    await waitFor(() => picker.selected.length === 1)
    expect(picker.selected).toEqual(['meta/llama-4'])
  })

  it('starts a chat on a free-text model id typed into "Other"', async () => {
    const picker = renderPicker()
    await waitForScreen(picker, 'Which model?')

    // Down past every model to the free-text entry, and in.
    for (let press = 0; press < CATALOG.length; press += 1) pressKey(picker, 'down')
    await waitForScreen(picker, `❯ ${String(CATALOG.length + 1)}. Other model id…`)
    pressKey(picker, 'enter')

    await waitForScreen(picker, 'type a model id as provider/model')
    typeText(picker, 'meta/llama-4')
    await waitForScreen(picker, '❯ meta/llama-4')

    pressKey(picker, 'enter')
    await waitFor(() => picker.selected.length === 1)
    expect(picker.selected).toEqual(['meta/llama-4'])
  })

  it('backs out of the free-text entry with Esc', async () => {
    const picker = renderPicker()
    await waitForScreen(picker, 'Which model?')

    pressKey(picker, 'down')
    pressKey(picker, 'down')
    pressKey(picker, 'down')
    await waitForScreen(picker, 'Other model id…')
    pressKey(picker, 'enter')
    await waitForScreen(picker, '❯ ')

    // Typed a little, then thought better of.
    typeText(picker, 'oops')
    pressKey(picker, 'escape')

    await waitForScreen(picker, '↑/↓ or a number to choose')
    expect(picker.selected).toEqual([])
    expect(frameOf(picker)).not.toContain('oops')
  })

  it('cancels on Ctrl+C', async () => {
    const picker = renderPicker()
    await waitForScreen(picker, 'Which model?')

    pressKey(picker, 'ctrlC')

    await waitFor(() => picker.wasCancelled())
    expect(picker.selected).toEqual([])
  })

  it('cancels on Ctrl+C from the free-text entry too', async () => {
    const picker = renderPicker()
    await waitForScreen(picker, 'Which model?')

    pressKey(picker, 'down')
    pressKey(picker, 'down')
    pressKey(picker, 'down')
    pressKey(picker, 'enter')
    await waitForScreen(picker, 'type a model id as provider/model')

    pressKey(picker, 'ctrlC')

    await waitFor(() => picker.wasCancelled())
  })

  it('does not submit an empty free-text id', async () => {
    const picker = renderPicker()
    await waitForScreen(picker, 'Which model?')

    pressKey(picker, 'down')
    pressKey(picker, 'down')
    pressKey(picker, 'down')
    pressKey(picker, 'enter')
    await waitForScreen(picker, 'type a model id as provider/model')

    pressKey(picker, 'enter')

    await waitForScreen(picker, 'type a model id as provider/model')
    expect(picker.selected).toEqual([])
  })
})

describe('formatContextWindow', () => {
  it('shortens a window to something a row can hold', () => {
    expect(formatContextWindow(200_000)).toBe('200k')
    expect(formatContextWindow(1_000_000)).toBe('1M')
    expect(formatContextWindow(1_048_576)).toBe('1M')
    expect(formatContextWindow(1_500_000)).toBe('1.5M')
    expect(formatContextWindow(512)).toBe('512')
    expect(formatContextWindow(null)).toBeNull()
    expect(formatContextWindow(0)).toBeNull()
  })
})

describe('ModelPicker with modes (#245, M6)', () => {
  const MODE = makeMode({ name: 'smart', model: 'openai/gpt-4.1-mini', reasoning_effort: 'high' })

  it('puts the modes above the providers, and picks one', async () => {
    const picker = renderPicker(CATALOG, [MODE])
    await waitForScreen(picker, 'Which model?')

    // The Modes heading is the first thing under the prompt, above every provider.
    const frame = frameOf(picker)
    expect(frame.indexOf('Modes')).toBeGreaterThan(-1)
    expect(frame.indexOf('Modes')).toBeLessThan(frame.indexOf('anthropic'))
    expect(frame).toContain('smart · openai/gpt-4.1-mini · high')

    pressKey(picker, 'enter')
    await waitFor(() => picker.selectedModes.length === 1)
    expect(picker.selectedModes[0]?.id).toBe(MODE.id)
    expect(picker.selected).toEqual([])
  })

  it('filters the modes with the search line, and counts what is left', async () => {
    const picker = renderPicker(CATALOG, [MODE, makeMode({ name: 'fast' })])
    await waitForScreen(picker, 'Which model?')

    typeText(picker, 'sma')
    await waitFor(() => frameOf(picker).includes('Search: sma'))
    const frame = frameOf(picker)
    expect(frame).toContain('smart')
    expect(frame).not.toContain('fast')
    expect(frame).not.toContain('anthropic')
  })

  it('offers the mode rows through pickerRows, ahead of the models', () => {
    const rows = pickerRows(CATALOG, '', [MODE])
    expect(rows[0]?.id).toBe(MODE.id)
    expect(rows[0]?.provider).toBe(MODES_HEADING)
    expect(rows[0]?.mode).toBe(MODE)
  })
})
