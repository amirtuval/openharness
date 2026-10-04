import {
  composerModel,
  defaultModelCard,
  expect,
  expectNoErrorBanner,
  getDefaultModel,
  pickModelId,
  setDefaultModel,
  shot,
  test,
} from './support'

/**
 * W19 — Settings → Default model (epic #116, U1/U4): the one model a new chat starts on,
 * stored on the server so the web app and `oh` agree on it.
 *
 * The scenario writes a default the catalog may not know (`provider/model` is validated for
 * shape only), checks the card says it saved, reloads to prove the value came back from the
 * server rather than from local state, and opens New chat to prove the composer starts on it.
 * It restores what the account had at the end, so the scenarios after it start where they
 * would have.
 */
test.describe('W19 the default model', () => {
  test('W19 Settings saves the default, a reload keeps it, and New chat starts on it', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const before = await getDefaultModel(request)
    // A distinctive id of this run, so the card's value cannot be a leftover from another
    // pass. Shape-valid, not necessarily catalogued — which is allowed and deliberate (C5).
    const chosen = `anthropic/qa-default-${Date.now().toString(36)}`

    try {
      await page.goto('/#/settings')
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

      await test.step('the card shows what the server holds and saves a pick', async () => {
        const card = defaultModelCard(page)
        await expect(card).toBeVisible()
        if (before !== null) {
          // Whatever the account had — an automatic pick (U4) or an earlier choice — is what
          // the card reads.
          await expect(card).toContainText(before)
        } else {
          await expect(card).toContainText('Choose a model')
        }

        await pickModelId(page, card.getByRole('button', { name: /^Model/ }), chosen)
        await expect(
          page.getByRole('status').filter({ hasText: 'Saved the default model.' }),
        ).toBeVisible()
        await shot(page, 'w19-01-default-saved')

        // The save went to the server: the API holds it.
        expect(await getDefaultModel(request)).toBe(chosen)
      })

      await test.step('a reload reads it back from the server', async () => {
        await page.reload()
        await expect(defaultModelCard(page)).toContainText(chosen)
        await expectNoErrorBanner(page)
        await shot(page, 'w19-02-after-reload')
      })

      await test.step('New chat is a composer on it, with no dialog in the way', async () => {
        await page.goto('/#/new')
        await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()
        await expect(composerModel(page)).toContainText(chosen)
        await expect(
          page.getByText('Start typing — the chat is created with your first message'),
        ).toBeVisible()
        await shot(page, 'w19-03-new-chat-on-the-default')
      })
    } finally {
      // Put the account back the way this scenario found it, so the scenarios after this one
      // see the default they would have had.
      await setDefaultModel(request, before)
    }

    await expectNoErrorBanner(page)
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
