import { execFileSync } from 'node:child_process'

import type { APIRequestContext } from '@playwright/test'

import { ensureDefaultModel, expect, shot, test } from './support'
import { ensureCliSignedIn, expectNoErrorNotice, ohCommand, Terminal } from './tmux'

/**
 * Subagents in `oh`, hands-on (epic #340, S9; issue #347).
 *
 * The terminal half of the epic's UX, driven through the **built** `oh` in a real pseudo-terminal
 * against a mock-model stack:

 * - a task is a **card** in the transcript — its type and description, its status, the messages
 *   between the parent and the child, and the result folded in;
 * - **`/agents`** lists the chat's tasks, switches into one and back, and stops one;
 * - a task's own chat is a full chat: a breadcrumb line, the normal composer, **Esc** to stop the
 *   turn and typing to steer or continue;
 * - **`oh modes`** marks a subagent type and shows the description read-only.
 *
 * Everything a task does is the mock model's markers (`apps/server/AGENTS.md`), which is why the
 * stack has to run with `OPENHARNESS_TEST_MODEL=mock` — the same stack `cli.spec.ts` uses:
 *
 * ```bash
 * OPENHARNESS_DEV_LOGIN=1 OPENHARNESS_TEST_MODEL=mock docker compose up --build -d
 * yarn turbo run build --filter=@openh/cli...
 * QA_WITH_CLI=1 yarn qa:web qa/cli-subagents.spec.ts
 * ```
 *
 * Opt-in with `QA_WITH_CLI=1`, and skipped on a real provider: every scenario here leans on the
 * mock's markers and its echo, which no provider has.
 */

const isRealModel = process.env.QA_MODEL !== undefined

/** The peer the mock answers with, and the type the helper is started as. */
const TYPE = 'general-purpose'

/** What a chat's first message and the parent's own turn are: the marker plus a prompt. */
const PROMPT = 'Report the tail of the log'

