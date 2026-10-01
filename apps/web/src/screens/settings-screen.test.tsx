import { AuthenticationError } from '@openharness/client'
import { createFakeClient } from '@openharness/client/testing'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { SETTINGS_STORAGE_KEY, getSettings } from '../lib/settings'
import { makeFake, renderApp } from '../test-support/render-app'

/** The settings screen: the server URL, and the model-provider keys this account runs on. */
describe('SettingsScreen', () => {
  it('starts from the defaults and says an empty URL means this origin', async () => {
    const fake = makeFake()
    renderApp(fake, { hash: '#/settings' })

    expect(await screen.findByLabelText('Server URL')).toHaveValue('')
    expect(screen.getByLabelText('Server URL')).toHaveAttribute(
      'placeholder',
      `(same origin: ${window.location.origin})`,
    )
  })

  it('saves the server URL to localStorage, and no key anywhere', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    renderApp(fake, { hash: '#/settings' })

    await user.type(await screen.findByLabelText('Server URL'), 'http://localhost:8787')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/Saved/)).toBeInTheDocument()
    await waitFor(() => {
      expect(getSettings()).toEqual({ serverUrl: 'http://localhost:8787' })
    })
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(
      JSON.stringify({ serverUrl: 'http://localhost:8787' }),
    )
  })

  it('opens with what a previous visit saved, and can clear the URL back to same-origin', async () => {
    const user = userEvent.setup({ delay: null })
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ serverUrl: 'https://api.example.com' }),
    )
    // Not `makeFake()`: this test wants what is already in `localStorage` to survive.
    const fake = createFakeClient()

    renderApp(fake, { hash: '#/settings' })

    expect(await screen.findByLabelText('Server URL')).toHaveValue('https://api.example.com')

    await user.clear(screen.getByLabelText('Server URL'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(getSettings().serverUrl).toBe('')
    })
  })

  it('says there are no keys yet, and lists what is saved as metadata only', async () => {
    const fake = makeFake()
    await fake.providerCredentials.put('anthropic', {
      type: 'api_key',
      api_key: 'sk-ant-abcdefgh1234',
    })
    renderApp(fake, { hash: '#/settings' })

    const list = within(await screen.findByRole('region', { name: 'Saved provider keys' }))

    expect(await list.findByText('anthropic')).toBeInTheDocument()
    expect(list.getByText('…1234')).toBeInTheDocument()
    expect(list.getByText(/Validated/)).toBeInTheDocument()
    // The key itself is nowhere: the API returns metadata, and the UI cannot show more.
    expect(document.body.textContent ?? '').not.toContain('sk-ant-abcdefgh1234')
  })

  it('adds a key, clears the field, and never renders the key back', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    renderApp(fake, { hash: '#/settings' })

    const key = 'sk-ant-super-secret-4321'
    const field = await screen.findByLabelText('API key')
    await user.type(field, key)
    await user.click(screen.getByRole('button', { name: 'Save key' }))

    expect(await screen.findByText(/Saved the anthropic key/)).toBeInTheDocument()
    expect(field).toHaveValue('')

    // What the server stored is metadata; what the page shows is metadata.
    await waitFor(async () => {
      const stored = await fake.providerCredentials.list()
      expect(stored.data.map((credential) => credential.last4)).toEqual(['4321'])
    })
    const list = within(screen.getByRole('region', { name: 'Saved provider keys' }))
    expect(await list.findByText('…4321')).toBeInTheDocument()
    expect(document.body.textContent ?? '').not.toContain(key)
    expect(document.body.innerHTML).not.toContain('super-secret')
  })

  it('replaces a saved key instead of adding a second one', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    await fake.providerCredentials.put('anthropic', { type: 'api_key', api_key: 'sk-ant-old-1111' })
    renderApp(fake, { hash: '#/settings' })

    // The button knows a key exists: saving is a replacement, and the list says so after.
    expect(await screen.findByRole('button', { name: 'Replace key' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('API key'), 'sk-ant-new-2222')
    await user.click(screen.getByRole('button', { name: 'Replace key' }))

    expect(await screen.findByText(/Saved the anthropic key/)).toBeInTheDocument()
    await waitFor(async () => {
      const stored = await fake.providerCredentials.list()
      expect(stored.data).toHaveLength(1)
      expect(stored.data[0]?.last4).toBe('2222')
    })
    expect(screen.queryByText('…1111')).not.toBeInTheDocument()
    expect(document.body.textContent ?? '').not.toContain('sk-ant-new-2222')
  })

  it('takes a free-text provider id for any router provider', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    renderApp(fake, { hash: '#/settings' })

    await user.selectOptions(await screen.findByLabelText('Provider'), 'Custom…')
    await user.type(screen.getByLabelText('Provider id'), 'mistral')
    await user.type(screen.getByLabelText('API key'), 'sk-mistral-9999')
    await user.click(screen.getByRole('button', { name: 'Save key' }))

    expect(await screen.findByText(/Saved the mistral key/)).toBeInTheDocument()
    await waitFor(async () => {
      const stored = await fake.providerCredentials.list()
      expect(stored.data.map((credential) => credential.provider)).toEqual(['mistral'])
    })
  })

  it('shows a rejected key next to the form, in the server’s words', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    renderApp(fake, { hash: '#/settings' })

    // The fake's one scriptable rejection: a key that is only whitespace fails the provider
    // call the server makes on save (422 invalid_provider_credential).
    const field = await screen.findByLabelText('API key')
    await user.type(field, '   ')
    await user.click(screen.getByRole('button', { name: 'Save key' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The key was rejected')
    expect(alert).toHaveTextContent('rejected by the provider')
    // Nothing was stored, so nothing is listed.
    expect(screen.queryByText(/Saved the/)).not.toBeInTheDocument()
  })

  it('asks for a fresh sign-in when the server requires one for a credential write', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    // A stale session: reads still work, the write is refused the way the server refuses one
    // older than `freshAge` (epic #65, A2) — 401.
    fake.providerCredentials.put = () => Promise.reject(new AuthenticationError('Not signed in.'))
    renderApp(fake, { hash: '#/settings' })

    await user.type(await screen.findByLabelText('API key'), 'sk-ant-late-0000')
    await user.click(screen.getByRole('button', { name: 'Save key' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Sign in again')
    expect(within(alert).getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      '#/signin?next=%23%2Fsettings',
    )
    // And the app is still on Settings: this is a prompt, not a sign-out.
    expect(screen.getByLabelText('Server URL')).toBeInTheDocument()
  })

  it('deletes a key after confirming in the page, not in a window.confirm', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    await fake.providerCredentials.put('openai', { type: 'api_key', api_key: 'sk-openai-7777' })
    renderApp(fake, { hash: '#/settings' })

    const list = within(await screen.findByRole('region', { name: 'Saved provider keys' }))
    await user.click(await list.findByRole('button', { name: 'Delete the openai key' }))

    // The confirmation is in the page: the key is still there, and Delete/Cancel are too.
    expect(list.getByText('Delete this key?')).toBeInTheDocument()
    await user.click(list.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Delete this key?')).not.toBeInTheDocument()
    await waitFor(async () => {
      expect((await fake.providerCredentials.list()).data).toHaveLength(1)
    })

    await user.click(list.getByRole('button', { name: 'Delete the openai key' }))
    await user.click(list.getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText(/Deleted the openai key/)).toBeInTheDocument()
    await waitFor(async () => {
      expect((await fake.providerCredentials.list()).data).toEqual([])
    })
    expect(list.queryByText('openai')).not.toBeInTheDocument()
  })
})
