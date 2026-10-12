import {
  createChat,
  expect,
  expectNoErrorBanner,
  openChat,
  sendFromComposer,
  setStoredTheme,
  shot,
  shotOf,
  test,
  uniqueName,
} from './support'

/**
 * W31 — subagents in the web app (epic #340, decision S9, issue #346).
 *
 * The hands-on half of the frontend work, against the mock model: a chat starts a helper, the
 * card draws in the transcript with its type, its description and its status, the reader watches
 * it, opens the child as a full chat, steers it, sends the parent's own `agent_message` and reads
 * the child's note back inline, and finally stops one that is still working.
 *
 * The four things a browser can prove that a component test cannot are all here: the card draws
 * where the `agent` call was *in the real transcript*, the child's own stream really feeds the
 * activity line (through the client's watcher), the child really opens as a chat with a
 * breadcrumb back, and the sidebar really nests it under the chat that started it — each of them
 * a round trip through the server, the brain, the store and the SSE stream.
 *
 * The mock's markers are the driver (`apps/server/AGENTS.md`): `__agent__ <type> | <prompt>`
 * starts one, `__agent_message__ <task_id> | <text>` is the parent steering it,
 * `__message_parent__ <note>` is the child talking back, and `__hold__` is a turn that never ends
 * — the latch the stop scenario needs.
 */

/** The type every deployment has, and what a card started without one would be called. */
const TYPE = 'general-purpose'

/** The description the mock derives from the prompt (its first line, collapsed). */
const DESCRIPTION = 'Check the release notes for 1.2'

/** The card in the open transcript. */
function card(page: Parameters<typeof shot>[0]) {
  return page.locator('[data-slot="task-card"]').first()
}

/** The sidebar's group of helpers under a chat, if that chat has any. */
function sidebarGroup(page: Parameters<typeof shot>[0]) {
  return page.locator('nav[aria-label="Chats"] [data-slot="chat-children"]').first()
}

/**
 * Bring the card into the middle of the transcript, so a screenshot of it is a screenshot of the
 * whole card.
 *
 * The transcript sticks to the bottom, which is where a reader wants it — and which puts a card
 * the turn has grown past half above the fold. Nothing is streaming while these shots are taken,
 * so the reader's own scroll holds.
 */
async function frameCard(page: Parameters<typeof shot>[0]): Promise<void> {
  await card(page).evaluate((element) => {
    element.scrollIntoView({ block: 'center' })
  })
}

