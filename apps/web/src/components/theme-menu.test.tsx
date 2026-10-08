import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { chooseTheme, getTheme } from '../lib/theme'
import { makeFake, openAccountMenu, renderApp } from '../test-support/render-app'

/**
 * The theme quick switch (epic #201, X3; moved into the account menu by U10).
 *
 * It is the same store and the same saved write as Settings → Appearance, reached from the
 * chat: `useTheme()` for the click and `components/theme-preference.tsx` — mounted by the
 * shell — for the account. So a click here paints the page and lands in the preferences,
 * exactly as a click there does.
 *
 * Since U10 the four choices are the account menu's submenu rather than a button of their own
 * in the sidebar's foot, so every path here starts by opening that menu — which is also the
 * thing worth pinning: the switch is still reachable from the chat, one menu down.
 */

/** What the page is painted with. */
function painted(): string | undefined {
  return document.documentElement.dataset.theme
}

/**
 * Open the account menu and its Theme submenu.
 *
 * Keyboard, one key per call. Radix opens a submenu on hover and on ArrowRight, and only the
 * second survives jsdom — a `hover` produces no pointer event it listens to. The keys also have
 * to be separate `keyboard()` calls: Radix moves focus from the menu itself into its first item
 * on the way, and a single burst of keys arrives before React has re-rendered the focus.
 */
async function openThemeSubmenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await openAccountMenu(user)
  await user.keyboard('{ArrowDown}') // Settings
  await user.keyboard('{ArrowDown}') // Theme
  await user.keyboard('{ArrowRight}') // its four choices
}

describe('the theme quick switch in the account menu', () => {
  it('paints and saves a theme picked from the account menu', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    // Start from a known choice: the store is module-level, and another test may have left
    // one behind (the cache is cleared between them, the module's copy is not).
    chooseTheme('system')
    renderApp(fake)

    await openThemeSubmenu(user)
    await user.click(await screen.findByRole('menuitemradio', { name: 'Dim' }))

    expect(painted()).toBe('dim')
    expect(getTheme()).toBe('dim')
    // The menu closes on a pick, as any overlay here does.
    expect(screen.queryByRole('menuitemradio', { name: 'Dim' })).not.toBeInTheDocument()
    await waitFor(async () => {
      expect((await fake.preferences.get()).theme).toBe('dim')
    })

    // And it reads back: a second visit opens on the theme now in effect.
    await openThemeSubmenu(user)
    expect(await screen.findByRole('menuitemradio', { name: 'Dim' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('closes on Escape without choosing', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    chooseTheme('system')
    renderApp(fake)

    await openAccountMenu(user)
    expect(await screen.findByRole('menu')).toBeInTheDocument()

    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
    expect(getTheme()).toBe('system')
  })
})
