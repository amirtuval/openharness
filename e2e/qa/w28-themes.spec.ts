import {
  expect,
  expectNoErrorBanner,
  openThemeSubmenu,
  paintedTheme,
  setStoredTheme,
  shot,
  storedTheme,
  test,
} from './support'

/**
 * W28 — the web themes (epic #201, X3, issue #203).
 *
 * Four choices — System, Light, Dim, Dark — stored on the account beside the default model,
 * painted as `data-theme` on `<html>`, and painted from a `localStorage` cache before the
 * server has been asked anything. What a browser can prove that a unit test cannot: the same
 * account opening the app in a second tab (a fresh document, an empty cache) still gets its
 * theme, and `system` really follows what the operating system says.
 *
 * The account's theme is put back at the end: the scenarios after this one did not ask for it
 * to be changed, and a stored theme follows the user to every browser in the stack.
 */
test.describe('W28 the web themes', () => {
  test('W28 a pick is painted, saved, and read back', async ({ page, request, consoleErrors }) => {
    const previous = await storedTheme(request)

    try {
      await test.step('the picker shows what the account holds', async () => {
        await page.goto('/#/settings')
        await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
        await expect(page.getByRole('radiogroup', { name: 'Theme' })).toBeVisible()
        await expect(page.getByRole('radio', { name: 'System' })).toBeChecked()
        await shot(page, 'w28-01-settings-system')
      })

      await test.step('each choice paints <html> and lands on the server', async () => {
        for (const [label, painted] of [
          ['Dim', 'dim'],
          ['Dark', 'dark'],
          ['Light', 'light'],
        ] as const) {
          await page.getByRole('radio', { name: label }).check()
          await expect(page.locator('html')).toHaveAttribute('data-theme', painted)
          expect(await storedTheme(request)).toBe(painted)
          await shot(page, `w28-02-settings-${painted}`)
        }
      })

      await test.step('a reload paints the stored theme before asking anything', async () => {
        // The account holds `light` now, but the cache the page reads first is the one the
        // last click wrote — so this is the same value either way, which is the point.
        await page.reload()
        await expect(page.getByRole('radio', { name: 'Light' })).toBeChecked()
        expect(await paintedTheme(page)).toBe('light')
        await expectNoErrorBanner(page)
      })

      await test.step('the account menu’s quick switch is the same setting', async () => {
        // Since #211 the four choices are a submenu of the account menu at the foot of the
        // sidebar (#201, U10): one menu for the person, rather than a theme button, a
        // sign-out button and an email sharing the corner.
        await openThemeSubmenu(page)
        await page.getByRole('menuitemradio', { name: 'Dim' }).click()

        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dim')
        expect(await storedTheme(request)).toBe('dim')
        await shot(page, 'w28-03-account-menu-dim')

        // And it reads back: the submenu opens on the choice the account holds.
        await openThemeSubmenu(page)
        await expect(page.getByRole('menuitemradio', { name: 'Dim' })).toHaveAttribute(
          'aria-checked',
          'true',
        )
        await shot(page, 'w28-04-account-menu-theme')
        await page.keyboard.press('Escape')
      })

      await test.step('a browser with no cache still ends up on the account’s theme', async () => {
        // What a second browser sees: the cache is the only thing that is local, so emptying
        // it leaves the account's stored value as the only answer — and the page takes it,
        // then caches it so the *next* first paint is right without asking.
        await page.evaluate(() => {
          localStorage.clear()
        })
        await page.reload()

        await expect(page.getByRole('radio', { name: 'Dim' })).toBeChecked()
        expect(await paintedTheme(page)).toBe('dim')
        const cached = await page.evaluate(() => localStorage.getItem('openharness:theme'))
        expect(cached).toBe('dim')
      })
    } finally {
      await setStoredTheme(request, previous)
    }

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W28b System follows the operating system, live', async ({ page, request }) => {
    const previous = await storedTheme(request)

    try {
      await setStoredTheme(request, 'system')
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.goto('/#/settings')
      await expect(page.getByRole('radio', { name: 'System' })).toBeChecked()

      // `system` resolves to one of the two, and it is the two the browser is told about.
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await shot(page, 'w28-04-system-dark')

      // The operating system flips while the page is open: no reload, no click.
      await page.emulateMedia({ colorScheme: 'light' })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await shot(page, 'w28-05-system-light')
    } finally {
      await setStoredTheme(request, previous)
    }
  })
})