test.describe('W31 subagents', () => {
  test('W31 a chat starts a helper: the card, the child chat, and the conversation between them', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const chat = await createChat(request)
    await openChat(page, chat.id)

    await test.step('the card appears where the agent call was, and finishes', async () => {
      await sendFromComposer(page, `__agent__ ${TYPE} | ${DESCRIPTION}`)

      const task = card(page)
      await expect(task).toBeVisible()
      // A card the parent's log alone can draw: the type, the description and the status.
      await expect(task).toHaveAttribute('data-type', TYPE)
      await expect(task.getByText(DESCRIPTION)).toBeVisible()
      await expect(task.locator('[data-slot="task-status"]')).toHaveText('done')
      // A task with a child session offers to open it; a finished one offers no Stop.
      await expect(task.getByRole('link', { name: 'Open' })).toBeVisible()
      await expect(task.locator('[data-slot="task-stop"]')).toHaveCount(0)
      // The result folds in — that is where a finished task says what came of it.
      await task.getByRole('button', { name: 'Result' }).click()
      await expect(task.locator('[data-slot="task-result"]')).toContainText(DESCRIPTION)

      // The chat's own header names what the whole tree spent (S8, #344): the child's requests
      // are in this chat's bill.
      await expect(page.locator('[data-slot="session-descendants"]')).toContainText(/subagents/)
      await expectNoErrorBanner(page)
      await shot(page, 'w31-01-card-done')
    })

    const taskId = await card(page).getAttribute('data-task')
    expect(taskId).toBeTruthy()

    await test.step('the sidebar nests the helper under the chat that started it', async () => {
      const group = sidebarGroup(page)
      await expect(group).toBeVisible()
      await expect(group.getByRole('button')).toHaveText(/1 subagent/)
      await expect(group.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
      await shot(page, 'w31-02-sidebar-nested')

      await group.getByRole('button').click()
      await expect(group.getByRole('link')).toHaveCount(1)
      await expectNoErrorBanner(page)
    })

    await test.step('the child opens as a full chat, under a breadcrumb', async () => {
      await card(page).getByRole('link', { name: 'Open' }).click()
      await expect(page).toHaveURL(/#\/s\/sesn_/)

      // The strip: where this chat sits, and the one line about what a subagent is.
      const strip = page.locator('[data-slot="subagent-header"]')
      await expect(strip).toBeVisible()
      await expect(strip.locator('[data-slot="breadcrumb-link"]').first()).toHaveAttribute(
        'href',
        `#/s/${chat.id}`,
      )
      await expect(strip.locator('[data-slot="breadcrumb-current"]')).toHaveCount(1)
      await expect(page.locator('[data-slot="subagent-note"]')).toHaveText(
        'A subagent cannot ask you anything, but you can message and interrupt it.',
      )
      // The child's own log: the prompt its parent wrote, and nothing of the parent's history.
      await expect(page.getByText(DESCRIPTION).first()).toBeVisible()
      // A normal composer — steering a helper is a message to it.
      await expect(page.locator('#composer-input')).toBeVisible()
      await expectNoErrorBanner(page)
      await shot(page, 'w31-03-child-chat')
    })

    await test.step('the reader steers the child, and the child talks back', async () => {
      // A message the *reader* sends to the child is an ordinary `user.message` in its log: the
      // child runs another turn, and its turn end reaches the parent as a result.
      const conversation = page.getByRole('log', { name: 'Conversation' })
      await sendFromComposer(page, 'Also check the upgrade notes.')
      await expect(conversation.getByText('Also check the upgrade notes.')).toBeVisible()
      await expectNoErrorBanner(page)

      // The child's note back to the parent is the one marker a child writes.
      await sendFromComposer(page, '__message_parent__ The changelog looks accurate so far.')
      await expect(
        conversation.getByText(/The changelog looks accurate so far\./).first(),
      ).toBeVisible()
      await shot(page, 'w31-04-child-steered')
    })

    await test.step('the parent steers the helper, and both directions read inline on the card', async () => {
      // Back up the breadcrumb to the parent chat.
      await page.locator('[data-slot="breadcrumb-link"]').first().click()
      await openChat(page, chat.id)

      // The parent's own `agent_message` — the model steering the helper it started.
      await sendFromComposer(page, `__agent_message__ ${String(taskId)} | Try the 1.2.1 notes too`)
      await expect(page.getByText(/Your message was sent to/).first()).toBeVisible()

      const task = card(page)
      const messages = task.locator('[data-slot="task-messages"] li')
      // Both directions, in the order they happened, in the parent's own words.
      await expect(messages.filter({ hasText: `→ ${TYPE}:` }).first()).toContainText(
        'Try the 1.2.1 notes too',
      )
      await expect(messages.filter({ hasText: `${TYPE} →:` }).first()).toContainText(
        'The changelog looks accurate so far.',
      )
      await expectNoErrorBanner(page)
      await shotOf(card(page), 'w31-05-card-messages')
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W31b a helper that is still working is stopped from its card', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const chat = await createChat(request)
    await openChat(page, chat.id)

    // A helper that has finished one turn and is then steered into `__hold__` — a turn that never
    // ends (one chunk and then nothing) until something aborts it, which is what the card's Stop
    // is. Steering it is also what makes the card *live* again with something to show: the child's
    // first turn reported usage, so its tokens are in the log the watcher reads.
    await sendFromComposer(page, `__agent__ ${TYPE} | Keep the changelog current`)
    const task = card(page)
    await expect(task.locator('[data-slot="task-status"]')).toHaveText('done')
    const taskId = await task.getAttribute('data-task')
    await sendFromComposer(page, `__agent_message__ ${String(taskId)} | __hold__`)

    await test.step('a running task shows its live line, what it spent, and Stop', async () => {
      await expect(task.locator('[data-slot="task-status"]')).toHaveText('running')
      // The child is streaming and calling nothing, which the client's own derivation draws as
      // "writing…" — the child's *stream*, not the parent's log, which is the whole point of
      // `watchTaskActivity`.
      await expect(task.locator('[data-slot="task-activity-line"]')).toHaveText('writing…')
      await expect(task.locator('[data-slot="task-tokens"]')).toContainText('tokens')
      await expect(
        task.getByRole('button', { name: `Stop ${TYPE} ${String(taskId)}` }),
      ).toBeVisible()
      await expectNoErrorBanner(page)
      await frameCard(page)
      await shot(page, 'w31-06-task-running-page')
      await shotOf(card(page), 'w31-06-task-running')
    })

    await test.step('Stop interrupts the child', async () => {
      await task.locator('[data-slot="task-stop"]').click()

      // The child's turn ends, and the brain announces every ended child turn as a `result` with
      // `status: idle` — so the card reads **done**. `stopped` is what `agent_stop` writes, a
      // tool only the parent *model* calls; a reader's Stop has no route that writes it. The
      // task has really stopped (its child is not running), and #346's PR records the gap.
      await expect(task.locator('[data-slot="task-status"]')).not.toHaveText('running')
      await expect(task.locator('[data-slot="task-stop"]')).toHaveCount(0)
      await expectNoErrorBanner(page)
      await shotOf(card(page), 'w31-07-task-stopped')
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W31c a described mode is a subagent type, and the agent tools are listed (#342; #346)', async ({
    page,
    consoleErrors,
  }) => {
    await page.goto('/#/settings')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

    await test.step('the editor asks for a subagent description', async () => {
      await page.getByRole('button', { name: 'Create mode' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByLabel('Subagent description')).toBeVisible()
      await expect(dialog.getByText(/subagent type/)).toBeVisible()

      // A fresh name every run: the stack's account keeps its modes, and a second run of this
      // spec would otherwise be answered with the 409 a duplicate name gets.
      const name = uniqueName('researcher')
      await dialog.getByLabel('Name').fill(name)
      await dialog.getByLabel(/My default model/).check()
      await dialog.getByLabel('Subagent description').fill('Reviews a diff for correctness bugs.')
      await shot(page, 'w31-08-mode-subagent-field')
      await dialog.getByRole('button', { name: 'Create mode' }).click()

      // The list marks it, because the difference between a preset and a kind of helper is
      // otherwise one empty field.
      const row = page.locator('li', { hasText: name }).first()
      await row.scrollIntoViewIfNeeded()
      await expect(row.locator('[data-slot="mode-subagent"]')).toHaveText('subagent type')
      await expect(row.locator('[data-slot="mode-subagent-description"]')).toContainText(
        'Reviews a diff for correctness bugs.',
      )
      await shot(page, 'w31-09-mode-subagent-type')
    })

    await test.step('Settings → Tools lists the subagent tools like any other built-in', async () => {
      // The five are registered for every deployment (#344), so the card that lists this build's
      // own tools lists them — no per-issue code, and this is what proves it against the real
      // server: the component tests cannot (the fake registers three built-ins and no agent
      // tools).
      const tools = page.locator('[data-slot="tools-list"]')
      await expect(tools).toBeVisible()
      await tools.scrollIntoViewIfNeeded()
      for (const name of ['agent', 'agent_message', 'agent_wait', 'agent_stop', 'message_parent']) {
        const row = tools.locator(`[data-slot="tool-row"][data-tool="${name}"]`)
        await expect(row).toHaveCount(1)
        await expect(row.locator('[data-slot="tool-default"]')).toContainText('allow')
      }
      await shot(page, 'w31-10-settings-tools-agent')
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W31d the card and the child’s chat in every theme, wide and narrow', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const chat = await createChat(request)
    await openChat(page, chat.id)
    await sendFromComposer(page, `__agent__ ${TYPE} | Review the release notes`)
    await expect(card(page)).toBeVisible()

    try {
      await test.step('Light, Dim and Dark at 1280', async () => {
        await page.setViewportSize({ width: 1280, height: 800 })
        for (const theme of ['light', 'dim', 'dark'] as const) {
          await setStoredTheme(request, theme)
          await page.reload()
          await openChat(page, chat.id)
          await expect(card(page)).toBeVisible()
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
          await shot(page, `w31-11-${theme}-card`)
        }
      })

      await test.step('and at 390, where the card has to wrap rather than overflow', async () => {
        await page.setViewportSize({ width: 390, height: 780 })
        for (const theme of ['light', 'dark'] as const) {
          await setStoredTheme(request, theme)
          await page.reload()
          await openChat(page, chat.id)
          await expect(card(page)).toBeVisible()
          // The document never scrolls, whatever the card does at this width: the shell owns the
          // viewport and the transcript is the one pane that scrolls (#316).
          const geometry = await page.evaluate(() => {
            const root = document.scrollingElement as HTMLElement
            return { scroll: root.scrollHeight, client: root.clientHeight }
          })
          expect(geometry.scroll).toBe(geometry.client)
          await shot(page, `w31-12-narrow-${theme}-card`)
        }
      })
    } finally {
      await page.setViewportSize({ width: 1280, height: 800 })
      await setStoredTheme(request, 'system')
    }

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
