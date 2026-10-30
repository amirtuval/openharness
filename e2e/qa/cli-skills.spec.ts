import type { APIRequestContext } from '@playwright/test'

import {
  CANDIDATE_PATHS,
  SKILLS_FILES,
  SKILLS_FILES_CHANGED,
  skillsFixtureAvailable,
  startSkillsRepo,
  type SkillsRepo,
} from './skills-fixture'
import {
  createChat,
  expect,
  QA_MODEL,
  isRealModel,
  readEvents,
  setDefaultModel,
  test,
} from './support'
import {
  Terminal,
  ensureCliSignedIn,
  expectNoErrorNotice,
  ohAsync,
  ohCommand,
  sendAndAwaitAnswer,
} from './tmux'

/**
 * C-skills — the `oh` half of the skills pass (epic #349; issue #355).
 *
 * The same cases `w30-skills.spec.ts` drives in a browser, driven the way the terminal does
 * them: the built `oh` binary for everything (`oh skills`, `oh skills add <url> --name …`,
 * `oh skills refresh <name>`, `oh skills enable|disable|remove <name>`), a real pseudo-terminal
 * for the two screens the reader types into (the import pick, and the `/` menu in a chat).
 * Nothing here goes through `@openharness/client` directly — that is the point of the file: the
 * library is what the web spec already exercises, and a CLI bug lives between the two.
 *
 * Opt-in with `QA_WITH_CLI=1` (it needs `tmux` and a built `apps/tui`), the same gate
 * `cli.spec.ts` uses, and it needs the fixture's stack settings — `OPENHARNESS_TEST_MODEL=mock`,
 * `OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS=1` and `NODE_EXTRA_CA_CERTS` — exactly as the web
 * half does (`e2e/AGENTS.md`).
 *
 * Real-model cases (S4, S7) skip unless a real model is named; S5 is a hands-on pass, for the
 * reason `w30-skills.spec.ts` gives.
 */

let repo: SkillsRepo | null = null

/**
 * The fixture repository, started once per worker — and started again by a worker a failed
 * test restarted, which is the state each scenario wants anyway (a scenario that moves the
 * branch resets it first).
 */
async function ensureRepo(): Promise<SkillsRepo> {
  repo ??= await startSkillsRepo()
  return repo
}

/** Empty the account's skills and chats, so a scenario starts from the state it describes. */
async function cleanAccount(request: APIRequestContext): Promise<void> {
  const skills = await request.get('/v1/me/skills')
  for (const skill of ((await skills.json()) as { data: { id: string }[] }).data) {
    await request.delete(`/v1/me/skills/${skill.id}`)
  }
  const sessions = await request.get('/v1/sessions?limit=100')
  for (const session of ((await sessions.json()) as { data: { id: string }[] }).data) {
    await request.delete(`/v1/sessions/${session.id}`)
  }
  // Modes too: a scenario creates one by a fixed name, and a name is unique among the
  // account's modes — a leftover from an earlier run would make the create a 409.
  const modes = await request.get('/v1/me/modes')
  for (const mode of ((await modes.json()) as { data: { id: string }[] }).data) {
    await request.delete(`/v1/me/modes/${mode.id}`)
  }
}

/** The names of the account's skills, sorted. */
async function storedSkills(request: APIRequestContext): Promise<string[]> {
  const response = await request.get('/v1/me/skills')
  const data = ((await response.json()) as { data: { name: string }[] }).data
  return data.map((skill) => skill.name).sort()
}

