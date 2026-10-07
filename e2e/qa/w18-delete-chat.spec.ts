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
  uniqueName,
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

/**
 * A chat with one finished turn in it, opened in the page.
 *
 * The text is unique per run: a session is named after its first message (#35) and the QA
 * stack is a used one, so a fixed sentence collides with the rows earlier runs left behind —
 * the sidebar then holds two identical rows, which is a locator problem, not a finding.
 */
async function chatWithATurn(page: Page, request: APIRequestContext, label: string) {
  const text = uniqueName(label)
  const session = await createChat(request, QA_MODEL)
  await sendMessage(request, session.id, text)
  await waitForIdle(request, session.id)
  await openChat(page, session.id)
  // The message in the transcript — the same words are also the session's title in the
  // sidebar and the heading, so this addresses the message itself.
  await expect(page.locator('article[data-role="user"]').last()).toContainText(text)
  return { ...session, text }
}

test.describe('W18 deleting a chat', () => {
  test('W18a the header delete asks first, then removes the chat for good', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const { id: sessionId, text } = await chatWithATurn(page, request, 'delete me from the header')

    await test.step('the confirmation is in the page, and Cancel leaves it alone', async () => {
      await page.getByRole('button', { name: 'Delete chat' }).click()
      await expect(page.getByText('Delete this chat and all its messages?')).toBeVisible()
      await shot(page, 'w18-01-confirm')

      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByText('Delete this chat and all its messages?')).toHaveCount(0)
      await expect(page.locator('article[data-role="user"]').last()).toContainText(text)
      // Nothing was deleted by a cancel.
      const stillThere = await request.get(`/v1/sessions/${sessionId}`)
      expect(stillThere.status()).toBe(200)
    })

    await test.step('Delete removes it and lands on New chat', async () => {
      await page.getByRole('button', { name: 'Delete chat' }).click()
      await page.getByRole('button', { name: 'Delete', exact: true }).click()

      await expect(page).toHaveURL(/#\/new/)
      await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()
      await expectNoErrorBanner(page)

      // Gone from the sidebar without a reload, and gone from the API. The text is this run's
      // own, so a row an earlier run left behind cannot answer for it.
      await expect(page.locator('#app-sidebar').getByText(text)).toHaveCount(0)
      expect((await request.get(`/v1/sessions/${sessionId}`)).status()).toBe(404)
      expect((await request.get(`/v1/sessions/${sessionId}/events`)).status()).toBe(404)
      await shot(page, 'w18-02-deleted')
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W18b the sidebar row’s menu deletes it too', async ({ page, request, consoleErrors }) => {
    const { id: sessionId, text } = await chatWithATurn(page, request, 'delete me from the sidebar')
    await page.goto('/')
    // #209: the root route of a signed-in reader is New chat (or the first-run screen for an
    // account with no key) — the Home screen it used to be is gone.
    await expect(page.locator('#app-sidebar')).toBeVisible()
    await expect(page).toHaveURL(/\/$|#\/$/)

    await test.step('the row is deleted from its own menu, with its own confirmation', async () => {
      const row = page.locator('#app-sidebar').getByText(text)
      await expect(row).toBeVisible()
      await page.getByRole('button', { name: 'Chat actions' }).first().click()
      await page.getByRole('menuitem', { name: 'Delete chat' }).click()

      await expect(page.getByText('Delete this chat?')).toBeVisible()
      await shot(page, 'w18-03-sidebar-confirm')
      await page.getByRole('button', { name: 'Delete', exact: true }).click()

      await expect(row).toHaveCount(0)
      expect((await request.get(`/v1/sessions/${sessionId}`)).status()).toBe(404)
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
    const text = uniqueName('a chat that will vanish')
    await sendMessage(request, session.id, text)
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
