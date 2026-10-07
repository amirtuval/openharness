import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { TWO_PROVIDERS, credential } from '../../test-support/catalog'
import { makeFake, renderApp } from '../../test-support/render-app'

/**
 * The Add-provider dialog (epic #201, X5): the same key form the first-run screen uses,
 * reachable from a chat — the model picker's last row, and the missing-key banner.
 *
 * What matters here is that a reader never leaves the chat to fix a key, and that a save is
 * visible to the chat immediately: the catalog is re-read, so the provider just connected is
 * in the picker the moment the dialog closes.
 */
describe('the Add-provider dialog', () => {
  it('opens from the model picker without leaving the chat', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    renderApp(fake)

    const hash = window.location.hash
    await user.click(await screen.findByRole('button', { name: /^Model: / }))
    await user.click(screen.getByRole('button', { name: '+ Add provider' }))

    const dialog = await screen.findByRole('dialog')
    // The tiles, because the reader has not said which provider: a dialog opened by hand
    // cannot guess one.
    expect(within(dialog).getByRole('button', { name: /Anthropic/ })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /OpenAI/ })).toBeInTheDocument()
    // The picker closed behind it — a popover under a modal is a trap for the focus the
    // dialog just took.
    expect(screen.queryByRole('listbox', { name: 'Models' })).not.toBeInTheDocument()
    // And the chat is still the route: this is a dialog, not a screen.
    expect(window.location.hash).toBe(hash)
  })

  it('collects a key, refreshes the catalog, and closes', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    renderApp(fake)

    await user.click(await screen.findByRole('button', { name: /^Model: / }))
    await user.click(screen.getByRole('button', { name: '+ Add provider' }))
    const dialog = await screen.findByRole('dialog')

    await user.click(within(dialog).getByRole('button', { name: /Groq/ }))

    // The same form as the first-run screen: the provider's own "get a key" link, and the
    // key field.
    expect(within(dialog).getByRole('link', { name: 'Get a key' })).toHaveAttribute(
      'href',
      'https://console.groq.com/keys',
    )
    await user.type(within(dialog).getByLabelText('API key'), 'gsk-from-a-chat-4321')
    await user.click(within(dialog).getByRole('button', { name: 'Save key' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    await waitFor(async () => {
      expect((await fake.providerCredentials.list()).data.map((entry) => entry.last4)).toEqual([
        '4321',
      ])
    })
    // The catalog was re-read (the plain way — a saves invalidates the server's cache entry
    // for that provider, so this is not the rate-limited refresh).
    await waitFor(() => {
      expect(fake.modelListCalls.map((call) => call.refresh)).toEqual([false, false])
    })
    // The shell says what happened, since the dialog is gone.
    expect(await screen.findByText('Saved the Groq key.')).toBeInTheDocument()
  })

  it('opens on the provider that was preselected, and cancels out of it', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ credentials: [credential('openai')] })
    renderApp(fake, { hash: '#/settings' })

    // Settings → Providers → Replace, which is the same dialog with the provider already known.
    await user.click(await screen.findByRole('button', { name: 'Replace the openai key' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Connect OpenAI')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Replace key' })).toBeInTheDocument()
    // No "back to the list": there is nothing to go back to when the caller named the
    // provider, so the second button is the ordinary way out instead.
    expect(
      within(dialog).queryByRole('button', { name: 'Back to the list' }),
    ).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  it('closes on Escape, and gives focus back to what opened it', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(TWO_PROVIDERS)
    renderApp(fake, { hash: '#/settings' })

    const trigger = await screen.findByRole('button', { name: 'Add provider' })
    await user.click(trigger)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    // Radix returns focus to the trigger: the keyboard reader is where they were, not on the
    // body. (A hand-rolled overlay is exactly where this goes wrong.)
    expect(trigger).toHaveFocus()
  })
})
