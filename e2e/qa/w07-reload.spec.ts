import {
  RELOAD_REPLY_PROMPT,
  QA_MODEL,
  conversation,
  createAgent,
  createSession,
  expect,
  expectNoErrorBanner,
  isRealModel,
  lastAgentText,
  openChat,
  sendFromComposer,
  shot,
  status,
  test,
  uniqueName,
  waitForAnswer,
  waitForLongReplyStart,
} from './support'

/**
 * The prompt that keeps the reply streaming while the page reloads.
 *
 * The mock has `__slow__` for this; a real provider has to be asked for something long.
 */
const reloadPrompt = isRealModel ? RELOAD_REPLY_PROMPT : '__slow__ reload in the middle of this'

/** Whitespace collapsed, so a comparison is about words rather than about rendering. */
function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** W7 — reloading: mid-stream, and after the turn. */
test.describe('W7 reload', () => {
  test('W7a a reload mid-stream restores the history and the reply continues live', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const agent = await createAgent(request, {
      name: uniqueName('QA W7'),
      model: QA_MODEL,
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)
    await expectNoErrorBanner(page)

    await sendFromComposer(page, reloadPrompt)
    await waitForLongReplyStart(page, { minLength: 40 })
    if (!isRealModel) {
      await page.waitForTimeout(1200)
    }
    // The premise of the scenario, asserted rather than assumed: the reload has to land while
    // the reply is still arriving. A real provider can answer a short reply faster than a test
    // can reload, and a reload after the turn proves nothing about a reload during it.
    await expect(status(page), 'the reload has to land mid-stream').toHaveAttribute(
      'aria-label',
      'Status: Running',
    )

    await page.reload()
    await expect(conversation(page)).toBeVisible()
    await expectNoErrorBanner(page)
    await expect(page.locator('article[data-role="user"]').last()).toContainText(reloadPrompt)

    const reply = page.locator('article[data-role="agent"]').last()
    await expect(reply).toContainText(/\S/, { timeout: 15_000 })
    await expect(status(page)).toHaveAttribute('aria-label', 'Status: Running')

    const before = (await lastAgentText(page)).length
    await expect
      .poll(async () => (await lastAgentText(page)).length, { timeout: 30_000 })
      .toBeGreaterThan(before)

    if (!isRealModel) {
      await expect(reply).toContainText('part 40/40', { timeout: 30_000 })
    }
    await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
    await shot(page, 'w7-01-reloaded-mid-stream')

    await expectNoErrorBanner(page)

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  // Reproduced issue #27 (a reload mid-stream resumed the reply mid-word, because the deltas
  // that had already arrived were stream-only). Fixed by D9 (#46): the chunks *are* the log
  // now, so a reloaded page replays them by `seq` and the beginning is there when the page
  // comes back.
  test('W7b a reload mid-stream keeps the text that already arrived', async ({ page, request }) => {
    const agent = await createAgent(request, {
      name: uniqueName('QA W7b'),
      model: QA_MODEL,
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)
    await expectNoErrorBanner(page)

    await sendFromComposer(page, reloadPrompt)
    await waitForLongReplyStart(page, { minLength: 40 })
    if (!isRealModel) {
      await page.waitForTimeout(1200)
    }
    await expect(status(page), 'the reload has to land mid-stream').toHaveAttribute(
      'aria-label',
      'Status: Running',
    )

    // What the reply has said so far. That the reloaded page still opens with it — rather
    // than resuming mid-word at whatever delta the new connection happened to catch — is the
    // whole of issue #27.
    const beforeReloadText = await lastAgentText(page)
    const beforeReload = normalized(beforeReloadText)

    await page.reload()
    const reply = page.locator('article[data-role="agent"]').last()
    await expect(reply).toContainText(/\S/, { timeout: 15_000 })
    await expectNoErrorBanner(page)

    if (isRealModel) {
      // Cut to a word boundary: the text may have been captured mid-token, and a partial word
      // at the end says nothing about whether the beginning survived.
      const slice = beforeReload.slice(0, 40)
      const head = slice.includes(' ') ? slice.slice(0, slice.lastIndexOf(' ')) : slice
      await expect
        .poll(async () => normalized(await lastAgentText(page)).startsWith(head), {
          timeout: 20_000,
          message: `the reply should still open with ${JSON.stringify(head)}`,
        })
        .toBe(true)
    } else {
      const text = await lastAgentText(page)
      expect(text, `the reply resumed with: ${JSON.stringify(text.slice(0, 60))}`).toContain(
        'part 1/40',
      )
    }

    // The reload really did land mid-reply: more of it arrived afterwards than had arrived
    // before, so the text compared above was a prefix of a reply still being written — which
    // is the situation #27 was about.
    await expect
      .poll(async () => (await lastAgentText(page)).length, {
        timeout: 60_000,
        message: 'the reply should have kept arriving after the reload',
      })
      .toBeGreaterThan(beforeReloadText.length)

    await expectNoErrorBanner(page)
  })

  test('W7c a reload after the turn restores the whole conversation', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const agent = await createAgent(request, {
      name: uniqueName('QA W7c'),
      model: QA_MODEL,
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)
    await expectNoErrorBanner(page)

    await sendFromComposer(page, 'the only turn')
    await waitForAnswer(page, 'the only turn')
    await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')

    await page.reload()
    await expect(conversation(page)).toBeVisible()
    // The reload reads the whole stored turn back — including the `span.model_request_end`
    // #39 corrupted — so this is where a session that stopped being readable shows up.
    await expectNoErrorBanner(page)
    await expect(page.locator('article[data-role]')).toHaveCount(2)
    await expect(page.locator('article[data-role="user"]').last()).toContainText('the only turn')
    // The reply is only known to be non-empty: nothing constrains how a model words one.
    await expect(page.locator('article[data-role="agent"]').last()).toContainText(/\S/)
    await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
    await shot(page, 'w7-02-reloaded-after-turn')

    await expectNoErrorBanner(page)

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
