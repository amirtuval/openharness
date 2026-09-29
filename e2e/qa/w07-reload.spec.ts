import {
  conversation,
  createAgent,
  createSession,
  expect,
  openChat,
  sendFromComposer,
  shot,
  status,
  test,
  uniqueName,
} from './support'

/** W7 — reloading: mid-stream, and after the turn. */
test.describe('W7 reload', () => {
  test('W7a a reload mid-stream restores the history and the reply continues live', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const agent = await createAgent(request, {
      name: uniqueName('QA W7'),
      model: 'anthropic/claude-sonnet-5',
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)

    await sendFromComposer(page, '__slow__ reload in the middle of this')
    await expect(page.locator('article[data-role="agent"]').last()).toContainText('part 1/40')
    await page.waitForTimeout(1200)

    await page.reload()
    await expect(conversation(page)).toBeVisible()
    await expect(page.locator('article[data-role="user"]').last()).toContainText(
      '__slow__ reload in the middle of this',
    )

    const reply = page.locator('article[data-role="agent"]').last()
    await expect(reply).toContainText('part ', { timeout: 15_000 })
    await expect(status(page)).toHaveAttribute('aria-label', 'Status: Running')

    const before = ((await reply.textContent()) ?? '').length
    await expect
      .poll(async () => ((await reply.textContent()) ?? '').length, { timeout: 15_000 })
      .toBeGreaterThan(before)

    await expect(reply).toContainText('part 40/40', { timeout: 30_000 })
    await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
    await shot(page, 'w7-01-reloaded-mid-stream')

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  // Known bug: the text that had already streamed in is not part of what comes back after a
  // reload, so the reply resumes mid-word. Reported on issue #14.
  test.fail(
    'W7b a reload mid-stream keeps the text that already arrived',
    async ({ page, request }) => {
      const agent = await createAgent(request, {
        name: uniqueName('QA W7b'),
        model: 'anthropic/claude-sonnet-5',
        system: 'Answer briefly.',
      })
      const session = await createSession(request, agent.id)
      await openChat(page, session.id)

      await sendFromComposer(page, '__slow__ reload in the middle of this')
      await expect(page.locator('article[data-role="agent"]').last()).toContainText('part 1/40')
      await page.waitForTimeout(1200)

      await page.reload()
      const reply = page.locator('article[data-role="agent"]').last()
      await expect(reply).toContainText('part ', { timeout: 15_000 })

      const text = (await reply.textContent()) ?? ''
      expect(text, `the reply resumed with: ${JSON.stringify(text.slice(0, 60))}`).toContain(
        'part 1/40',
      )
    },
  )

  test('W7c a reload after the turn restores the whole conversation', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const agent = await createAgent(request, {
      name: uniqueName('QA W7c'),
      model: 'anthropic/claude-sonnet-5',
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)

    await sendFromComposer(page, 'the only turn')
    await expect(page.locator('article[data-role="agent"]').last()).toContainText('the only turn')
    await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')

    await page.reload()
    await expect(conversation(page)).toBeVisible()
    await expect(page.locator('article[data-role]')).toHaveCount(2)
    await expect(page.locator('article[data-role="user"]').last()).toContainText('the only turn')
    await expect(page.locator('article[data-role="agent"]').last()).toContainText('the only turn')
    await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
    await shot(page, 'w7-02-reloaded-after-turn')

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
