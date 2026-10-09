import type { ModelEntry } from '@openharness/protocol'
import { makeMode } from '@openharness/protocol/fixtures'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { RefreshOutcome } from '../../hooks/use-models'
import { ANTHROPIC, OPENAI, modelEntry, providerStatus } from '../../test-support/catalog'
import { ModelPicker, type ModelPickerProps } from './model-picker'

/**
 * The picker on its own (#91, epic #116): grouping, search, the free-text escape hatch, the
 * keyboard rule, refresh — and its two sizes, the Settings trigger and the composer's compact
 * control. Rendered directly rather than through a screen: none of it needs a client or a
 * route, and the screens' tests are about the flows that use it.
 */

function renderPicker(props: Partial<ModelPickerProps> = {}) {
  const onChange = vi.fn()
  const result = render(
    <ModelPicker
      models={[ANTHROPIC, OPENAI]}
      providers={[providerStatus('anthropic'), providerStatus('openai')]}
      value={null}
      onChange={onChange}
      {...props}
    />,
  )
  return { onChange, result }
}

/** The picker's trigger button (either variant). */
function trigger(): HTMLElement {
  return screen.getByRole('button', { name: /Model/ })
}

/** The group inside the open listbox for one provider. */
function group(provider: string): HTMLElement {
  return within(screen.getByRole('listbox', { name: 'Models' })).getByRole('group', {
    name: provider,
  })
}

function openPicker(): HTMLElement {
  const button = trigger()
  return button
}

describe('ModelPicker', () => {
  it('groups the catalog by provider, with display names, ids and context windows', async () => {
    const user = userEvent.setup({ delay: null })
    renderPicker()

    await user.click(openPicker())

    const anthropic = group('anthropic')
    expect(within(anthropic).getByText('Claude Sonnet 5')).toBeInTheDocument()
    expect(within(anthropic).getByText(/anthropic\/claude-sonnet-5/)).toBeInTheDocument()
    expect(within(anthropic).getByText(/200K context/)).toBeInTheDocument()

    const openai = group('openai')
    expect(within(openai).getByText('GPT-4.1 mini')).toBeInTheDocument()
    expect(within(openai).getByText(/openai\/gpt-4\.1-mini/)).toBeInTheDocument()
    expect(within(openai).getByText(/128K context/)).toBeInTheDocument()

    // A provider the catalog does not list is not there at all — the list is the catalog, not
    // a hardcoded provider table.
    expect(
      within(screen.getByRole('listbox', { name: 'Models' })).queryByRole('group', {
        name: 'google',
      }),
    ).not.toBeInTheDocument()
  })

  it('searches by name and by id', async () => {
    const user = userEvent.setup({ delay: null })
    renderPicker()

    await user.click(openPicker())
    await user.type(screen.getByRole('combobox', { name: 'Search models' }), 'gpt-4.1')

    expect(group('openai')).toBeInTheDocument()
    expect(
      within(screen.getByRole('listbox', { name: 'Models' })).queryByRole('group', {
        name: 'anthropic',
      }),
    ).not.toBeInTheDocument()
  })

  it('offers a picked free-text model and reports it through onChange', async () => {
    const user = userEvent.setup({ delay: null })
    const { onChange } = renderPicker()

    await user.click(openPicker())
    await user.click(screen.getByRole('option', { name: /Other model ID/ }))
    await user.type(screen.getByLabelText('Model ID'), 'deepseek/deepseek-chat')
    await user.click(screen.getByRole('button', { name: 'Use model' }))

    expect(onChange).toHaveBeenCalledWith('deepseek/deepseek-chat')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger()).toHaveFocus()
  })

  it('is keyboard driven: arrows move, Enter picks, Escape closes', async () => {
    const user = userEvent.setup({ delay: null })
    const { onChange } = renderPicker()

    const button = trigger()
    button.focus()
    await user.keyboard('{Enter}')

    // The combobox pattern: focus stays in the search field, the active option is announced.
    const search = screen.getByRole('combobox', { name: 'Search models' })
    expect(search).toHaveFocus()
    expect(search).toHaveAttribute('aria-activedescendant')
    expect(screen.getByRole('option', { name: /Claude Sonnet 5/ })).toHaveAttribute(
      'data-active',
      'true',
    )

    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')

    expect(onChange).toHaveBeenCalledWith('openai/gpt-4.1-mini')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(button).toHaveFocus()

    await user.click(button)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(button).toHaveFocus()
  })

  it('shows the fallback note on a provider that came from the built-in list', async () => {
    const user = userEvent.setup({ delay: null })
    renderPicker({
      providers: [
        providerStatus('anthropic'),
        providerStatus('openai', {
          status: 'fallback',
          fetched_at: null,
          message: 'The provider timed out.',
        }),
      ],
    })

    await user.click(openPicker())

    expect(
      within(group('openai')).getByText("from the built-in list; the provider couldn't be reached"),
    ).toBeInTheDocument()
  })

  it('refreshes through onRefresh, keeping the panel open', async () => {
    const user = userEvent.setup({ delay: null })
    const onRefresh = vi.fn((): Promise<RefreshOutcome> => Promise.resolve({ ok: true }))
    renderPicker({ onRefresh })

    await user.click(openPicker())
    await user.click(screen.getByRole('button', { name: 'Refresh models' }))

    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('listbox', { name: 'Models' })).toBeInTheDocument()
  })

  it('shows a rate-limited refresh as a note, not an error', async () => {
    const user = userEvent.setup({ delay: null })
    renderPicker({
      // The server's sentence, as the outcome carries it.
      onRefresh: () =>
        Promise.resolve({
          ok: false,
          kind: 'rate_limit',
          message: 'Refreshed too recently; try again in a minute.',
        }),
    })

    await user.click(openPicker())
    await user.click(screen.getByRole('button', { name: 'Refresh models' }))

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Refreshed too recently; try again in a minute.',
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says why a failed refresh failed', async () => {
    const user = userEvent.setup({ delay: null })
    renderPicker({
      onRefresh: () =>
        Promise.resolve({ ok: false, kind: 'error', message: 'The catalog service is down.' }),
    })

    await user.click(openPicker())
    await user.click(screen.getByRole('button', { name: 'Refresh models' }))

    expect(await screen.findByRole('status')).toHaveTextContent(
      'The catalog could not be refreshed. The catalog service is down.',
    )
  })

  it('names the model on the compact trigger and opens the same listbox', async () => {
    const user = userEvent.setup({ delay: null })
    renderPicker({ variant: 'compact', value: OPENAI.id })

    // The composer's control reads as one quiet line: the display name, and a chevron.
    const button = screen.getByRole('button', { name: 'Model: GPT-4.1 mini' })
    expect(button).toHaveAttribute('aria-haspopup', 'listbox')
    // Theme-aware by construction: an app button, never a native select (#87).
    expect(button.tagName).toBe('BUTTON')

    await user.click(button)
    expect(group('anthropic')).toBeInTheDocument()
  })

  it('shows a value the catalog does not know as its id', () => {
    renderPicker({ variant: 'compact', value: 'deepseek/deepseek-chat' })

    expect(
      screen.getByRole('button', { name: 'Model: deepseek/deepseek-chat' }),
    ).toBeInTheDocument()
  })
})

