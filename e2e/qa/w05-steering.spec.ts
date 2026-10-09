import {
  LONG_REPLY_PROMPT,
  QA_MODEL,
  createAgent,
  createSession,
  eventTypes,
  expect,
  expectNoErrorBanner,
  isRealModel,
  openChat,
  sendFromComposer,
  shot,
  status,
  test,
  uniqueName,
  waitForLongReplyStart,
} from './support'

/**
 * W5 — steering: a message sent while a reply is streaming is queued and answered after the
 * reply in flight, without the session ever going idle in between.
 */
test.describe('W5 steering', () => {
  test('W5 a message sent mid-stream is queued and answered in the same turn', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const agent = await createAgent(request, {
      name: uniqueName('QA W5'),
      model: QA_MODEL,
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)
    await expectNoErrorBanner(page)

    const firstQuestion = isRealModel ? LONG_REPLY_PROMPT : '__slow__ the first question'
    await sendFromComposer(page, firstQuestion)
    await waitForLongReplyStart(page)

    await test.step('the steering message shows as queued while the reply streams', async () => {
      await sendFromComposer(page, 'the second question')

      const steering = page.locator('article[data-role="user"]').last()
      await expect(steering).toContainText('the second question')
      await expect(steering).toHaveAttribute('data-pending', 'true')
      await expect(steering.getByText('queued')).toBeVisible()
      // The composer stays usable and the first reply keeps arriving.
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Running')
      await shot(page, 'w5-01-steering-queued')
    })

    await test.step('the agent answers it in the same turn', async () => {
      const secondReply = page.locator('article[data-role="agent"]').nth(1)
      // Nothing in a real answer names the question it answers, so there the arrival of a
      // second reply is the whole of it; the event log below is the exact half of this check.
      if (isRealModel) {
        await expect(page.locator('article[data-role="agent"]')).toHaveCount(2, {
          timeout: 60_000,
        })
      } else {
        await expect(secondReply).toContainText('the second question', { timeout: 30_000 })
        await expect(page.locator('article[data-role="agent"]')).toHaveCount(2)
      }
      await expect(
        page.locator('article[data-role="user"]').last().getByText('queued'),
      ).toHaveCount(0)
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')

      const log = await eventTypes(request, session.id)
      // One turn covering two model requests: the session went running once, and only reached
      // idle after the steering message had been answered.
      expect(log.filter((type) => type === 'session.status_running')).toHaveLength(1)
      expect(log.filter((type) => type === 'session.status_idle')).toHaveLength(1)
      expect(log.at(-1)).toBe('session.status_idle')
      expect(log.filter((type) => type === 'agent.message')).toHaveLength(2)
      await shot(page, 'w5-02-steering-answered')
    })

    await expectNoErrorBanner(page)

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
