import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { chooseTheme, getTheme } from '../lib/theme'
import { makeFake, renderApp } from '../test-support/render-app'

/**
 * The sidebar's theme quick switch (epic #201, X3).
 *
 * It is the same store and the same saved write as Settings → Appearance, reached from the
 * chat: `useTheme()` for the click and `components/theme-preference.tsx` — mounted by the
 * shell — for the account. So a click here paints the page and lands in the preferences,
 * exactly as a click there does.
 */

/** What the page is painted with. */
function painted(): string | undefined {
  return document.documentElement.dataset.theme
}

describe('the sidebar theme menu', () => {
  it('paints and saves a theme picked from the user row', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    // Start from a known choice: the store is module-level, and another test may have left
    // one behind (the cache is cleared between them, the module's copy is not).
    chooseTheme('system')
    renderApp(fake)

    const trigger = await screen.findByRole('button', { name: 'Theme: System' })
    await user.click(trigger)

    await user.click(await screen.findByRole('menuitemradio', { name: 'Dim' }))

    expect(painted()).toBe('dim')
    expect(getTheme()).toBe('dim')
    // The menu closes on a pick, as any overlay here does.
    expect(screen.queryByRole('menu', { name: 'Theme' })).not.toBeInTheDocument()
    await waitFor(async () => {
      expect((await fake.preferences.get()).theme).toBe('dim')
    })

    // And it reads back: the trigger says which theme is in effect.
    expect(await screen.findByRole('button', { name: 'Theme: Dim' })).toBeInTheDocument()
  })

  it('closes on Escape without choosing', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    chooseTheme('system')
    renderApp(fake)

    await user.click(await screen.findByRole('button', { name: 'Theme: System' }))
    expect(await screen.findByRole('menu', { name: 'Theme' })).toBeInTheDocument()

    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: 'Theme' })).not.toBeInTheDocument()
    })
    expect(getTheme()).toBe('system')
  })
})
