import type { APIRequestContext, Page } from '@playwright/test'

import {
  QA_MODEL,
  createAgent,
  createSession,
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
 * W18 — deleting a chat (epic #116, U5): a hard delete that takes the whole log, confirmed in
 * the page — never `window.confirm`, which blocks and cannot be themed.
 *
 * Three readings: the sidebar's kebab (with its Cancel that must not delete), the open chat's
 * header action (deleting what you are looking at takes you to New chat), and a chat deleted
 * *elsewhere* — through the API, while the browser has it open — which the app learns from the
 * stream's `session.deleted` and announces in the shell.
 */

/** A session with one finished turn, named so its sidebar row is readable. */
async function chatWithATurn(request: APIRequestContext, label: string): Promise<string> {
  const agent = await createAgent(request, {
    name: uniqueName(`QA W18 ${label}`),
    model: QA_MODEL,
    system: 'Answer briefly.',
  })
  const session = await createSession(request, agent.id)
  await sendMessage(request, session.id, `a chat deleted by W18 ${label}`)
  await waitForIdle(request, session.id)
  return session.id
}

/** The sidebar row for a session. */
function rowFor(page: Page, sessionId: string) {
  return page.locator('li').filter({ has: page.locator(`a[href="#/s/${sessionId}"]`) })
}

/** Whether the server still has the session — the API's own answer. */
async function sessionIsGone(request: APIRequestContext, sessionId: string): Promise<boolean> {
  const response = await request.get(`/v1/sessions/${sessionId}`)
  if (response.status() === 404) {
    return true
  }
  expect(response.status(), await response.text()).toBe(200)
  return false
}

test.describe('W18 deleting a chat', () => {
  test('W18a the sidebar kebab confirms in the page, and Cancel really cancels', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const chat = await chatWithATurn(request, 'a')
    await page.goto('/')
    await expect(rowFor(page, chat)).toBeVisible()

    await test.step('the menu offers Delete chat, and the confirmation can be backed out of', async () => {
      await rowFor(page, chat).getByRole('button', { name: 'Chat actions' }).click()
      await page.getByRole('menuitem', { name: 'Delete chat' }).click()
      await expect(page.getByText('Delete this chat?')).toBeVisible()
      await shot(page, 'w18-01-confirm-in-the-sidebar')

      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByText('Delete this chat?')).toHaveCount(0)
      // Nothing was deleted behind the confirmation's back.
      expect(await sessionIsGone(request, chat)).toBe(false)
      await expect(rowFor(page, chat)).toBeVisible()
    })

    await test.step('confirming deletes it, and the row goes with it', async () => {
      await rowFor(page, chat).getByRole('button', { name: 'Chat actions' }).click()
      await page.getByRole('menuitem', { name: 'Delete chat' }).click()
      await page.getByRole('button', { name: 'Delete', exact: true }).click()

      await expect(rowFor(page, chat)).toHaveCount(0)
      // No reload was needed for the row to go, and the server agrees it is gone: the whole
      // log went with it, so its events read is a 404 too.
      expect(await sessionIsGone(request, chat)).toBe(true)
      const events = await request.get(`/v1/sessions/${chat}/events`)
      expect(events.status()).toBe(404)
      await shot(page, 'w18-02-deleted-from-the-sidebar')
    })

    await expectNoErrorBanner(page)
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W18b the open chat deletes from its header and leaves for New chat', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const chat = await chatWithATurn(request, 'b')
    await openChat(page, chat)
    await expectNoErrorBanner(page)

    await test.step('the header asks in the page before deleting', async () => {
      await page.getByRole('button', { name: 'Delete chat' }).click()
      await expect(page.getByText('Delete this chat and all its messages?')).toBeVisible()
      await shot(page, 'w18-03-confirm-in-the-header')
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
    })

    await test.step('the reader lands on New chat, and the chat is gone', async () => {
      await expect(page).toHaveURL(/#\/new/)
      await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()
      expect(await sessionIsGone(request, chat)).toBe(true)
      await expect(rowFor(page, chat)).toHaveCount(0)
      await shot(page, 'w18-04-after-deleting-the-open-chat')
    })

    await expectNoErrorBanner(page)
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W18c a chat deleted elsewhere says so and the app leaves it', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const chat = await chatWithATurn(request, 'c')
    await openChat(page, chat)
    await expectNoErrorBanner(page)

    // Deleted through the API — the way the CLI or another tab would — while this tab has the
    // chat open and its stream running. The stream's final `session.deleted` is what tells it.
    const deleted = await request.delete(`/v1/sessions/${chat}`)
    expect(deleted.status(), await deleted.text()).toBe(204)

    await test.step('the shell announces it and leaves the chat', async () => {
      await expect(page.getByText('This chat was deleted.')).toBeVisible()
      await expect(page).toHaveURL(/#\/new/)
      await expect(rowFor(page, chat)).toHaveCount(0)
      await shot(page, 'w18-05-deleted-elsewhere')
    })

    await expectNoErrorBanner(page)
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