test.describe('cli subagents (#340, S9; #347)', () => {
  test.skip(process.env.QA_WITH_CLI !== '1', 'set QA_WITH_CLI=1 to drive the oh CLI in tmux')
  test.skip(isRealModel, 'the mock markers and the mock echo are what these scenarios drive')
  test.setTimeout(300_000)

  test('a task is a card, /agents switches into it, Esc stops it, and it goes back', async ({
    context,
    request,
  }) => {
    const terminal = new Terminal('oh-qa-a7', 100, 30)
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    terminal.start()

    try {
      const parentHandle = (await startChat(terminal, request)).slice(-6)

      // 1. Start a helper. The card appears where the `agent` call was.
      send(terminal, `__agent__ ${TYPE} | ${PROMPT}`)
      await terminal.waitFor(new RegExp(`· ${TYPE} · ${PROMPT}`), 60_000)
      await terminal.screenshot(shot, 'a7-01-card-running')

      // 2. The child runs its own turn and its result folds into the card. (A helper the mock
      // answers finishes in a blink, which is why the *running* state is the other scenario's —
      // its child streams for ten seconds.)
      await terminal.waitFor(new RegExp(`● done · ${TYPE}`), 90_000)
      const finished = terminal.capture(400)
      expect(finished).toContain(`⎿ ${PROMPT}`)
      await terminal.screenshot(shot, 'a7-02-card-done')

      // 3. /agents lists it, with the row marked and the panel's own keys named.
      send(terminal, '/agents')
      await terminal.waitFor(/Agents/, 15_000)
      await terminal.waitFor(new RegExp(`❯ ● done · ${TYPE}: ${PROMPT}`), 15_000)
      expect(terminal.capture()).toContain('Enter open · s stop')
      await terminal.screenshot(shot, 'a7-03-agents-list')

      // 4. Enter switches into the task's own chat: a breadcrumb, and its own conversation.
      terminal.send('Enter')
      // The breadcrumb is the chain from the root chat down to this one; the parent's title is
      // its first message, so the line reads `<the marker…> › …`. Nothing else draws a `›`
      // between two chat titles, which is what makes this the breadcrumb rather than the prompt.
      await terminal.waitFor(/__agent__[^\n]* › /, 30_000)
      await terminal.waitFor(new RegExp(PROMPT), 15_000)
      await terminal.screenshot(shot, 'a7-04-child-chat')

      // 5. Steer it, and read its answer — the child's own composer works like any chat's.
      send(terminal, 'one more pass over the tail')
      await terminal.waitUntil(
        (screen) => countOf(screen, 'one more pass over the tail') >= 2,
        60_000,
      )

      // 6. Esc stops the child's turn: the one key a reader has over a helper (S1).
      send(terminal, '__slow__ keep going')
      await terminal.waitFor(/part 1\/40/, 60_000)
      terminal.send('Escape')
      await terminal.waitFor(/Interrupted/, 30_000)
      await terminal.screenshot(shot, 'a7-05-child-interrupted')

      // 7. Continue it after the stop: the child is a chat like any other.
      send(terminal, 'carry on then')
      await terminal.waitUntil((screen) => countOf(screen, 'carry on then') >= 2, 60_000)

      // 8. Back to the parent: /agents again, and its first row goes up.
      send(terminal, '/agents')
      await terminal.waitFor(/‹ back to /, 15_000)
      await terminal.screenshot(shot, 'a7-06-back-row')
      terminal.send('Enter')
      await terminal.waitFor(new RegExp(`${parentHandle}`), 30_000)
      // The breadcrumb is gone: this is a top-level chat again.
      await terminal.waitUntil((screen) => !/__agent__[^\n]* › /.test(screen), 15_000)

      expectNoErrorNotice(terminal.capture(400))
      await quit(terminal)
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('a task is stopped from the list', async ({ context, request }) => {
    const terminal = new Terminal('oh-qa-a7b', 100, 30)
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    terminal.start()

    try {
      await startChat(terminal, request)
      // A helper that does not finish on its own: `__slow__` streams for about ten seconds.
      send(terminal, `__agent__ ${TYPE} | __slow__ think about it`)
      await terminal.waitFor(new RegExp(`◐ running · ${TYPE} · __slow__`), 60_000)

      send(terminal, '/agents')
      await terminal.waitFor(/Agents/, 15_000)
      await terminal.waitFor(new RegExp(`running · ${TYPE}: __slow__`), 15_000)
      await terminal.screenshot(shot, 'a7-07-stop-before')

      // `s` stops the highlighted task: one `user.interrupt` to the child session. The child's
      // turn-end is then a **stop**, so the row reads `stopped` rather than the `done` an `idle`
      // delivery would draw (S7; #348) — and the delivery is what the parent's log now holds.
      terminal.send('s')
      await terminal.waitFor(/Stopped general-purpose — its turn ended where it got to\./, 30_000)
      await terminal.waitFor(new RegExp(`stopped · ${TYPE}: __slow__ think about it`), 30_000)
      await terminal.screenshot(shot, 'a7-08-stop-after')

      expectNoErrorNotice(terminal.capture(400))
      await quit(terminal)
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('a helper is nested: oh sessions lists the chat, not the child (A12)', async ({
    context,
    request,
  }) => {
    const terminal = new Terminal('oh-qa-a7d', 120, 30)
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    terminal.start()

    try {
      const parentHandle = (await startChat(terminal, request)).slice(-6)
      send(terminal, `__agent__ ${TYPE} | ${PROMPT}`)
      await terminal.waitFor(new RegExp(`● done · ${TYPE}`), 90_000)
      const parent = await newestSession(request)

      // The child is a real session, but not a chat of its own: `oh sessions` — which reads
      // `GET /v1/sessions` with no parent filter — shows the chat that started it and not it
      // (S3, S12's web half is the sidebar's).
      const listed = ohSessions(request)
      expect(await listed).toContain(` ${parentHandle}`)
      const children = await childrenOf(request, parent)
      expect(children.length, 'the helper exists as a session').toBe(1)
      for (const child of children) {
        expect(await listed, 'the helper is not a top-level chat').not.toContain(child.slice(-6))
      }
      await terminal.screenshot(shot, 'a8-01-oh-sessions-nested')
      expectNoErrorNotice(terminal.capture(400))
      await quit(terminal)
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('the two clients agree: a helper started in oh is on the web, and back (A15)', async ({
    context,
    request,
  }) => {
    const terminal = new Terminal('oh-qa-a7e', 120, 30)
    const web = await context.newPage()
    await ensureCliSignedIn(web)
    terminal.start()

    try {
      await startChat(terminal, request)
      send(terminal, `__agent__ ${TYPE} | ${PROMPT}`)
      await terminal.waitFor(new RegExp(`● done · ${TYPE}`), 90_000)
      const parent = await newestSession(request)
      const child = (await childrenOf(request, parent))[0]
      expect(child, 'oh started a helper').toBeDefined()

      // A helper started from the terminal is a card on the web, and the card opens its child as
      // a full chat — both clients read the same log, so both show the same thing (S9).
      await web.goto(`/#/s/${parent}`)
      const card = web.locator('[data-slot="task-card"]').first()
      await expect(card).toBeVisible()
      await expect(card).toHaveAttribute('data-type', TYPE)
      await expect(card.locator('[data-slot="task-status"]')).toHaveText('done')
      await shot(web, 'a8-02-web-card-from-oh')
      await card.getByRole('link', { name: 'Open' }).click()
      await expect(web).toHaveURL(new RegExp(child ?? ''))
      await expect(web.locator('[data-slot="subagent-header"]')).toBeVisible()
      await shot(web, 'a8-03-web-child-from-oh')

      // …and the other way: the same chat, opened in `oh`, draws the same card for it.
      send(terminal, '/agents')
      await terminal.waitFor(/Agents/, 15_000)
      await terminal.waitFor(
        new RegExp(`done · ${TYPE}: __slow__|done · ${TYPE}: ${PROMPT}`),
        15_000,
      )
      await terminal.screenshot(web, 'a8-04-oh-agents-same-task')
      expectNoErrorNotice(terminal.capture(400))
      await quit(terminal)
    } finally {
      terminal.kill()
      await web.close()
    }
  })

  test('the card and /agents hold at 120 and at 80 columns (A16)', async ({ context, request }) => {
    const terminal = new Terminal('oh-qa-a7f', 120, 30)
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    terminal.start()

    try {
      await startChat(terminal, request)
      send(terminal, `__agent__ ${TYPE} | ${PROMPT}`)
      await terminal.waitFor(new RegExp(`● done · ${TYPE}`), 90_000)
      await terminal.screenshot(shot, 'a8-05-card-120')

      send(terminal, '/agents')
      await terminal.waitFor(/Agents/, 15_000)
      await terminal.screenshot(shot, 'a8-06-agents-120')

      // Narrower than the card's own line: it has to wrap rather than be cut off — the card is
      // chrome the reader still has to be able to read at a small terminal (S9).
      terminal.resize(80, 30)
      await terminal.waitFor(/Agents/, 15_000)
      await terminal.screenshot(shot, 'a8-07-agents-80')
      terminal.send('Escape')
      await terminal.waitUntil((screen) => !screen.includes('Esc done'), 10_000)
      await terminal.screenshot(shot, 'a8-08-card-80')
      expectNoErrorNotice(terminal.capture(400))
      await quit(terminal)
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('a child’s output cannot drive the reader’s terminal (#368)', async ({
    context,
    request,
  }) => {
    const name = 'oh-qa-a7g'
    const terminal = new Terminal(name, 100, 30)
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    terminal.start()

    try {
      await startChat(terminal, request)
      // The mock echoes its prompt, so a prompt carrying the sequences is a **reply** carrying
      // them — and the reply is what a card folds in and draws. Two of the real attacks: an OSC
      // that renames the pane, and a CSI that clears it.
      const marker = 'qaescape'
      send(terminal, `__agent__ ${TYPE} | ${marker} \u001b]0;pwned\u0007\u001b[2J tail`)
      await terminal.waitFor(new RegExp(`● done · ${TYPE}`), 90_000)

      const screen = terminal.capture(400)
      // Drawn as plain text: nothing was cleared (the chat above the card is still on screen)
      // and the printable tail came through.
      expect(screen).toContain(marker)
      expect(screen).toContain('tail')
      // The title the OSC would have rewritten is untouched.
      expect(paneTitle(name)).not.toContain('pwned')
      expectNoErrorNotice(screen)
      await terminal.screenshot(shot, 'a7-10-sanitized-output')
      await quit(terminal)
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('oh modes marks a subagent type and shows its description', async ({ context, request }) => {
    // Wide enough that the description is one line: a terminal wraps a long line at column 0,
    // which would split the sentence the assertion is about.
    const terminal = new Terminal('oh-qa-a7c', 200, 30)
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)

    // A type is a mode with a description (#342), and `oh` does not create one: the web app's
    // Settings → Modes does. This is the same write it makes.
    const description = 'Researches a question on the web and reports sources.'
    await createSubagentType(request, 'researcher-a7', description)

    try {
      terminal.start()
      terminal.run(ohCommand('modes'))
      await terminal.waitFor(/researcher-a7/, 60_000)
      const screen = terminal.capture(400)
      expect(screen).toContain('subagent type')
      expect(screen).toContain(description)
      expect(screen).toContain('read-only')
      await terminal.screenshot(shot, 'a7-09-oh-modes')
      expectNoErrorNotice(terminal.capture())
    } finally {
      terminal.kill()
      await shot.close()
    }
  })
})

/**
 * Start `oh` in the terminal and wait for the chat it opens.
 *
 * The same step `cli.spec.ts` takes: a bare `oh` starts on the account's default model, so the
 * account is given one first (`PUT /v1/me/preferences`, the write Settings → Default model
 * makes), and the wait is for the status line — which names the session it created.
 */
async function startChat(terminal: Terminal, request: APIRequestContext): Promise<string> {
  const model = await ensureDefaultModel(request)
  terminal.run(ohCommand())
  // The status line draws the session as a shortened handle — `sesn_…S76VM6` — which is what a
  // reader recognises it by (that is what the status line is for); the toast below the regex is
  // that handle as it is on screen.
  const handle = (await terminal.waitFor(/sesn_[^\s]+/, 30_000))[0] ?? ''
  await terminal.waitForIdle()
  expect(terminal.capture()).toContain(model)
  return handle
}

/** Type a line into the prompt and send it. */
function send(terminal: Terminal, text: string): void {
  terminal.type(text)
  terminal.send('Enter')
}

/** How many times `text` has been written at the start of a line since the pane's first row. */
function countOf(screen: string, text: string): number {
  const first = (text.split('\n')[0] ?? '').trim()
  return `\n${screen}`.split(`\n${first}`).length - 1
}

/**
 * Leave the chat the way the second idle Ctrl+C does, and wait for the shell back.
 *
 * The first Esc is for a flow that may still own the input area — the `/agents` list is up until
 * it is left, and the Ctrl+C after it is the chat's again.
 */
async function quit(terminal: Terminal): Promise<void> {
  if (terminal.capture().includes('Esc done')) {
    terminal.send('Escape')
    await terminal.waitUntil((screen) => !screen.includes('Esc done'), 10_000)
  }
  // A deliberate beat between keys: a terminal sends a lone `ESC` and the byte after it in one
  // read, and Ink reads that pair as one meta sequence — so an `Escape` and the Ctrl+C behind it
  // sent together are a keystroke neither of them. (The same reason `cli.spec.ts` pauses after a
  // resize.)
  await new Promise((resolve) => setTimeout(resolve, 300))
  terminal.send('C-c')
  await terminal.waitFor(/Press Ctrl\+C again to exit\./, 15_000)
  terminal.send('C-c')
  await terminal.waitFor(/Resume this session with: oh -s sesn_[A-Z0-9]+/, 15_000)
  await terminal.waitForShellPrompt()
}

/** The full id of the newest chat — the one `oh` is showing as a shortened handle. */
async function newestSession(request: APIRequestContext): Promise<string> {
  const response = await request.get('/v1/sessions', { params: { limit: 1 } })
  expect(response.status(), await response.text()).toBe(200)
  const body = (await response.json()) as { data: { id: string }[] }
  return body.data[0]?.id ?? ''
}

/** One session's children, through the read the sidebar's nesting makes (S3). */
async function childrenOf(request: APIRequestContext, parentId: string): Promise<string[]> {
  const response = await request.get('/v1/sessions', {
    params: { limit: 100, parent_session_id: parentId },
  })
  expect(response.status(), await response.text()).toBe(200)
  const body = (await response.json()) as { data: { id: string }[] }
  return body.data.map((session) => session.id)
}

/** What `oh sessions` would list: every top-level chat, newest first, as shortened handles. */
async function ohSessions(request: APIRequestContext): Promise<string> {
  const response = await request.get('/v1/sessions', { params: { limit: 100 } })
  expect(response.status(), await response.text()).toBe(200)
  const body = (await response.json()) as { data: { id: string }[] }
  return body.data.map((session) => ` ${session.id.slice(-6)}`).join(' ')
}

/** Create a mode that carries a description — a **subagent type** (epic #340, S2; #342). */
async function createSubagentType(
  request: APIRequestContext,
  name: string,
  description: string,
): Promise<void> {
  const response = await request.post('/v1/me/modes', {
    data: { name, model: 'my-default-model', subagent_description: description },
  })
  // A name is unique per user, so a second run of the pass reuses what the first one made.
  expect([201, 409]).toContain(response.status())
}

/** The tmux pane's own title — what an unsanitised OSC 0 would have rewritten (#368). */
function paneTitle(session: string): string {
  return execFileSync('tmux', ['display-message', '-p', '-t', session, '#{pane_title}'], {
    encoding: 'utf8',
  })
}
