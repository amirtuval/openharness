import {
  createAgent,
  createSession,
  expect,
  openChat,
  sendFromComposer,
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

    await test.step('each entry shows what the chat is about and the model', async () => {
      const newest = links.first()
      // The label is the session's title — derived from the first message since #29 — and the
      // agent's name only when there is no title to show (`apps/web/src/lib/format.ts`).
      await expect(newest).toContainText(made[2]!.text)
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

  // Was `test.fail` as the reproduction of issue #29 (nothing ever set `Session.title`, so
  // every chat with one agent read identically). Fixed by PR #32: the server derives the
  // title from the first `user.message` and never overwrites one that exists.
  test('W9b a chat gets a title to tell it apart', async ({ page, request }) => {
    await page.goto('/#/new')
    // Whatever agent the picker offers first: which one it is has nothing to do with the
    // title this test is about.
    await page.getByRole('button', { name: 'Create chat' }).click()
    await expect(page).toHaveURL(/#\/s\/sesn_/)

    const sessionId = (await page.evaluate(() => window.location.hash)).replace('#/s/', '')
    await sendFromComposer(page, 'a chat about the release checklist')
    await expect(page.locator('article[data-role="agent"]').last()).toContainText(
      'release checklist',
    )

    const session = await request.get(`/v1/sessions/${sessionId}`)
    const body = (await session.json()) as { title: string | null }
    expect(body.title, 'a session created from the UI has a title').not.toBeNull()
    // The server derives it from the first line of the first message and never overwrites one
    // that exists (`apps/server/src/titles.ts`).
    expect(body.title, 'the title says what the chat is about').toBe(
      'a chat about the release checklist',
    )

    // What the sidebar makes of that title, without a reload, is W9d below.
  })

  // Was `test.fail` as the reproduction of issue #35: the title is derived on the server when
  // the first message is stored and nothing told the client, so the sidebar row — and the
  // chat header — kept the agent's name until something reloaded the page. Fixed by PR #37:
  // the open chat re-reads the session once after its first message and both surfaces merge
  // that copy in.
  test('W9d the sidebar shows a new title without a reload', async ({ page }) => {
    await page.goto('/#/new')
    await page.getByRole('button', { name: 'Create chat' }).click()
    await expect(page).toHaveURL(/#\/s\/sesn_/)
    const sessionId = (await page.evaluate(() => window.location.hash)).replace('#/s/', '')
    await sendFromComposer(page, 'a chat about the release checklist')
    await expect(page.locator('article[data-role="agent"]').last()).toContainText(
      'release checklist',
    )

    // The list the sidebar is holding was loaded before this chat had a message.
    await expect(page.locator(`a[href="#/s/${sessionId}"]`)).toContainText(
      'a chat about the release checklist',
    )
    // The header reads the same re-read: a user who opens a chat, sends the first message and
    // stays there must not be left looking at the agent's name either.
    await expect(
      page.getByRole('heading', { name: 'a chat about the release checklist' }),
    ).toBeVisible()
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
