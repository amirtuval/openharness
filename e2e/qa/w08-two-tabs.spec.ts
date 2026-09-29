import {
  QA_MODEL,
  createAgent,
  createSession,
  expect,
  openChat,
  sendFromComposer,
  shot,
  test,
  uniqueName,
  waitForAnswer,
} from './support'

/** W8 — the same session open twice: what one tab sends, the other sees while it happens. */
test.describe('W8 two tabs', () => {
  test('W8 a message sent in one tab appears in the other', async ({
    page,
    context,
    request,
    consoleErrors,
  }) => {
    const agent = await createAgent(request, {
      name: uniqueName('QA W8'),
      model: QA_MODEL,
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)

    const other = await context.newPage()
    await openChat(page, session.id)
    await openChat(other, session.id)

    await test.step('from the first tab', async () => {
      await sendFromComposer(page, 'sent from tab one')
      await expect(other.locator('article[data-role="user"]').last()).toContainText(
        'sent from tab one',
      )
      await waitForAnswer(other, 'sent from tab one')
    })

    await test.step('from the second tab', async () => {
      await sendFromComposer(other, 'sent from tab two')
      await expect(page.locator('article[data-role="user"]').last()).toContainText(
        'sent from tab two',
      )
      await waitForAnswer(page, 'sent from tab two')
    })

    await expect(page.locator('article[data-role]')).toHaveCount(4)
    await expect(other.locator('article[data-role]')).toHaveCount(4)
    await shot(other, 'w8-01-second-tab')

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
    await other.close()
  })
})
