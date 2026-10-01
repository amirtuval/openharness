import { expect, signInWithDevForm, test } from './support'

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
        // The sidebar's own control, which only exists for a signed-in person.
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
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
