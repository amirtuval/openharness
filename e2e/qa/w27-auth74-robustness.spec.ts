import {
  QA_MODEL,
  createAgent,
  createSession,
  expect,
  expectNoErrorBanner,
  openChat,
  sendFromComposer,
  shot,
  test,
  transcript,
  uniqueName,
  waitForIdle,
} from './support'
import {
  AGENT_LINE,
  CLI_LOGIN_HINT,
  Terminal,
  ensureCliSignedIn,
  expectNoErrorNotice,
  occurrences,
  ohCommand,
  ohCommandIn,
  openDevicePage,
  scratchConfigHome,
  sendAndAwaitAnswer,
} from './tmux'

/**
 * W27 — §11 of the #74 QA pass (epic #65): cross-client behaviour and robustness.
 *
 * The other two steps of §11 are the suite's own restart scenarios, run with
 * `QA_ALLOW_SERVER_RESTART=1`:
 *
 * - **11.2** (a server killed mid-reply, the turn finishing on the new process, still signed
 *   in) is `w14-recovery.spec.ts`.
 * - **11.3** (the app showing the connection error while the server is down, and recovering)
 *   is `w11-errors.spec.ts`'s W11c.
 *
 * Needs `QA_WITH_CLI=1` (tmux + a built CLI + a signed-in browser half).
 */

test.describe('W27 §11 cross-client and robustness', () => {
  test.skip(process.env.QA_WITH_CLI !== '1', 'set QA_WITH_CLI=1 to drive the oh CLI in tmux')
  test.setTimeout(300_000)

  test('W27a one session in the web app and oh — both see everything, in the same order', async ({
    context,
    page,
    request,
  }) => {
    const agent = await createAgent(request, {
      name: uniqueName('QA W27 both clients'),
      model: QA_MODEL,
      system: 'Answer in one short sentence.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)

    const terminal = new Terminal('oh-qa-w27a', 100, 30)
    const shotPage = await context.newPage()
    await ensureCliSignedIn(shotPage)
    terminal.start()
    try {
      terminal.run(ohCommand('-s', session.id))
      await terminal.waitForIdle()
      await terminal.waitFor(/❯/)

      await test.step('from the terminal: the browser follows the same session', async () => {
        await sendAndAwaitAnswer(terminal, 'sent from the terminal')
        await terminal.waitForIdle(120_000)
        await waitForIdle(request, session.id)
        await expect(page.getByRole('log', { name: 'Conversation' })).toContainText(
          'sent from the terminal',
        )
        await shot(page, 'w27-01-from-terminal')
      })

      await test.step('from the browser: the terminal sees it, then the reply', async () => {
        const before = occurrences(terminal.capture(), AGENT_LINE)
        await sendFromComposer(page, 'sent from the browser')
        await terminal.waitUntil((screen) => occurrences(screen, AGENT_LINE) > before, 120_000)
        await terminal.waitForIdle(120_000)
        await waitForIdle(request, session.id)
        await expect(page.getByRole('log', { name: 'Conversation' })).toContainText(
          'sent from the browser',
        )
        await terminal.screenshot(shotPage, 'w27-02-from-browser')
      })

      await test.step('the same order on both sides', async () => {
        const web = await transcript(page)
        const users = web
          .filter((line) => line.startsWith('user:'))
          .map((line) => line.slice('user:'.length).trim())
        expect(users).toEqual(['sent from the terminal', 'sent from the browser'])
        expect(
          web.filter((line) => line.startsWith('agent:')),
          'one reply per turn',
        ).toHaveLength(2)

        const pane = terminal.capture(300)
        const first = pane.indexOf('sent from the terminal')
        const second = pane.indexOf('sent from the browser')
        expect(first).toBeGreaterThanOrEqual(0)
        expect(second).toBeGreaterThan(first)
        expectNoErrorNotice(terminal.capture())
        await expectNoErrorBanner(page)
        await terminal.screenshot(shotPage, 'w27-03-order')
      })
    } finally {
      terminal.kill()
      await shotPage.close()
    }
  })

  test('W27b Settings and the device page at 390x844', async ({ context, page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/#/settings')
    await expect(page.getByText('Model providers')).toBeVisible()
    await expect(page.getByLabel('Server URL')).toBeVisible()
    const settingsOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(settingsOverflow, 'no horizontal scroll on Settings').toBeLessThanOrEqual(1)
    await shot(page, 'w27-04-settings-390x844')

    const home = scratchConfigHome('w27-device')
    const terminal = new Terminal('oh-qa-w27b', 120, 24)
    const devicePage = await context.newPage()
    await devicePage.setViewportSize({ width: 390, height: 844 })
    terminal.start()
    try {
      terminal.run(ohCommandIn(home, 'login', '--no-browser'))
      const hint = await terminal.waitFor(CLI_LOGIN_HINT, 30_000)
      await openDevicePage(devicePage, hint[1] ?? '')
      await expect(devicePage.getByRole('heading', { name: 'Approve a CLI login' })).toBeVisible()
      await expect(devicePage.locator('[data-slot="device-user-code"]')).toBeVisible()
      await expect(devicePage.getByRole('button', { name: 'Approve' })).toBeVisible()
      await expect(devicePage.getByRole('button', { name: 'Deny' })).toBeVisible()
      const deviceOverflow = await devicePage.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(deviceOverflow, 'no horizontal scroll on the device page').toBeLessThanOrEqual(1)
      await shot(devicePage, 'w27-05-device-390x844')

      // Decide it, so no code is left pending for a later scenario.
      await devicePage.getByRole('button', { name: 'Approve' }).click()
      await expect(devicePage.getByText('Approved')).toBeVisible()
    } finally {
      terminal.kill()
      await devicePage.close()
    }
  })
})
