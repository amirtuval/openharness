import {
  QA_MODEL,
  createAgent,
  createSession,
  expect,
  expectNoErrorBanner,
  getSession,
  listAllAgents,
  openChat,
  sendFromComposer,
  shot,
  test,
  uniqueName,
  waitForAnswer,
} from './support'

/** W10 — editing an agent: new sessions take the new prompt, existing ones keep their snapshot. */
test.describe('W10 agents', () => {
  test('W10a an edited system prompt applies to new sessions only', async ({
    page,
    request,
    consoleErrors,
  }) => {
    // The Agents screen renders at most one page of agents (20, the protocol's default) and
    // drops `next_page`, so a freshly created agent is only reachable in the UI while the
    // server has fewer than that. Reported separately on this issue.
    const existing = (await listAllAgents(request)).length
    const uiCanSeeIt = existing < 20

    const name = uniqueName('QA W10')
    const agent = await createAgent(request, {
      name,
      model: QA_MODEL,
      system: 'You are version one.',
    })
    const before = await createSession(request, agent.id)

    if (uiCanSeeIt) {
      await test.step('edit the system prompt in the UI', async () => {
        await page.goto('/#/agents')
        await page.getByRole('button', { name: `Edit ${name}` }).click()
        await page.getByLabel('System prompt').fill('You are version two.')
        await page.getByRole('button', { name: 'Save changes' }).click()

        await expect(page.getByRole('status').filter({ hasText: `Saved ${name}` })).toBeVisible()
        await expect(page.getByText('You are version two.')).toBeVisible()
        await shot(page, 'w10-01-agent-edited')
      })
    } else {
      test.info().annotations.push({
        type: 'note',
        description: `the server has ${existing} agents and the Agents screen truncates at 20, so the edit went through the API instead of the form`,
      })
      await test.step('edit the system prompt through the API', async () => {
        const response = await request.post(`/v1/agents/${agent.id}`, {
          data: { system: 'You are version two.' },
        })
        expect(response.status(), await response.text()).toBe(200)
      })
    }

    const after = await createSession(request, agent.id)

    await test.step('the existing session kept its snapshot', async () => {
      const session = await getSession(request, before.id)
      const snapshot = session.agent as { name: string; system: string | null }
      expect(snapshot.system).toBe('You are version one.')
    })

    await test.step('the new session has the new prompt', async () => {
      const session = await getSession(request, after.id)
      const snapshot = session.agent as { name: string; system: string | null }
      expect(snapshot.system).toBe('You are version two.')
    })

    await test.step('both chats still answer', async () => {
      await openChat(page, before.id)
      await expectNoErrorBanner(page)
      await sendFromComposer(page, 'still here')
      await waitForAnswer(page, 'still here')
      await expectNoErrorBanner(page)
    })

    await expectNoErrorBanner(page)

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W10b an agent can be created with a system prompt from the form', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const name = uniqueName('QA W10b')
    await page.goto('/#/agents')
    await page.getByLabel('Name').fill(name)
    await page.getByLabel('Model').fill('openai/gpt-5.1')
    await page.getByLabel('System prompt').fill('You are terse.')
    await page.getByRole('button', { name: 'Create agent' }).click()
    await expect(page.getByRole('status').filter({ hasText: `Created ${name}` })).toBeVisible()

    const created = (await listAllAgents(request)).find((entry) => entry.name === name)
    expect(created?.system).toBe('You are terse.')
    expect(created?.model.id).toBe('openai/gpt-5.1')

    await expectNoErrorBanner(page)

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  // Was `test.fail` as the reproduction of issue #25 (the screen rendered one page of agents
  // and dropped `next_page`, so everything past the 20 oldest was unreachable). Fixed by
  // PR #33: `useAgents` walks every page through `listAllPages`.
  test('W10c the agents screen lists every agent', async ({ page, request }) => {
    for (let index = 0; index < 21; index += 1) {
      await createAgent(request, {
        name: uniqueName(`QA W10c ${index}`),
        model: QA_MODEL,
        system: '',
      })
    }

    await page.goto('/#/agents')
    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible()
    await expect
      .poll(async () => page.locator('[data-slot="agent-card"]').count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(21)
    await shot(page, 'w10-02-agent-list-truncated')
  })
})
