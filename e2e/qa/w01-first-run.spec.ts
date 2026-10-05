import {
  composer,
  defaultModel,
  ensureDefaultModel,
  expect,
  expectNoErrorBanner,
  sendFromComposer,
  setDefaultModel,
  shot,
  test,
  uniqueName,
  waitForAnswer,
} from './support'

/**
 * W1 — first run: an empty app, the default model, and the first chat it starts.
 *
 * Model-first since #91, immediate since #113 (epic #116, U2): "New chat" is an empty chat
 * whose composer runs on the account's **default model**, and the session is created with the
 * first message — there is no picker screen and no agent form to drive any more (this scenario
 * used to create an agent through the UI first, then pick it).
 *
 * The states a first run can be in are all worth asserting, and which one this stack is in
 * depends on what it holds:
 *
 * - **no default, no key** (the mock pass) → "Add a provider key to start" and the link to
 *   Settings, which is what a first run with nothing configured must say. The immediate chat
 *   is then driven by storing a default the way Settings does (`PUT /v1/me/preferences`),
 *   because that is the state the rest of the scenario is about.
 * - **no default, keys** (#146) → the composer waits for a pick ("Pick a model to start"),
 *   because the catalog lists what can run; the same `PUT` then gives it a default.
 * - **a default** (a stack where a key was saved, or another scenario set one) → the composer
 *   straight away.
 *
 * Either way the default is put back afterwards: a pass that runs W1 first must not leave the
 * account configured in a way the scenarios after it did not ask for.
 */
test.describe('W1 first run', () => {
  test('W1 empty state, the default model, and a first chat', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const previousDefault = await defaultModel(request)

    await test.step('the app opens on the home screen with nothing in it', async () => {
      const sessions = await request.get('/v1/sessions')
      const body = (await sessions.json()) as { data: unknown[] }

      await page.goto('/')
      // The app opens on home: a heading, the sidebar, and — on a stack nobody has used — the
      // empty-state line. Which heading depends on the viewport (the shell owns it), so this
      // asserts the app is up rather than a particular word.
      await expect(page.getByRole('heading', { name: 'openharness' })).toBeVisible()

      if (body.data.length > 0) {
        // Not the assertion's fault: this server has been used before. The full first-run
        // reading needs a database with no sessions in it.
        test.info().annotations.push({
          type: 'note',
          description: `server already has ${body.data.length} session(s); the empty-state assertion was not exercised`,
        })
      } else {
        await expect(page.getByText('No chats yet.')).toBeVisible()
        await shot(page, 'w1-01-first-run-home')
      }
    })

    await test.step('New chat is a chat, or a pointer to Settings when nothing can run', async () => {
      await page.getByRole('link', { name: 'New chat' }).first().click()
      await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()

      if (previousDefault === null) {
        const catalog = (await (await request.get('/v1/models')).json()) as { data: unknown[] }
        if (catalog.data.length === 0) {
          // No key has been saved on this stack and nothing set a default: the one honest
          // thing the screen can say. (The server's automatic default arrives with the first
          // key, U4 — see `defaultModel` in `support.ts`.)
          await expect(page.getByText('Add a provider key to start')).toBeVisible()
          await expect(page.getByRole('link', { name: /Model providers/ })).toBeVisible()
          await shot(page, 'w1-02-no-default')
        } else {
          // Keys but no default (#146): the catalog says what can run, so the composer offers
          // it — waiting for a pick, or with a sole model preselected — instead of claiming
          // there is no key.
          await expect(composer(page)).toBeVisible()
          await expect(page.getByText('Add a provider key to start')).not.toBeVisible()
          await shot(page, 'w1-02-pick-a-model')
        }

        // Store a default the way Settings does, and reload: the account now has one.
        await ensureDefaultModel(request)
        await page.reload()
      }

      // The composer, on the default model — no dialog in between.
      await expect(composer(page)).toBeVisible()
      await expect(page.getByText(/the chat is created with your first message/)).toBeVisible()
      const modelControl = page.getByRole('button', { name: /^Model: / })
      await expect(modelControl).toBeVisible()
      await expect(modelControl).not.toHaveAccessibleName(/Choose a model/)
      await shot(page, 'w1-03-immediate-chat')
    })

    await test.step('the first message creates the chat and is answered', async () => {
      // Unique per run: a session is named after its first message (#35), and a stack that has
      // been used before still holds the row an earlier run's identical sentence made.
      const prompt = uniqueName('the first thing anyone said here')
      await sendFromComposer(page, prompt)

      // The session is created by that send and the app moves to it.
      await expect(page).toHaveURL(/#\/s\/sesn_/)
      await expectNoErrorBanner(page)
      await waitForAnswer(page, prompt)
      await expectNoErrorBanner(page)

      // It is in the sidebar, named after what was said.
      await expect(page.locator('#app-sidebar').getByText(prompt)).toBeVisible()
      await shot(page, 'w1-04-first-reply')
    })

    // Leave the account as it was found, so a pass that runs W1 first does not hand the next
    // scenario a default model it never asked for.
    await setDefaultModel(request, previousDefault)

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
