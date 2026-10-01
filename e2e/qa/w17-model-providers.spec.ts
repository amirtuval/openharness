import { expect, shot, test } from './support'
import type { Page } from '@playwright/test'

/**
 * W17 — Settings → Model providers (epic #65, A5).
 *
 * The card is where a person brings their own key: the keys already stored, a key the
 * provider refuses, and add / replace / delete. Two scenarios, with two different appetites:
 *
 * - **W17a** runs anywhere: the empty state (or the keys already stored) and a key the
 *   provider refuses. Validation is a real provider call, so a key nothing issued is refused
 *   whether or not the stack can reach the provider — an unvalidated key is never stored.
 * - **W17b** adds, replaces and deletes a *working* key, so it needs one:
 *   `QA_PROVIDER=openai QA_PROVIDER_KEY=sk-…` (and a second key in `QA_PROVIDER_KEY_2` when the
 *   replace half should swap one real key for another). Without it the scenario skips.
 *
 * The chat-side half — a turn that has no key for its provider, and the message that says so —
 * is W11e (`w11-errors.spec.ts`), next to the other turn-failure scenarios.
 */

/** The provider a key is added for, and the key itself. */
const QA_PROVIDER = process.env.QA_PROVIDER ?? 'openai'
const QA_PROVIDER_KEY = process.env.QA_PROVIDER_KEY ?? ''
/** A second key, for the replace half; the same key is saved again when it is not given. */
const QA_PROVIDER_KEY_2 = process.env.QA_PROVIDER_KEY_2 ?? QA_PROVIDER_KEY
/** The card's list of stored keys. */
function savedKeys(page: Page) {
  return page.getByRole('region', { name: 'Saved provider keys' })
}

/** Open Settings and wait for the model-providers card to have loaded. */
async function openModelProviders(page: Page): Promise<void> {
  await page.goto('/#/settings')
  await expect(page.getByText('Model providers')).toBeVisible()
  await expect(savedKeys(page).getByText('Loading your keys…')).toHaveCount(0)
}

test.describe('W17 model providers', () => {
  test('W17a the stored keys, and a key the provider refuses', async ({ page }) => {
    await openModelProviders(page)
    await shot(page, 'w17a-01-settings')

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

    await test.step('a key the provider refuses is not stored', async () => {
      const bogus = 'sk-not-a-real-key-0000'
      const before = await savedKeys(page)
        .locator('[data-slot="provider-credential"]')
        .allTextContents()

      await page.locator('#provider-picker').selectOption(QA_PROVIDER)
      await page.locator('#provider-api-key').fill(bogus)
      await page.getByRole('button', { name: /^(Save|Replace) key$/ }).click()

      // The server validated it with one real provider call and refused to store it (422).
      await expect(page.getByRole('alert')).toContainText(/rejected|refused|key/i)
      await expect(page.getByRole('alert')).not.toContainText(bogus)
      await shot(page, 'w17a-02-rejected')

      // Nothing was written: the list is what it was, and the key is nowhere in it (the form
      // field still holds what was typed — that is the person's own text, not a stored key).
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

    await openModelProviders(page)
    const rows = savedKeys(page).locator('[data-slot="provider-credential"]')
    const existing = rows.filter({ hasText: QA_PROVIDER })

    // Start from "no key for this provider", whatever earlier runs left behind.
    if ((await existing.count()) > 0) {
      await page.getByRole('button', { name: `Delete the ${QA_PROVIDER} key` }).click()
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(rows.filter({ hasText: QA_PROVIDER })).toHaveCount(0)
    }

    await test.step('add', async () => {
      await page.locator('#provider-picker').selectOption(QA_PROVIDER)
      await page.locator('#provider-api-key').fill(QA_PROVIDER_KEY)
      await page.getByRole('button', { name: 'Save key' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Saved the' })).toBeVisible()

      // The row knows the provider and the last four characters, and nothing else — the key
      // is write-only (A5), so it is not on the page in any form.
      const row = rows.filter({ hasText: QA_PROVIDER })
      await expect(row).toContainText(`…${QA_PROVIDER_KEY.slice(-4)}`)
      expect(await page.content()).not.toContain(QA_PROVIDER_KEY)
      await shot(page, 'w17b-01-saved')
    })

    await test.step('replace', async () => {
      await page.locator('#provider-api-key').fill(QA_PROVIDER_KEY_2)
      // The button knows a key is already stored for this provider.
      await page.getByRole('button', { name: 'Replace key' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Saved the' })).toBeVisible()

      const row = rows.filter({ hasText: QA_PROVIDER })
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
      await expect(rows.filter({ hasText: QA_PROVIDER })).toHaveCount(0)
      await shot(page, 'w17b-03-deleted')
    })
  })
})
