import { createFakeClient } from '@openharness/client/testing'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { SETTINGS_STORAGE_KEY, getSettings } from '../lib/settings'
import { makeFake, renderApp } from '../test-support/render-app'

/** The settings screen: two values in `localStorage`, and what an empty URL means. */
describe('SettingsScreen', () => {
  it('starts from the defaults and says an empty URL means this origin', async () => {
    const fake = makeFake()
    renderApp(fake, { hash: '#/settings' })

    expect(await screen.findByLabelText('Server URL')).toHaveValue('')
    expect(screen.getByLabelText('API key')).toHaveValue('')
    expect(screen.getByLabelText('Server URL')).toHaveAttribute(
      'placeholder',
      `(same origin: ${window.location.origin})`,
    )
  })

  it('saves the server URL and the API key to localStorage', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    renderApp(fake, { hash: '#/settings' })

    await user.type(await screen.findByLabelText('Server URL'), 'http://localhost:8787')
    await user.type(screen.getByLabelText('API key'), 'oh_secret')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/Saved/)).toBeInTheDocument()
    await waitFor(() => {
      expect(getSettings()).toEqual({ serverUrl: 'http://localhost:8787', apiKey: 'oh_secret' })
    })
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(
      JSON.stringify({ serverUrl: 'http://localhost:8787', apiKey: 'oh_secret' }),
    )
  })

  it('opens with what a previous visit saved, and can clear the URL back to same-origin', async () => {
    const user = userEvent.setup({ delay: null })
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ serverUrl: 'https://api.example.com', apiKey: 'oh_saved' }),
    )
    // Not `makeFake()`: this test wants what is already in `localStorage` to survive.
    const fake = createFakeClient()

    renderApp(fake, { hash: '#/settings' })

    expect(await screen.findByLabelText('Server URL')).toHaveValue('https://api.example.com')
    expect(screen.getByLabelText('API key')).toHaveValue('oh_saved')

    await user.clear(screen.getByLabelText('Server URL'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(getSettings().serverUrl).toBe('')
    })
    expect(getSettings().apiKey).toBe('oh_saved')
  })
})
