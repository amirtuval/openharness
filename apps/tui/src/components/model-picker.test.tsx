import { makeModelEntry } from '@openharness/protocol/fixtures'
import type { ModelEntry } from '@openharness/protocol'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { frameOf, pressKey, typeText, waitFor, waitForScreen } from '../test-support/input'
import { formatContextWindow, ModelPicker } from './model-picker'

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
function renderPicker(models: readonly ModelEntry[] = CATALOG) {
  const selected: string[] = []
  let cancelled = false
  const instance = render(
    <ModelPicker
      models={models}
      onSelect={(modelId) => {
        selected.push(modelId)
      }}
      onCancel={() => {
        cancelled = true
      }}
    />,
  )

  return {
    ...instance,
    selected,
    wasCancelled: () => cancelled,
  }
}

afterEach(() => {
  cleanup()
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

  it('leaves the numbers to the arrows when the list is longer than nine', async () => {
    const models = Array.from({ length: 10 }, (_unused, index) =>
      makeModelEntry({
        id: `openai/model-${String(index)}`,
        provider: 'openai',
        name: `Model ${String(index)}`,
      }),
    )
    const picker = renderPicker(models)
    await waitForScreen(picker, 'Which model?')

    typeText(picker, '1')
    // Nothing was picked: "1" is a row number only while a single keystroke cannot be a
    // prefix of one, and eleven rows is past that.
    expect(picker.selected).toEqual([])
    expect(frameOf(picker)).toContain('↓ 1 more')
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

    // Typed a little, then thought better of it.
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
