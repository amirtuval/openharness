import {
  composer,
  expect,
  expectNoErrorBanner,
  sendFromComposer,
  shot,
  test,
  waitForAnswer,
} from './support'

/**
 * W1 — first run: an empty app, and the first chat it can start.
 *
 * Model-first since #91: New chat picks a model from the catalog, and there is no agent form
 * to drive any more — this scenario used to create an agent through the UI first. What the
 * catalog holds depends on the stack: with a provider key stored it lists models and the
 * chat half runs; without one the screen is the empty state pointing at Settings, which is
 * itself a first-run state worth asserting rather than skipping over.
 */
test.describe('W1 first run', () => {
  test('W1 empty state, the catalog, and a first chat', async ({
    page,
    request,
    consoleErrors,
  }) => {
    await test.step('the app opens on the home screen with nothing in it', async () => {
      const sessions = await request.get('/v1/sessions')
      const body = (await sessions.json()) as { data: unknown[] }

      await page.goto('/')
      await expect(page.getByRole('heading', { name: 'openharness' })).toBeVisible()
      await expect(page.getByRole('link', { name: 'New chat' }).first()).toBeVisible()

      if (body.data.length > 0) {
        // Not the assertion's fault: this server has been used before. The full first-run
        // reading needs a database with no sessions in it.
        test.info().annotations.push({
          type: 'note',
          description: `server already has ${body.data.length} session(s); the empty-state assertion was not exercised`,
        })
      } else {
        await expect(page.getByText('No chats yet.')).toBeVisible()
        await shot(page, 'w1-01-empty-state')
      }
    })

    // Which first chat is possible depends on whether the pass has a key stored (see
    // `QA_PROVIDER_KEY` in `e2e/AGENTS.md`): the catalog lists a provider only with one.
    const modelList = await request.get('/v1/models')
    const catalog = (await modelList.json()) as { providers: unknown[] }

    await test.step('New chat offers the catalog — or Settings, with no keys at all', async () => {
      await page.getByRole('link', { name: 'New chat' }).first().click()
      await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()

      if (catalog.providers.length === 0) {
        await expect(page.getByText('No model providers yet')).toBeVisible()
        await expect(page.getByRole('link', { name: /Model providers/ })).toBeVisible()
        await shot(page, 'w1-02-no-providers')
        return
      }

      // The picker with a default selection — the last model a chat was created with, else
      // the catalog's first entry — so Create chat works without opening it.
      await expect(page.getByRole('button', { name: 'Model' })).toBeVisible()
      await page.getByRole('button', { name: 'Create chat' }).click()

      await expect(page).toHaveURL(/#\/s\/sesn_/)
      await expect(composer(page)).toBeFocused()
      await expect(page.getByText('Say something to start the conversation.')).toBeVisible()

      await sendFromComposer(page, 'hello from W1')
      await waitForAnswer(page, 'hello from W1')
      await shot(page, 'w1-03-first-chat')
    })

    await expectNoErrorBanner(page)

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
