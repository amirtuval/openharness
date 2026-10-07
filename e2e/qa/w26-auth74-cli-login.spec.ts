import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  BASE_URL,
  LONG_REPLY_PROMPT,
  QA_MODEL,
  createAgent,
  expect,
  isRealModel,
  shot,
  test,
  uniqueName,
} from './support'
import {
  CLI_CONFIG_HOME,
  CLI_LOGIN_HINT,
  CLI_SERVER,
  Terminal,
  cliCredentialsMode,
  cliCredentialsPath,
  ensureCliSignedIn,
  forgetCliCredentials,
  loggedInAs,
  modeOf,
  oh,
  ohCommand,
  ohCommandIn,
  openDevicePage,
  replyHasText,
  scratchConfigHome,
  sendAndAwaitAnswer,
} from './tmux'

/**
 * W26 — §10 of the #74 QA pass (epic #65, A6): `oh login` and friends.
 *
 * The whole device flow, hands-on: the command before any token exists, the URL and code it
 * prints, the approval a person makes in the browser (the same code on both screens), the
 * credential file's permissions, `whoami`, a real chat, Ctrl+C and steering, logout revoking
 * the token server-side, the deny path, a wrong code, and Ctrl+C mid-poll.
 *
 * Needs `QA_WITH_CLI=1` (tmux + a built CLI). The chat scenarios run the pass's model; on the
 * mock they use `__slow__`, on a real provider they ask for numbers.
 */

/** The token `oh` stored for the server under test, if any. Never printed by an assertion. */
function storedToken(home: string): string | null {
  const file = path.join(home, 'openharness', 'credentials.json')
  if (!existsSync(file)) {
    return null
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    servers?: Record<string, string>
  }
  return parsed.servers?.[CLI_SERVER] ?? null
}

