import {
  ensureDefaultModel,
  expect,
  expectNoErrorBanner,
  isRealModel,
  openChat,
  sendFromComposer,
  shot,
  test,
  waitForAnswer,
} from './support'
import {
  AGENT_LINE,
  Terminal,
  ensureCliSignedIn,
  expectNoErrorNotice,
  occurrences,
  ohCommand,
  sendAndAwaitAnswer,
} from './tmux'

/** Leave a chat: one Ctrl+C arms the exit and says so, the second one takes it. */
async function quit(terminal: Terminal): Promise<void> {
  terminal.send('C-c')
  await terminal.waitFor(/Press Ctrl\+C again to exit\./)
  terminal.send('C-c')
  await terminal.waitFor(/Resume this session with: oh -s /)
  await terminal.waitForShellPrompt()
}

/**
 * C10 — the web app and `oh` on the same session.
 *
 * The CLI half runs in a real pseudo-terminal; the browser half is the same Playwright page
 * the other specs use. Opt-in with `QA_WITH_CLI=1`, so `yarn qa:web` stays runnable on a
 * machine without tmux.
 *
 * A new chat in `oh` starts on the account's default model with no dialog (U2) — this file
 * used to drive the agent picker, which is gone — and the default has to exist for that to be
 * the reading on a fresh mock stack.
 */
test.describe('C10 cross-client', () => {
  test.skip(process.env.QA_WITH_CLI !== '1', 'set QA_WITH_CLI=1 to drive the oh CLI in tmux')

  test('C10 a chat started in oh appears in the web app, and oh resumes a web chat', async ({
    page,
    request,
  }) => {
    const model = await ensureDefaultModel(request)
    // This file sorts before `cli.spec.ts`, so on a fresh run it is the first thing to drive
    // `oh` — and a config directory with no token in it is a "not signed in" error, not a
    // chat. `ensureCliSignedIn` runs the device flow when there is none and is a no-op after.
    await ensureCliSignedIn(page)

    const terminal = new Terminal('oh-qa-c10', 100, 30)
    terminal.start()

    try {
      let startedInChat = ''

      await test.step('oh starts a new chat on the default model', async () => {
        terminal.run(ohCommand())
        await terminal.waitForIdle()
        startedInChat = (await terminal.waitFor(/sesn_[A-Z0-9]+/))[0]
        const opened = terminal.capture()
        expect(opened).toContain(model)
        expect(opened, 'no model dialog').not.toContain('Which model?')
        expectNoErrorNotice(opened)
      })

      await test.step('what oh sends shows up in the browser', async () => {
        await sendAndAwaitAnswer(terminal, 'sent from the terminal')

        await openChat(page, startedInChat)
        await expectNoErrorBanner(page)
        await expect(page.locator('article[data-role="user"]').last()).toContainText(
          'sent from the terminal',
        )
        await waitForAnswer(page, 'sent from the terminal')
        await expectNoErrorBanner(page)
        await shot(page, 'c10-01-oh-session-in-the-web')
      })

      await test.step('what the browser sends shows up in oh', async () => {
        const before = occurrences(terminal.capture(), AGENT_LINE)
        await sendFromComposer(page, 'sent from the browser')
        // The agent's line, not the user's: the user's own message is echoed immediately and
        // the turn is still running behind it.
        if (isRealModel) {
          await terminal.waitUntil((screen) => occurrences(screen, AGENT_LINE) > before, 60_000)
        } else {
          await terminal.waitFor(/agent › sent from the browser/, 30_000)
        }
        await terminal.waitForIdle()
        expect(terminal.capture()).toContain('you › sent from the browser')
        expectNoErrorNotice(terminal.capture())
      })

      await test.step('oh resumes the chat and shows both sides of it', async () => {
        await quit(terminal)
        await terminal.waitForShellPrompt()

        terminal.run(ohCommand('-s', startedInChat))
        await terminal.waitFor(/sent from the browser/)
        await terminal.waitForIdle()
        const screen = terminal.capture(400)
        expect(screen).toContain('sent from the terminal')
        expect(screen).toContain('sent from the browser')
        expectNoErrorNotice(screen)
      })
    } finally {
      terminal.kill()
    }

    // And the other way round: a session the web app made, resumed by id in `oh`.
    const created = await request.post('/v1/sessions', { data: { model: { id: model } } })
    expect(created.status(), await created.text()).toBe(201)
    const webSession = ((await created.json()) as { id: string }).id
    await openChat(page, webSession)
    await expectNoErrorBanner(page)
    await sendFromComposer(page, 'started in the browser')
    await waitForAnswer(page, 'started in the browser')

    terminal.start()
    try {
      terminal.run(ohCommand('-s', webSession))
      await terminal.waitFor(/started in the browser/)
      expect(terminal.capture()).toContain('started in the browser')
      expectNoErrorNotice(terminal.capture())
    } finally {
      terminal.kill()
    }
  })
})
