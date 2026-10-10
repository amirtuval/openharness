import { makeMode } from '@openharness/protocol/fixtures'
import { newModeId } from '@openharness/protocol'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { makeFake, renderApp } from '../../test-support/render-app'
import { TWO_PROVIDERS, credential } from '../../test-support/catalog'

/**
 * Settings → Modes (#245, M6), against the fake server.
 *
 * The card is the empty state, "Create mode", the list with Edit and an in-page Delete — the
 * shape the Providers card has. The two refusals the reader can fix themselves are here too: a
 * name they already have, and the twentieth-plus-one mode, both shown beside the form.
 */

function renderSettings(options: Parameters<typeof makeFake>[0] = {}): void {
  renderApp(makeFake({ ...TWO_PROVIDERS, ...options }), { hash: '#/settings' })
}

const user = userEvent.setup()

describe('Settings → Modes', () => {
  it('shows an empty state and creates a mode', async () => {
    renderSettings()
    expect(await screen.findByText(/No modes yet\./)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Create mode' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Name'), 'smart')
    // Pick a model from the catalog: open the picker and click the entry.
    await user.click(within(dialog).getByRole('button', { name: /Model/ }))
    await user.click(await screen.findByRole('option', { name: /Claude Sonnet 5/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Create mode' }))

    // The row is there, and the empty state is gone.
    expect(await screen.findByText('smart')).toBeInTheDocument()
    expect(screen.queryByText(/No modes yet\./)).not.toBeInTheDocument()
    expect(screen.getByText('anthropic/claude-sonnet-5')).toBeInTheDocument()
  })

  it('refuses a name the reader already has, beside the form', async () => {
    renderSettings({ modes: [makeMode({ name: 'deep' })] })
    expect(await screen.findByText('deep')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Create mode' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Name'), 'deep')
    await user.click(within(dialog).getByRole('button', { name: /Model/ }))
    await user.click(await screen.findByRole('option', { name: /Claude Sonnet 5/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Create mode' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/already exists/)
  })

  it('refuses the twenty-first mode', async () => {
    const modes = Array.from({ length: 20 }, (_unused, index) =>
      makeMode({ id: newModeId(), name: `mode ${index}` }),
    )
    renderSettings({ modes })
    await screen.findByText('mode 0')

    await user.click(screen.getByRole('button', { name: 'Create mode' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Name'), 'one too many')
    await user.click(within(dialog).getByRole('button', { name: /Model/ }))
    await user.click(await screen.findByRole('option', { name: /Claude Sonnet 5/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Create mode' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/limit/)
  })

  it('edits a mode', async () => {
    renderSettings({ modes: [makeMode({ name: 'deep' })] })
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog')
    const name = within(dialog).getByLabelText('Name')
    await user.clear(name)
    await user.type(name, 'deeper')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('deeper')).toBeInTheDocument()
    expect(screen.queryByText('deep')).not.toBeInTheDocument()
  })

  it('deletes a mode after an in-page confirmation', async () => {
    renderSettings({ modes: [makeMode({ name: 'deep' })] })
    const row = (await screen.findByText('deep')).closest('li')
    expect(row).not.toBeNull()

    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Delete' }))
    // Cancelling keeps it.
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('deep')).toBeInTheDocument()

    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Delete' }))
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText('deep')).not.toBeInTheDocument())
    expect(screen.getByText(/No modes yet\./)).toBeInTheDocument()
  })

  it('offers "my default model" as the model', async () => {
    renderSettings({ credentials: [credential('anthropic')] })
    await user.click(await screen.findByRole('button', { name: 'Create mode' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Name'), 'mine')
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(within(dialog).getByRole('button', { name: 'Create mode' }))

    expect(await screen.findByText('mine')).toBeInTheDocument()
    // The row says what it follows, so the reader can tell it apart from a pinned model.
    expect(screen.getByText(/my default model/)).toBeInTheDocument()
  })

  it('does not offer modes in the Default model picker', async () => {
    renderSettings({ modes: [makeMode({ name: 'deep' })] })
    // The Default model card is a model preference, not a mode: its picker has no Modes group.
    await screen.findByText('deep')
    const pickers = await screen.findAllByRole('button', { name: /Model|Choose a model/ })
    for (const picker of pickers) {
      await user.click(picker)
      // Nothing above the models: the group heading is a Modes-card row name only.
      expect(screen.queryByRole('group', { name: 'Modes' })).not.toBeInTheDocument()
      await user.keyboard('{Escape}')
    }
    expect(screen.getByText('deep')).toBeInTheDocument()
  })
})
