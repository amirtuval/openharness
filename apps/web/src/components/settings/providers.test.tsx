import { ApiError, AuthenticationError } from '@openharness/client'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { TWO_PROVIDERS } from '../../test-support/catalog'
import { makeFake, renderApp } from '../../test-support/render-app'

/**
 * Settings → Providers (epic #65 A5; epic #201 X5): the list, and the destructive half of the
 * flow. Adding and replacing are the Add-provider dialog, which has its own file — what this
 * card has to get right is the list, the in-page delete, and where each of its buttons leads.
 */
describe('the Providers card', () => {
  it('lists a saved key as metadata only, never the key itself', async () => {
    const fake = makeFake({ credentials: TWO_PROVIDERS.credentials })
    renderApp(fake, { hash: '#/settings' })

    const list = within(await screen.findByRole('region', { name: 'Saved credentials' }))

    // The display name from the shared metadata, and the last four characters — never the id
    // alone and never the key.
    expect(await list.findByText('Anthropic')).toBeInTheDocument()
    expect(list.getByText('…1111')).toBeInTheDocument()
    expect(list.getAllByText(/Validated/)).toHaveLength(2)
    expect(list.getByText('OpenAI')).toBeInTheDocument()
    expect(document.body.textContent ?? '').not.toContain('sk-ant')
  })

  it('says there are no keys yet, and offers the way to add one', async () => {
    const fake = makeFake({ models: [], providers: [] })
    renderApp(fake, { hash: '#/settings' })

    expect(await screen.findByText(/No credentials yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add provider' })).toBeInTheDocument()
  })

  it('opens the dialog on the tiles from Add provider', async () => {
    const user = userEvent.setup({ delay: null })
    renderApp(makeFake({ models: [], providers: [] }), { hash: '#/settings' })

    await user.click(await screen.findByRole('button', { name: 'Add provider' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Add a provider')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /Mistral/ })).toBeInTheDocument()
  })

  it('replaces a key through the dialog, and the list follows', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ credentials: TWO_PROVIDERS.credentials })
    renderApp(fake, { hash: '#/settings' })

    await user.click(await screen.findByRole('button', { name: 'Replace the openai credential' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Connect OpenAI')).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText('API key'), 'sk-openai-new-9999')
    await user.click(within(dialog).getByRole('button', { name: 'Replace key' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(await screen.findByText('Saved the openai credential.')).toBeInTheDocument()
    // One credential per provider: the row is the same row, with the new last four.
    const list = within(screen.getByRole('region', { name: 'Saved credentials' }))
    expect(await list.findByText('…9999')).toBeInTheDocument()
    await waitFor(() => {
      expect(list.queryByText('…2222')).not.toBeInTheDocument()
    })
    expect(document.body.textContent ?? '').not.toContain('sk-openai-new-9999')
  })

  it('deletes a key after confirming in the page, not in a window.confirm', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ credentials: TWO_PROVIDERS.credentials })
    renderApp(fake, { hash: '#/settings' })

    const list = within(await screen.findByRole('region', { name: 'Saved credentials' }))
    await user.click(await list.findByRole('button', { name: 'Delete the openai credential' }))

    // The confirmation is in the page: the key is still there, and Delete/Cancel are too.
    expect(list.getByText('Delete this key?')).toBeInTheDocument()
    await user.click(list.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Delete this key?')).not.toBeInTheDocument()
    await waitFor(async () => {
      expect((await fake.providerCredentials.list()).data).toHaveLength(2)
    })

    await user.click(list.getByRole('button', { name: 'Delete the openai credential' }))
    await user.click(list.getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('Deleted the openai credential.')).toBeInTheDocument()
    await waitFor(async () => {
      expect((await fake.providerCredentials.list()).data.map((entry) => entry.name)).toEqual([
        'anthropic',
      ])
    })
    expect(list.queryByText('OpenAI')).not.toBeInTheDocument()
  })

  it('shows a failed delete inline', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ credentials: TWO_PROVIDERS.credentials })
    fake.providerCredentials.delete = () =>
      Promise.reject(new ApiError(500, 'The key store is down.'))
    renderApp(fake, { hash: '#/settings' })

    const list = within(await screen.findByRole('region', { name: 'Saved credentials' }))
    await user.click(await list.findByRole('button', { name: 'Delete the anthropic credential' }))
    await user.click(list.getByRole('button', { name: 'Delete' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The request failed')
    expect(alert).toHaveTextContent('The key store is down.')
    // Nothing was deleted, so the row is still there.
    expect(list.getByText('Anthropic')).toBeInTheDocument()
  })

  it('asks for a fresh sign-in when the server requires one for a credential write', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ credentials: TWO_PROVIDERS.credentials })
    // A stale session: reads still work, the write is refused the way the server refuses one
    // older than `freshAge` (epic #65, A2) — 401.
    fake.providerCredentials.delete = () =>
      Promise.reject(new AuthenticationError('Not signed in.'))
    renderApp(fake, { hash: '#/settings' })

    const list = within(await screen.findByRole('region', { name: 'Saved credentials' }))
    await user.click(await list.findByRole('button', { name: 'Delete the anthropic credential' }))
    await user.click(list.getByRole('button', { name: 'Delete' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Sign in again')
    expect(within(alert).getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      '#/signin?next=%23%2Fsettings',
    )
    // And the app is still on Settings: this is a prompt, not a sign-out.
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
  })

  it('shows a failed keys load as a banner with what went wrong', async () => {
    const fake = makeFake(TWO_PROVIDERS)
    fake.providerCredentials.list = () =>
      Promise.reject(new ApiError(500, 'The key store is down.'))
    renderApp(fake, { hash: '#/settings' })

    const title = await screen.findByText('Could not load your credentials')
    expect(title.closest('[role="alert"]')).toHaveTextContent('The key store is down.')
  })
})
