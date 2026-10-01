import { BASE_URL, expect, shot, signInWithDevForm, test } from './support'

/**
 * W16 — signing out (epic #65, A2).
 *
 * A context of its own, signed in through the page rather than by the shared fixture: signing
 * out revokes the session the *shared* fixtures would otherwise keep handing to every later
 * scenario, so this one must not touch it.
 *
 * What the scenario proves: the control is in the sidebar, it puts the app back on the
 * sign-in page without moving the URL, the cookie is gone (a reload stays signed out, and the
 * API refuses it), and signing in again comes back to where the person was.
 */
test.describe('W16 sign out', () => {
  test('signs out from the sidebar, and the session is gone for real', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await test.step('sign in through the page', async () => {
        await page.goto('/#/signin')
        await signInWithDevForm(page)
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
      })

      // Somewhere that is not the home screen, so "comes back here" means something.
      await page.goto('/#/agents')
      await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible()
      await shot(page, 'w16-01-signed-in')

      await test.step('sign out puts the sign-in page back, at the same URL', async () => {
        await page.getByRole('button', { name: 'Sign out' }).click()
        await expect(page.getByRole('heading', { name: 'Sign in to openharness' })).toBeVisible()
        expect(new URL(page.url()).hash).toBe('#/agents')
        await shot(page, 'w16-02-signed-out')
      })

      await test.step('the session is really gone, not just hidden', async () => {
        // A reload does not bring the app back: the cookie is not there any more.
        await page.reload()
        await expect(page.getByRole('heading', { name: 'Sign in to openharness' })).toBeVisible()

        // And the API the cookie used to open answers 401 — the session row is deleted, so the
        // request fails even for a caller that kept a copy of the cookie.
        const refused = await context.request.get('/v1/me')
        expect(refused.status()).toBe(401)
      })

      await test.step('signing in again comes back to where the person was', async () => {
        await signInWithDevForm(page)
        await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible()
        expect(page.url()).toBe(`${BASE_URL}/#/agents`)
      })
    } finally {
      await context.close()
    }
  })
})
