import {
  addProviderKey,
  deleteProviderKey,
  expect,
  openProviders,
  providerDialog,
  savedKeys,
  shot,
  test,
} from './support'

/**
 * W17 — Settings → Providers (epic #65, A5; epic #201, X5).
 *
 * The card is where a person brings their own key: the keys already stored, a key the provider
 * refuses, and add / replace / delete. Since #209 the card is a **list**: adding and replacing
 * happen in the Add-provider dialog (the same component the model picker and the first-run
 * screen open), so this scenario drives the dialog rather than an inline form.
 *
 * Two scenarios, with two different appetites:
 *
 * - **W17a** runs anywhere: the empty state (or the keys already stored) and a key the
 *   provider refuses. Validation is a real provider call, so a key nothing issued is refused
 *   whether or not the stack can reach the provider — an unvalidated key is never stored.
 * - **W17b** adds, replaces and deletes a *working* key, so it needs one:
 *   `QA_PROVIDER=openai QA_PROVIDER_KEY=sk-…` (and a second key in `QA_PROVIDER_KEY_2` when the
 *   replace half should swap one real key for another). Without it the scenario skips.
 *
 * The chat-side half — a turn that has no key for its provider, and the message that says so,
 * whose action now opens the dialog in place — is W11e (`w11-errors.spec.ts`).
 */

/** The provider a key is added for, and the key itself. */
const QA_PROVIDER = process.env.QA_PROVIDER ?? 'openai'
/** The provider's display name, as the tiles and the list spell it. */
const QA_PROVIDER_NAME = QA_PROVIDER === 'openai' ? 'OpenAI' : QA_PROVIDER
const QA_PROVIDER_KEY = process.env.QA_PROVIDER_KEY ?? ''
/** A second key, for the replace half; the same key is saved again when it is not given. */
const QA_PROVIDER_KEY_2 = process.env.QA_PROVIDER_KEY_2 ?? QA_PROVIDER_KEY
/** The Add-provider dialog, as the shared helper spells it. */
function dialog(page: Parameters<typeof providerDialog>[0]) {
  return providerDialog(page)
}

test.describe('W17 providers', () => {
  test('W17a the stored keys, and a key the provider refuses', async ({ page }) => {
    await openProviders(page)
    await shot(page, 'w17a-01-settings-providers')

    await test.step('the card lists the keys, or says there are none', async () => {
      const rows = savedKeys(page).locator('[data-slot="provider-credential"]')
      const count = await rows.count()
      if (count === 0) {
        await expect(savedKeys(page)).toContainText('No provider keys yet')
      } else {
        // A key row shows the provider and the last four characters — never the key (A5).
        for (let index = 0; index < count; index += 1) {
          await expect(rows.nth(index)).toContainText(/…/)
        }
      }
    })

    await test.step('the dialog is where a key is typed', async () => {
      // #209: the list adds through the dialog, so the tiles come first and the form second.
      await page.getByRole('button', { name: 'Add provider' }).click()
      await expect(dialog(page)).toBeVisible()
      await expect(dialog(page).getByText('Add a provider')).toBeVisible()
      await dialog(page)
        .getByRole('button', { name: new RegExp(QA_PROVIDER_NAME) })
        .click()

      // The provider's own "get a key" link, and the key field with its provider's hint.
      await expect(dialog(page).getByRole('link', { name: /Get a key/ })).toBeVisible()
      await expect(dialog(page).getByLabel('API key')).toBeVisible()
      await shot(page, 'w17a-02-dialog')
    })

    await test.step('a key the provider refuses is not stored', async () => {
      const bogus = 'sk-not-a-real-key-0000'
      const before = await savedKeys(page)
        .locator('[data-slot="provider-credential"]')
        .allTextContents()

      await dialog(page).getByLabel('API key').fill(bogus)
      await dialog(page)
        .getByRole('button', { name: /^(Save|Replace) key$/ })
        .click()

      // The server validated it with one real provider call and refused to store it (422).
      const alert = dialog(page).getByRole('alert')
      await expect(alert).toContainText(/rejected|refused|key/i)
      await expect(alert).not.toContainText(bogus)
      await shot(page, 'w17a-03-rejected')

      // The dialog stays open — the key is the thing to change — and nothing was written.
      await expect(dialog(page)).toBeVisible()
      await dialog(page).getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog(page)).toHaveCount(0)
      await expect
        .poll(async () =>
          savedKeys(page).locator('[data-slot="provider-credential"]').allTextContents(),
        )
        .toEqual(before)
      expect(await savedKeys(page).textContent()).not.toContain(bogus)
    })
  })

  test('W17b add, replace and delete a working key', async ({ page }) => {
    test.skip(
      QA_PROVIDER_KEY === '',
      'set QA_PROVIDER_KEY (and QA_PROVIDER) to store a real key through the card',
    )

    await openProviders(page)
    const rows = savedKeys(page).locator('[data-slot="provider-credential"]')
    const existing = rows.filter({ hasText: QA_PROVIDER_NAME })

    // Start from "no key for this provider", whatever earlier runs left behind.
    if ((await existing.count()) > 0) {
      await deleteProviderKey(page, QA_PROVIDER)
    }

    await test.step('add', async () => {
      await addProviderKey(page, QA_PROVIDER_NAME, QA_PROVIDER_KEY)

      // The card says what happened; the list follows the dialog's own read.
      await expect(page.getByRole('status').filter({ hasText: 'Saved the' })).toBeVisible()

      // The row knows the provider's display name and the last four characters, and nothing
      // else — the key is write-only (A5), so it is not on the page in any form.
      const row = rows.filter({ hasText: QA_PROVIDER_NAME })
      await expect(row).toContainText(`…${QA_PROVIDER_KEY.slice(-4)}`)
      expect(await page.content()).not.toContain(QA_PROVIDER_KEY)
      await shot(page, 'w17b-01-saved')
    })

    await test.step('replace', async () => {
      // The row's own action, which opens the dialog on that provider: no tiles in the way.
      await page.getByRole('button', { name: `Replace the ${QA_PROVIDER} key` }).click()
      await expect(dialog(page).getByText(`Connect ${QA_PROVIDER_NAME}`)).toBeVisible()
      await dialog(page).getByLabel('API key').fill(QA_PROVIDER_KEY_2)
      await dialog(page).getByRole('button', { name: 'Replace key' }).click()
      await expect(dialog(page)).toHaveCount(0)

      const row = rows.filter({ hasText: QA_PROVIDER_NAME })
      await expect(row).toContainText(`…${QA_PROVIDER_KEY_2.slice(-4)}`)
      // One row per provider, replaced in place — not a second credential.
      await expect(row).toHaveCount(1)
      expect(await page.content()).not.toContain(QA_PROVIDER_KEY)
      expect(await page.content()).not.toContain(QA_PROVIDER_KEY_2)
      await shot(page, 'w17b-02-replaced')
    })

    await test.step('delete, with the confirmation the card asks for', async () => {
      await page.getByRole('button', { name: `Delete the ${QA_PROVIDER} key` }).click()
      await expect(page.getByText('Delete this key?')).toBeVisible()
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Deleted the' })).toBeVisible()
      await expect(rows.filter({ hasText: QA_PROVIDER_NAME })).toHaveCount(0)
      await shot(page, 'w17b-03-deleted')
    })
  })
})
