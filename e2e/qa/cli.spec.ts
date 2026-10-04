import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { APIRequestContext } from '@playwright/test'

import {
  LONG_REPLY_END,
  LONG_REPLY_PROMPT,
  QA_MODEL,
  createAgent,
  createChat,
  eventTypes,
  ensureDefaultModel,
  expect,
  isRealModel,
  requestedModels,
  setDefaultModel,
  test,
  uniqueName,
} from './support'
import {
  AGENT_LINE,
  CLI_CONFIG_HOME,
  CLI_CWD,
  CLI_LOGIN_HINT,
  CLI_SERVER,
  Terminal,
  cliCredentialsMode,
  ensureCliSignedIn,
  expectNoErrorNotice,
  forgetCliCredentials,
  loggedInAs,
  occurrences,
  ohCommand,
  openDevicePage,
  replyHasText,
  sendAndAwaitAnswer,
} from './tmux'

/**
 * Leave a chat, and answer the resume hint it prints.
 *
 * One Ctrl+C arms the exit and says so; the second, inside the two-second window, takes it.
 * Waiting for the first message rather than sleeping makes the pair deterministic — a stray
 * Ctrl+C while a turn is running is an interrupt, not an arm.
 */
async function quit(terminal: Terminal): Promise<string> {
  terminal.send('C-c')
  await terminal.waitFor(/Press Ctrl\+C again to exit\./)
  terminal.send('C-c')
  const hint = await terminal.waitFor(/Resume this session with: oh -s sesn_[A-Z0-9]+/)
  await terminal.waitForShellPrompt()
  return hint[0]
}

/**
 * Run `oh` the way a shell would, and answer what it printed and how it exited.
 *
 * The one-shot commands (`agents`, `sessions`, a bad argument) do not need a terminal: they
 * write their output and exit, so this reads them straight from a pipe. The interactive
 * screens go through {@link Terminal} instead.
 */
function oh(
  args: readonly string[],
  options: { readonly configHome?: string } = {},
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', ['apps/tui/dist/index.js', ...args], {
      cwd: CLI_CWD,
      encoding: 'utf8',
      // The QA run's own config directory, so the developer's stored tokens are never read
      // or written by a scenario.
      env: { ...process.env, XDG_CONFIG_HOME: options.configHome ?? CLI_CONFIG_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { stdout, status: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number }
    return {
      stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      status: failure.status ?? -1,
    }
  }
}

/**
 * A config directory for `oh` that holds nothing: the state a machine that never signed in is
 * in, without touching the session the other scenarios share.
 */
function scratchConfigHome(label: string): string {
  const home = path.join(CLI_CONFIG_HOME, `scratch-${label}`)
  rmSync(home, { recursive: true, force: true })
  return home
}

/** A config directory holding a token the server will not accept — the 401 path. */
function staleConfigHome(): string {
  const home = scratchConfigHome('stale')
  const directory = path.join(home, 'openharness')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    path.join(directory, 'credentials.json'),
    JSON.stringify({ servers: { [CLI_SERVER]: 'not-a-real-session-token' } }),
  )
  return home
}

/** Every agent the server has, oldest first — the list `oh agents` is supposed to print. */
async function allAgents(request: APIRequestContext): Promise<{ id: string; name: string }[]> {
  const agents: { id: string; name: string }[] = []
  let page: string | null = null
  for (;;) {
    const response = await request.get('/v1/agents', {
      params: { limit: 100, ...(page === null ? {} : { page }) },
    })
    expect(response.status(), await response.text()).toBe(200)
    const body = (await response.json()) as {
      data: { id: string; name: string }[]
      next_page: string | null
    }
    agents.push(...body.data)
    if (body.next_page === null) {
      return agents
    }
    page = body.next_page
  }
}

/**
 * Start `oh` in the terminal and wait for the chat it opens.
 *
 * Since #114 (epic #116, U2) a bare `oh` starts on the account's **default model** — there is
 * no "Which agent?" picker any more — so the scenario just waits for the status line, which
 * names the model it is running and the session it created. Without a default and without a
 * provider key the CLI says so instead (`no-models`), which is why the account is given one
 * first: the same `PUT /v1/me/preferences` Settings → Default model makes.
 *
 * @returns the session the chat was created on
 */
