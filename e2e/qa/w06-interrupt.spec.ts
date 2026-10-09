import {
  QA_MODEL,
  RELOAD_REPLY_PROMPT,
  createAgent,
  createSession,
  eventTypes,
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

/** W6 — Stop: the stream ends, the partial text stays, and the chat keeps working. */
test.describe('W6 interrupt', () => {
  test('W6 Stop ends the stream, keeps the partial reply, and the chat still works', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const agent = await createAgent(request, {
      name: uniqueName('QA W6'),
      model: QA_MODEL,
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)
    await expectNoErrorBanner(page)

    // 300 numbers rather than 60: a real provider streams the shorter reply faster than the
    // Stop button can be looked for (#74 §12), and a Stop after the model has finished would
    // test nothing. The mock's `__slow__` is unchanged.
    const prompt = isRealModel ? RELOAD_REPLY_PROMPT : '__slow__ something long please'
    await sendFromComposer(page, prompt)
    // Enough of the reply to have something worth keeping, and early enough that there is
    // still a long way to go.
    await waitForLongReplyStart(page, { minLength: 40 })
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()

    await test.step('Stop ends the stream and keeps what arrived', async () => {
      await page.getByRole('button', { name: 'Stop' }).click()
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')

      const stopped = await lastAgentText(page)
      expect(stopped.trim().length, 'the partial reply is still on screen').toBeGreaterThan(0)
      if (!isRealModel) {
        expect(stopped, 'the partial reply is still on screen').toContain('part 1/40')
        expect(stopped, 'the reply stopped short of the end').not.toContain('part 40/40')
      }

      await page.waitForTimeout(1500)
      expect(await lastAgentText(page), 'nothing more arrived after Stop').toBe(stopped)
      await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
      await shot(page, 'w6-01-after-stop')

      const log = await eventTypes(request, session.id)
      expect(log).toContain('user.interrupt')
      expect(log.at(-1)).toBe('session.status_idle')
    })

    await test.step('a new message works afterwards', async () => {
      await sendFromComposer(page, 'after the interrupt')
      await waitForAnswer(page, 'after the interrupt')
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
    })

    await expectNoErrorBanner(page)

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
