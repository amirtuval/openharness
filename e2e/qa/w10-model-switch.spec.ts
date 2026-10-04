import type { APIRequestContext } from '@playwright/test'

import {
  QA_MODEL,
  composer,
  composerModel,
  expect,
  expectNoErrorBanner,
  isRealModel,
  openChat,
  pickModelId,
  sendFromComposer,
  shot,
  test,
  waitForAnswer,
} from './support'

/**
 * W10 — the composer's model switch (epic #116, U3), where the Agents screen used to be.
 *
 * A chat runs one model at a time, and the composer's selector is where it changes: a pick is
 * **held for the next message** (the control says so before anything is sent), that message
 * carries `{ model }`, and the session runs it from then on. The transcript draws the change
 * as a "Switched to …" marker above the message that carried it — but only for a **change**:
 * the first model the log shows (a chat created on one, or the first pick of a fresh chat)
 * sets the transcript's model silently, because there is nothing it changed from.
 *
 * The scenario makes two switches of a fresh chat to show both halves, then reloads: the
 * selector and the marker read the log after a fresh load, not local state.
 *
 * The switches go to free-text ids on the mock — it answers every id, and a mock pass may
 * have no keys, so no catalog; on a real-provider pass they go to catalog entries.
 */

/** A session of this file's own, so the scenarios cannot step on each other. */
async function sessionOn(request: APIRequestContext, model: string): Promise<string> {
  const response = await request.post('/v1/sessions', { data: { model: { id: model } } })
  expect(response.status(), await response.text()).toBe(201)
  return ((await response.json()) as { id: string }).id
}

/**
 * Two models to switch to that will actually answer: free-text ids on the mock (it answers
 * whatever it is asked), catalog entries on a real pass — `[]` when the account's keys can
 * list fewer than two models besides the one the chat already runs.
 *
 * `label` is what the switches' UI shows for one: the catalog's display name where there is
 * one, the id otherwise.
 */
async function switchTargets(
  request: APIRequestContext,
  current: string,
): Promise<{ id: string; label: string }[]> {
  if (!isRealModel) {
    return [
      { id: 'openai/qa-switch-mini', label: 'openai/qa-switch-mini' },
      { id: 'google/qa-switch-flash', label: 'google/qa-switch-flash' },
    ]
  }
  const response = await request.get('/v1/models')
  expect(response.status(), await response.text()).toBe(200)
  const body = (await response.json()) as { data: { id: string; name: string }[] }
  return body.data
    .filter((entry) => entry.id !== current)
    .slice(0, 2)
    .map((entry) => ({ id: entry.id, label: entry.name }))
}

/** The `model` of the last model request in a session's log — what the turn actually ran. */
async function lastRequestModel(request: APIRequestContext, sessionId: string): Promise<string> {
  const response = await request.get(`/v1/sessions/${sessionId}/events`, {
    params: { 'types[]': 'span.model_request_start', limit: 100 },
  })
  expect(response.status(), await response.text()).toBe(200)
  const body = (await response.json()) as { data: { model?: string }[] }
  const last = body.data.at(-1)?.model
  if (last === undefined) {
    throw new Error(`session ${sessionId} has no model request in its log`)
  }
  return last
}

/** How the composer's control labels a model: the catalog's name where there is one, else the id. */
async function labelOf(request: APIRequestContext, modelId: string): Promise<string> {
  if (!isRealModel) {
    return modelId
  }
  const response = await request.get('/v1/models')
  const body = (await response.json()) as { data: { id: string; name: string }[] }
  return body.data.find((entry) => entry.id === modelId)?.name ?? modelId
}