async function startChat(
  terminal: Terminal,
  request: APIRequestContext,
  args: readonly string[] = [],
): Promise<string> {
  const model = await ensureDefaultModel(request)
  terminal.run(ohCommand(...args))
  await terminal.waitFor(/sesn_[A-Z0-9]+/, 30_000)
  await terminal.waitForIdle()
  // The status line names the model the chat runs, so "it started on the default" is a
  // reading rather than an assumption.
  expect(terminal.capture()).toContain(model)
  return (await terminal.waitFor(/sesn_[A-Z0-9]+/))[0] ?? ''
}

/**
 * The `oh` scenarios, driven through a real pseudo-terminal.
 *
 * Opt-in with `QA_WITH_CLI=1`, because it needs `tmux` and a built CLI:
 *
 *   yarn turbo run build --filter=@openharness/cli...
 *   QA_WITH_CLI=1 yarn qa:web qa/cli.spec.ts
 */
test.describe('cli scenarios', () => {
  test.skip(process.env.QA_WITH_CLI !== '1', 'set QA_WITH_CLI=1 to drive the oh CLI in tmux')

  // These run a whole conversation through a pseudo-terminal, and against a real provider one
  // of them streams a long reply with another turn behind it. The suite's 120 s ceiling is
  // sized for the browser scenarios.
  test.setTimeout(240_000)

  test('C1 new chat: start on the default model, send, stream, prompt back', async ({
    context,
    request,
  }) => {
    const terminal = new Terminal('oh-qa-c1')
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    terminal.start()

    try {
      const model = await ensureDefaultModel(request)
      terminal.run(ohCommand())

      // The chat opens on the account's default model — the status line names it and the
      // session it just created (U2). No picker is in the way.
      await terminal.waitFor(/sesn_[A-Z0-9]+/, 30_000)
      await terminal.waitForIdle()
      expect(terminal.capture()).toContain(model)
      await terminal.screenshot(shot, 'c1-01-started-on-the-default')

      // Wait for the reply, not just for "idle": the status line says idle before the turn
      // starts too, so an `idle` that was already on screen is not the end of anything.
      await sendAndAwaitAnswer(terminal, 'hello from the terminal')
      await terminal.screenshot(shot, 'c1-02-streaming')
      await terminal.waitForIdle()
      const screen = terminal.capture()
      expect(screen).toContain('you › hello from the terminal')
      if (!isRealModel) {
        // The mock answers by echoing its prompt; where the reply's own words are not known,
        // the line above is the only half of this that can be asserted.
        expect(screen).toContain('agent › hello from the terminal')
      }
      expect(screen, 'the status line is back').toMatch(/idle/)
      expectNoErrorNotice(screen)
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('C2 a long reply at 80x24 and at 200x50', async ({ context, request }) => {
    const terminal = new Terminal('oh-qa-c2', 80, 24)
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    terminal.start()

    try {
      await startChat(terminal, request)

      const longPrompt = isRealModel ? LONG_REPLY_PROMPT : '__slow__ a long reply please'
      await sendAndAwaitAnswer(terminal, longPrompt, { slow: !isRealModel })
      await terminal.screenshot(shot, 'c2-01-slow-stream-80x24')

      await terminal.waitForIdle(180_000)
      // Wrapped to the terminal width, and the status line and prompt are still there.
      const narrow = terminal.capture()
      expectNoErrorNotice(narrow)
      expect(narrow).toMatch(/idle/)
      expect(narrow).toContain('❯')
      if (isRealModel) {
        // The whole reply went through an 80x24 pane: the last number it was asked for is in
        // the scrollback, so nothing was dropped on the way.
        expect(terminal.capture(400), 'the reply arrived in full').toMatch(LONG_REPLY_END)
      } else {
        expect(narrow).toContain('part 40/40')
      }

      terminal.resize(200, 50)
      await new Promise((resolve) => setTimeout(resolve, 500))
      await sendAndAwaitAnswer(terminal, 'now at the wider size')
      // Waiting for the prompt line is the assertion for the client half of this: it is
      // written the moment Enter is pressed, at the new width, into a pane a long reply has
      // already scrolled. Whether it is *still* in the capture below depends on how far the
      // reply that follows pushed it up, which is not what this scenario is about.
      await terminal.waitFor(/you › now at the wider size/, 60_000)
      await terminal.waitForIdle()
      await terminal.screenshot(shot, 'c2-02-wide-200x50')
      const wide = terminal.capture()
      expect(wide).toContain('❯')
      expect(wide, 'the status line is back').toMatch(/idle/)
      expectNoErrorNotice(wide)
      if (!isRealModel) {
        expect(wide).toContain('now at the wider size')
        // The reply printed before the resize keeps the 80-column wrapping it was written
        // with; nothing reflows it, and nothing is left half-drawn either.
        expect(wide).toContain('part 40/40')
      }
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('C3 resume: the printed hint, and -c', async ({ context, request }) => {
    const terminal = new Terminal('oh-qa-c3', 100, 30)
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    terminal.start()

    try {
      await startChat(terminal, request)

      await sendAndAwaitAnswer(terminal, 'a message worth resuming')
      await terminal.waitForIdle()
      const sessionId = (await terminal.waitFor(/sesn_[A-Z0-9]+/))[0]

      const hint = await quit(terminal)
      expect(hint).toContain(sessionId)
      await terminal.screenshot(shot, 'c3-01-resume-hint')

      // The hint, followed literally: the history comes back.
      terminal.run(ohCommand('-s', sessionId))
      await terminal.waitFor(/a message worth resuming/)
      await terminal.waitForIdle()
      expect(terminal.capture()).toContain('a message worth resuming')
      expectNoErrorNotice(terminal.capture())
      await terminal.screenshot(shot, 'c3-02-resumed')

      await quit(terminal)

      // -c: the most recent session, which is the one just resumed.
      terminal.run(ohCommand('-c'))
      // The history that comes back holds both sides; which line is asserted depends on
      // whether the reply's words are known.
      await terminal.waitFor(
        isRealModel ? /a message worth resuming/ : /agent › a message worth resuming/,
        30_000,
      )
      await terminal.waitForIdle()
      expect(terminal.capture()).toContain('a message worth resuming')
      expectNoErrorNotice(terminal.capture())
      await terminal.screenshot(shot, 'c3-03-continued')
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('C4 a message sent while a reply streams is queued and answered', async ({
    context,
    request,
  }) => {
    const terminal = new Terminal('oh-qa-c4', 100, 30)
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    terminal.start()

    try {
      await startChat(terminal, request)

      const firstQuestion = isRealModel ? LONG_REPLY_PROMPT : '__slow__ first question'
      await sendAndAwaitAnswer(terminal, firstQuestion, { slow: !isRealModel })
      await terminal.waitFor(/\brunning\b/, 15_000)
      if (!isRealModel) {
        await terminal.waitFor(/part 3\/40/)
      }

      terminal.type('second question')
      terminal.send('Enter')
      await terminal.waitFor(/second question \(queued\)/)
      await terminal.screenshot(shot, 'c4-01-steering-queued')

      // The steering message is claimed when the brain answers it, and the `(queued)` marker
      // goes with it. Counting `agent ›` lines would not do here: a long reply scrolls the
      // first one off a 30-row pane, so the count never reaches two.
      await terminal.waitUntil((screen) => !screen.includes('(queued)'), 120_000)
      await terminal.waitForIdle()
      expect(terminal.capture(), 'the queued marker is gone').not.toContain('(queued)')
      expectNoErrorNotice(terminal.capture())
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('C5 Ctrl+C stops a stream and a second Ctrl+C exits cleanly', async ({
    context,
    request,
  }) => {
    // A terminal of its own: an earlier `__slow__` reply would still be on screen and its
    // "part 3/40" would satisfy the wait below before this turn had started.
    const terminal = new Terminal('oh-qa-c5', 100, 30)
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    terminal.start()

    try {
      await startChat(terminal, request)

      await test.step('Ctrl+C stops the stream and keeps the partial reply', async () => {
        const prompt = isRealModel ? LONG_REPLY_PROMPT : '__slow__ interrupt me'
        await sendAndAwaitAnswer(terminal, prompt, { slow: !isRealModel })
        await terminal.waitFor(/\brunning\b/, 15_000)
        if (isRealModel) {
          // Interrupt a reply that has actually said something. The `agent ›` line shows up
          // with only the streaming cursor on it, before the first token.
          await terminal.waitUntil(replyHasText, 60_000)
        } else {
          await terminal.waitFor(/part 5\/40/, 20_000)
        }
        terminal.send('C-c')
        await terminal.waitForIdle(180_000)

        const screen = terminal.capture()
        const promptLine = prompt.split('\n')[0] ?? ''
        const interrupted = screen.slice(screen.lastIndexOf(`you › ${promptLine}`))
        expect(interrupted, 'the partial reply stays on screen').toMatch(
          isRealModel ? /agent › / : /part 1\/40/,
        )
        if (isRealModel) {
          // The reply was asked to count, one number per line, so the last number on a line of
          // its own means it finished — which an interrupt mid-stream must prevent.
          expect(interrupted, 'the reply stopped short of the end').not.toMatch(LONG_REPLY_END)
        } else {
          expect(interrupted, 'the reply stopped short').not.toContain('part 40/40')
        }
        expect(interrupted, 'back at the prompt').toContain('❯')
        await terminal.screenshot(shot, 'c5-01-interrupted')

        await new Promise((resolve) => setTimeout(resolve, 1500))
        expect(terminal.capture(), 'nothing arrived after the interrupt').toBe(screen)
      })

      await test.step('a new message still works', async () => {
        await sendAndAwaitAnswer(terminal, 'after the interrupt')
        await terminal.waitForIdle()
        expectNoErrorNotice(terminal.capture())
      })

      await test.step('Ctrl+C twice when idle exits and restores the terminal', async () => {
        await quit(terminal)

        terminal.run('echo terminal-restored')
        await terminal.waitFor(/terminal-restored/)
        expect(terminal.capture()).toContain('terminal-restored')
        await terminal.screenshot(shot, 'c5-02-terminal-restored')
      })
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('C6 Ctrl+J and Alt+Enter insert a newline', async ({ context, request }) => {
    const terminal = new Terminal('oh-qa-c6', 100, 30)
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    terminal.start()

    try {
      await startChat(terminal, request)

      terminal.type('first line')
      terminal.send('C-j')
      await new Promise((resolve) => setTimeout(resolve, 200))
      terminal.type('second line')
      await terminal.waitFor(/first line\s*\n\s+second line/)
      await terminal.screenshot(shot, 'c6-01-ctrl-j')

      const beforeSend = occurrences(terminal.capture(), AGENT_LINE)
      terminal.send('Enter')
      if (isRealModel) {
        await terminal.waitUntil((screen) => occurrences(screen, AGENT_LINE) > beforeSend, 60_000)
      } else {
        await terminal.waitFor(/agent › first line/, 30_000)
      }
      const sent = terminal.capture()
      expect(sent).toContain('second line')

      await terminal.waitForIdle()
      expectNoErrorNotice(terminal.capture())
      terminal.type('alt line one')
      terminal.send('M-Enter')
      await new Promise((resolve) => setTimeout(resolve, 200))
      terminal.type('alt line two')
      await terminal.waitFor(/alt line one\s*\n\s+alt line two/)
      await terminal.screenshot(shot, 'c6-02-alt-enter')
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('C7 commands and bad arguments', async ({ page, request }) => {
    await ensureCliSignedIn(page)
    await test.step('--version and --help', () => {
      const version = oh(['--version'])
      expect(version.status).toBe(0)
      expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)

      const help = oh(['--help'])
      expect(help.status).toBe(0)
      expect(help.stdout).toContain('Usage:')
      expect(help.stdout).toContain('oh sessions')
    })

    await test.step('bad arguments explain themselves and exit 2', () => {
      const flag = oh(['--nope'])
      expect(flag.status).toBe(2)
      expect(flag.stdout).toContain("Unknown option '--nope'")

      const command = oh(['frobnicate'])
      expect(command.status).toBe(2)
      expect(command.stdout).toContain("unknown command 'frobnicate'")

      const missing = oh(['-s'])
      expect(missing.status).toBe(2)
      expect(missing.stdout).toContain('argument missing')
    })

    await test.step('oh agents and oh sessions are readable', async () => {
      // The two listings say "No agents yet." / "No sessions yet." on an account that has
      // none, and the agents screen is gone from the UI (#91) — so a fresh stack has no agent
      // until something creates one through the API (C7b does, 21 of them, but it runs after
      // this). Make sure both exist rather than depend on what ran before.
      await createAgent(request, {
        name: uniqueName('QA C7'),
        model: QA_MODEL,
        system: 'Answer briefly.',
      })
      await createChat(request, QA_MODEL)

      const agents = oh(['agents', '--server', CLI_SERVER])
      expect(agents.status).toBe(0)
      const firstAgentLine = agents.stdout.split('\n').filter((line) => line.trim() !== '')[0] ?? ''
      expect(firstAgentLine).toMatch(/^agent_\S+\s+.*\S+\/\S+/)

      const sessions = oh(['sessions', '--server', CLI_SERVER])
      expect(sessions.status).toBe(0)
      const firstSessionLine =
        sessions.stdout.split('\n').filter((line) => line.trim() !== '')[0] ?? ''
      expect(firstSessionLine).toMatch(/^sesn_\S+\s+.*\s+(running|idle)\s+\S+/)
    })
  })

  // Regression coverage for issue #30: `oh agents`, the picker and `--agent` read one page of
  // 20 (the protocol's `DEFAULT_PAGE_LIMIT`) and dropped `next_page`, so everything past the
  // 20 oldest was invisible and `--agent <name>` called an agent that exists "missing". Fixed
  // by PR #34: `listAllAgents` walks the cursor (`apps/tui/src/paging.ts`).
  test('C7b every agent is reachable past the first page', async ({ request, context }) => {
    // One page, which is what the CLI used to stop at.
    const PAGE = 20

    await test.step('the server has more agents than one page holds', async () => {
      const before = (await allAgents(request)).length
      for (let index = before; index < PAGE + 1; index += 1) {
        await createAgent(request, {
          name: uniqueName(`QA C7b ${String(index)}`),
          model: QA_MODEL,
          system: 'Answer briefly.',
        })
      }
      expect((await allAgents(request)).length, 'more than one page of agents').toBeGreaterThan(
        PAGE,
      )
    })

    // Created last, so it is the newest — and the one a first-page-only listing cannot see.
    const newest = await createAgent(request, {
      name: uniqueName('QA C7b'),
      model: QA_MODEL,
      system: 'Answer briefly.',
    })

    await test.step('oh agents lists all of them', () => {
      const listed = oh(['agents', '--server', CLI_SERVER])
      expect(listed.status).toBe(0)
      const rows = listed.stdout.split('\n').filter((line) => line.trim() !== '')
      expect(rows.length, 'a row per agent, not one page of them').toBeGreaterThan(PAGE)
      expect(rows.at(-1), 'the newest agent is listed last').toContain(newest.name)
      expect(listed.stdout).toContain(newest.id)
    })

    await test.step('oh --agent <name> finds the newest one', async () => {
      const terminal = new Terminal('oh-qa-c7b', 80, 24)
      const shot = await context.newPage()
      await ensureCliSignedIn(shot)
      terminal.start()
      try {
        terminal.run(ohCommand('--agent', `'${newest.name}'`))
        // Either the chat comes up on a session, or the error this scenario is about appears.
        await terminal.waitFor(/sesn_[A-Z0-9]+|no agent matches/, 30_000)
        expect(terminal.capture(), 'the agent was resolved').not.toContain('no agent matches')
        await terminal.waitForIdle()
        expectNoErrorNotice(terminal.capture())
        await terminal.screenshot(shot, 'c7b-01-agent-past-the-first-page')
        await quit(terminal)
      } finally {
        terminal.kill()
        await shot.close()
      }
    })
  })

  // The failure a real provider actually produces, and what `oh` makes of it. The mock only
  // fails on its scripted markers, so this one runs against a real model or not at all.
  test('C11 a turn that fails says so in oh, and the chat keeps working', async ({
    context,
    request,
  }) => {
    test.skip(!isRealModel, 'the mock model answers whatever id an agent names')

    const terminal = new Terminal('oh-qa-c11', 100, 30)
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    terminal.start()

    try {
      const agent = await createAgent(request, {
        name: uniqueName('QA C11'),
        model: 'openai/does-not-exist-123',
        system: 'Answer briefly.',
      })

      terminal.run(ohCommand('--agent', `'${agent.name}'`))
      const sessionId = (await terminal.waitFor(/sesn_[A-Z0-9]+/, 30_000))[0]
      await terminal.waitForIdle()

      await test.step('the error is shown and the prompt comes back', async () => {
        terminal.type('this model does not exist')
        terminal.send('Enter')
        await terminal.waitFor(/error:/, 60_000)
        await terminal.waitFor(/does-not-exist-123/, 60_000)
        await terminal.waitForIdle()
        expect(terminal.capture(), 'the prompt is usable again').toContain('❯')
        await terminal.screenshot(shot, 'c11-01-turn-error')
      })

      await test.step('the chat is still usable', async () => {
        terminal.type('and again')
        terminal.send('Enter')
        // The notice is replaced rather than added to, so counting it does not work; what says
        // the second message was answered at all is the session's log.
        await expect
          .poll(
            async () =>
              (await eventTypes(request, sessionId)).filter(
                (type) => type === 'span.model_request_start',
              ).length,
            { timeout: 60_000, message: 'the second message should have started a turn' },
          )
          .toBe(2)
        await terminal.waitForIdle()
        const screen = terminal.capture()
        expect(screen, 'the failure is still reported').toContain('error:')
        expect(screen, 'the prompt is usable again').toContain('❯')
      })
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('C9 a server that is not there, and a token a server no longer accepts', () => {
    const down = oh(['agents', '--server', 'http://localhost:3999'])
    expect(down.status).toBe(1)
    expect(down.stdout).toContain('could not reach the server at http://localhost:3999')
    expect(down.stdout, 'no stack trace').not.toMatch(/\n\s+at /)

    // With no token at all, the commands that need one say how to get one. A config directory
    // of its own, so this does not touch the session the other scenarios share.
    const none = oh(['agents', '--server', CLI_SERVER], { configHome: scratchConfigHome('none') })
    expect(none.status).toBe(1)
    expect(none.stdout).toContain(`not signed in to ${CLI_SERVER}. Run \`oh login\`.`)
    expect(none.stdout, 'no stack trace').not.toMatch(/\n\s+at /)

    // A token the server does not accept — revoked, expired, or another server's — is the 401
    // path, and `oh` answers it with the same sentence.
    const stale = oh(['agents', '--server', CLI_SERVER], { configHome: staleConfigHome() })
    expect(stale.status).toBe(1)
    expect(stale.stdout).toContain(`not signed in to ${CLI_SERVER}. Run \`oh login\`.`)
    expect(stale.stdout, 'no stack trace').not.toMatch(/\n\s+at /)
  })

  // --- signing in, and out, from the terminal (A6) ------------------------------------------

  // The device flow `oh login` runs, with the approval made in a real browser — the half a
  // unit test's fake replaces. The scenarios below it share whatever this leaves behind, so
  // they run after it; C14 signs out at the end and puts a session back.
  test('C12 oh login --no-browser: the code, the browser approval, the stored token', async ({
    context,
    page,
  }) => {
    forgetCliCredentials()
    expect(cliCredentialsMode(), 'a clean slate').toBeNull()

    const terminal = new Terminal('oh-qa-c12', 100, 30)
    const shot = await context.newPage()
    terminal.start()
    try {
      terminal.run(ohCommand('login', '--no-browser'))
      const hint = await terminal.waitFor(CLI_LOGIN_HINT, 30_000)
      const url = hint[1] ?? ''
      const userCode = hint[2] ?? ''
      // The URL is the web app's approval route with the code in the fragment, and the code on
      // the screen is the one the page shows (A6: compare them before approving).
      expect(url).toBe(`${CLI_SERVER}/#/device?user_code=${userCode}`)
      await terminal.screenshot(shot, 'c12-01-login-code')

      await openDevicePage(page, url)
      await expect(page.getByRole('heading', { name: 'Approve a CLI login' })).toBeVisible()
      await expect(page.locator('[data-slot="device-user-code"]')).toHaveText(userCode)
      await page.getByRole('button', { name: 'Approve' }).click()
      await expect(page.getByText('Approved')).toBeVisible()

      // The CLI was polling; it signs itself in and says who it is.
      const email = await loggedInAs(terminal)
      expect(email.length).toBeGreaterThan(0)
      await terminal.waitForShellPrompt()

      // The token is stored per server, readable only by its owner — 0600, as A2 promises.
      expect(cliCredentialsMode()).toBe(0o600)
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('C13 oh whoami', async ({ page }) => {
    await ensureCliSignedIn(page)
    const whoami = oh(['whoami', '--server', CLI_SERVER])
    expect(whoami.status).toBe(0)
    expect(whoami.stdout).toMatch(/^Logged in as \S+ on http:\/\/localhost:3000/)
  })

  test('C14 oh logout revokes the token, and the next command says so', async ({ page }) => {
    await ensureCliSignedIn(page)

    const before = oh(['whoami', '--server', CLI_SERVER])
    expect(before.status).toBe(0)

    const logout = oh(['logout', '--server', CLI_SERVER])
    expect(logout.status).toBe(0)
    expect(logout.stdout).toContain(`Logged out of ${CLI_SERVER}.`)

    // The token is gone from disk, and the commands that needed it say how to get one back.
    const after = oh(['whoami', '--server', CLI_SERVER])
    expect(after.status).toBe(1)
    expect(after.stdout).toContain(`not signed in to ${CLI_SERVER}. Run \`oh login\`.`)

    const chat = oh(['agents', '--server', CLI_SERVER])
    expect(chat.status).toBe(1)
    expect(chat.stdout).toContain('Run `oh login`.')

    // And `oh` gets a session again, which leaves one behind for anything that runs after
    // this scenario (they call `ensureCliSignedIn`, which finds it). Deliberately not another
    // device login: the device-verification endpoint allows five requests per ten minutes
    // (#140), the scenarios that are *about* the device page already spend that budget, and
    // signing in again through the flow is covered where it is the point — C12 and W26a.
    await ensureCliSignedIn(page)
  })

  // --- the chat's model, from the terminal (epic #116, U1/U3) -------------------------------

  test('C15 /model switches the chat, and --model overrides the default', async ({
    context,
    request,
  }) => {
    // The picker's free-text row is reached by the number key only while the list is short
    // enough for numbers to be unambiguous (the TUI picker's own rule): an empty catalog is
    // one row, and the mock pass is what this drives. With a real catalog the row sits behind
    // hundreds of arrow presses, and the same switch is covered in the browser (W10a).
    test.skip(isRealModel, 'the free-text row is not reachable by keystroke in a long catalog')

    const terminal = new Terminal('oh-qa-c15', 100, 30)
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    terminal.start()

    try {
      const sessionId = await startChat(terminal, request)
      const switched = 'acme/qa-cli-switched'

      await test.step('/model takes a free-text id the catalog does not know', async () => {
        terminal.type('/model')
        terminal.send('Enter')
        // The catalog of a stack with no provider keys is empty, and the free-text row is the
        // last one — position 1 in a list of one (the number keys pick a row outright).
        await terminal.waitFor(/Other model id/)
        await terminal.screenshot(shot, 'c15-01-model-picker')
        terminal.send('1')
        terminal.type(switched)
        terminal.send('Enter')

        // The status line names the model the next message will run (U3: the pick is held
        // until a message carries it), and nothing has been sent yet.
        await terminal.waitFor(new RegExp(`${switched} \\(next message\\)`), 30_000)
        await terminal.screenshot(shot, 'c15-02-picked')
      })

      await test.step('the next message runs it, and the session keeps it', async () => {
        await sendAndAwaitAnswer(terminal, 'answered on the switched model')
        await terminal.waitForIdle()
        expect(terminal.capture()).toContain(switched)
        expectNoErrorNotice(terminal.capture())

        // The same evidence the web scenario reads (W10a): the spans name the model that ran.
        expect((await requestedModels(request, sessionId)).at(-1)).toBe(switched)
      })

      await test.step('--model starts a chat on it without touching the default', async () => {
        const defaultBefore = await ensureDefaultModel(request)
        await quit(terminal)

        terminal.run(ohCommand('--model', switched))
        await terminal.waitFor(/sesn_[A-Z0-9]+/, 30_000)
        await terminal.waitForIdle()
        expect(terminal.capture()).toContain(switched)

        // The override is this chat's, not the account's: the stored default is untouched.
        const stored = await request.get('/v1/me/preferences')
        expect(((await stored.json()) as { default_model: string | null }).default_model).toBe(
          defaultBefore,
        )
        expectNoErrorNotice(terminal.capture())
        await quit(terminal)
      })
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('C16 oh sessions delete: the confirmation, --yes, and a chat that is really gone', async ({
    context,
    request,
  }) => {
    const terminal = new Terminal('oh-qa-c16', 100, 30)
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    terminal.start()

    try {
      const sessionId = await startChat(terminal, request)
      await quit(terminal)

      await test.step('answering no leaves it alone', async () => {
        terminal.run(ohCommand('sessions', 'delete', sessionId))
        await terminal.waitFor(new RegExp(`Delete chat ${sessionId}\\? This cannot be undone`))
        await terminal.screenshot(shot, 'c16-01-confirm')
        terminal.type('n')
        terminal.send('Enter')
        await terminal.waitFor(/Not deleted\./)

        const stillThere = await request.get(`/v1/sessions/${sessionId}`)
        expect(stillThere.status()).toBe(200)
      })

      await test.step('answering yes deletes it, and the server has nothing left', async () => {
        terminal.run(ohCommand('sessions', 'delete', sessionId))
        await terminal.waitFor(new RegExp(`Delete chat ${sessionId}\\?`))
        terminal.type('y')
        terminal.send('Enter')
        // The sentence wraps at the pane's width — the id included — so the wait is for the
        // words and the id is read off the capture with the wrapping taken out.
        await terminal.waitFor(/Deleted chat/)
        expect(terminal.capture().replace(/\s+/gu, '')).toContain(`Deletedchat${sessionId}.`)

        // Gone for real, log and all — the same 404s the web scenario checks (W18).
        expect((await request.get(`/v1/sessions/${sessionId}`)).status()).toBe(404)
        expect((await request.get(`/v1/sessions/${sessionId}/events`)).status()).toBe(404)
        await terminal.screenshot(shot, 'c16-02-deleted')
      })
    } finally {
      terminal.kill()
      await shot.close()
    }

    await test.step('--yes deletes without asking', async () => {
      const session = await createChat(request, QA_MODEL)
      const deleted = oh(['sessions', 'delete', session.id, '--yes', '--server', CLI_SERVER])
      expect(deleted.status, deleted.stdout).toBe(0)
      expect(deleted.stdout).toContain(`Deleted chat ${session.id}.`)
      const gone = await request.get(`/v1/sessions/${session.id}`)
      expect(gone.status()).toBe(404)
    })
  })

  test('C17 oh default-model reads and writes the account default', async ({ request, page }) => {
    await ensureCliSignedIn(page)
    const previous = await ensureDefaultModel(request)
    const chosen = 'acme/qa-cli-default'

    try {
      const read = oh(['default-model', '--server', CLI_SERVER])
      expect(read.status, read.stdout).toBe(0)
      expect(read.stdout).toContain(`Default model: ${previous}`)

      const written = oh(['default-model', chosen, '--server', CLI_SERVER])
      expect(written.status, written.stdout).toBe(0)
      expect(written.stdout).toContain(`Default model set to ${chosen}.`)

      // The same value the web app's Settings shows: the API is the one copy (U1).
      const stored = await request.get('/v1/me/preferences')
      expect(((await stored.json()) as { default_model: string | null }).default_model).toBe(chosen)

      // And a chat started with no flags runs it — `--model` is the only thing that overrides.
      const terminal = new Terminal('oh-qa-c17', 100, 30)
      terminal.start()
      try {
        terminal.run(ohCommand())
        await terminal.waitFor(/sesn_[A-Z0-9]+/, 30_000)
        await terminal.waitForIdle()
        expect(terminal.capture()).toContain(chosen)
      } finally {
        terminal.kill()
      }
    } finally {
      await setDefaultModel(request, previous)
    }
  })
})