describe('ModelPicker on a catalog with one entry', () => {
  it('still offers the entry and the free-text escape hatch', async () => {
    const user = userEvent.setup({ delay: null })
    const only: ModelEntry = modelEntry({
      id: 'anthropic/claude-haiku-4-5',
      provider: 'anthropic',
      name: 'Claude Haiku 4.5',
    })
    renderPicker({ models: [only], providers: [providerStatus('anthropic')] })

    await user.click(openPicker())

    expect(group('anthropic').textContent).toContain('Claude Haiku 4.5')
    expect(screen.getByRole('option', { name: /Other model ID/ })).toBeInTheDocument()
  })
})

describe('ModelPicker with modes (#245, M6)', () => {
  const MODE = makeMode({ name: 'deep', model: 'anthropic/claude-sonnet-5' })

  it('offers the modes as a group above the providers, and picks one', async () => {
    const user = userEvent.setup({ delay: null })
    const onSelectMode = vi.fn()
    renderPicker({ modes: [MODE], onSelectMode })

    await user.click(trigger())

    const modes = within(screen.getByRole('listbox', { name: 'Models' })).getByRole('group', {
      name: 'Modes',
    })
    expect(within(modes).getByText('deep')).toBeInTheDocument()
    // The row says what the mode resolves to.
    expect(within(modes).getByText(/anthropic\/claude-sonnet-5 · high/)).toBeInTheDocument()

    // The group is above every provider group in the list.
    const listbox = screen.getByRole('listbox', { name: 'Models' })
    const groups = [...listbox.querySelectorAll('[role="group"]')].map((element) =>
      element.getAttribute('aria-label'),
    )
    expect(groups).toEqual(['Modes', 'anthropic', 'openai'])

    await user.click(within(modes).getByRole('option', { name: /deep/ }))
    expect(onSelectMode).toHaveBeenCalledWith(MODE)
  })

  it('filters the modes as the query is typed', async () => {
    const user = userEvent.setup({ delay: null })
    renderPicker({ modes: [makeMode({ name: 'deep' }), makeMode({ name: 'fast' })] })
    await user.click(trigger())
    const search = screen.getByRole('combobox')
    await user.type(search, 'dee')
    const listbox = screen.getByRole('listbox', { name: 'Models' })
    expect(within(listbox).getByText('deep')).toBeInTheDocument()
    expect(within(listbox).queryByText('fast')).not.toBeInTheDocument()
    // Nothing matches: the empty line names modes as well as models.
    await user.clear(search)
    await user.type(search, 'zzz')
    expect(within(listbox).getByText(/No modes or models match/)).toBeInTheDocument()
  })

  it('names the mode the chat follows in the compact trigger', () => {
    renderPicker({ modes: [MODE], selectedModeId: MODE.id, variant: 'compact' })
    expect(screen.getByRole('button', { name: 'Model: deep' })).toBeInTheDocument()
  })
})
