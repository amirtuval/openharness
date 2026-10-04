import type { APIRequestContext, Page } from '@playwright/test'

import {
  QA_MODEL,
  createChat,
  deleteChat,
  errorBanners,
  expect,
  expectNoErrorBanner,
  openChat,
  sendMessage,
  shot,
  test,
  waitForIdle,
} from './support'

/**
 * W18 — deleting a chat (epic #116, U5).
 *
 * The web half of the hard delete: the confirm is **in the page** (never `window.confirm`, and
 * never a one-click delete), the row leaves the sidebar without the app asking the server for
 * the list again, and the chat is gone for real — the API answers 404 for it afterwards, on
 * every read, and with every byte of its log.
 *
 * The delete itself is a `DELETE /v1/sessions/{id}` — 204, owner-scoped — which `#115`'s e2e
 * suite proves at the database (the cascade leaves no row in any session-keyed table). What
 * only a browser can prove is what the reader sees: the confirmation, the navigation, and the
 * list dropping the row.
 */

/** A chat with one finished turn in it, opened in the page. */
async function chatWithATurn(page: Page, request: APIRequestContext, text: string) {
  const session = await createChat(request, QA_MODEL)
  await sendMessage(request, session.id, text)
  await waitForIdle(request, session.id)
  await openChat(page, session.id)
  await expect(page.getByText(text)).toBeVisible()
  return session
}

test.describe('W18 deleting a chat', () => {
  test('W18a the header delete asks first, then removes the chat for good', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const session = await chatWithATurn(page, request, 'delete me from the header')

    await test.step('the confirmation is in the page, and Cancel leaves it alone', async () => {
      await page.getByRole('button', { name: 'Delete chat' }).click()
      await expect(page.getByText('Delete this chat and all its messages?')).toBeVisible()
      await shot(page, 'w18-01-confirm')

      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByText('Delete this chat and all its messages?')).toHaveCount(0)
      await expect(page.getByText('delete me from the header')).toBeVisible()
      // Nothing was deleted by a cancel.
      const stillThere = await request.get(`/v1/sessions/${session.id}`)
      expect(stillThere.status()).toBe(200)
    })

    await test.step('Delete removes it and lands on New chat', async () => {
      await page.getByRole('button', { name: 'Delete chat' }).click()
      await page.getByRole('button', { name: 'Delete', exact: true }).click()

      await expect(page).toHaveURL(/#\/new/)
      await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()
      await expectNoErrorBanner(page)

      // Gone from the sidebar without a reload, and gone from the API.
      await expect(page.locator('#app-sidebar').getByText('delete me from the header')).toHaveCount(
        0,
      )
      expect((await request.get(`/v1/sessions/${session.id}`)).status()).toBe(404)
      expect((await request.get(`/v1/sessions/${session.id}/events`)).status()).toBe(404)
      await shot(page, 'w18-02-deleted')
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W18b the sidebar row’s menu deletes it too', async ({ page, request, consoleErrors }) => {
    const session = await chatWithATurn(page, request, 'delete me from the sidebar')
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'openharness' })).toBeVisible()

    await test.step('the row is deleted from its own menu, with its own confirmation', async () => {
      const row = page.locator('#app-sidebar').getByText('delete me from the sidebar')
      await expect(row).toBeVisible()
      await page.getByRole('button', { name: 'Chat actions' }).first().click()
      await page.getByRole('menuitem', { name: 'Delete chat' }).click()

      await expect(page.getByText('Delete this chat?')).toBeVisible()
      await shot(page, 'w18-03-sidebar-confirm')
      await page.getByRole('button', { name: 'Delete', exact: true }).click()

      await expect(row).toHaveCount(0)
      expect((await request.get(`/v1/sessions/${session.id}`)).status()).toBe(404)
    })

    await expectNoErrorBanner(page)
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W18c a chat deleted in another tab leaves the open one, with a notice', async ({
    page,
    request,
    consoleErrors,
  }) => {
    // The second tab is the API, not a page: what the open chat has to notice is the stream's
    // `session.deleted`, which is the same event a second browser gets.
    const session = await createChat(request, QA_MODEL)
    await sendMessage(request, session.id, 'a chat that will vanish')
    await waitForIdle(request, session.id)
    await openChat(page, session.id)

    await deleteChat(request, session.id)

    // The open chat announces it and moves to New chat — the session behind it is gone, so
    // there is nothing left to show or to stream.
    await expect(page).toHaveURL(/#\/new/, { timeout: 15_000 })
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()
    await expect(page.locator('#app-sidebar').getByText('a chat that will vanish')).toHaveCount(0)
    await shot(page, 'w18-04-deleted-elsewhere')

    // The notice is the shell's own line, not an error: a delete is not a failure.
    await expect(page.getByText('This chat was deleted.')).toBeVisible()
    expect(await errorBanners(page).allTextContents()).toEqual([])

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
