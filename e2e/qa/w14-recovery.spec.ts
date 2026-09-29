import {
  LONG_REPLY_END,
  LONG_REPLY_PROMPT,
  QA_MODEL,
  composeServer,
  conversation,
  createAgent,
  createSession,
  eventTypes,
  expect,
  isRealModel,
  lastAgentText,
  openChat,
  readEvents,
  sendFromComposer,
  shot,
  status,
  test,
  uniqueName,
  waitForAnswer,
  waitForHealth,
} from './support'

/**
 * W14 — the server dying in the middle of a stream.
 *
 * The log is the state, so a turn whose server was killed half-way has to be re-run by the next
 * process: the same `user.message` is answered, exactly once, with no half-written reply left
 * behind and no session stuck in `running`. This is the property that makes the architecture
 * worth its complexity, and it is checked here against a real provider as well as the mock.
 *
 * It kills the container, so it is opt-in: `QA_ALLOW_SERVER_RESTART=1`.
 */
test.describe('W14 crash recovery', () => {
  test.skip(
    process.env.QA_ALLOW_SERVER_RESTART !== '1',
    'set QA_ALLOW_SERVER_RESTART=1 to kill and restart the server container',
  )

  test('W14 a turn the server died in the middle of is re-run and completed', async ({
    page,
    request,
  }) => {
    const agent = await createAgent(request, {
      name: uniqueName('QA W14'),
      model: QA_MODEL,
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)

    const prompt = isRealModel ? LONG_REPLY_PROMPT : '__slow__ a long reply'
    await sendFromComposer(page, prompt)

    // Wait until the reply is genuinely under way: a crash before the first token would be a
    // different (and much easier) case than a crash in the middle of one.
    if (isRealModel) {
      await waitForAnswer(page, prompt, { minLength: 30 })
    } else {
      await expect(page.locator('article[data-role="agent"]').last()).toContainText('part 3/40')
    }
    const partial = await lastAgentText(page)
    expect(partial.trim().length, 'something had arrived before the crash').toBeGreaterThan(0)

    await test.step('the server is killed mid-stream and comes back', async () => {
      composeServer({}, 'kill', 'server')
      composeServer({}, 'up', '-d', 'server')
      await waitForHealth()
    })

    await test.step('the turn is re-run and ends', async () => {
      await expect
        .poll(async () => (await eventTypes(request, session.id)).at(-1), {
          timeout: 180_000,
          message: 'the turn should have been picked up and finished',
        })
        .toBe('session.status_idle')
    })

    await test.step('exactly one reply is stored, and it is a whole one', async () => {
      const log = await readEvents(request, session.id)
      const types = log.map((event) => String(event.type))

      expect(
        types.filter((type) => type === 'agent.message'),
        'the re-run replaced the attempt, it did not add to it',
      ).toHaveLength(1)
      expect(types, 'no turn is left open').not.toContain('session.status_rescheduled')

      // The brain that died left its span open; the one that took over closes it with the
      // reason the package documents (`packages/brain/AGENTS.md`, the inherited turn).
      const lost = log.filter(
        (event) =>
          event.type === 'span.model_request_end' &&
          (event.error as { type?: string } | undefined)?.type === 'brain_lost',
      )
      expect(lost, 'the killed request was closed as `brain_lost`').toHaveLength(1)

      const reply = log.find((event) => event.type === 'agent.message')
      const text = ((reply?.content ?? []) as { text: string }[])
        .map((block) => block.text)
        .join('')
      expect(text.length, 'the stored reply is longer than what the preview had').toBeGreaterThan(
        partial.length,
      )
      if (isRealModel) {
        expect(text, 'the re-run wrote the whole reply, not the fragment it replaced').toMatch(
          LONG_REPLY_END,
        )
      } else {
        expect(text, 'the re-run wrote the whole reply').toContain('part 40/40')
      }
    })

    await test.step('a reconnected tab shows the finished reply', async () => {
      await page.reload()
      await expect(conversation(page)).toBeVisible()
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
      const finalText = await lastAgentText(page)
      expect(finalText.length, 'the tab has the whole reply, not the fragment').toBeGreaterThan(
        partial.length,
      )
      if (!isRealModel) {
        expect(finalText).toContain('part 40/40')
      }
      await shot(page, 'w14-01-after-crash-recovery')
    })
  })
})
