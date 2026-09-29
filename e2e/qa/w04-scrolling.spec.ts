import {
  LONG_REPLY_PROMPT,
  QA_MODEL,
  conversation,
  createAgent,
  createSession,
  distanceFromBottom,
  expect,
  expectNoErrorBanner,
  isRealModel,
  lastAgentText,
  openChat,
  seedTurns,
  sendFromComposer,
  shot,
  test,
  uniqueName,
  waitForLongReplyStart,
} from './support'

/**
 * W4 — scrolling during a long reply: scrolling up must stick, and coming back to the bottom
 * must start following again. The reply is the mock's `__slow__` one, or a long answer from a
 * real model, so the stream is still running while the reader is scrolling around in it.
 */
test.describe('W4 scrolling', () => {
  test('W4 scrolling up during a stream holds, scrolling back resumes', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const agent = await createAgent(request, {
      name: uniqueName('QA W4'),
      model: QA_MODEL,
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    // A conversation taller than the window, so "scrolled up" is a real position.
    await seedTurns(
      request,
      session.id,
      ['filler one', 'filler two', 'filler three'].map(
        (label) => `${label} ${'the quick brown fox jumps over the lazy dog '.repeat(20)}`,
      ),
    )
    await openChat(page, session.id)
    await expectNoErrorBanner(page)

    const prompt = isRealModel ? LONG_REPLY_PROMPT : '__slow__ a long reply'
    await sendFromComposer(page, prompt)
    await waitForLongReplyStart(page)

    await test.step('scroll up: the view stays where the reader put it', async () => {
      await conversation(page).evaluate((element) => {
        element.scrollTop = 0
      })
      expect(await distanceFromBottom(page), 'scrolled away from the bottom').toBeGreaterThan(100)
      await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
      await shot(page, 'w4-01-scrolled-up')

      const before = await lastAgentText(page)
      await page.waitForTimeout(2000)
      const after = await lastAgentText(page)

      expect(after.length, 'the reply kept streaming while scrolled up').toBeGreaterThan(
        before.length,
      )
      expect(await distanceFromBottom(page), 'the view did not jump back down').toBeGreaterThan(100)
    })

    await test.step('scroll back to the bottom: following resumes', async () => {
      await page.getByRole('button', { name: 'Jump to latest' }).click()
      expect(await distanceFromBottom(page)).toBeLessThan(48)
      await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0)

      await page.waitForTimeout(1500)
      expect(
        await distanceFromBottom(page),
        'the view followed the new deltas after scrolling back down',
      ).toBeLessThan(48)
      await shot(page, 'w4-02-following-again')
    })

    await expectNoErrorBanner(page)

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
