import type { Page } from '@playwright/test'

import {
  QA_MODEL,
  createChat,
  defaultModel,
  ensureDefaultModel,
  expect,
  expectNoErrorBanner,
  getSession,
  openChat,
  pickModel,
  requestedModels,
  sendFromComposer,
  setDefaultModel,
  shot,
  test,
  waitForAnswer,
} from './support'

/**
 * W10 — the composer's model switch (epic #116, U3).
 *
 * This file used to drive the Agents screen. That screen is gone (#91): agents stay in the
 * API as optional presets, and the model control in the composer is what replaced it — the
 * switch is now the thing a reader does mid-chat, so this is the scenario that exercises it.
 *
 * The ids are deliberately ones no catalog holds. The router takes `provider/model` ids the
 * catalog does not know (C5), the picker offers "Other model ID…" for exactly that, and on a
 * stack with no provider keys the catalog is empty — so the free-text row is the route the
 * scenarios take, and it is also the one that proves the id travels as given.
 */
const SWITCHED = 'acme/qa-switched'

/** The switch is visible in the transcript above the message that carried it. */
async function expectSwitchedMarker(page: Page, modelId: string) {
  await expect(page.getByText(`Switched to ${modelId}`)).toBeVisible()
}

test.describe('W10 the composer model switch', () => {
  test('W10a a switch applies from the next message, and the log records which model ran', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const session = await createChat(request, QA_MODEL)
    await openChat(page, session.id)

    await test.step('the first message runs on the session’s model', async () => {
      await sendFromComposer(page, 'before the switch')
      await waitForAnswer(page, 'before the switch')
      await expectNoErrorBanner(page)
    })

    await test.step('pick another model in the composer', async () => {
      await pickModel(page, SWITCHED)
      // Picking does not send anything: the selector holds the choice until the next message.
      await expect(page.getByRole('button', { name: `Model: ${SWITCHED}` })).toBeVisible()
      await shot(page, 'w10-01-switch-picked')
    })

    await test.step('the next message runs on the new model, and says so', async () => {
      await sendFromComposer(page, 'after the switch')
      await waitForAnswer(page, 'after the switch')
      await expectSwitchedMarker(page, SWITCHED)
      await expectNoErrorBanner(page)
      await shot(page, 'w10-02-switched')
    })

    await test.step('the server agrees, in the session and in the spans', async () => {
      // The projection moved with the message (U3), and every request records the model that
      // actually ran — which is the whole point of the switch being recorded in the log.
      const stored = await getSession(request, session.id)
      expect(stored.model).toEqual({ id: SWITCHED })
      expect(await requestedModels(request, session.id)).toEqual([QA_MODEL, SWITCHED])
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W10b the switch sticks: it survives a reload, and the messages after it keep it', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const session = await createChat(request, QA_MODEL)
    await openChat(page, session.id)

    await sendFromComposer(page, 'the first message')
    await waitForAnswer(page, 'the first message')
    await pickModel(page, SWITCHED)
    await sendFromComposer(page, 'the message that switched')
    await waitForAnswer(page, 'the message that switched')

    await test.step('a reload shows the switched model, with nothing re-picked', async () => {
      await page.reload()
      await expect(page.getByRole('button', { name: `Model: ${SWITCHED}` })).toBeVisible()
      await expect(page.getByText(`Switched to ${SWITCHED}`)).toBeVisible()
      await expectNoErrorBanner(page)
      await shot(page, 'w10-03-after-reload')
    })

    await test.step('a later message is still answered on the switched model', async () => {
      await sendFromComposer(page, 'no pick this time')
      await waitForAnswer(page, 'no pick this time')
      await expectNoErrorBanner(page)

      const stored = await getSession(request, session.id)
      expect(stored.model).toEqual({ id: SWITCHED })
      expect(await requestedModels(request, session.id)).toEqual([QA_MODEL, SWITCHED, SWITCHED])
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W10c a new chat is created on the model the composer is holding', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const previousDefault = await ensureDefaultModel(request)

    // A new chat holds the default until the reader picks another one; the session is created
    // with the first message, so the pick is what the session is created on (U2).
    await page.goto('/#/new')
    await expect(page.getByRole('button', { name: `Model: ${previousDefault}` })).toBeVisible()
    await pickModel(page, SWITCHED)
    await expect(page.getByRole('button', { name: `Model: ${SWITCHED}` })).toBeVisible()

    await sendFromComposer(page, 'started on the picked model')
    await expect(page).toHaveURL(/#\/s\/sesn_/)
    await waitForAnswer(page, 'started on the picked model')

    const sessionId = /#\/s\/(sesn_[A-Z0-9]+)/.exec(page.url())?.[1] ?? ''
    expect(sessionId, 'the chat the send created').not.toBe('')
    const stored = await getSession(request, sessionId)
    expect(stored.model).toEqual({ id: SWITCHED })
    expect(await requestedModels(request, sessionId)).toEqual([SWITCHED])
    await expectNoErrorBanner(page)
    await shot(page, 'w10-04-new-chat-on-the-pick')

    // The default is untouched by a pick made in a chat: it is what the *next* new chat opens
    // with, which is w19's scenario. Put the account back as it was found either way.
    expect(await defaultModel(request)).toBe(previousDefault)
    await setDefaultModel(request, previousDefault)

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
