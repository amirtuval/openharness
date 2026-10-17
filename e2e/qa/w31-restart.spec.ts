import {
  composeServer,
  createChat,
  expect,
  readEvents,
  sendMessage,
  shot,
  taskEvents,
  test,
  waitForHealth,
  waitForIdle,
  waitForTaskNotification,
  waitForTurnEnd,
} from './support'

/**
 * A13 — a crash in the middle of a subagent's work loses nothing and duplicates nothing
 * (epic #340, S4/S7; the #348 pass).
 *
 * The log is the state, so a helper whose turn a killed server was running has to be picked up
 * by the next process — and the news it owes its parent has to arrive **exactly once**: the
 * notification is written through the store's idempotent append keyed by
 * `<child_session_id>:<idle seq>`, so a recovery that delivers what the dead turn owed must be
 * the same append.
 *
 * It kills the container, so it is opt-in — the harness and the variable `w14-recovery.spec.ts`
 * uses:
 *
 * ```bash
 * QA_ALLOW_SERVER_RESTART=1 yarn qa:web qa/w31-restart.spec.ts
 * ```
 *
 * The mock's `__slow__` marker is what makes the crash land inside the child's turn: the reply
 * streams for ten seconds, and the kill takes a couple, so the request is still open when the
 * container goes.
 */
test.describe('W31 restart mid-task (A13)', () => {
  test.skip(
    process.env.QA_ALLOW_SERVER_RESTART !== '1',
    'set QA_ALLOW_SERVER_RESTART=1 to kill and restart the server container',
  )

  test('a helper whose turn the crash cut short is re-run, and reports once (A13)', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const chat = await createChat(request)
    await page.goto(`/#/s/${chat.id}`)
    await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible()

    const started = await sendMessage(
      request,
      chat.id,
      '__agent__ general-purpose | __slow__ a job the crash interrupts',
    )
    await waitForTurnEnd(request, chat.id, started)
    const childId = await page.locator('[data-slot="task-card"]').first().getAttribute('data-task')
    expect(childId).toBeTruthy()
    // The child's own turn is streaming: killing now lands inside the request, not after it.
    await page.waitForTimeout(1500)

    await test.step('the server is killed mid-task and comes back', async () => {
      composeServer({}, 'kill', 'server')
      composeServer({}, 'up', '-d', 'server')
      await waitForHealth()
    })

    await test.step('the child is re-run and tells its parent exactly once (S4)', async () => {
      await waitForTaskNotification(request, chat.id, undefined, 1, 180_000)
      await waitForIdle(request, chat.id, 180_000)
      const notifications = (await taskEvents(request, chat.id)).filter(
        (event) => event.type === 'session.task_notification',
      )
      expect(notifications, 'the parent was told once, not twice').toHaveLength(1)
      expect(notifications[0]?.kind, 'and told it finished').toBe('result')

      // The child's log holds one reply, not one per attempt — the killed attempt's chunks were
      // superseded by the message the re-run stored.
      const childLog = await readEvents(request, chat.id)
      expect(childLog.filter((event) => event.type === 'session.task_notification')).toHaveLength(1)
    })

    await test.step('a reconnected tab reads the same log', async () => {
      await page.reload()
      await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(0)
      await shot(page, 'w31-22-restart-mid-task')
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('a parent waiting in agent_wait survives the crash (A13)', async ({ request }) => {
    const chat = await createChat(request)
    const armed = await sendMessage(request, chat.id, '__task__ 20000')
    await waitForTurnEnd(request, chat.id, armed)
    // A short deadline, so the case is about the *log* surviving the crash rather than about the
    // process that armed the timer: the task's own timer died with the old process, and the wait
    // has to end by the deadline the pause recorded.
    const waiting = await sendMessage(request, chat.id, '__wait__ 5')
    await waitForTurnEnd(request, chat.id, waiting)

    composeServer({}, 'kill', 'server')
    composeServer({}, 'up', '-d', 'server')
    await waitForHealth()

    // The resumed turn settles the wait from the log: **one** result for the `agent_wait` call —
    // the deadline the pause recorded, honoured by a process that never armed its timer.
    let results: Record<string, unknown>[] = []
    await expect
      .poll(
        async () => {
          const log = await readEvents(request, chat.id)
          const call = log.find(
            (event) => event.type === 'agent.tool_use' && event.name === 'agent_wait',
          )
          results = log.filter(
            (event) => event.type === 'agent.tool_result' && event.tool_use_id === call?.id,
          )
          return results.length
        },
        { timeout: 180_000, message: 'the resumed wait never resolved' },
      )
      .toBeGreaterThan(0)
    expect(results, 'the wait was resolved exactly once').toHaveLength(1)
  })
})