/** Empty the prompt line, one Backspace at a time — what a reader's own finger would do. */
async function clearLine(terminal: Terminal, presses: number): Promise<void> {
  for (let press = 0; press < presses; press += 1) {
    terminal.send('BSpace')
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
}

/** The id of the newest chat the account has — the one a just-started `oh` created. */
async function newestSession(request: APIRequestContext): Promise<string> {
  const response = await request.get('/v1/sessions?limit=1')
  const data = ((await response.json()) as { data: { id: string }[] }).data
  expect(data[0], 'a chat exists to read the log of').toBeDefined()
  return data[0]?.id ?? ''
}

/** Every stored `session.skill_loaded` of a session, oldest first. */
async function loadedSkills(
  request: APIRequestContext,
  sessionId: string,
): Promise<{ name: string; content: string }[]> {
  return (await readEvents(request, sessionId))
    .filter((event) => event.type === 'session.skill_loaded')
    .map((event) => event as unknown as { name: string; content: string })
}

/** Wait until a session holds `count` loaded skills — `waitForIdle` passes vacuously between two sends. */
async function waitForLoaded(
  request: APIRequestContext,
  sessionId: string,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    if ((await loadedSkills(request, sessionId)).length >= count) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`session ${sessionId} never loaded ${String(count)} skills`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

test.describe('cli skills scenarios', () => {
  test.skip(process.env.QA_WITH_CLI !== '1', 'set QA_WITH_CLI=1 to drive the oh CLI in tmux')

  test.afterAll(async () => {
    await repo?.close()
    repo = null
  })

  test('CS1 `oh skills add` previews, picks interactively, and `--name`/`--all` both work', async ({
    context,
    request,
  }) => {
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    test.setTimeout(240_000)
    await cleanAccount(request)
    const url = (await ensureRepo()).url
    const terminal = new Terminal('oh-qa-skills-add')
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    terminal.start()

    try {
      await test.step('a bare `oh skills` says there is nothing yet', async () => {
        const listed = await ohAsync(['skills'])
        expect(listed.status, listed.stdout).toBe(0)
        expect(listed.stdout).toContain('No skills yet')
      })

      await test.step('`--name` is the non-interactive import, and prints the preview', async () => {
        const imported = await ohAsync(['skills', 'add', url, '--name', 'release-notes'])
        expect(imported.status, imported.stdout).toBe(0)
        // The preview's own heading names where the clone landed and at which commit…
        expect(imported.stdout).toContain(`Import from ${url} @ `)
        // …every candidate is a line, and the ones that cannot be imported say so…
        expect(imported.stdout).toContain('+ release-notes')
        expect(imported.stdout).toContain('! huge-skill')
        expect(imported.stdout).toContain('cannot be imported')
        // …with the server's own reasons under them.
        expect(imported.stdout).toContain('the limit is 20.0 KB')
        expect(imported.stdout).toContain('built-in command')
        expect(imported.stdout).toContain('Imported release-notes.')
        expect(await storedSkills(request)).toEqual(['release-notes'])
      })

      await test.step('`--name` for a candidate that cannot be imported is refused', async () => {
        const refused = await ohAsync(['skills', 'add', url, '--name', 'compact'])
        expect(refused.status).toBe(1)
        expect(refused.stdout).toContain('cannot be imported')
        expect(refused.stdout).toContain('built-in command')
        // Nothing was stored.
        expect(await storedSkills(request)).toEqual(['release-notes'])
      })

      await test.step('`--name` for a name the repository does not offer is refused', async () => {
        const refused = await ohAsync(['skills', 'add', url, '--name', 'not-a-candidate'])
        expect(refused.status).toBe(1)
        expect(refused.stdout).toContain('no skill named not-a-candidate')
        expect(refused.stdout).toContain('the preview found')
      })

      await test.step('the listing names each skill, its state, its source and its commit', async () => {
        const listed = await ohAsync(['skills'])
        expect(listed.status, listed.stdout).toBe(0)
        expect(listed.stdout).toContain('release-notes  on')
        expect(listed.stdout).toContain(url)
        expect(listed.stdout).toContain('Writes the release notes')
      })

      await test.step('the pick: `a` takes them all, Enter imports', async () => {
        // A terminal, so `oh skills add` with no name and no `--all` opens the pick instead of
        // refusing.
        terminal.run(ohCommand('skills', 'add', url))
        await terminal.waitFor(/Import from .*skills\.git @ /, 60_000)
        // The pick is a screen of its own, and it is mounted a moment after the preview is
        // printed — a key sent before then reaches a process still drawing the lines above.
        await terminal.waitFor(/space choose · a all/, 30_000)
        expect(terminal.capture()).toContain('cannot be imported')
        expect(terminal.capture()).toContain('you already have a skill with this name')
        await terminal.screenshot(shot, 'cs1-01-pick')

        // Ink writes the frame during React's commit but subscribes `useInput` in the
        // passive-effect flush after it, so a key sent the instant a screen appears is a key
        // nobody hears (`apps/tui/AGENTS.md`). The mark is what says the key landed.
        await terminal.waitFor(/space choose · a all/, 30_000)
        await new Promise((resolve) => setTimeout(resolve, 500))
        for (let press = 0; press < 3; press += 1) {
          terminal.send('a')
          await new Promise((resolve) => setTimeout(resolve, 400))
          if (terminal.capture().includes('◉')) {
            break
          }
        }
        expect(terminal.capture(), '`a` chose every importable candidate').toContain('◉')
        terminal.send('Enter')
        await terminal.waitFor(/Imported 2 skills: house-style, summarize-thread\./, 60_000)
        await terminal.waitForShellPrompt()
        await terminal.screenshot(shot, 'cs1-02-imported')
        expect(await storedSkills(request)).toEqual([
          'house-style',
          'release-notes',
          'summarize-thread',
        ])
      })

      await test.step('`--all` on a repository already imported refuses, and says why', async () => {
        const again = await ohAsync(['skills', 'add', url, '--all'])
        expect(again.status).toBe(1)
        // Every importable candidate's name is taken, so the store refuses the batch.
        expect(again.stdout.toLowerCase()).toContain('already')
      })
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('CS2 a browse URL is split into a ref and a folder', async ({ request }) => {
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    test.setTimeout(120_000)
    await cleanAccount(request)
    const browse = (await ensureRepo()).browse(CANDIDATE_PATHS['house-style'])

    const imported = await ohAsync(['skills', 'add', browse, '--name', 'house-style'])
    expect(imported.status, imported.stdout).toBe(0)
    // The heading names the repository, the ref and the folder the browse URL was split into —
    // and never the `/tree/…` half as part of the repository.
    expect(imported.stdout).toContain('/org/skills.git · main · skills/house-style')
    expect(imported.stdout).not.toContain('/tree/')
    expect(imported.stdout).toContain('Imported house-style.')
    expect(await storedSkills(request)).toEqual(['house-style'])
  })

  test('CS9 `oh skills refresh` shows the changes and replaces only on a yes', async ({
    request,
  }) => {
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    test.setTimeout(180_000)
    const fixture = await ensureRepo()
    // Back to the starting point, so "nothing upstream" is true whatever ran before this.
    await fixture.commit(SKILLS_FILES, 'back to the starting point')
    await cleanAccount(request)
    const url = fixture.url
    expect((await ohAsync(['skills', 'add', url, '--name', 'release-notes'])).status).toBe(0)
    const importedAt = await fixture.head()

    // A chat that loads the skill **before** anything moves: it is the "older chat" the last
    // step reads back, and the body it loaded is the one it must still hold afterwards. The
    // turn has to have run before the push — the brain loads a skill at its request boundary,
    // from the snapshot as it is then.
    const chat = await createChat(request, 'anthropic/claude-sonnet-5')
    const invocation = await request.post(`/v1/sessions/${chat.id}/events`, {
      data: {
        events: [
          {
            type: 'user.message',
            content: [{ type: 'text', text: '/release-notes v0.9' }],
            skill: { name: 'release-notes', arguments: 'v0.9' },
          },
        ],
      },
    })
    expect(invocation.status(), await invocation.text()).toBe(200)
    await waitForLoaded(request, chat.id, 1)

    await test.step('nothing upstream is "already up to date"', async () => {
      const unchanged = await ohAsync(['skills', 'refresh', 'release-notes'])
      expect(unchanged.status, unchanged.stdout).toBe(0)
      expect(unchanged.stdout).toContain(`Already up to date at ${importedAt.slice(0, 7)}.`)
    })

    await fixture.commit(SKILLS_FILES_CHANGED, 'more release-note detail')
    const movedTo = await fixture.head()

    await test.step('the diff is printed, and a declined confirm replaces nothing', async () => {
      // Standard input is not a terminal for this run, so `oh` prints the confirm as a line and
      // reads the answer — and an EOF is not a yes.
      const declined = await ohAsync(['skills', 'refresh', 'release-notes'])
      expect(declined.status, declined.stdout).toBe(0)
      expect(declined.stdout).toContain('1 file added')
      expect(declined.stdout).toContain('1 file removed')
      expect(declined.stdout).toContain('1 file changed')
      expect(declined.stdout).toContain('references/format.md')
      expect(declined.stdout).toContain('scripts/publish.sh')
      // The unified diff of `SKILL.md`, with its `+`/`-` lines.
      expect(declined.stdout).toContain('newest first')
      expect(declined.stdout).toContain('Not refreshed.')

      // The snapshot still names the commit it was imported at.
      const listed = await ohAsync(['skills'])
      expect(listed.stdout).toContain(importedAt.slice(0, 7))
      expect(listed.stdout).not.toContain(movedTo.slice(0, 7))
    })

    await test.step('`--yes` confirms, and the snapshot moves to the previewed commit', async () => {
      const confirmed = await ohAsync(['skills', 'refresh', 'release-notes', '--yes'])
      expect(confirmed.status, confirmed.stdout).toBe(0)
      expect(confirmed.stdout).toContain(`Refreshed release-notes to ${movedTo.slice(0, 7)}.`)
      const listed = await ohAsync(['skills'])
      expect(listed.stdout).toContain(movedTo.slice(0, 7))
    })

    await test.step('a chat that loaded the skill before the refresh replays unchanged', async () => {
      const loaded = await loadedSkills(request, chat.id)
      expect(loaded[0]?.content).toContain('Write the release notes for v0.9')
      expect(loaded[0]?.content, 'the pre-refresh body, not the new one').not.toContain(
        'newest first',
      )
    })
  })

  test('CS10 `oh skills enable`, `disable` and `remove`', async ({ request }) => {
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    test.setTimeout(120_000)
    await cleanAccount(request)
    const url = (await ensureRepo()).url
    expect((await ohAsync(['skills', 'add', url, '--name', 'summarize-thread'])).status).toBe(0)

    const off = await ohAsync(['skills', 'disable', 'summarize-thread'])
    expect(off.status, off.stdout).toBe(0)
    expect(off.stdout).toContain('summarize-thread is off.')
    expect((await ohAsync(['skills'])).stdout).toContain('summarize-thread  off  command only')

    // A skill that is off is refused as an invocation, and nothing is stored.
    const session = await createChat(request, 'anthropic/claude-sonnet-5')
    const refused = await request.post(`/v1/sessions/${session.id}/events`, {
      data: {
        events: [
          {
            type: 'user.message',
            content: [{ type: 'text', text: '/summarize-thread the thread' }],
            skill: { name: 'summarize-thread', arguments: 'the thread' },
          },
        ],
      },
    })
    expect(refused.status(), await refused.text()).toBe(400)

    const on = await ohAsync(['skills', 'enable', 'summarize-thread'])
    expect(on.status, on.stdout).toBe(0)
    expect(on.stdout).toContain('summarize-thread is on.')

    const removed = await ohAsync(['skills', 'remove', 'summarize-thread', '--yes'])
    expect(removed.status, removed.stdout).toBe(0)
    expect(removed.stdout).toContain('Removed summarize-thread.')
    expect(await storedSkills(request)).toEqual([])
    expect((await ohAsync(['skills'])).stdout).toContain('No skills yet')
  })

  test('CS6+CS8 the `/` menu in a chat: the rows, the hint, the send, and the flags', async ({
    context,
    request,
  }) => {
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    test.setTimeout(240_000)
    await cleanAccount(request)
    const url = (await ensureRepo()).url
    expect((await ohAsync(['skills', 'add', url, '--name', 'release-notes'])).status).toBe(0)
    expect((await ohAsync(['skills', 'add', url, '--name', 'house-style'])).status).toBe(0)
    expect((await ohAsync(['skills', 'add', url, '--name', 'summarize-thread'])).status).toBe(0)

    const terminal = new Terminal('oh-qa-skills-chat', 100, 30)
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    terminal.start()

    try {
      // The **model this pass names**, not whatever the catalog would put first: a real-model
      // pass on a stack with two credentials must chat on the one `QA_MODEL` names.
      await setDefaultModel(request, QA_MODEL)
      terminal.run(ohCommand())
      // The status line shortens the session id in the middle (`sesn_…KJK80E`), so the id this
      // scenario needs comes from the API once the chat exists.
      await terminal.waitFor(/sesn_/, 30_000)
      await terminal.waitForIdle()
      const sessionId = await newestSession(request)

      await test.step('typing `/` opens the menu with the built-ins and the reader’s skills', async () => {
        terminal.type('/')
        await terminal.waitFor(/release-notes/)
        const screen = terminal.capture()
        // The built-in command of the protocol is a row (K7)…
        expect(screen).toContain('/compact')
        // …the reader's own skills are rows, with their `argument-hint`…
        expect(screen).toContain('/release-notes')
        expect(screen).toContain('version')
        // …and a `user-invocable: false` skill is not (K1, K7).
        expect(screen).not.toContain('house-style')
        // `disable-model-invocation` is kept: a command only the reader runs is the menu's job.
        expect(screen).toContain('/summarize-thread')
        await terminal.screenshot(shot, 'cs6-01-slash-menu')
      })

      await test.step('Escape closes the menu and keeps what is typed', async () => {
        terminal.send('Escape')
        await new Promise((resolve) => setTimeout(resolve, 300))
        const screen = terminal.capture()
        expect(screen).not.toContain('/compact')
        // The prompt still holds the `/`: nothing was cleared and nothing was sent.
        expect(screen).toContain('/')
        expectNoErrorNotice(screen)
        await clearLine(terminal, 4)
      })

      await test.step('the arrows move the highlight, and Tab completes to `/name `', async () => {
        terminal.type('/summarize')
        await terminal.waitFor(/summarize-thread/)
        terminal.send('Tab')
        await new Promise((resolve) => setTimeout(resolve, 300))
        const screen = terminal.capture()
        // Tab completed the name: the box holds the command, and the menu is gone — the skill's
        // `argument-hint` is the box's own hint from here, which is what the send uses.
        expect(screen).toContain('/summarize-thread')
        await clearLine(terminal, 40)
        terminal.send('Escape')
        await new Promise((resolve) => setTimeout(resolve, 200))
      })

      await test.step('`/release-notes v0.3` sends, and the log holds the substituted body', async () => {
        // Not `sendAndAwaitAnswer`: the mock echoes its prompt, and the prompt this message
        // builds is the skill's own instructions — the typed line is not what comes back.
        terminal.type('/release-notes v0.3')
        terminal.send('Enter')
        await terminal.waitFor(/Write the release notes for v0\.3/, 60_000)
        await terminal.waitForIdle()
        await terminal.screenshot(shot, 'cs6-02-invoked')
        const screen = terminal.capture()
        expect(screen).toContain('/release-notes v0.3')
        expectNoErrorNotice(screen)

        const loaded = await loadedSkills(request, sessionId)
        expect(loaded).toHaveLength(1)
        expect(loaded[0]?.name).toBe('release-notes')
        // K7: the body the model was given, with `$ARGUMENTS` substituted.
        expect(loaded[0]?.content).toContain('Write the release notes for v0.3')
        expect(loaded[0]?.content).not.toContain('$ARGUMENTS')
      })

      await test.step('S8 a disable-model-invocation skill is refused to the model', async () => {
        terminal.type('__skill__ summarize-thread')
        terminal.send('Enter')
        // The mock calls `skill` with that name, and the tool refuses it by name (K6): the
        // refusal is the call's result, which is what the log is read for — a terminal draws
        // the result's first line, and the sentence is longer than the pane.
        const deadline = Date.now() + 60_000
        let refused = false
        while (!refused && Date.now() < deadline) {
          const events = await readEvents(request, sessionId)
          refused = JSON.stringify(
            events.filter((event) => event.type === 'agent.tool_result'),
          ).includes('disable-model-invocation')
          if (!refused) {
            await new Promise((resolve) => setTimeout(resolve, 250))
          }
        }
        expect(refused, 'the `skill` tool refused summarize-thread').toBe(true)
        await terminal.waitForIdle()
        expectNoErrorNotice(terminal.capture())
      })
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('CS6b a chat’s mode decides what the `/` menu offers', async ({ context, request }) => {
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    test.setTimeout(240_000)
    await cleanAccount(request)
    const url = (await ensureRepo()).url
    expect((await ohAsync(['skills', 'add', url, '--name', 'release-notes'])).status).toBe(0)
    expect((await ohAsync(['skills', 'add', url, '--name', 'summarize-thread'])).status).toBe(0)

    // The mode needs a model whose provider has a credential (`requireUsableMode`), exactly as
    // S11 does; the mock answers it whatever the id says.
    const credentials = await request.get('/v1/provider-credentials')
    const providers = ((await credentials.json()) as { data: { name: string }[] }).data
    test.skip(
      providers.length === 0,
      'a mode whose model has no credential cannot start a chat — this stack has none',
    )
    const provider = providers[0]?.name ?? 'custom'
    const listing = await request.get('/v1/me/skills')
    const byName = new Map(
      ((await listing.json()) as { data: { id: string; name: string }[] }).data.map((skill) => [
        skill.name,
        skill.id,
      ]),
    )
    const release = byName.get('release-notes') ?? ''
    const summarize = byName.get('summarize-thread') ?? ''

    // Stored off, the mode turns it on; stored on, the mode turns it off. The menu must follow
    // the mode in both directions (K8) — a row the server would refuse must not be offered, and
    // one it would accept must not be hidden.
    expect(
      (await request.post(`/v1/me/skills/${release}`, { data: { enabled: false } })).status(),
    ).toBe(200)
    expect(
      (
        await request.post('/v1/me/modes', {
          data: {
            name: 'menu-mode',
            model: `${provider}/a-mode-model`,
            tools: { builtin: {}, skills: { [release]: true, [summarize]: false } },
          },
        })
      ).status(),
    ).toBe(201)

    const terminal = new Terminal('oh-qa-skills-mode-menu', 100, 30)
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    terminal.start()
    try {
      terminal.run(ohCommand('--mode', 'menu-mode'))
      await terminal.waitFor(/sesn_/, 30_000)
      await terminal.waitForIdle()

      terminal.type('/')
      await terminal.waitFor(/\/release-notes/)
      const screen = terminal.capture()
      expect(screen).toContain('/release-notes')
      // The mode turned it off, so it is not a row even though the user's own switch is on.
      expect(screen).not.toContain('/summarize-thread')
      await terminal.screenshot(shot, 'cs6b-01-mode-menu')
      expectNoErrorNotice(screen)
    } finally {
      terminal.kill()
      await shot.close()
    }
  })

  test('CS11 `oh modes` shows a mode’s skill override read-only', async ({ request }) => {
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    test.setTimeout(120_000)
    await cleanAccount(request)
    const url = (await ensureRepo()).url
    expect((await ohAsync(['skills', 'add', url, '--name', 'release-notes'])).status).toBe(0)

    const listing = await request.get('/v1/me/skills')
    const skill = ((await listing.json()) as { data: { id: string; name: string }[] }).data[0]
    const created = await request.post('/v1/me/modes', {
      data: {
        name: 'no-release-notes',
        model: 'anthropic/claude-sonnet-5',
        tools: { builtin: {}, skills: { [skill?.id ?? '']: false } },
      },
    })
    expect(created.status(), await created.text()).toBe(201)

    // `oh` does not edit modes (that is Settings → Modes in the web app), so the override is
    // shown by name rather than being editable — the #354 decision.
    const modes = await ohAsync(['modes'])
    expect(modes.status, modes.stdout).toBe(0)
    expect(modes.stdout).toContain('no-release-notes')
    expect(modes.stdout).toContain('release-notes off')
  })

  test('CS4 a real model loads a skill unprompted (real model only)', async ({
    context,
    request,
  }) => {
    test.skip(!isRealModel, 'set QA_MODEL (or OPENHARNESS_QA_MODEL) to a real model')
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    test.setTimeout(240_000)
    await cleanAccount(request)
    const url = (await ensureRepo()).url
    // Signed in **first**: `oh` keeps one token per server URL, and the import below is a
    // request of its own — one that a stack this run has never signed in to would refuse.
    const terminal = new Terminal('oh-qa-skills-real', 100, 30)
    const shot = await context.newPage()
    await ensureCliSignedIn(shot)
    expect(
      (await ohAsync(['skills', 'add', url, '--name', 'release-notes'])).status,
      'the fixture imported on the stack under test',
    ).toBe(0)
    terminal.start()

    try {
      // The **model this pass names**, not whatever the catalog would put first: a real-model
      // pass on a stack with two credentials must chat on the one `QA_MODEL` names.
      await setDefaultModel(request, QA_MODEL)
      terminal.run(ohCommand())
      await terminal.waitFor(/sesn_/, 30_000)
      await terminal.waitForIdle()
      const sessionId = await newestSession(request)

      await sendAndAwaitAnswer(
        terminal,
        'Write the release notes for v0.3, following the skill this project ships for it.',
      )
      await terminal.waitForIdle(180_000)
      await terminal.screenshot(shot, 'cs4-01-real-model')

      const events = await readEvents(request, sessionId)
      expect(JSON.stringify(events), 'the model called `skill` on its own').toContain(
        'references/tone.md',
      )
      // The log says what the model was given (K6): it read the skill and one of its
      // reference files. The screen is read for the `Loaded skill …` line the transcript
      // draws — the `Read …` line is a tool line whose path a narrow pane may wrap.
      expect(JSON.stringify(events)).toContain('skill_read')
      expect(JSON.stringify(events)).toContain('references/tone.md')
      expect(terminal.capture(200)).toContain('Loaded skill release-notes')
      expectNoErrorNotice(terminal.capture())
    } finally {
      terminal.kill()
      await shot.close()
    }
  })
})
