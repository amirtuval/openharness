import {
  composer,
  composerModel,
  expect,
  expectNoErrorBanner,
  getDefaultModel,
  sendFromComposer,
  shot,
  test,
  waitForAnswer,
} from './support'

/**
 * W1 — first run: no agents, and the first chat the account can start.
 *
 * Model-first since #91 and immediate since U2/#113: New chat is an empty composer on the
 * account's **default model**, and the session is created by the first message — there is no
 * agent form to drive and no "Create chat" button. `#/agents`, a bookmark from before #91,
 * lands on the home screen: the Agents screen is gone from the app.
 *
 * Which first chat is possible depends on what the stack has: with a default model — a stored
 * provider key, the automatic pick it triggers (U4), or a default an earlier scenario of this
 * pass left in place — New chat is the composer, and this scenario sends the first message.
 * With none (a fresh mock stack: no keys, no catalog) the screen is the no-default state
 * pointing at Settings, which is itself a first-run reading worth asserting rather than
 * skipping over.
 */
test.describe('W1 first run', () => {
  test('W1 the empty app, no agents, and the immediate first chat', async ({
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

    await test.step('there is no Agents screen any more', async () => {
      // The sidebar offers no Agent link, and the old `#/agents` bookmark is home, not a
      // screen: agents stay in the API as optional presets (#96) and left the UI in #91.
      await expect(page.getByRole('link', { name: 'Agents' })).toHaveCount(0)
      await page.goto('/#/agents')
      await expect(page.getByRole('heading', { name: 'openharness' })).toBeVisible()
      await shot(page, 'w1-02-agents-bookmark-lands-home')
    })

    // Which first chat is possible depends on the pass: a real-provider pass has keys and a
    // default (U4 picks one on the first key); a mock pass may have neither.
    const defaultModel = await getDefaultModel(request)

    if (defaultModel === null) {
      await test.step('with no default and no keys, New chat points at Settings', async () => {
        await page.goto('/#/new')
        await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()
        await expect(page.getByText('Add a provider key to start')).toBeVisible()
        // The way out is a link to the screen that fixes it, not a dead end.
        await expect(page.getByRole('link', { name: /Model providers/ })).toBeVisible()
        await shot(page, 'w1-03-no-default')
      })
    } else {
      await test.step('New chat is an empty composer on the default model', async () => {
        await page.goto('/#/new')
        await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()
        // No dialog and nothing to create first: the composer is there, focused, with the
        // default model selected (the catalog may not even list it — the id still shows).
        await expect(composer(page)).toBeFocused()
        await expect(composerModel(page)).toContainText(defaultModel)
        await shot(page, 'w1-04-new-chat-on-the-default')
      })

      await test.step('the first message creates the chat and is answered', async () => {
        await sendFromComposer(page, 'hello from W1')
        await expect(page).toHaveURL(/#\/s\/sesn_/)
        await waitForAnswer(page, 'hello from W1')
        await shot(page, 'w1-05-first-chat')
      })
    }

    await expectNoErrorBanner(page)

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
