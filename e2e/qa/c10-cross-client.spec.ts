import {
  QA_MODEL,
  createAgent,
  createSession,
  expect,
  isRealModel,
  openChat,
  sendFromComposer,
  shot,
  test,
  waitForAnswer,
} from './support'
import {
  AGENT_LINE,
  CLI_COMMAND,
  CLI_SERVER,
  Terminal,
  occurrences,
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
 */
test.describe('C10 cross-client', () => {
  test.skip(process.env.QA_WITH_CLI !== '1', 'set QA_WITH_CLI=1 to drive the oh CLI in tmux')

  test('C10 a chat started in oh appears in the web app, and oh resumes a web chat', async ({
    page,
    request,
  }) => {
    // A session per run, so `oh -s` below names something this test made.
    const agent = await createAgent(request, {
      name: `QA C10 ${Date.now().toString(36)}`,
      model: QA_MODEL,
      system: 'Answer briefly.',
    })

    // `oh` skips the picker when the server has exactly one agent, and the first thing this
    // test does is choose from it — so make sure there is a choice to make.
    const agents = await request.get('/v1/agents', { params: { limit: 100 } })
    if (((await agents.json()) as { data: unknown[] }).data.length < 2) {
      await createAgent(request, {
        name: `QA C10 decoy ${Date.now().toString(36)}`,
        model: QA_MODEL,
        system: 'Answer briefly.',
      })
    }

    const terminal = new Terminal('oh-qa-c10', 100, 30)
    terminal.start()

    try {
      let startedInChat = ''

      await test.step('oh starts a new chat', async () => {
        terminal.run(`${CLI_COMMAND} --server ${CLI_SERVER}`)
        await terminal.waitFor(/Which agent\?/)
        // Enter takes the row the cursor starts on: the picker does not offer number keys
        // once the server has more than nine agents.
        terminal.send('Enter')
        await terminal.waitForIdle()
        startedInChat = (await terminal.waitFor(/sesn_[A-Z0-9]+/))[0]
      })

      await test.step('what oh sends shows up in the browser', async () => {
        await sendAndAwaitAnswer(terminal, 'sent from the terminal')

        await openChat(page, startedInChat)
        await expect(page.locator('article[data-role="user"]').last()).toContainText(
          'sent from the terminal',
        )
        await waitForAnswer(page, 'sent from the terminal')
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
      })

      await test.step('oh resumes the chat and shows both sides of it', async () => {
        await quit(terminal)
        await terminal.waitForShellPrompt()

        terminal.run(`${CLI_COMMAND} --server ${CLI_SERVER} -s ${startedInChat}`)
        await terminal.waitFor(/sent from the browser/)
        await terminal.waitForIdle()
        const screen = terminal.capture(400)
        expect(screen).toContain('sent from the terminal')
        expect(screen).toContain('sent from the browser')
      })
    } finally {
      terminal.kill()
    }

    // And the other way round: a session the web app made, resumed by id in `oh`.
    const webSession = await createSession(request, agent.id)
    await openChat(page, webSession.id)
    await sendFromComposer(page, 'started in the browser')

    terminal.start()
    try {
      terminal.run(`${CLI_COMMAND} --server ${CLI_SERVER} -s ${webSession.id}`)
      await terminal.waitFor(/started in the browser/)
      expect(terminal.capture()).toContain('started in the browser')
    } finally {
      terminal.kill()
    }
  })
})
