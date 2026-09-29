import {
  composer,
  conversation,
  createAgent,
  createSession,
  distanceFromBottom,
  expect,
  eventTypes,
  openChat,
  recordRendering,
  renderedLengths,
  sawStatus,
  sendFromComposer,
  shot,
  status,
  test,
  uniqueName,
} from './support'

/**
 * W2 — one turn: the reply arrives in pieces, the status goes running → idle, the composer
 * keeps the focus, and markdown comes out rendered.
 */
test.describe('W2 basic chat', () => {
  test('W2 a reply streams in, the input keeps focus, markdown renders', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const agent = await createAgent(request, {
      name: uniqueName('QA W2'),
      model: 'anthropic/claude-sonnet-5',
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)
    await recordRendering(page)

    await test.step('the reply streams in piece by piece', async () => {
      await sendFromComposer(page, 'hello there')

      const agentMessage = page.locator('article[data-role="agent"]').last()
      await expect(agentMessage).toContainText('hello there')
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')

      const lengths = [...new Set(await renderedLengths(page))].filter((length) => length > 0)
      expect(
        lengths.length,
        `the reply was rendered at ${lengths.length} distinct lengths`,
      ).toBeGreaterThan(1)

      const log = await eventTypes(request, session.id)
      expect(log.indexOf('session.status_running')).toBeGreaterThan(-1)
      expect(log.indexOf('session.status_running')).toBeLessThan(log.indexOf('session.status_idle'))
      expect(await sawStatus(page, 'Running'), 'the header painted "Running"').toBe(true)
    })

    await test.step('the input keeps the focus', async () => {
      await expect(composer(page)).toBeFocused()
    })

    await test.step('markdown renders', async () => {
      const markdown = [
        '# A heading',
        '',
        '- first',
        '- second',
        '',
        '```js',
        'const answer = 42',
        '```',
      ].join('\n')
      await sendFromComposer(page, markdown)

      const reply = page.locator('article[data-role="agent"]').last()
      await expect(reply.locator('h1')).toHaveText('A heading')
      await expect(reply.locator('ul li')).toHaveCount(2)
      await expect(reply.locator('pre code')).toContainText('const answer = 42')
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
      await shot(page, 'w2-01-markdown-reply')
    })

    await test.step('the conversation follows the new messages', async () => {
      expect(await distanceFromBottom(page)).toBeLessThan(48)
      await expect(conversation(page)).toBeVisible()
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
