import {
  API_KEY,
  authHeaders,
  composer,
  expect,
  openChat,
  sendFromComposer,
  shot,
  test,
  waitForAnswer,
} from './support'

/**
 * W12 — auth. Needs a server started with `OPENHARNESS_API_KEY`, and the same value in
 * `QA_API_KEY`; without it the scenario is skipped rather than run against an open server.
 */
test.describe('W12 auth', () => {
  test('W12 no key and a wrong key are reported, the right key works', async ({
    page,
    request,
    consoleErrors,
  }) => {
    test.skip(API_KEY === '', 'set QA_API_KEY to the value the server was started with')

    await test.step('the API really is guarded', async () => {
      const anonymous = await request.get('/v1/agents')
      expect(anonymous.status()).toBe(401)
      const health = await request.get('/health')
      expect(health.status()).toBe(200)
    })

    await test.step('with no key saved, the app says so', async () => {
      await page.goto('/#/settings')
      await page.getByLabel('API key').fill('')
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible()

      await expect(page.getByRole('alert')).toBeVisible()
      await expect(page.getByRole('alert')).toContainText(/x-api-key|authentication|key/i)
      await shot(page, 'w12-01-no-key')
    })

    await test.step('a wrong key is reported', async () => {
      await page.getByLabel('API key').fill('not-the-key')
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByRole('alert')).toBeVisible()
      await expect(page.getByRole('alert')).toContainText(/x-api-key|authentication|key/i)
      await shot(page, 'w12-02-wrong-key')
    })

    await test.step('the right key works', async () => {
      await page.getByLabel('API key').fill(API_KEY)
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByRole('alert')).toHaveCount(0)

      const sessions = await request.get('/v1/sessions', { headers: authHeaders() })
      expect(sessions.status()).toBe(200)
      const body = (await sessions.json()) as { data: { id: string }[] }
      const session = body.data[0]
      expect(session, 'the server has a session to open').toBeTruthy()

      await openChat(page, session!.id)
      await expect(composer(page)).toBeFocused()
      await sendFromComposer(page, 'authenticated and working')
      await waitForAnswer(page, 'authenticated and working')
      await shot(page, 'w12-03-authenticated')
    })

    const unexpected = consoleErrors.filter(
      (entry) => !/Failed to load resource|the server responded with a status of 401/.test(entry),
    )
    expect(unexpected, unexpected.join('\n')).toEqual([])
  })
})
