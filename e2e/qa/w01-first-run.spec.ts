import {
  QA_MODEL,
  composer,
  expect,
  sendFromComposer,
  shot,
  test,
  uniqueName,
  waitForAnswer,
} from './support'

/**
 * W1 — first run: an empty app, one agent created through the form, one chat started with it.
 */
test.describe('W1 first run', () => {
  test('W1 empty state, create an agent, start a chat', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const agentName = uniqueName('QA First')

    await test.step('the app opens on the home screen with nothing in it', async () => {
      const agents = await request.get('/v1/agents')
      const body = (await agents.json()) as { data: unknown[] }

      await page.goto('/')
      await expect(page.getByRole('heading', { name: 'openharness' })).toBeVisible()
      await expect(page.getByRole('link', { name: 'New chat' }).first()).toBeVisible()

      if (body.data.length > 0) {
        // Not the assertion's fault: this server has been used before. The full first-run
        // reading needs a database with no agents in it.
        test.info().annotations.push({
          type: 'note',
          description: `server already has ${body.data.length} agent(s); the empty-state assertion was not exercised`,
        })
      } else {
        await expect(page.getByText('No chats yet.')).toBeVisible()
        await shot(page, 'w1-01-empty-state')
      }
    })

    await test.step('create an agent', async () => {
      await page.getByRole('link', { name: 'Agents' }).click()
      await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible()

      await page.getByLabel('Name').fill(agentName)
      await page.getByLabel('Model').fill(QA_MODEL)
      await page.getByLabel('System prompt').fill('You are a concise QA test agent.')
      await page.getByRole('button', { name: 'Create agent' }).click()

      await expect(
        page.getByRole('status').filter({ hasText: `Created ${agentName}` }),
      ).toBeVisible()
      await expect(page.getByRole('button', { name: `Edit ${agentName}` })).toBeVisible()
      await shot(page, 'w1-02-agent-created')
    })

    await test.step('start a chat with it', async () => {
      await page.getByRole('link', { name: 'New chat' }).first().click()
      await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()
      await expect(page.locator('#new-chat-agent')).toHaveValue(/agent_/)

      await page.getByRole('button', { name: 'Create chat' }).click()

      await expect(page).toHaveURL(/#\/s\/sesn_/)
      await expect(composer(page)).toBeFocused()
      await expect(page.getByText('Say something to start the conversation.')).toBeVisible()

      await sendFromComposer(page, 'hello from W1')
      await waitForAnswer(page, 'hello from W1')
      await shot(page, 'w1-03-first-chat')
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
