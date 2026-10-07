import {
  NEW_CHAT_GREETING,
  composer,
  defaultModel,
  ensureDefaultModel,
  expect,
  expectNoErrorBanner,
  providerDialog,
  sendFromComposer,
  setDefaultModel,
  shot,
  test,
  uniqueName,
  waitForAnswer,
} from './support'
import type { APIRequestContext } from '@playwright/test'

/**
 * W1 — first run: the app a fresh account lands in, the provider key it asks for, and the first
 * chat the first message creates.
 *
 * The root route of a signed-in reader is New chat — or, when the account has **no provider
 * key**, the first-run screen (epic #201, X5): "Connect a model provider", a tile per provider,
 * a key form, the default model the server picked, and Start chatting. The Home screen this
 * scenario used to open on is gone, so what `goto('/')` shows is now a fact worth asserting
 * rather than a dead end worth walking past.
 *
 * Which of the two states the stack is in depends on what it holds:
 *
 * - **no key** (a fresh mock stack) → the onboarding flow, driven as far as the stack allows.
 *   Saving for real needs `QA_PROVIDER_KEY`; without one the flow is observed to the form and
 *   left through "Skip for now", which is the state the rest of the scenario then uses.
 * - **a key** (a stack that has been used) → New chat, straight away: the screen is invisible
 *   to every account it does not apply to, which is half of what it has to get right.
 *
 * Either way the default is put back afterwards: a pass that runs W1 first must not leave the
 * account configured in a way the scenarios after it did not ask for.
 */

/** How many provider credentials the account holds — what the first-run screen keys off. */
async function storedCredentialCount(request: APIRequestContext): Promise<number> {
  const response = await request.get('/v1/provider-credentials')
  expect(response.status(), await response.text()).toBe(200)
  const body = (await response.json()) as { data: unknown[] }
  return body.data.length
}

/** The provider the pass may store a real key for, and the tile that offers it. */
const QA_PROVIDER = process.env.QA_PROVIDER ?? 'openai'
const QA_PROVIDER_NAME = QA_PROVIDER === 'openai' ? 'OpenAI' : QA_PROVIDER
const QA_PROVIDER_KEY = process.env.QA_PROVIDER_KEY ?? ''