test.describe('W26 §10 oh login and friends', () => {
  test.skip(process.env.QA_WITH_CLI !== '1', 'set QA_WITH_CLI=1 to drive the oh CLI in tmux')
  test.setTimeout(300_000)

  test('W26a before login; the device login; the credential file; whoami', async ({
    context,
    page,
  }) => {
    await test.step('10.1 sessions before logging in', () => {
      const home = scratchConfigHome('w26-none')
      const before = oh(['sessions', '--server', CLI_SERVER], { configHome: home })
      expect(before.status).toBe(1)
      expect(before.stdout).toContain(`not signed in to ${CLI_SERVER}. Run \`oh login\`.`)
    })

    const terminal = new Terminal('oh-qa-w26a', 120, 24)
    const shotPage = await context.newPage()
    let loginUrl = ''
    let loginCode = ''
    terminal.start()
    try {
      await test.step('10.2 login prints the URL and the code', async () => {
        forgetCliCredentials()
        expect(cliCredentialsMode(), 'a clean slate').toBeNull()
        terminal.run(ohCommand('login', '--no-browser'))
        const hint = await terminal.waitFor(CLI_LOGIN_HINT, 30_000)
        loginUrl = hint[1] ?? ''
        loginCode = hint[2] ?? ''
        expect(loginUrl).toBe(`${CLI_SERVER}/#/device?user_code=${loginCode}`)
        await terminal.screenshot(shotPage, 'w26-01-login-code')
      })

      await test.step('10.3 the page shows the same code; approve', async () => {
        await openDevicePage(page, loginUrl)
        await expect(page.getByRole('heading', { name: 'Approve a CLI login' })).toBeVisible()
        await expect(page.locator('[data-slot="device-user-code"]')).toHaveText(loginCode)
        await shot(page, 'w26-02-device-page')
        await page.getByRole('button', { name: 'Approve' }).click()
        await expect(page.getByText('Approved')).toBeVisible()
      })

      await test.step('10.4 back in the terminal: logged in, file modes 0600/0700', async () => {
        const email = await loggedInAs(terminal)
        // §10.4 expects `dev@localhost`, the documented spelling a person types. The account
        // row is stored as `dev@localhost.localdomain` (Better Auth's email validation refuses
        // a dotless domain; server AGENTS.md, A7), and both frontends display the stored
        // spelling — the CLI here, the web sidebar too (verified in this pass). Consistent,
        // but a rough edge worth knowing: only the documented local door prints the other one.
        expect(email).toBe('dev@localhost.localdomain')
        expect(terminal.capture()).toContain(
          `Logged in as dev@localhost.localdomain on ${CLI_SERVER}`,
        )
        await terminal.waitForShellPrompt()
        await terminal.screenshot(shotPage, 'w26-03-logged-in')
        expect(cliCredentialsMode()).toBe(0o600)
        expect(modeOf(path.dirname(cliCredentialsPath()))).toBe(0o700)
      })

      await test.step('10.5 whoami', () => {
        const whoami = oh(['whoami', '--server', CLI_SERVER])
        expect(whoami.status).toBe(0)
        // The server is the one the command named, not the CLI's default (#192).
        expect(whoami.stdout).toMatch(
          new RegExp(`^Logged in as dev@localhost\\.localdomain on ${CLI_SERVER}`),
        )
      })
    } finally {
      terminal.kill()
      await shotPage.close()
    }
  })

  test('W26b a real chat from oh; Ctrl+C mid-reply, then a steer', async ({ context, request }) => {
    const terminal = new Terminal('oh-qa-w26b', 100, 30)
    const shotPage = await context.newPage()
    await ensureCliSignedIn(shotPage)
    terminal.start()
    try {
      // An agent on the pass's model, so the CLI chat runs the real provider.
      const agent = await createAgent(request, {
        name: uniqueName('QA W26 oh chat'),
        model: QA_MODEL,
        system: 'Answer in one short sentence.',
      })

      await test.step('10.6 a chat that streams, visible in the web app', async () => {
        terminal.run(ohCommand('--agent', agent.id))
        await terminal.waitForIdle()
        await sendAndAwaitAnswer(terminal, 'a first message from the oh CLI')
        await terminal.waitForIdle()
        expect(terminal.capture()).toContain('you › a first message from the oh CLI')
        await terminal.screenshot(shotPage, 'w26-04-oh-chat')

        // The session shows up in the web app as the signed-in dev user's — the newest row,
        // titled after the first message.
        await shotPage.goto('/#/')
        await shotPage.getByText('a first message from the oh CLI').first().click()
        await expect(shotPage.getByRole('log', { name: 'Conversation' })).toContainText(
          'a first message from the oh CLI',
        )
        await shot(shotPage, 'w26-05-visible-in-web')
      })

      await test.step('10.7 Ctrl+C mid-reply, then steer', async () => {
        await shotPage.goto('/#/')
        const prompt = isRealModel ? LONG_REPLY_PROMPT : '__slow__ a long reply from the CLI'
        await sendAndAwaitAnswer(terminal, prompt, { slow: !isRealModel })
        // Interrupt once the reply has text (a cursor alone is not a reply).
        await terminal.waitUntil((screen) => replyHasText(screen), 60_000)
        terminal.send('C-c')
        await terminal.waitForIdle(60_000)
        const partial = terminal.capture()
        expect(replyHasText(partial), 'the partial reply stays').toBe(true)
        await terminal.screenshot(shotPage, 'w26-06-interrupted')

        await sendAndAwaitAnswer(terminal, 'a short follow-up after the interrupt')
        await terminal.waitForIdle(60_000)
        expect(terminal.capture()).toContain('you › a short follow-up after the interrupt')
        expect(terminal.capture(), 'no error notice').not.toMatch(/\n\s*error:/)
        await terminal.screenshot(shotPage, 'w26-07-steered')
      })
    } finally {
      terminal.kill()
      await shotPage.close()
    }
  })

  test('W26c oh logout revokes the token server-side', async ({ page }) => {
    await ensureCliSignedIn(page)
    const token = storedToken(CLI_CONFIG_HOME)
    expect(token, 'a stored token to revoke').not.toBeNull()

    const logout = oh(['logout', '--server', CLI_SERVER])
    expect(logout.status).toBe(0)
    expect(logout.stdout).toContain(`Logged out of ${CLI_SERVER}.`)

    // Gone from the file, and the commands that needed it say how to get one back.
    expect(storedToken(CLI_CONFIG_HOME)).toBeNull()
    const after = oh(['whoami', '--server', CLI_SERVER])
    expect(after.status).toBe(1)
    expect(after.stdout).toContain(`not signed in to ${CLI_SERVER}. Run \`oh login\`.`)

    // Revoked server-side, not merely forgotten: the old token is refused with the 401
    // envelope (replayed by curl, in spirit — this is the same bearer request).
    const refused = await fetch(`${BASE_URL}/v1/me`, {
      headers: { authorization: `Bearer ${token ?? ''}` },
    })
    expect(refused.status).toBe(401)
    const body = (await refused.json()) as { error?: { type?: string } }
    expect(body.error?.type).toBe('authentication_error')
  })

  test('W26d the deny path: oh reports the denial and exits non-zero', async ({
    context,
    page,
  }) => {
    const home = scratchConfigHome('w26-deny')
    const terminal = new Terminal('oh-qa-w26d', 120, 24)
    const shotPage = await context.newPage()
    terminal.start()
    try {
      terminal.run(`${ohCommandIn(home, 'login', '--no-browser')}; echo "login-exit:$?"`)
      const hint = await terminal.waitFor(CLI_LOGIN_HINT, 30_000)
      const url = hint[1] ?? ''
      await openDevicePage(page, url)
      await expect(page.getByRole('heading', { name: 'Approve a CLI login' })).toBeVisible()
      await page.getByRole('button', { name: 'Deny' }).click()
      await expect(page.getByText('Denied')).toBeVisible()
      await shot(page, 'w26-08-denied')

      await terminal.waitFor(/the login was denied in the browser\./, 30_000)
      const exit = await terminal.waitFor(/login-exit:(\d+)/, 30_000)
      expect(exit[1]).not.toBe('0')
      await terminal.screenshot(shotPage, 'w26-09-denied-terminal')
      expect(
        existsSync(path.join(home, 'openharness', 'credentials.json')),
        'nothing was stored',
      ).toBe(false)
    } finally {
      terminal.kill()
      await shotPage.close()
    }
  })

  test('W26e the device page with a code the server never issued', async ({ page }) => {
    // Fixed by #80: the page used to drop the server's `400
    // {"error":"invalid_request","error_description":"Invalid user code"}` and show the
    // stand-in "The sign-in request failed."; it now reads the body and says so in a sentence.
    // The code alphabet is `[A-HJ-NP-Z2-9]{8}` (the server's own shape), so this is a
    // well-formed code nobody issued — the case a phishing terminal hits.
    await openDevicePage(page, `${BASE_URL}/#/device?user_code=ZZZZZZZZ`)
    await expect(page.getByText('Device login failed')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0)
    await expect(page.getByText('Approved')).toHaveCount(0)
    await shot(page, 'w26-10-wrong-code')
    await expect(page.getByRole('alert')).toContainText(/not one this server issued/i)
  })

  test('W26f Ctrl+C during the login poll writes no token', async ({ context }) => {
    const home = scratchConfigHome('w26-interrupt')
    const terminal = new Terminal('oh-qa-w26f', 120, 24)
    const shotPage = await context.newPage()
    terminal.start()
    try {
      terminal.run(ohCommandIn(home, 'login', '--no-browser'))
      await terminal.waitFor(CLI_LOGIN_HINT, 30_000)
      terminal.send('C-c')
      await terminal.waitForShellPrompt()
      const screen = terminal.capture()
      expect(screen, 'no stack trace').not.toMatch(/\n\s+at /)
      await terminal.screenshot(shotPage, 'w26-11-interrupted-poll')
      expect(
        existsSync(path.join(home, 'openharness', 'credentials.json')),
        'no token written',
      ).toBe(false)
    } finally {
      terminal.kill()
      await shotPage.close()
    }
  })
})
