import {
  createAgent,
  createSession,
  eventTypes,
  expect,
  openChat,
  sendFromComposer,
  shot,
  status,
  test,
  uniqueName,
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
      model: 'anthropic/claude-sonnet-5',
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)

    await sendFromComposer(page, '__slow__ something long please')
    const reply = page.locator('article[data-role="agent"]').last()
    await expect(reply).toContainText('part 1/40')
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()

    await test.step('Stop ends the stream and keeps what arrived', async () => {
      await page.getByRole('button', { name: 'Stop' }).click()
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')

      const stopped = (await reply.textContent()) ?? ''
      expect(stopped, 'the partial reply is still on screen').toContain('part 1/40')
      expect(stopped, 'the reply stopped short of the end').not.toContain('part 40/40')

      await page.waitForTimeout(1500)
      expect((await reply.textContent()) ?? '', 'nothing more arrived after Stop').toBe(stopped)
      await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
      await shot(page, 'w6-01-after-stop')

      const log = await eventTypes(request, session.id)
      expect(log).toContain('user.interrupt')
      expect(log.at(-1)).toBe('session.status_idle')
    })

    await test.step('a new message works afterwards', async () => {
      await sendFromComposer(page, 'after the interrupt')
      await expect(page.locator('article[data-role="agent"]').last()).toContainText(
        'after the interrupt',
      )
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
