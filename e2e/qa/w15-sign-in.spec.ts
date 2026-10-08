import { expect, openAccountMenu, signInWithDevForm, test } from './support'

/**
 * W15 — the sign-in page (epic #65, A1/A3/A7).
 *
 * The one page every scenario in this pass normally skips past, because the fixtures sign the
 * browser in before it loads. Here it is on purpose: a context with no session at all, and the
 * two ways in the page offers — the social providers, and the development login.
 *
 * The provider buttons only exist when the server has credentials for them, so that half of
 * the scenario skips unless the stack was started with dummy client ids (see `e2e/AGENTS.md`):
 *
 * ```bash
 * GOOGLE_CLIENT_ID=dummy GOOGLE_CLIENT_SECRET=dummy \
 *   GITHUB_CLIENT_ID=dummy GITHUB_CLIENT_SECRET=dummy \
 *   MICROSOFT_CLIENT_ID=dummy MICROSOFT_CLIENT_SECRET=dummy \
 *   docker compose up --build -d
 * ```
 *
 * Real sign-ins with Google, GitHub and Microsoft are checked by hand (they need real OAuth
 * apps); this scenario proves the page offers what the server reports.
 */
test.describe('W15 sign-in', () => {
  test('offers the configured providers and the dev form, and signs in', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await page.goto('/#/signin')
      await expect(page.getByRole('heading', { name: 'Sign in to openharness' })).toBeVisible()

      await test.step('the dev form is there (A7)', async () => {
        await expect(page.getByText('Development login')).toBeVisible()
        await expect(page.getByLabel('Username')).toBeVisible()
        await expect(page.getByLabel('Username')).toHaveAttribute('placeholder', 'dev@localhost')
        await expect(page.getByLabel('Password')).toBeVisible()
      })

      await test.step('the provider buttons match what the server has configured', async () => {
        // Read as the page's own request: no session, the same call the screen makes.
        const anonymous = await context.request.get('/v1/auth-config')
        expect(anonymous.status()).toBe(200)
        const config = (await anonymous.json()) as { providers: string[]; dev_login: boolean }
        expect(config.dev_login).toBe(true)

        const labels: Record<string, string> = {
          google: 'Sign in with Google',
          github: 'Sign in with GitHub',
          microsoft: 'Sign in with Microsoft',
        }
        test.skip(
          config.providers.length === 0,
          'the stack was started without provider client ids; see the note at the top of this file',
        )
        for (const provider of config.providers) {
          await expect(
            page.getByRole('button', { name: labels[provider] ?? '' }),
            `${provider} is configured, so its button is offered`,
          ).toBeVisible()
        }
      })

      await test.step('the card is its own padding above the first button (#187)', async () => {
        // The sign-in card is the only card in the app with a bare `CardContent` at the top —
        // every other one renders a `CardHeader` first, which is what the shadcn registry's
        // padding is designed around — and the `pt-6` that used to sit on that content put a
        // *second* 24px above the first button: 49px from the card's top border against 25px
        // below the last one. Measured against the card's own computed padding, so the check is
        // the relationship and not a number copied out of `card.tsx`.
        //
        // On this stack the dev form always follows the providers (the QA stack runs with
        // `OPENHARNESS_DEV_LOGIN=1`), so "below the last button" is not the card's bottom
        // border here; `sign-in-screen.test.tsx` pins that side (`top === bottom`), off the
        // same arithmetic, and this measures the real pixels of the top one.
        const anonymous = await context.request.get('/v1/auth-config')
        const config = (await anonymous.json()) as { providers: string[]; dev_login: boolean }
        const labels: Record<string, string> = {
          google: 'Sign in with Google',
          github: 'Sign in with GitHub',
          microsoft: 'Sign in with Microsoft',
        }
        test.skip(
          config.providers.length === 0,
          'the stack was started without provider client ids',
        )

        const card = page.locator('[data-slot="card"]').first()
        const firstButton = page.getByRole('button', {
          name: labels[config.providers[0] ?? ''] ?? '',
        })
        const lastButton = page.getByRole('button', {
          name: labels[config.providers[config.providers.length - 1] ?? ''] ?? '',
        })

        // Both viewports the issue was measured at: the widths do not enter the arithmetic
        // (the card is a fixed-width column inside a centred flex), and this proves it.
        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport)
          const cardBox = await card.boundingBox()
          const firstBox = await firstButton.boundingBox()
          const lastBox = await lastButton.boundingBox()
          expect(cardBox, 'the card is on screen').not.toBeNull()
          expect(firstBox, 'the first provider button is on screen').not.toBeNull()
          expect(lastBox, 'the last provider button is on screen').not.toBeNull()
          if (cardBox === null || firstBox === null || lastBox === null) {
            return
          }

          const style = await card.evaluate((element) => {
            const computed = getComputedStyle(element)
            return {
              paddingTop: Number.parseFloat(computed.paddingTop),
              borderTop: Number.parseFloat(computed.borderTopWidth),
            }
          })

          const above = firstBox.y - cardBox.y - style.borderTop
          expect(
            Math.abs(above - style.paddingTop),
            `at ${String(viewport.width)}x${String(viewport.height)}: the first button sits ${String(above)}px below the card's top border, and the card's own padding is ${String(style.paddingTop)}px`,
          ).toBeLessThanOrEqual(1)
        }
        await page.setViewportSize({ width: 1280, height: 800 })
      })

      await test.step('a wrong password is refused, without signing anybody in', async () => {
        await page.getByLabel('Username').fill('dev@localhost')
        await page.getByLabel('Password').fill('not-the-password')
        await page.getByRole('button', { name: 'Sign in', exact: true }).click()
        await expect(page.getByRole('alert')).toContainText(/sign-in failed/i)
        // Still the sign-in page: a refused attempt signs nobody in.
        await expect(page.getByRole('heading', { name: 'Sign in to openharness' })).toBeVisible()
      })

      await test.step('the dev user signs in and lands in the app', async () => {
        await signInWithDevForm(page)

        // The shell replaces the sign-in page, and the sidebar knows who it is (A2: a session
        // cookie; the URL never moved).
        await expect(page.getByRole('heading', { name: 'Sign in to openharness' })).toHaveCount(0)
        // The sidebar's own control, which only exists for a signed-in person — one menu
        // down, in the account menu at its foot (#211).
        await openAccountMenu(page)
        await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible()
        await page.keyboard.press('Escape')
      })

      await test.step('already signed in, #/signin goes home', async () => {
        await page.goto('/#/signin')
        await expect(page.getByRole('heading', { name: 'Sign in to openharness' })).toHaveCount(0)
      })
    } finally {
      await context.close()
    }
  })
})
