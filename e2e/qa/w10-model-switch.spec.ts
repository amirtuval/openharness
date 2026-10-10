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
const SWITCHED_AGAIN = 'acme/qa-switched-twice'

/**
 * The switch is visible in the transcript above the message that carried it.
 *
 * Every switch draws one, the **first** included (#268): the transcript is seeded with the
 * session's own model when the chat opens, so the first model a message carries is a change
 * from the model the session already ran (`packages/client/src/transcript.ts`,
 * `TranscriptSeed`; the web hook resets the transcript with `opened.model.id`). A message that
 * carries no model, or the model already in effect, draws none.
 */
async function expectSwitchedMarker(page: Page, modelId: string) {
  // `exact`, because two markers can now be on screen at once (#268) and a substring match
  // would treat "Switched to acme/qa-switched" and "…-twice" as the same element.
  await expect(page.getByText(`Switched to ${modelId}`, { exact: true })).toBeVisible()
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

    await test.step('the next message runs on the new model', async () => {
      await sendFromComposer(page, 'after the switch')
      await waitForAnswer(page, 'after the switch')
      await expectNoErrorBanner(page)
      // The selector reads the log back, not a local leftover.
      await expect(page.getByRole('button', { name: `Model: ${SWITCHED}` })).toBeVisible()
      // The first switch draws its marker too (#268): the transcript was seeded with the
      // session's own model when the chat opened.
      await expectSwitchedMarker(page, SWITCHED)
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
    // The first switch draws its marker (#268).
    await expectSwitchedMarker(page, SWITCHED)

    await test.step('switching again draws the change in the transcript', async () => {
      // The transcript knows a model from the message that just switched it, so a second
      // switch is a change it can mark.
      await pickModel(page, SWITCHED_AGAIN)
      await sendFromComposer(page, 'and switched again')
      await waitForAnswer(page, 'and switched again')
      await expectSwitchedMarker(page, SWITCHED_AGAIN)
      await expectNoErrorBanner(page)
      await shot(page, 'w10-03-switched-twice')
    })

    await test.step('a reload shows the switched model, with nothing re-picked', async () => {
      await page.reload()
      await expect(page.getByRole('button', { name: `Model: ${SWITCHED_AGAIN}` })).toBeVisible()
      // The markers are log data, not local state: replaying the session draws both of them
      // again, the first switch's included.
      await expectSwitchedMarker(page, SWITCHED)
      await expectSwitchedMarker(page, SWITCHED_AGAIN)
      await expectNoErrorBanner(page)
      await shot(page, 'w10-04-after-reload')
    })

    await test.step('a later message is still answered on the switched model', async () => {
      await sendFromComposer(page, 'no pick this time')
      await waitForAnswer(page, 'no pick this time')
      await expectNoErrorBanner(page)

      const stored = await getSession(request, session.id)
      expect(stored.model).toEqual({ id: SWITCHED_AGAIN })
      expect(await requestedModels(request, session.id)).toEqual([
        QA_MODEL,
        SWITCHED,
        SWITCHED_AGAIN,
        SWITCHED_AGAIN,
      ])
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