test.describe('W1 first run', () => {
  test('W1 the root route, the provider it asks for, and a first chat', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const previousDefault = await defaultModel(request)
    const hasKey = (await storedCredentialCount(request)) > 0

    if (!hasKey) {
      await test.step('the root route is the first-run screen, not a home screen', async () => {
        await page.goto('/')

        // #209: an account with no key gets the onboarding flow, and the sentence that says
        // why (the server runs on the reader's own keys).
        await expect(page.getByRole('heading', { name: 'Connect a model provider' })).toBeVisible()
        await expect(page.getByText(/run on your own provider keys/)).toBeVisible()
        // Tiles, with the free-tier hint where the provider has one (X8).
        await expect(page.getByRole('button', { name: /Groq/ })).toContainText('Free tier')
        await expect(page.getByRole('button', { name: /Anthropic/ })).toBeVisible()
        await shot(page, 'w1-01-first-run')
      })

      await test.step('a tile opens the key form, with the provider’s own key link', async () => {
        await page.getByRole('button', { name: new RegExp(QA_PROVIDER_NAME) }).click()

        await expect(page.getByRole('link', { name: /Get a key/ })).toBeVisible()
        await expect(page.getByLabel('API key')).toBeVisible()
        await shot(page, 'w1-02-key-form')

        if (QA_PROVIDER_KEY === '') {
          // No key to store: leave the flow the way a reader who is not ready would, and the
          // rest of the scenario runs from New chat's own empty state.
          await page.getByRole('button', { name: 'Skip for now' }).click()
          await expect(page.getByText('Add a provider key to start')).toBeVisible()
          await expect(page.getByRole('link', { name: 'Settings → Providers' })).toBeVisible()
          await shot(page, 'w1-03-skipped')
        } else {
          await page.getByLabel('API key').fill(QA_PROVIDER_KEY)
          await page.getByRole('button', { name: /^(Save|Replace) key$/ }).click()

          // The server validated the key, stored it, and picked a default model for the
          // account (U4) — which is exactly what the confirmation names.
          await expect(
            page.getByRole('heading', { name: /set: your default model is/ }),
          ).toBeVisible()
          await expect(page.getByRole('button', { name: /^Model/ })).toBeVisible()
          await shot(page, 'w1-03-connected')

          await test.step('Start chatting lands in a new chat with the cursor in the box', async () => {
            await page.getByRole('button', { name: 'Start chatting' }).click()
            await expect(composer(page)).toBeVisible()
            await expect(composer(page)).toBeFocused()
          })
        }
      })
    } else {
      await test.step('an account with a key never sees the first-run screen', async () => {
        await page.goto('/')

        await expect(page.getByRole('heading', { name: NEW_CHAT_GREETING })).toBeVisible()
        await expect(page.getByRole('heading', { name: 'Connect a model provider' })).toHaveCount(0)
        await shot(page, 'w1-01-new-chat')
      })
    }

    await test.step('New chat is a chat, or a pointer to Settings when nothing can run', async () => {
      await page.goto('/#/new')
      await expect(page.getByRole('heading', { name: NEW_CHAT_GREETING })).toBeVisible()

      if (previousDefault === null) {
        const catalog = (await (await request.get('/v1/models')).json()) as { data: unknown[] }
        if ((await storedCredentialCount(request)) === 0) {
          // Still no key: "Add a provider key to start" is the whole truth, and the composer
          // is not there — there is no model a message could run on.
          await expect(page.getByText('Add a provider key to start')).toBeVisible()
          await expect(page.getByRole('link', { name: 'Settings → Providers' })).toBeVisible()
          await shot(page, 'w1-04-no-key')
        } else if (catalog.data.length === 0) {
          // A key whose provider listed nothing: a pointer, not a claim about keys.
          await expect(page.getByText('Add a provider key to start')).toBeVisible()
        } else {
          // Keys but no default (#146): the catalog says what can run, so the composer offers
          // it — waiting for a pick, or with a sole model preselected.
          await expect(composer(page)).toBeVisible()
          await expect(page.getByText('Add a provider key to start')).not.toBeVisible()
          await shot(page, 'w1-04-pick-a-model')
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
      await shot(page, 'w1-05-immediate-chat')
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
      await shot(page, 'w1-06-first-reply')
    })

    // Leave the account as it was found, so a pass that runs W1 first does not hand the next
    // scenario a default model it never asked for.
    await setDefaultModel(request, previousDefault)

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W1b a key is added from inside a chat, without leaving it', async ({
    page,
    request,
    consoleErrors,
  }) => {
    test.skip(
      QA_PROVIDER_KEY === '',
      'set QA_PROVIDER (and QA_PROVIDER_KEY) to store a key through the dialog',
    )

    // The other half of #209: the same form, from the model picker of a chat that is already
    // open. What matters is that the save happens *here* — the catalog gains the provider's
    // models and the reader never leaves the composer.
    const session = (await (
      await request.post('/v1/sessions', {
        data: { model: { id: 'openai/gpt-4.1-mini' } },
      })
    ).json()) as { id: string }

    await page.goto(`/#/s/${session.id}`)
    await expect(composer(page)).toBeVisible()

    await page.getByRole('button', { name: /^Model: / }).click()
    await page.getByRole('button', { name: '+ Add provider' }).click()
    await expect(providerDialog(page)).toBeVisible()
    await expect(page.getByRole('listbox', { name: 'Models' })).toHaveCount(0)
    await shot(page, 'w1b-01-add-provider-dialog')

    await providerDialog(page)
      .getByRole('button', { name: new RegExp(QA_PROVIDER_NAME) })
      .click()
    await providerDialog(page).getByLabel('API key').fill(QA_PROVIDER_KEY)
    await providerDialog(page)
      .getByRole('button', { name: /^(Save|Replace) key$/ })
      .click()

    await expect(providerDialog(page)).toHaveCount(0)
    // The shell's notice, and the chat is still the route: nothing navigated.
    await expect(page.getByText(/Saved the .* key\./)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`#/s/${session.id}`))
    await expectNoErrorBanner(page)
    await shot(page, 'w1b-02-saved')

    // The picker now offers the new provider's models — no reload, no Settings trip.
    await page.getByRole('button', { name: /^Model: / }).click()
    await expect(page.getByRole('option', { name: /gpt-/ })).toBeVisible()

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
