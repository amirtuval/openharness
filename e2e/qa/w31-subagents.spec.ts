import {
  agentToolResults,
  createChat,
  deleteModeNamed,
  ensureMode,
  deleteChat,
  expect,
  expectNoErrorBanner,
  ensureDefaultModel,
  getSession,
  isRealModel,
  listChildren,
  offeredTools,
  openChat,
  QA_MODEL,
  readEvents,
  sendFromComposer,
  sendMessage,
  sessionUsage,
  setStoredTheme,
  setToolSetting,
  shot,
  shotOf,
  taskEvents,
  test,
  transcript,
  updateMode,
  waitForAnswer,
  waitForIdle,
  waitForTaskNotification,
  waitForTaskStatus,
  waitForTurnEnd,
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

/**
 * The limits the stack under test was started with (S6).
 *
 * Both have deployment defaults (3 and 10, `OPENHARNESS_MAX_AGENT_DEPTH` /
 * `OPENHARNESS_MAX_LIVE_TASKS`), and the cases that exercise them need a stack whose values
 * are small enough to reach in a scenario. The screen name of what the stack runs is
 * `QA_MAX_AGENT_DEPTH` / `QA_MAX_LIVE_TASKS`; the cases that need them lower their assertion to
 * a skip that says which variable to set, rather than starting ten helpers at a default of ten.
 */
const MAX_DEPTH = Number(process.env.QA_MAX_AGENT_DEPTH ?? '3')
const MAX_LIVE_TASKS = Number(process.env.QA_MAX_LIVE_TASKS ?? '10')

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
      // The row is labelled with the description the parent model gave — which is the child's
      // title (epic #340) — and not with the model it runs.
      await expect(group.getByRole('link')).toHaveText(DESCRIPTION)
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

    await test.step('Stop interrupts the child, and the card reads stopped', async () => {
      await task.locator('[data-slot="task-stop"]').click()

      // The child's turn ends because of the reader's `user.interrupt`, so the brain announces it
      // as a **stop** — `status: stopped` and a result that says the user stopped the helper
      // (S7; #348). Read as `idle`, the card would say **done** and the parent model would believe
      // the helper finished, which is the gap #346 and #347 both recorded.
      await expect(task.locator('[data-slot="task-status"]')).toHaveText('stopped')
      await expect(task.locator('[data-slot="task-stop"]')).toHaveCount(0)
      await expectNoErrorBanner(page)
      await shotOf(card(page), 'w31-07-task-stopped')
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W31c a described mode is a subagent type, and the agent tools are listed (#342; #346)', async ({
    page,
    request,
    consoleErrors,
  }) => {
    await page.goto('/#/settings')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

    await test.step('the editor asks for a subagent description', async () => {
      // A **fixed** name, cleared first: the account is the stack's own and keeps its modes, so a
      // unique name per run would leak one each time and meet the twenty-mode limit (#348's
      // re-runs did exactly that), while a fixed one reuses the row it made last time. The reload
      // is for the row this tab still holds: it was deleted through the API, and a person who
      // deleted from another tab would see the list without it.
      const name = 'qa-mode-field'
      await deleteModeNamed(request, name)
      await page.reload()
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

      await page.getByRole('button', { name: 'Create mode' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByLabel('Subagent description')).toBeVisible()
      await expect(dialog.getByText(/subagent type/)).toBeVisible()
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

  test('W31e two helpers work at once: two cards, and both results reach the parent (A1)', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const chat = await createChat(request)
    await openChat(page, chat.id)
    const cards = page.locator('[data-slot="task-card"]')

    await test.step('two helpers are started and both are live at once', async () => {
      await sendFromComposer(page, `__agent__ ${TYPE} | __slow__ list three fruits`)
      await expect(cards).toHaveCount(1)
      await expect(cards.first().locator('[data-slot="task-status"]')).toHaveText('running')
      // The live line is the child's own stream, so a card that shows one is a card whose child
      // really is being followed (#345).
      await expect(cards.first().locator('[data-slot="task-activity-line"]')).toBeVisible()
      await expectNoErrorBanner(page)
      await shot(page, 'w31-13-two-helpers-one')

      await sendFromComposer(page, `__agent__ ${TYPE} | __slow__ list three colours`)
      await expect(cards).toHaveCount(2)
      await expect(cards.nth(1).locator('[data-slot="task-status"]')).toHaveText('running')
      await shot(page, 'w31-14-two-helpers-running')
    })

    await test.step('the reader keeps talking to the parent while both run', async () => {
      // The parent is idle between its two `agent` calls, so this is an ordinary message: the
      // point is that two helpers running do not stop the chat being a chat (S1).
      await sendFromComposer(page, 'still there?')
      await waitForAnswer(page, 'still there?')
      await expectNoErrorBanner(page)
    })

    await test.step('both cards finish, each with its own result', async () => {
      await expect(cards.first().locator('[data-slot="task-status"]')).toHaveText('done', {
        timeout: 60_000,
      })
      await expect(cards.nth(1).locator('[data-slot="task-status"]')).toHaveText('done', {
        timeout: 60_000,
      })
      // Each card is its own task: a description derived from its own prompt, and a result that
      // is its own child's final message (the mock's slow reply, counted off).
      await expect(cards.first().locator('[data-slot="task-description"]')).toContainText('fruits')
      await expect(cards.nth(1).locator('[data-slot="task-description"]')).toContainText('colours')
      await cards.first().getByRole('button', { name: 'Result' }).click()
      await expect(cards.first().locator('[data-slot="task-result"]')).toContainText('part 40/40')
      await cards.nth(1).getByRole('button', { name: 'Result' }).click()
      await expect(cards.nth(1).locator('[data-slot="task-result"]')).toContainText('part 40/40')
      // Both tasks ended with an `idle` delivery — two cards, two results, and no status left
      // `running` (S4).
      const statuses = (await taskEvents(request, chat.id))
        .filter((event) => event.type === 'session.task_status')
        .map((event) => event.status)
      expect(statuses.filter((status) => status === 'idle')).toHaveLength(2)
      await expectNoErrorBanner(page)
      await shot(page, 'w31-15-two-helpers-done')
    })

    await test.step('the sidebar counts both under the chat, and settles', async () => {
      const group = sidebarGroup(page)
      await expect(group).toBeVisible()
      await expect(group.getByRole('button')).toHaveText(/2 subagents/)
      // Both helpers have finished, so nothing is working: the group's running count and its coral
      // dot have to move with the cards, or the sidebar claims work is in flight when none is
      // (#374 — the report the shell hears was keyed on how *many* tasks there are, so a helper
      // finishing changed nothing it could see).
      await expect(group.getByRole('button')).toHaveText(/^2 subagents$/)
      await expect(group.locator('[data-slot="chat-children-running"]')).toHaveCount(0)
      await expectNoErrorBanner(page)
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W31f a result reaches a busy, an idle and a waiting parent (A2)', async ({ request }) => {
    /** The last status event before `seq` — what the parent was doing when the news arrived. */
    const statusBefore = async (sessionId: string, seq: number): Promise<string | undefined> => {
      const log = await readEvents(request, sessionId)
      const before = log
        .filter(
          (event) => String(event.type).startsWith('session.status_') && Number(event.seq) < seq,
        )
        .at(-1)
      return before === undefined ? undefined : String(before.type)
    }

    /** What the session's `agent_wait` call was finally answered with — its own result. */
    const waitResultText = async (sessionId: string, timeoutMs = 60_000): Promise<string> => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const log = await readEvents(request, sessionId)
        const call = log.find(
          (event) => event.type === 'agent.tool_use' && event.name === 'agent_wait',
        )
        const result = log.find(
          (event) => event.type === 'agent.tool_result' && event.tool_use_id === call?.id,
        )
        if (result !== undefined) {
          return ((result.content ?? []) as { text?: string }[])
            .map((block) => block.text ?? '')
            .join('')
        }
        if (Date.now() > deadline) {
          throw new Error(`session ${sessionId} never resolved its agent_wait call`)
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }

    await test.step('idle: the news starts a parent turn of its own', async () => {
      const chat = await createChat(request)
      await sendMessage(request, chat.id, `__agent__ ${TYPE} | report the idle case`)
      await waitForTaskNotification(request, chat.id, 'result')
      const notification = (await taskEvents(request, chat.id)).find(
        (event) => event.type === 'session.task_notification',
      )
      expect(notification, 'the child reported').toBeDefined()
      // The parent was idle when it arrived — and its log holds a turn after it that nobody
      // asked for: a notification is a queued event, so a signal starts the turn that folds it
      // in (S4).
      expect(await statusBefore(chat.id, notification?.seq ?? 0)).toBe('session.status_idle')
      await waitForIdle(request, chat.id)
      const log = await readEvents(request, chat.id)
      const after = log.filter(
        (event) =>
          String(event.type) === 'session.status_running' &&
          Number(event.seq) > (notification?.seq ?? 0),
      )
      expect(after, 'the notification started a turn').not.toHaveLength(0)
    })

    await test.step('busy: the news waits for the request in flight', async () => {
      const chat = await createChat(request)
      // The test background task reports after two seconds; the parent's own reply is a
      // ten-second one, so the news lands while a request is open.
      const started = await sendMessage(request, chat.id, '__task__ 2000')
      await waitForTurnEnd(request, chat.id, started)
      await sendMessage(request, chat.id, '__slow__ a long reply while the task works')
      await waitForTaskNotification(request, chat.id, undefined, 1)
      const notification = (await taskEvents(request, chat.id)).find(
        (event) => event.type === 'session.task_notification',
      )
      // The turn was open: the news arrived *during* a request, so it is steering for the next
      // one rather than the start of a turn (S4).
      expect(await statusBefore(chat.id, notification?.seq ?? 0)).toBe('session.status_running')
      await waitForIdle(request, chat.id, 60_000)
      // And it did reach the model: the notification is claimed by a request, which is what
      // "folded in" means in the log (P4).
      const claimed = (await readEvents(request, chat.id)).some((event) =>
        ((event.consumes ?? []) as unknown[]).includes(notification?.id ?? ''),
      )
      expect(claimed, 'a request claimed the queued notification').toBe(true)
    })

    await test.step('waiting: the news is the agent_wait result', async () => {
      const chat = await createChat(request)
      const armed = await sendMessage(request, chat.id, '__task__ 2000')
      await waitForTurnEnd(request, chat.id, armed)
      await sendMessage(request, chat.id, '__wait__ 30')
      // The wait was open when the news arrived; the call's result *is* that news (S5), framed
      // as data rather than as instructions.
      const text = await waitResultText(chat.id)
      expect(text, 'the framed notification is the result').toContain('background task')
    })

    await test.step('waiting: the deadline resolves it, naming what is still running', async () => {
      const chat = await createChat(request)
      await sendMessage(request, chat.id, '__wait__ 1')
      const text = await waitResultText(chat.id)
      expect(text).toContain('The wait timed out')
    })

    await test.step('a user message resolves it instead', async () => {
      const chat = await createChat(request)
      const waiting = await sendMessage(request, chat.id, '__wait__ 60')
      // The wait has to be *open* before the message lands: the turn ends `waiting_on_tasks`,
      // and the session is idle while the call is still unanswered (S5).
      await waitForTurnEnd(request, chat.id, waiting)
      await sendMessage(request, chat.id, 'never mind, do something else')
      expect(await waitResultText(chat.id)).toBe('The user sent a message instead.')
    })
  })

  test('W31p a helper parked in a wait is stopped from its card, and reads stopped (A9; #373)', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const chat = await createChat(request)
    await openChat(page, chat.id)
    // The child calls `agent_wait` itself, so it is idle *and* working: the card's fifth status.
    await sendFromComposer(page, `__agent__ ${TYPE} | __wait__ 120 wait for something to report`)
    const task = card(page)
    await expect(task.locator('[data-slot="task-status"]')).toHaveText('waiting')
    await expect(task.locator('[data-slot="task-stop"]')).toBeVisible()
    await shotOf(task, 'w31-23-task-waiting')

    // The reader's Stop is the child's `user.interrupt`, and a paused child is still working: the
    // stop has to be recorded in the child's own log, its wait resolved, and the card read
    // **stopped** rather than the `done` an `idle` delivery draws (S7; #373).
    await task.locator('[data-slot="task-stop"]').click()
    await expect(task.locator('[data-slot="task-status"]')).toHaveText('stopped', {
      timeout: 30_000,
    })
    await waitForTaskStatus(request, chat.id, 'stopped')
    // Nothing moves it back afterwards: the newest task status is the stop, however long the
    // child's wait had left to run (the #371 caveat, closed).
    await page.waitForTimeout(2000)
    const statuses = (await taskEvents(request, chat.id))
      .filter((event) => event.type === 'session.task_status')
      .map((event) => event.status)
    expect(statuses.at(-1), 'the newest status is still stopped').toBe('stopped')
    await expectNoErrorBanner(page)
    await shotOf(card(page), 'w31-24-task-waiting-stopped')

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W31g the reader steers, interrupts and continues a child (A5)', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const chat = await createChat(request)
    await openChat(page, chat.id)
    await sendFromComposer(page, `__agent__ ${TYPE} | Keep the changelog current`)
    await expect(card(page).locator('[data-slot="task-status"]')).toHaveText('done')
    await card(page).getByRole('link', { name: 'Open' }).click()
    await expect(page).toHaveURL(/#\/s\/sesn_/)
    await expectNoErrorBanner(page)

    await test.step('the child is a chat the reader can steer', async () => {
      await sendFromComposer(page, 'one more pass over the tail')
      await expect(
        page.getByRole('log', { name: 'Conversation' }).getByText('one more pass over the tail'),
      ).toBeVisible()
      await expectNoErrorBanner(page)
      await shot(page, 'w31-16-child-steered')
    })

    await test.step('Stop interrupts the child, and the reader can carry on', async () => {
      // A turn that never ends on its own — the only thing a reader's Stop has to stop.
      await sendFromComposer(page, '__hold__ keep going')
      const stop = page.getByRole('button', { name: 'Stop', exact: true })
      await expect(stop).toBeVisible()
      await stop.click()
      await expect(page.getByText('Interrupted')).toBeVisible()
      await expectNoErrorBanner(page)
      await shot(page, 'w31-17-child-interrupted')

      // The child is a chat like any other: the next message runs another turn.
      await sendFromComposer(page, 'carry on then')
      await waitForAnswer(page, 'carry on then')
      await expectNoErrorBanner(page)
    })

    await test.step('the breadcrumb leads back to the parent', async () => {
      await page.locator('[data-slot="breadcrumb-link"]').first().click()
      await openChat(page, chat.id)
      await expectNoErrorBanner(page)
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W31h a child cannot ask: an ask policy is denied, and no prompt appears (A6)', async ({
    page,
    request,
    consoleErrors,
  }) => {
    // The echo tool is this build's own, and a person may set it to `ask`. In a **child** that
    // policy cannot be honoured, so the call is refused at once with the sentence S1 fixes and
    // the turn carries on — and nothing on either client is ever offered a confirmation.
    await setToolSetting(request, 'echo', { enabled: true, policy: 'ask' })
    try {
      const chat = await createChat(request)
      await openChat(page, chat.id)
      await sendFromComposer(page, `__agent__ ${TYPE} | try the echo tool`)
      await expect(card(page).locator('[data-slot="task-status"]')).toHaveText('done')
      const child = (await listChildren(request, chat.id))[0]
      expect(child, 'the helper has a child session').toBeDefined()

      await card(page).getByRole('link', { name: 'Open' }).click()
      await expect(page).toHaveURL(/#\/s\/sesn_/)
      await sendFromComposer(page, '__tool__ hello there')

      const conversation = page.getByRole('log', { name: 'Conversation' })
      await expect(
        conversation.getByText(
          "This tool needs the user's approval, which a non-interactive run cannot ask for.",
        ),
      ).toBeVisible()
      // The turn carried on rather than pausing: no approval prompt, no sign of `ask_user`.
      await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Deny' })).toHaveCount(0)
      await expectNoErrorBanner(page)
      await shot(page, 'w31-18-child-ask-denied')

      // The log itself: the call is `is_error` under the permission it was evaluated at, and the
      // request the child was offered held no `ask_user` (S1).
      const log = await readEvents(request, child?.id ?? '')
      const call = log.find((event) => event.type === 'agent.tool_use')
      const result = log.find(
        (event) => event.type === 'agent.tool_result' && event.tool_use_id === call?.id,
      )
      expect(call?.evaluated_permission).toBe('ask')
      expect(result?.is_error).toBe(true)
      expect(await offeredTools(request, child?.id ?? '')).not.toContain('ask_user')
    } finally {
      await setToolSetting(request, 'echo', { enabled: true, policy: 'allow' })
    }

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W31i the types on offer, an unknown one, and an edit between two starts (A7)', async ({
    request,
  }) => {
    // A mode is usable only when its model can be used, and a **mock** stack has no provider
    // key at all — so every mode here follows "my default model", the same spelling the CLI
    // spec uses, and the account is given one first.
    await ensureDefaultModel(request)
    // Fixed names, brought to the state each case needs: the account is the QA stack's own and a
    // user holds at most twenty modes, so a spec that created one per run would fail on the
    // twenty-first (and a re-run would meet its own 409) — `ensureMode` is the re-runnable form.
    const described = 'qa-reviewer'
    const describedMode = await ensureMode(request, {
      name: described,
      model: 'my-default-model',
      subagent_description: 'Reviews a diff for correctness bugs.',
    })
    const plain = 'qa-preset'
    await ensureMode(request, {
      name: plain,
      model: 'my-default-model',
      subagent_description: null,
    })

    await test.step('an unknown type is answered with the types that exist', async () => {
      const chat = await createChat(request)
      const asked = await sendMessage(request, chat.id, `__agent__ no-such-type | do the thing`)
      await waitForTurnEnd(request, chat.id, asked)
      const [refusal] = await agentToolResults(request, chat.id)
      expect(refusal?.isError).toBe(true)
      // `general-purpose` first, and only the modes that carry a description: the plain preset
      // is a mode, not a kind of helper (S2).
      expect(refusal?.text).toContain('general-purpose')
      expect(refusal?.text).toContain(described)
      expect(refusal?.text).not.toContain(plain)
      const listed = refusal?.text.slice(refusal.text.indexOf(':') + 1) ?? ''
      expect(listed.trim().split(',')[0]?.trim()).toBe('general-purpose')
    })

    await test.step('a mode whose model cannot be used is an is_error the model acts on', async () => {
      // A mode's model is only usable when the account has a key for its provider, and a mock
      // stack has none — so every mode here is refused, with a sentence that tells the model what
      // to do instead rather than throwing (S2). The start that *does* work is `general-purpose`.
      const chat = await createChat(request)
      const refusedStart = await sendMessage(
        request,
        chat.id,
        `__agent__ ${described} | start with a mode`,
      )
      await waitForTurnEnd(request, chat.id, refusedStart)
      const [refused] = await agentToolResults(request, chat.id)
      expect(refused?.isError).toBe(true)
      expect(refused?.text).toContain(described)
      expect(refused?.text).toContain('cannot be started')

      // The built-in type always works: it is the parent continued, so it needs no mode.
      const working = await sendMessage(request, chat.id, `__agent__ ${TYPE} | do it here`)
      await waitForTurnEnd(request, chat.id, working)
      await waitForTaskStatus(request, chat.id, 'idle')
      const results = await agentToolResults(request, chat.id)
      expect(results.at(-1)?.isError ?? false).toBe(false)
      expect(results.at(-1)?.text).toContain('Started general-purpose')
    })

    await test.step('an edit between two calls changes what the next one is offered', async () => {
      // The mock stack has no provider key, so **no** mode's model is usable here (a type's
      // availability is a credential question) — but the listing is not: a mode with no
      // description is a preset, and the resolver runs per call, so describing one between two
      // `agent` calls makes it a type on the **second** (M6's live-follow, S2; #342).
      const chat = await createChat(request)
      const late = 'qa-late-type'
      const mode = await ensureMode(request, {
        name: late,
        model: 'my-default-model',
        subagent_description: null,
      })

      const firstAsk = await sendMessage(request, chat.id, '__agent__ no-such-type | who is there?')
      await waitForTurnEnd(request, chat.id, firstAsk)
      const [before] = await agentToolResults(request, chat.id)
      expect(before?.isError).toBe(true)
      expect(before?.text).toContain('general-purpose')
      expect(before?.text).not.toContain(late)

      await updateMode(request, mode.id, { subagent_description: 'Handles the late case.' })
      const secondAsk = await sendMessage(request, chat.id, '__agent__ no-such-type | and now?')
      await waitForTurnEnd(request, chat.id, secondAsk)
      const results = await agentToolResults(request, chat.id)
      expect(results.at(-1)?.text, 'the edited mode is a type on the next call').toContain(late)
    })

    await test.step('the agent tools are the ones a settings screen can see', async () => {
      const chat = await createChat(request)
      const plainTurn = await sendMessage(request, chat.id, 'hello')
      await waitForTurnEnd(request, chat.id, plainTurn)
      const offered = await offeredTools(request, chat.id)
      for (const name of ['agent', 'agent_message', 'agent_wait', 'agent_stop']) {
        expect(offered, `a top-level chat is offered ${name}`).toContain(name)
      }
      // The child's half is not a top-level chat's tool.
      expect(offered).not.toContain('message_parent')
      // A type started from a mode leaves the mode as it was — the settings screen reads it.
      expect((await request.get(`/v1/me/modes/${describedMode.id}`)).status()).toBe(200)
    })
  })

  test('W31j nesting to the max depth, and the live-task cap (A8)', async ({ request }) => {
    test.skip(
      MAX_DEPTH > 2,
      'set QA_MAX_AGENT_DEPTH=2 on the stack so a grandchild is already at the limit',
    )
    const chat = await createChat(request)

    await test.step('the deepest allowed child is not offered the parent-side tools', async () => {
      const levelOne = await sendMessage(request, chat.id, `__agent__ ${TYPE} | level one`)
      await waitForTurnEnd(request, chat.id, levelOne)
      await waitForTaskStatus(request, chat.id, 'idle')
      const child = (await listChildren(request, chat.id))[0]
      expect((await getSession(request, child?.id ?? '')).depth).toBe(1)

      // A child at depth 1 may still start one (the cap is exclusive of the limit), so the
      // grandchild sits at depth 2 — the limit itself.
      const levelTwo = await sendMessage(request, child?.id ?? '', `__agent__ ${TYPE} | level two`)
      await waitForTurnEnd(request, child?.id ?? '', levelTwo)
      await waitForTaskStatus(request, child?.id ?? '', 'idle')
      const grandchild = (await listChildren(request, child?.id ?? ''))[0]
      expect((await getSession(request, grandchild?.id ?? '')).depth).toBe(2)

      const offered = await offeredTools(request, grandchild?.id ?? '')
      expect(offered, 'the deepest child may not nest further').not.toContain('agent')
      expect(offered).not.toContain('agent_message')
      expect(offered).not.toContain('agent_wait')
      expect(offered).not.toContain('agent_stop')
      // It is still a child, so it can talk to the chat above it.
      expect(offered).toContain('message_parent')
    })

    await test.step('the live-task cap refuses with an is_error', async () => {
      test.skip(
        MAX_LIVE_TASKS > 2,
        'set QA_MAX_LIVE_TASKS=2 on the stack so the cap is reachable in a scenario',
      )
      const busy = await createChat(request)
      const held: string[] = []
      try {
        for (let index = 0; index < MAX_LIVE_TASKS; index += 1) {
          const hold = await sendMessage(
            request,
            busy.id,
            `__agent__ ${TYPE} | __hold__ helper ${String(index)}`,
          )
          await waitForTurnEnd(request, busy.id, hold)
        }
        const children = await listChildren(request, busy.id)
        expect(children, 'the cap allows exactly its number of live helpers').toHaveLength(
          MAX_LIVE_TASKS,
        )
        held.push(...children.map((child) => child.id))

        const tooMany = await sendMessage(request, busy.id, `__agent__ ${TYPE} | one too many`)
        await waitForTurnEnd(request, busy.id, tooMany)
        const results = await agentToolResults(request, busy.id)
        const refusal = results.at(-1)
        expect(refusal?.isError).toBe(true)
        expect(refusal?.text).toContain('which is the limit')
        expect(await listChildren(request, busy.id)).toHaveLength(MAX_LIVE_TASKS)
      } finally {
        // Leave the stack as it was found: a held turn would otherwise run for ever, and hold
        // one of the deployment's concurrency slots for every scenario after this one.
        for (const child of held) {
          await request.post(`/v1/sessions/${child}/events`, {
            data: { events: [{ type: 'user.interrupt' }] },
          })
        }
        await deleteChat(request, busy.id)
      }
    })
  })

  test('W31k a stopped parent leaves its helpers running; a rewind stops one (A9, A10)', async ({
    request,
  }) => {
    await test.step('interrupting the parent does not stop its helper', async () => {
      const chat = await createChat(request)
      const held = await sendMessage(request, chat.id, `__agent__ ${TYPE} | __hold__ keep working`)
      await waitForTurnEnd(request, chat.id, held)
      const child = (await listChildren(request, chat.id))[0]

      // The parent's own reply, interrupted: a person's Stop is about the turn they are looking
      // at, not about the tree below it (S7).
      await sendMessage(request, chat.id, '__slow__ a long reply')
      await new Promise((resolve) => setTimeout(resolve, 1000))
      await request.post(`/v1/sessions/${chat.id}/events`, {
        data: { events: [{ type: 'user.interrupt' }] },
      })
      await waitForIdle(request, chat.id)
      expect(
        (await getSession(request, child?.id ?? '')).status,
        'the helper is still working',
      ).toBe('running')
      const statuses = (await taskEvents(request, chat.id)).map((event) => event.status)
      expect(statuses).not.toContain('stopped')
      await request.post(`/v1/sessions/${child?.id ?? ''}/events`, {
        data: { events: [{ type: 'user.interrupt' }] },
      })
    })

    await test.step('a rewind past the agent call stops the helper it started (S7)', async () => {
      const chat = await createChat(request)
      const first = await sendMessage(request, chat.id, `__agent__ ${TYPE} | __hold__ rewind me`)
      await waitForTurnEnd(request, chat.id, first)
      const child = (await listChildren(request, chat.id))[0]

      // Edit and resend: the rewind and the edited message are one batch, so the chat restarts
      // from the edit — and the helper the taken-back call started is work the reader said did
      // not happen.
      const response = await request.post(`/v1/sessions/${chat.id}/events`, {
        data: {
          events: [
            { type: 'session.rewind', from_seq: first },
            { type: 'user.message', content: [{ type: 'text', text: 'never mind' }] },
          ],
        },
      })
      expect(response.status(), await response.text()).toBe(200)
      await waitForIdle(request, chat.id)

      const statuses = (await taskEvents(request, chat.id)).map((event) => event.status)
      expect(statuses, 'the helper was written stopped').toContain('stopped')
      // And it stays stopped: nothing the child says afterwards may move the card again — the
      // news from a task the log no longer names is dropped (S7, the #370 follow-up).
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const after = (await taskEvents(request, chat.id)).filter(
        (event) => event.status !== undefined,
      )
      expect(after.at(-1)?.status, 'the newest status is still stopped').toBe('stopped')
      expect((await getSession(request, child?.id ?? '')).status).toBe('idle')
    })
  })

  test('W31l deleting a chat takes its whole tree, and usage covers it (A11, A14)', async ({
    request,
  }) => {
    test.skip(MAX_DEPTH < 2, 'set QA_MAX_AGENT_DEPTH=2 on the stack so three levels exist')
    const chat = await createChat(request)
    const firstLevel = await sendMessage(request, chat.id, `__agent__ ${TYPE} | level one`)
    await waitForTurnEnd(request, chat.id, firstLevel)
    await waitForTaskStatus(request, chat.id, 'idle')
    const child = (await listChildren(request, chat.id))[0]
    const secondLevel = await sendMessage(request, child?.id ?? '', `__agent__ ${TYPE} | level two`)
    await waitForTurnEnd(request, child?.id ?? '', secondLevel)
    await waitForTaskStatus(request, child?.id ?? '', 'idle')
    const grandchild = (await listChildren(request, child?.id ?? ''))[0]
    expect(grandchild, 'three levels of the tree').toBeDefined()

    await test.step("a chat's usage includes its descendants (S8)", async () => {
      const usage = await sessionUsage(request, chat.id)
      expect(
        usage.descendants.totals.output_tokens,
        'the helpers’ tokens are in the bill',
      ).toBeGreaterThan(0)
      // The per-user read is unchanged: it has no `descendants` of its own.
      const me = await request.get('/v1/me/usage')
      expect(me.status()).toBe(200)
      expect(Object.keys((await me.json()) as object)).not.toContain('descendants')
    })

    await test.step('deleting the parent deletes every descendant (S7)', async () => {
      await deleteChat(request, chat.id)
      for (const sessionId of [chat.id, child?.id ?? '', grandchild?.id ?? '']) {
        expect((await request.get(`/v1/sessions/${sessionId}`)).status(), sessionId).toBe(404)
      }
    })
  })

  test('W31m a chat that never used subagents is unchanged (A17)', async ({ request }) => {
    const chat = await createChat(request)
    const ordinary = await sendMessage(request, chat.id, 'an ordinary message')
    await waitForTurnEnd(request, chat.id, ordinary)
    const types = (await readEvents(request, chat.id)).map((event) => String(event.type))
    expect(types).toContain('agent.message')
    expect(types.filter((type) => type.startsWith('session.task_'))).toHaveLength(0)

    await test.step('turning the agent tools off takes them out of the request', async () => {
      const names = ['agent', 'agent_message', 'agent_wait', 'agent_stop'] as const
      for (const name of names) {
        await setToolSetting(request, name, { enabled: false, policy: 'allow' })
      }
      try {
        const turnedOff = await createChat(request)
        const withoutTools = await sendMessage(request, turnedOff.id, 'no tools for you')
        await waitForTurnEnd(request, turnedOff.id, withoutTools)
        const offered = await offeredTools(request, turnedOff.id)
        for (const name of names) {
          expect(offered, `${name} is not offered`).not.toContain(name)
        }
        // Everything else is still there: one switch does not empty the offer.
        expect(offered.length).toBeGreaterThan(0)
      } finally {
        for (const name of names) {
          await setToolSetting(request, name, { enabled: true, policy: 'allow' })
        }
      }
    })
  })
})

/**
 * The real-model half of the pass (A1, A4, A7 with a usable type).
 *
 * The mock's markers drive a scripted model; a real provider answers in its own words and calls
 * the tools because it decided to, which is the one thing no mock can prove. Everything here is
 * skipped unless `QA_MODEL` names a real model (`isRealModel`), and it runs against a stack
 * **without** `OPENHARNESS_TEST_MODEL=mock` — the same gate the other `isRealModel` cases use.
 *
 * The prompts are explicit about the tools to call: a QA pass is evidence that the tools work
 * end to end, not a study of how a model chooses them.
 */
test.describe('W31 real model (A1, A4)', () => {
  test.skip(
    !isRealModel,
    'set QA_MODEL to a real provider/model and run the stack without the mock',
  )

  test('W31n two helpers of different types in one chat (A1)', async ({
    page,
    request,
    consoleErrors,
  }) => {
    // A type is a mode with a description, and on a real stack the account has the key its model
    // needs — so this is also A7's "a described mode is startable" case.
    const name = 'qa-real-researcher'
    await ensureMode(request, {
      name,
      model: QA_MODEL,
      subagent_description: 'Looks something small up and reports it in one line.',
    })

    const chat = await createChat(request)
    await openChat(page, chat.id)
    await sendFromComposer(
      page,
      `Call the agent tool TWICE, in this one turn, starting two background subagents. ` +
        `The first call: type "${name}", prompt "Reply with exactly: ALPHA". ` +
        `The second call: type "general-purpose", prompt "Reply with exactly: BETA". ` +
        `Then reply to me with the single word STARTED.`,
    )

    await test.step('two helpers start, of two different types', async () => {
      await expect(page.locator('[data-slot="task-card"]')).toHaveCount(2, { timeout: 120_000 })
      const types = await page
        .locator('[data-slot="task-card"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-type')))
      expect(types).toContain(name)
      expect(types).toContain('general-purpose')
      await expectNoErrorBanner(page)
      await shot(page, 'w31-19-real-two-helpers')
    })

    await test.step('the reader keeps talking to the parent while they run', async () => {
      await sendFromComposer(page, 'Anything else I should know? Answer briefly.')
      await expect
        .poll(async () => await page.locator('article[data-role="agent"]').count(), {
          timeout: 120_000,
        })
        .toBeGreaterThan(1)
      await expectNoErrorBanner(page)
    })

    await test.step('both results reach the parent, which uses them', async () => {
      const cards = page.locator('[data-slot="task-card"]')
      for (let index = 0; index < 2; index += 1) {
        await expect(cards.nth(index).locator('[data-slot="task-status"]')).toHaveText(
          /done|failed/,
          { timeout: 240_000 },
        )
      }
      // A real model's two helpers each said something, and both turned up in the parent's own
      // words — which is what "the parent uses them" means.
      await expect
        .poll(
          async () => {
            const text = (await transcript(page)).join('\n')
            return text.includes('ALPHA') && text.includes('BETA')
          },
          { timeout: 240_000, message: 'the parent never used both results' },
        )
        .toBe(true)
      // What they spent is in the bill (S8).
      await expect(page.locator('[data-slot="session-descendants"]')).toContainText(/subagents/)
      await expectNoErrorBanner(page)
      await shot(page, 'w31-20-real-parent-used-both')
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W31o a finished helper is continued with agent_message (A4)', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const chat = await createChat(request)
    await openChat(page, chat.id)
    await sendFromComposer(
      page,
      'Call the agent tool once, with type "general-purpose", prompt "Reply with exactly: FIRST".',
    )
    await expect(card(page).locator('[data-slot="task-status"]')).toHaveText(/done|failed/, {
      timeout: 240_000,
    })
    const taskId = await card(page).getAttribute('data-task')
    expect(taskId).toBeTruthy()

    // The parent continues a child that already reported: the same card, a second result, and the
    // child's own context intact (its prompt is still in its log).
    await sendFromComposer(
      page,
      `Now call agent_message with task_id ${String(taskId)} and text ` +
        `"Reply with exactly: SECOND".`,
    )
    // Two results for one task is "the same card, continued" — and a second `user.message` in the
    // child's own log is the proof that its context was carried on rather than restarted (S5).
    await waitForTaskNotification(request, chat.id, 'result', 2, 240_000)
    const child = (await listChildren(request, chat.id))[0]
    const childLog = await readEvents(request, child?.id ?? '')
    const prompts = childLog.filter((event) => event.type === 'user.message')
    expect(prompts.length, "the child's context was continued, not replaced").toBeGreaterThan(1)
    await expect
      .poll(
        async () => {
          const results = await taskEvents(request, chat.id)
          const newest = results.filter((event) => event.kind === 'result').at(-1)
          return newest?.text ?? ''
        },
        { timeout: 240_000, message: 'the continued helper never reported SECOND' },
      )
      .toContain('SECOND')
    await expectNoErrorBanner(page)
    await shot(page, 'w31-21-real-child-continued')

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
