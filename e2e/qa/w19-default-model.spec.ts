import {
  composer,
  defaultModel,
  expect,
  expectNoErrorBanner,
  pickModel,
  setDefaultModel,
  shot,
  test,
} from './support'

/**
 * W19 — Settings → Default model (epic #116, U1/U2).
 *
 * The one setting the web app and `oh` share, and the model a new chat opens on. Stored on the
 * server (`GET`/`PUT /v1/me/preferences`), so the scenario can check both halves of the claim:
 * the picker writes what a fresh read of the API answers, and the *next* new chat is composed
 * on it.
 *
 * The id is one no catalog holds — on a stack with no provider keys the catalog is empty, and
 * the router takes `provider/model` ids the catalog does not know (C5), which is exactly what
 * the picker's free-text row is for. The account's default is put back at the end: the
 * scenarios after this one did not ask for it to be changed.
 */
const CHOSEN = 'acme/qa-default'

/** The picker in the Default model card: the full-size one, whose trigger is labelled "Model". */
const settingsTrigger = /^Model\b/

test.describe('W19 the default model in Settings', () => {
  test('W19 a pick is saved to the server, and the next new chat opens on it', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const previous = await defaultModel(request)

    try {
      await test.step('the card shows what the server holds', async () => {
        await page.goto('/#/settings')
        await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
        // Exact: the card's loading line says "Loading your default model…" too.
        await expect(page.getByText('Default model', { exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: settingsTrigger })).toBeVisible()
        await shot(page, 'w19-01-settings')
      })

      await test.step('picking one saves it immediately, and the server agrees', async () => {
        await pickModel(page, CHOSEN, { trigger: settingsTrigger })
        await expect(page.getByText('Saved the default model.')).toBeVisible()
        expect(await defaultModel(request)).toBe(CHOSEN)
        await shot(page, 'w19-02-saved')
      })

      await test.step('a reload reads the stored value back, not a local leftover', async () => {
        await page.reload()
        await expect(page.getByRole('button', { name: settingsTrigger })).toContainText(CHOSEN)
        await expectNoErrorBanner(page)
      })

      await test.step('New chat opens on it', async () => {
        await page.goto('/#/new')
        await expect(composer(page)).toBeVisible()
        await expect(page.getByRole('button', { name: `Model: ${CHOSEN}` })).toBeVisible()
        await shot(page, 'w19-03-new-chat-on-the-default')
      })
    } finally {
      // Leave the account as it was found.
      await setDefaultModel(request, previous)
    }

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W19b a stack with no default says so, and does not pretend to have one', async ({
    page,
    request,
    consoleErrors,
  }) => {
    // The states a stack with no default can be in (#146). With no provider key at all the
    // catalog is empty and "Add a provider key to start" is the truth — the state the mock
    // pass starts in (U2/U4). With keys the catalog lists models that can run, so the screen
    // must offer them instead of claiming there is no key. Set the default to null
    // explicitly rather than assume, and put the stored value back afterwards.
    const previous = await defaultModel(request)
    await setDefaultModel(request, null)

    try {
      await page.goto('/#/settings')
      await expect(page.getByRole('button', { name: /^Model\b/ })).toContainText('Choose a model')

      const catalog = (await (await request.get('/v1/models')).json()) as { data: unknown[] }
      const credentials = (await (await request.get('/v1/provider-credentials')).json()) as {
        data: unknown[]
      }
      await page.goto('/#/new')
      if (credentials.data.length === 0) {
        // #209: no key at all is the first-run flow, whatever default is stored — there is
        // nothing that could run it. This is the road the mock pass starts on.
        await expect(page.getByRole('heading', { name: 'Connect a model provider' })).toBeVisible()
      } else if (catalog.data.length === 0) {
        await expect(page.getByText('Add a provider key to start')).toBeVisible()
        await expect(page.getByRole('link', { name: 'Settings → Providers' })).toBeVisible()
      } else {
        // Keys but no default (#146): the composer offers the catalog — waiting for a pick,
        // or with a sole model preselected — and never the claim about keys.
        await expect(composer(page)).toBeVisible()
        await expect(page.getByText('Add a provider key to start')).not.toBeVisible()
      }
      await shot(page, 'w19-04-no-default')
    } finally {
      await setDefaultModel(request, previous)
    }

    // Nothing about it is an error: an account with no key has done nothing wrong.
    expect(await page.getByRole('alert').allTextContents()).toEqual([])
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
