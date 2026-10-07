import type { GetPreferencesResponse } from '@openharness/protocol'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { THEME_STORAGE_KEY } from '../../lib/theme'
import { makeFake, renderApp } from '../../test-support/render-app'

/**
 * Settings → Appearance (epic #201, X3).
 *
 * The card is a picker over the theme store, and the store's write back to the server is
 * `components/theme-preference.tsx`, mounted with the shell — so these tests render the app
 * rather than the card alone, and assert both halves of a click: the attribute the page is
 * painted with, and what the account ends up holding.
 *
 * The other half of X3 is which of the two wins when they disagree, which is what the second
 * test is about: the cache paints first (there is no request in the first frame), and the
 * account's stored value replaces it once it arrives.
 */

/** What the page is painted with. */
function painted(): string | undefined {
  return document.documentElement.dataset.theme
}

/** The radio with a given label, in the Appearance card. */
function option(label: string): HTMLElement {
  return screen.getByRole('radio', { name: label })
}

describe('the Appearance card', () => {
  it('saves a pick to the account, and paints it at once', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    renderApp(fake, { hash: '#/settings' })

    // The pickers show what is stored — `system`, for an account that never chose.
    await waitFor(() => {
      expect(option('System')).toBeChecked()
    })

    await user.click(option('Dark'))

    // Painted by the click itself, not by the round trip...
    expect(painted()).toBe('dark')
    expect(option('Dark')).toBeChecked()
    // ...and written to the server, which is what a later `oh` or another browser reads.
    await waitFor(async () => {
      expect(await fake.preferences.get()).toEqual({ default_model: null, theme: 'dark' })
    })

    // The cache is refreshed too, so the next first paint is already dark.
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('paints the cached theme first and adopts the account’s once it answers', async () => {
    const user = userEvent.setup({ delay: null })
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')

    const fake = makeFake({ preferences: { theme: 'light' } })
    // Hold the reads open: "the cache painted it" is only observable while the answer is late.
    // Every caller gets one — the shell's theme read and the settings screen's preferences
    // read are two — so all of them are answered at once.
    const held: ((preferences: GetPreferencesResponse) => void)[] = []
    fake.preferences.get = () =>
      new Promise((resolve) => {
        held.push(resolve)
      })

    renderApp(fake, { hash: '#/settings' })

    // The cache, not the account: the first frame is dark and no request has answered yet.
    expect(painted()).toBe('dark')
    await waitFor(() => {
      expect(option('Dark')).toBeChecked()
    })

    for (const answer of held) {
      answer({ default_model: null, theme: 'light' })
    }

    // The account's value wins once it has been read, and takes the cache with it.
    await waitFor(() => {
      expect(painted()).toBe('light')
    })
    expect(option('Light')).toBeChecked()
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')

    // A pick from here on is written back, like any other.
    await user.click(option('System'))
    await waitFor(() => {
      expect(option('System')).toBeChecked()
    })
  })
})