test.describe('W10 the composer model switch', () => {
  test('W10a the first switch is silent, the next is marked, and the session runs it', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const targets = await switchTargets(request, QA_MODEL)
    if (targets.length < 2) {
      test.skip(true, 'the account can list fewer than two other models to switch to')
      return
    }
    const [first, second] = targets as [
      { id: string; label: string },
      { id: string; label: string },
    ]

    const sessionId = await sessionOn(request, QA_MODEL)
    await openChat(page, sessionId)
    await expectNoErrorBanner(page)
    // The selector starts on the model the session was created with.
    await expect(composerModel(page)).toContainText(await labelOf(request, QA_MODEL))
    const marker = page.locator('[data-slot="model-change"]')

    await test.step('the pick is held, and visible before anything is sent', async () => {
      await pickModelId(page, composerModel(page), first.id)
      // Not applied yet — nothing was sent — but the control says what the next message will
      // run. The session is untouched.
      await expect(composerModel(page)).toContainText(first.label)
      const response = await request.get(`/v1/sessions/${sessionId}`)
      expect(((await response.json()) as { model: { id: string } }).model.id).toBe(QA_MODEL)
      await shot(page, 'w10-01-pick-held')
    })

    await test.step('the message carries it — no marker, because it is the log’s first model', async () => {
      await sendFromComposer(page, 'sent on the switched model')
      await waitForAnswer(page, 'sent on the switched model')
      // The chat's own configuration moved, and the log attributes the turn to it…
      const response = await request.get(`/v1/sessions/${sessionId}`)
      expect(((await response.json()) as { model: { id: string } }).model.id).toBe(first.id)
      expect(await lastRequestModel(request, sessionId)).toBe(first.id)
      // …but the transcript draws no change marker: nothing before it said what the session
      // ran, so there is nothing "Switched to …" could differ from (`@openharness/client`).
      await expect(marker).toHaveCount(0)
      await shot(page, 'w10-02-first-switch-is-silent')
    })

    await test.step('the next switch is a change, and the transcript marks it', async () => {
      await pickModelId(page, composerModel(page), second.id)
      await sendFromComposer(page, 'and now it is a change')
      await waitForAnswer(page, 'and now it is a change')
      await expect(marker).toHaveCount(1)
      await expect(marker).toContainText(`Switched to ${second.label}`)
      expect(await lastRequestModel(request, sessionId)).toBe(second.id)

      // It sticks: a later message names no model and still runs the switched one.
      await sendFromComposer(page, 'one more, without naming a model')
      await waitForAnswer(page, 'one more, without naming a model')
      expect(await lastRequestModel(request, sessionId)).toBe(second.id)
      await expectNoErrorBanner(page)
      await shot(page, 'w10-03-switched-and-marked')
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W10b the switch survives a reload and a second message', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const targets = await switchTargets(request, QA_MODEL)
    if (targets.length < 2) {
      test.skip(true, 'the account can list fewer than two other models to switch to')
      return
    }
    const [first, second] = targets as [
      { id: string; label: string },
      { id: string; label: string },
    ]

    const sessionId = await sessionOn(request, QA_MODEL)
    await openChat(page, sessionId)
    await pickModelId(page, composerModel(page), first.id)
    await sendFromComposer(page, 'the first message on another model')
    await waitForAnswer(page, 'the first message on another model')
    await pickModelId(page, composerModel(page), second.id)
    await sendFromComposer(page, 'the marked switch')
    await waitForAnswer(page, 'the marked switch')

    await test.step('a reload reads the model and the marker from the log', async () => {
      await page.reload()
      await expect(page.locator('article[data-role="user"]').last()).toContainText(
        'the marked switch',
      )
      // The selector is not local state: the session's model, as the log last said, is what
      // the composer shows after a fresh read — and the marker is rebuilt with it.
      await expect(composerModel(page)).toContainText(second.label)
      await expect(page.locator('[data-slot="model-change"]')).toHaveCount(1)
      await shot(page, 'w10-04-after-reload')
      await expectNoErrorBanner(page)
    })

    await test.step('and the chat keeps running it', async () => {
      await sendFromComposer(page, 'still on the switched model after the reload')
      await waitForAnswer(page, 'still on the switched model after the reload')
      expect(await lastRequestModel(request, sessionId)).toBe(second.id)
      await expect(composer(page)).toBeFocused()
      await expectNoErrorBanner(page)
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
