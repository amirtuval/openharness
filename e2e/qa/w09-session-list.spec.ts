import {
  createAgent,
  createSession,
  expect,
  openChat,
  sendMessage,
  shot,
  test,
  uniqueName,
  waitForIdle,
} from './support'

/** W9 — the session list: newest first, switchable, with something to tell the chats apart. */
test.describe('W9 session list', () => {
  test('W9 new sessions come first and switching between them works', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const made: { agent: string; session: string; text: string }[] = []
    for (const label of ['alpha', 'beta', 'gamma']) {
      const agent = await createAgent(request, {
        name: uniqueName(`QA W9 ${label}`),
        model: 'anthropic/claude-sonnet-5',
        system: 'Answer briefly.',
      })
      const session = await createSession(request, agent.id)
      const text = `message for ${label}`
      await sendMessage(request, session.id, text)
      await waitForIdle(request, session.id)
      made.push({ agent: agent.name, session: session.id, text })
    }

    await page.goto('/')
    const sidebar = page.getByRole('navigation', { name: 'Chats' })
    const links = sidebar.locator('a[href^="#/s/"]')
    await expect(links.first()).toBeVisible()

    await test.step('newest first, matching the API', async () => {
      const listed = await request.get('/v1/sessions', { params: { limit: 10 } })
      const body = (await listed.json()) as { data: { id: string }[] }
      const apiOrder = body.data.map((session) => session.id)
      const domOrder = await links.evaluateAll((nodes) =>
        nodes.map((node) => (node.getAttribute('href') ?? '').replace('#/s/', '')),
      )
      expect(domOrder.slice(0, apiOrder.length)).toEqual(apiOrder)

      const newestThree = domOrder.slice(0, 3)
      expect(newestThree).toEqual([made[2]!.session, made[1]!.session, made[0]!.session])
      await shot(page, 'w9-01-session-list')
    })

    await test.step('each entry shows the agent and the model', async () => {
      const newest = links.first()
      await expect(newest).toContainText(made[2]!.agent)
      await expect(newest).toContainText('anthropic/claude-sonnet-5')
    })

    await test.step('switching sessions works', async () => {
      const second = links.nth(1)
      const secondId = made[1]!.session
      await second.click()
      await expect(page).toHaveURL(new RegExp(secondId))
      await expect(page.locator('article[data-role="user"]').last()).toContainText(made[1]!.text)
      await expect(page.locator('a[aria-current="page"]')).toHaveCount(1)
      await expect(page.locator(`a[href="#/s/${secondId}"]`)).toHaveAttribute(
        'aria-current',
        'page',
      )
      await expect(links.first()).not.toHaveAttribute('aria-current', 'page')
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  // Known bug: nothing in the web app ever sets a session title, so every chat with the same
  // agent reads the same in the list. Reported on issue #14.
  test.fail('W9b a chat gets a title to tell it apart', async ({ page, request }) => {
    await page.goto('/#/new')
    // Whatever agent the picker offers first: which one it is has nothing to do with the
    // title this test is about.
    await page.getByRole('button', { name: 'Create chat' }).click()
    await expect(page).toHaveURL(/#\/s\/sesn_/)

    const sessionId = (await page.evaluate(() => window.location.hash)).replace('#/s/', '')
    await page.getByLabel('Message').fill('a chat about the release checklist')
    await page.getByLabel('Message').press('Enter')
    await expect(page.locator('article[data-role="agent"]').last()).toContainText(
      'release checklist',
    )

    const session = await request.get(`/v1/sessions/${sessionId}`)
    const body = (await session.json()) as { title: string | null }
    expect(body.title, 'a session created from the UI has a title').not.toBeNull()
  })

  test('W9c the sidebar highlights the open chat', async ({ page, request, consoleErrors }) => {
    const agent = await createAgent(request, {
      name: uniqueName('QA W9c'),
      model: 'anthropic/claude-sonnet-5',
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)
    await expect(page.locator(`a[href="#/s/${session.id}"]`)).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
