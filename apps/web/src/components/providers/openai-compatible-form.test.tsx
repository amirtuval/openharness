import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { credential } from '../../test-support/catalog'
import { makeFake, renderApp } from '../../test-support/render-app'

/**
 * The custom OpenAI-compatible form (epic #245, A3b).
 *
 * The tile, the two fields (a base URL and a key that may be left empty), and the public
 * `details` the route publishes — the base URL's host — which the saved list shows. A second
 * credential of the type asks for a name, exactly as Azure's does, and a keyless save is
 * accepted rather than held.
 */

/** The Add-provider dialog, opened from Settings → Providers. */
async function openDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Add provider' }))
  return screen.findByRole('dialog')
}

/** Open the custom tile in the dialog. */
async function openCustomForm(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const dialog = await openDialog(user)
  await user.click(within(dialog).getByRole('button', { name: 'Custom (OpenAI-compatible)' }))
  return dialog
}

describe('the custom OpenAI-compatible form', () => {
  it('opens on the custom tile with a base URL and an optional key, and no key page', async () => {
    const user = userEvent.setup({ delay: null })
    renderApp(makeFake({ models: [], providers: [] }), { hash: '#/settings' })

    const dialog = await openCustomForm(user)

    expect(within(dialog).getByText('Connect Custom (OpenAI-compatible)')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Base URL')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('API key (optional)')).toBeInTheDocument()
    // A custom endpoint is the reader's own, so there is no "Get a key" page to draw.
    expect(within(dialog).queryByText('Get a key')).not.toBeInTheDocument()
    // The first credential of a type takes the type's default name, so nothing asks for one.
    expect(within(dialog).queryByLabelText('Name')).not.toBeInTheDocument()
  })

  it('stores a keyless endpoint under the default name, publishing only its host', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ models: [], providers: [] })
    renderApp(fake, { hash: '#/settings' })

    const dialog = await openCustomForm(user)
    await user.type(within(dialog).getByLabelText('Base URL'), 'http://127.0.0.1:11434/v1')
    // The key is optional: the save is enabled with nothing typed into it.
    const save = within(dialog).getByRole('button', { name: 'Save key' })
    await waitFor(() => {
      expect(save).toBeEnabled()
    })
    await user.click(save)

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    const { data } = await fake.providerCredentials.list()
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({
      type: 'openai_compatible',
      name: 'custom',
      last4: '',
      details: { base_url_host: '127.0.0.1:11434' },
    })
    // The list names it, shows that it carries no key and the host it points at — and never the
    // whole URL, whose path is the reader's.
    const list = within(screen.getByRole('region', { name: 'Saved credentials' }))
    expect(await list.findByText('Custom (OpenAI-compatible)')).toBeInTheDocument()
    expect(list.getByText('no key')).toBeInTheDocument()
    expect(list.getByText(/127\.0\.0\.1:11434/)).toBeInTheDocument()
    expect(document.body.textContent ?? '').not.toContain('127.0.0.1:11434/v1')
  })

  it('stores a keyed endpoint and shows its last four', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ models: [], providers: [] })
    renderApp(fake, { hash: '#/settings' })

    const dialog = await openCustomForm(user)
    await user.type(within(dialog).getByLabelText('Base URL'), 'https://api.example.com/v1')
    await user.type(within(dialog).getByLabelText('API key (optional)'), 'sk-custom-4242')
    await user.click(within(dialog).getByRole('button', { name: 'Save key' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    const { data } = await fake.providerCredentials.list()
    expect(data[0]).toMatchObject({
      name: 'custom',
      last4: '4242',
      details: { base_url_host: 'api.example.com' },
    })
    const list = within(screen.getByRole('region', { name: 'Saved credentials' }))
    expect(list.getByText('…4242')).toBeInTheDocument()
    expect(document.body.textContent ?? '').not.toContain('sk-custom-4242')
  })

  it('asks for a name for a second credential of the type, and saves under it', async () => {
    const user = userEvent.setup({ delay: null })
    // One custom credential is already stored, so the type's default name is taken.
    const fake = makeFake({
      credentials: [credential('custom', '1111')],
      models: [],
      providers: [],
    })
    renderApp(fake, { hash: '#/settings' })

    const dialog = await openCustomForm(user)

    const name = within(dialog).getByLabelText('Name')
    expect(name).toBeInTheDocument()
    await user.type(name, 'my-local')
    await user.type(within(dialog).getByLabelText('Base URL'), 'http://127.0.0.1:8000/v1')
    await user.click(within(dialog).getByRole('button', { name: 'Save key' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    const { data } = await fake.providerCredentials.list()
    expect(data.map((entry) => entry.name).sort()).toEqual(['custom', 'my-local'])
    const list = within(screen.getByRole('region', { name: 'Saved credentials' }))
    expect(await list.findByText('my-local')).toBeInTheDocument()
  })

  it('refuses a name the server would refuse, before the save', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({
      credentials: [credential('custom', '1111')],
      models: [],
      providers: [],
    })
    renderApp(fake, { hash: '#/settings' })

    const dialog = await openCustomForm(user)
    await user.type(within(dialog).getByLabelText('Base URL'), 'https://api.example.com/v1')

    const name = within(dialog).getByLabelText('Name')
    const save = within(dialog).getByRole('button', { name: 'Save key' })

    for (const [typed, expected] of [
      ['Custom', /short and lowercase/],
      ['openai', /belongs to one of the built-in providers/],
      ['custom', /already have a Custom \(OpenAI-compatible\) credential called that/],
    ] as const) {
      await user.clear(name)
      await user.type(name, typed)
      expect(await within(dialog).findByText(expected)).toBeInTheDocument()
      expect(save).toBeDisabled()
    }

    // A name of its own is accepted, and the save goes through (the key is optional).
    await user.clear(name)
    await user.type(name, 'my-local')
    await waitFor(() => {
      expect(save).toBeEnabled()
    })
  })
})
