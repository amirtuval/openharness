import type { APIRequestContext, Page } from '@playwright/test'

import {
  CANDIDATE_PATHS,
  IMPORTABLE_CANDIDATES,
  SKILLS_BINARY_ICON,
  SKILLS_FILES,
  SKILLS_FILES_CHANGED,
  skillsFixtureAvailable,
  startSkillsRepo,
  type SkillsRepo,
} from './skills-fixture'
import {
  composer,
  createChat,
  expect,
  expectNoErrorBanner,
  isRealModel,
  QA_MODEL,
  readEvents,
  setStoredTheme,
  shot,
  test,
  waitForIdle,
} from './support'

/**
 * W30 — the skills screens (epic #349; issues #353, #355), hands-on against the real stack.
 *
 * The web half of #355's plan: S1, S2, S3, S6, S8, S9, S10, S11 and S14 (the screenshots), all
 * against the real server — the real import (a `git` repository served by
 * `./skills-fixture`'s loopback front, cloned by the real `isomorphic-git`/`safeFetch` path),
 * the real `/` menu, the real refresh diff, the real mode override.
 *
 * Two things the stack must be told, both in `e2e/AGENTS.md`:
 *
 * - `OPENHARNESS_TEST_MODEL=mock`, so a turn needs no provider key at all;
 * - `OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS=1` and
 *   `NODE_EXTRA_CA_CERTS=$PWD/e2e/fixtures/skills-https/ca.pem`, because the fixture is a
 *   loopback `https://` address.
 *
 * Nothing here needs a **stored provider credential** except S11 and S11b: a mode whose model
 * has no credential is refused (and cannot start a helper), so those two skip on a stack that
 * has none. Every other chat this spec opens is a session created through the API and opened at
 * `#/s/<id>`, which is not gated.
 *
 * S4 (a real model loading a skill on its own) is the last scenario and skips unless a real
 * model is named (`QA_MODEL`/`OPENHARNESS_QA_MODEL`), the way the rest of the QA pass does.
 * S5 (the refusals) is a hands-on pass, not a spec: three of its cases need a stack started
 * **without** the self-host flag, and the rest a repository that is 20 MB, private or gone.
 */

/** A session created through the API on `QA_MODEL`, opened in the browser. */
async function chatOn(page: Page, request: APIRequestContext): Promise<string> {
  const session = await createChat(request, QA_MODEL)
  await page.goto(`/#/s/${session.id}`)
  await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible()
  return session.id
}

/** Open Settings → Skills, dismissing the shell's notice if one is up. */
async function openSkillsCard(page: Page): Promise<void> {
  await page.goto('/#/settings')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  const dismiss = page.getByRole('button', { name: 'Dismiss notice' })
  if ((await dismiss.count()) > 0) {
    await dismiss.click()
  }
  const card = page.locator('[data-slot="skill-row"]').first()
  if ((await card.count()) > 0) {
    await card.scrollIntoViewIfNeeded()
  }
}

/** Open the Import panel and preview `url`, waiting for the answer. */
async function preview(page: Page, url: string, extra: { ref?: string; path?: string } = {}) {
  const open = page.getByRole('button', { name: 'Import', exact: true })
  if ((await page.getByLabel('Repository URL').count()) === 0) {
    await open.click()
  }
  await page.getByLabel('Repository URL').fill(url)
  if (extra.ref !== undefined || extra.path !== undefined) {
    await page.getByRole('button', { name: /Advanced/ }).click()
    if (extra.ref !== undefined) {
      await page.getByLabel('Ref').fill(extra.ref)
    }
    if (extra.path !== undefined) {
      await page.getByLabel('Folder').fill(extra.path)
    }
  }
  await page.getByRole('button', { name: 'Preview' }).click()
  await expect(page.locator('[data-slot="skill-import-preview"]')).toBeVisible()
}

/** One candidate row of an open preview. */
function candidate(page: Page, name: string) {
  return page.locator(`[data-slot="skill-candidate"][data-candidate="${name}"]`)
}

/** Tick or untick a candidate, and wait for the box to say so. */
async function select(page: Page, name: string, pick: boolean): Promise<void> {
  const box = candidate(page, name).getByRole('checkbox')
  if (pick) {
    await box.check()
  } else {
    await box.uncheck()
  }
}

/** Import exactly the named candidates from the open preview. */
async function importPicked(page: Page, names: readonly string[]): Promise<void> {
  const boxes = page.locator('[data-slot="skill-candidate"] input[type=checkbox]')
  for (const box of await boxes.all()) {
    if ((await box.isChecked()) && !(await box.isDisabled())) {
      await box.uncheck()
    }
  }
  for (const name of names) {
    await select(page, name, true)
  }
  await page
    .getByRole('button', { name: new RegExp(`^Import ${String(names.length)} skills?$`) })
    .click()
  await expect(page.locator('[data-slot="skill-import-preview"]')).toBeHidden()
}

/** Empty the account's skills and chats, so the pass starts from the state it shows. */
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

/** Every stored `session.skill_loaded` of a session, oldest first. */
async function loadedSkills(
  request: APIRequestContext,
  sessionId: string,
): Promise<{ name: string; content: string; commit_sha: string }[]> {
  return (await readEvents(request, sessionId))
    .filter((event) => event.type === 'session.skill_loaded')
    .map((event) => event as unknown as { name: string; content: string; commit_sha: string })
}

/**
 * Wait until a session holds `count` loaded skills, and answer them.
 *
 * `waitForIdle` is not enough between two sends on one session: the log's last status is
 * *already* `session.status_idle` when the second message goes out, so the wait passes before
 * the new turn has even started (the idle a fresh turn writes is the same event). The count of
 * `session.skill_loaded` is the thing that really changed.
 */
async function waitForLoaded(
  request: APIRequestContext,
  sessionId: string,
  count: number,
): Promise<{ name: string; content: string; commit_sha: string }[]> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const loaded = await loadedSkills(request, sessionId)
    if (loaded.length >= count) {
      return loaded
    }
    if (Date.now() > deadline) {
      throw new Error(`session ${sessionId} never loaded ${String(count)} skills`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/**
 * Put the account into a known state: no skills, no chats, and the named candidates imported.
 *
 * Every scenario does this for itself rather than leaning on the one before it, because
 * Playwright **restarts the worker after a failed test** — which re-runs `beforeAll` and would
 * otherwise leave the run after a failure with an account the failing scenario emptied.
 */
async function ensureSkills(
  request: APIRequestContext,
  names: readonly string[],
  options: { readonly wipe?: boolean } = {},
): Promise<{ id: string; name: string }[]> {
  if (options.wipe !== false) {
    await cleanAccount(request)
  }
  if (names.length === 0) {
    return []
  }
  const url = (await ensureRepo()).url
  const preview = await request.post('/v1/me/skills/import/preview', { data: { url } })
  expect(preview.status(), await preview.text()).toBe(200)
  const body = (await preview.json()) as { commit_sha: string }
  const stored = await request.post('/v1/me/skills/import', {
    data: { url, commit_sha: body.commit_sha, names: [...names] },
  })
  expect(stored.status(), await stored.text()).toBe(201)
  return ((await stored.json()) as { data: { id: string; name: string }[] }).data
}

/**
 * The fixture repository, started once per worker.
 *
 * A worker that a failed test restarted asks for a fresh repository, which is the state every
 * scenario wants anyway: a scenario that moves the branch resets it first.
 */
async function ensureRepo(): Promise<SkillsRepo> {
  repo ??= await startSkillsRepo()
  return repo
}

/** Wait until the log holds a matching event, and answer the newest one. */
async function waitForEvent(
  request: APIRequestContext,
  sessionId: string,
  matches: (event: Record<string, unknown>) => boolean,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = (await readEvents(request, sessionId)).filter(matches)
    if (found.length > 0) {
      return found.at(-1) ?? {}
    }
    if (Date.now() > deadline) {
      throw new Error(`session ${sessionId} never held the event the scenario waited for`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** Wait until the log holds at least `count` tool results, and answer them in order. */
async function waitForResults(
  request: APIRequestContext,
  sessionId: string,
  count: number,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const results = (await readEvents(request, sessionId)).filter(
      (event) => event.type === 'agent.tool_result',
    )
    if (results.length >= count) {
      return results
    }
    if (Date.now() > deadline) {
      throw new Error(`session ${sessionId} never held ${String(count)} tool results`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** The themes every view is captured in, the same three the app ships (epic #201, X3). */
const THEMES = ['light', 'dim', 'dark'] as const

/** The two widths every view is captured at: a desktop and a narrow phone-ish one. */
const WIDTHS = [
  { width: 1280, height: 900, label: 'desktop' },
  { width: 400, height: 780, label: 'narrow' },
] as const

let repo: SkillsRepo | null = null

test.describe('W30 the skills screens', () => {
  test.afterAll(async () => {
    await repo?.close()
    repo = null
  })

  test('S1+S3 importing two from a collection, and what the preview refuses', async ({
    page,
    request,
    consoleErrors,
  }) => {
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    await cleanAccount(request)
    const url = (await ensureRepo()).url

    await test.step('S1 Settings → Skills starts empty', async () => {
      await openSkillsCard(page)
      await expect(page.getByText(/No skills yet/)).toBeVisible()
      await expectNoErrorBanner(page)
    })

    await test.step('S1+S3 the preview names every candidate and its problem', async () => {
      await preview(page, url)
      await expect(page.locator('[data-slot="skill-candidate"]')).toHaveCount(6)
      await expect(page.locator('[data-slot="skill-import-preview"]')).toContainText(
        '6 skills found at',
      )

      // The three importable ones: a description, a `SKILL.md` and a file list behind the
      // disclosure.
      for (const name of IMPORTABLE_CANDIDATES) {
        await expect(candidate(page, name)).toHaveAttribute('data-selectable', 'true')
        await expect(
          candidate(page, name).locator('[data-slot="skill-candidate-description"]'),
        ).not.toBeEmpty()
      }
      const first = page.locator('[data-slot="skill-candidate"][data-candidate="release-notes"]')
      await first.getByRole('button', { name: /files?$/ }).click()
      await expect(first.locator('[data-slot="skill-candidate-skill-md"]')).toBeVisible()
      await expect(first.locator('[data-slot="skill-candidate-files"]')).toContainText('SKILL.md')
      // A binary file is a candidate's file like any other: the import stores it losslessly
      // (base64) rather than failing the Postgres write on a NUL byte.
      await expect(first.locator('[data-slot="skill-candidate-files"]')).toContainText(
        'assets/icon.png',
      )

      // S3: the three the import would refuse, each with the server's own reason, and a
      // checkbox that cannot be ticked into a refusal.
      for (const name of ['broken-skill', 'huge-skill', 'compact']) {
        await expect(candidate(page, name)).toHaveAttribute('data-selectable', 'false')
        await expect(candidate(page, name).getByRole('checkbox')).toBeDisabled()
        await expect(
          candidate(page, name).locator('[data-slot="skill-candidate-problem"]'),
        ).not.toBeEmpty()
      }
      // The frontmatter names a folder that is not its own…
      await expect(candidate(page, 'broken-skill')).toContainText('a-name-that-is-not-the-folder')
      // …the `SKILL.md` is past the cap K4 sets…
      await expect(candidate(page, 'huge-skill')).toContainText('the limit is 20.0 KB')
      // …and the name belongs to a built-in command.
      await expect(candidate(page, 'compact')).toContainText('built-in command')
    })

    await test.step('S1 two are picked and imported, and land with their source and commit', async () => {
      await importPicked(page, ['release-notes', 'summarize-thread'])
      const rows = page.locator('[data-slot="skill-row"]')
      await expect(rows).toHaveCount(2)
      await expect(
        page.locator('[data-slot="skill-row"][data-skill="release-notes"]'),
      ).toBeVisible()
      // The source line names the repository and its short commit.
      await expect(page.locator('[data-slot="skill-source"]').first()).toContainText('127.0.0.1')
      await expect(page.locator('[data-slot="skill-source"]').first()).toContainText(
        '/org/skills.git',
      )
      await expectNoErrorBanner(page)

      // The binary file the fixture ships is stored, listed at its real byte size, and served
      // as base64 — which is what a Postgres-backed import of it has to answer (K4).
      const listed = await request.get('/v1/me/skills')
      expect(listed.status(), await listed.text()).toBe(200)
      const release = (
        (await listed.json()) as {
          data: { id: string; name: string; files: { path: string; size: number }[] }[]
        }
      ).data.find((skill) => skill.name === 'release-notes')
      expect(release, 'the fixture import stored release-notes').toBeDefined()
      expect(release?.files).toContainEqual({
        path: 'assets/icon.png',
        size: SKILLS_BINARY_ICON.length,
      })
      const icon = await request.get(`/v1/me/skills/${release?.id ?? ''}/files/assets/icon.png`)
      expect(icon.status(), await icon.text()).toBe(200)
      expect(await icon.json()).toMatchObject({
        path: 'assets/icon.png',
        size: SKILLS_BINARY_ICON.length,
        encoding: 'base64',
      })
    })

    await test.step('S3 a name the reader already has is flagged, and only that one', async () => {
      await preview(page, url)
      const taken = candidate(page, 'release-notes')
      await expect(taken).toHaveAttribute('data-selectable', 'false')
      await expect(taken.locator('[data-slot="skill-candidate-taken"]')).not.toBeEmpty()
      // The candidates whose name is free are still importable — a taken name refuses one
      // candidate, not the preview.
      await expect(candidate(page, 'house-style')).toHaveAttribute('data-selectable', 'true')
      await page.getByRole('button', { name: 'Cancel' }).click()
    })

    await test.step('S3 a reserved name is refused by the route too', async () => {
      const response = await request.post('/v1/me/skills/import', {
        data: { url, commit_sha: await (await ensureRepo()).head(), names: ['compact'] },
      })
      expect(response.status(), await response.text()).toBe(422)
      const body = (await response.json()) as { error: { message: string } }
      expect(body.error.message).toContain('built-in command')
      // Nothing was stored.
      const listing = await request.get('/v1/me/skills')
      const data = ((await listing.json()) as { data: { name: string }[] }).data
      expect(data.map((skill) => skill.name).sort()).toEqual(['release-notes', 'summarize-thread'])
    })

    expect(consoleErrors.filter((entry) => !/favicon/i.test(entry))).toEqual([])
  })

  test('S2 a browse URL is split into its ref and its folder, and imports one skill', async ({
    page,
    request,
  }) => {
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    await ensureSkills(request, ['release-notes', 'summarize-thread'])
    const browse = (await ensureRepo()).browse(CANDIDATE_PATHS['house-style'])

    await openSkillsCard(page)
    await preview(page, browse)
    // One candidate, and the preview says which repository, ref and folder it read.
    await expect(page.locator('[data-slot="skill-candidate"]')).toHaveCount(1)
    await expect(page.locator('[data-slot="skill-import-preview"]')).toContainText(
      'One skill found at',
    )
    await expect(page.locator('[data-slot="skill-import-preview"]')).toContainText(
      '/org/skills.git',
    )
    await expect(page.locator('[data-slot="skill-import-preview"]')).toContainText('main')
    await expect(page.locator('[data-slot="skill-import-preview"]')).toContainText(
      'skills/house-style',
    )
    // The `/tree/…` half is not part of the repository it cloned.
    await expect(page.locator('[data-slot="skill-import-preview"]')).not.toContainText('/tree/')

    await importPicked(page, ['house-style'])
    await expect(page.locator('[data-slot="skill-row"][data-skill="house-style"]')).toBeVisible()
    await expectNoErrorBanner(page)
  })

  test('S6 the `/` menu, the arguments, and what the log holds', async ({
    page,
    request,
    consoleErrors,
  }) => {
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    await ensureSkills(request, ['release-notes', 'summarize-thread', 'house-style'])
    const sessionId = await chatOn(page, request)
    const input = composer(page)

    await test.step('a bare / opens the menu: the built-ins and the reader’s own skills', async () => {
      await input.fill('/')
      const menu = page.getByRole('listbox', { name: 'Slash commands' })
      await expect(menu).toBeVisible()
      // The built-in (K7) and every enabled, user-invocable skill — with its `argument-hint`.
      await expect(menu.locator('[data-command="compact"]')).toBeVisible()
      await expect(menu.locator('[data-command="release-notes"]')).toContainText('version')
      await expect(menu.locator('[data-command="summarize-thread"]')).toBeVisible()
      // `user-invocable: false` is the model's own command: not a row (K1, K7).
      await expect(menu.locator('[data-command="house-style"]')).toHaveCount(0)
    })

    await test.step('the arrows move the highlight and Escape closes the menu', async () => {
      const menu = page.getByRole('listbox', { name: 'Slash commands' })
      await input.fill('/')
      const first = menu.locator('[role="option"]').first()
      await expect(first).toHaveAttribute('aria-selected', 'true')
      await input.press('ArrowDown')
      await expect(menu.locator('[role="option"]').nth(1)).toHaveAttribute('aria-selected', 'true')
      await input.press('Escape')
      await expect(menu).toBeHidden()
      // Escape closed the menu and nothing else: the box still holds the line, and no turn ran.
      await expect(input).toHaveValue('/')
    })

    await test.step('a pick fills the box and shows the argument hint as the placeholder', async () => {
      await input.fill('/release')
      await page.getByRole('listbox', { name: 'Slash commands' }).locator('[role="option"]').click()
      await expect(input).toHaveValue('/release-notes ')
      await expect(input).toHaveAttribute('placeholder', 'version')
    })

    await test.step('the send carries the skill, substitutes $ARGUMENTS and draws the chip', async () => {
      await input.fill('/release-notes v1.2')
      await page.getByRole('button', { name: 'Send message' }).click()
      await expect(page.locator('[data-slot="message-skill"]')).toBeVisible()
      await expect(page.getByText('/release-notes v1.2').first()).toBeVisible()
      await expectNoErrorBanner(page)

      const loaded = await waitForLoaded(request, sessionId, 1)
      expect(loaded).toHaveLength(1)
      expect(loaded[0]?.name).toBe('release-notes')
      // K7: every `$ARGUMENTS` replaced by what the reader typed, and the commit recorded.
      expect(loaded[0]?.content).toContain(
        'Write the release notes for v1.2, one paragraph per change.',
      )
      expect(loaded[0]?.content).not.toContain('$ARGUMENTS')
      expect(loaded[0]?.commit_sha).toMatch(/^[0-9a-f]{40}$/)
    })

    await test.step('a body with no $ARGUMENTS has the arguments appended after it', async () => {
      await input.fill('/summarize-thread the release thread')
      await page.getByRole('button', { name: 'Send message' }).click()
      const loaded = await waitForLoaded(request, sessionId, 2)
      expect(loaded.map((event) => event.name)).toEqual(['release-notes', 'summarize-thread'])
      // The whole stored body — the markdown heading included — with the arguments appended
      // after it, because this skill's body has no `$ARGUMENTS` to put them in.
      expect(loaded[1]?.content).toBe(
        '# Summarize a thread\n\nRead the thread and list its decisions.\n\nthe release thread',
      )
    })

    expect(consoleErrors.filter((entry) => !/favicon/i.test(entry))).toEqual([])
  })

  test('S8 the invocation flags decide who may run a skill', async ({ page, request }) => {
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    await ensureSkills(request, ['release-notes', 'summarize-thread', 'house-style'])

    await test.step('both badges are on the Settings rows', async () => {
      await openSkillsCard(page)
      await expect(
        page.locator(
          '[data-slot="skill-row"][data-skill="summarize-thread"] [data-slot="skill-badge"]',
        ),
      ).toHaveText('command only')
      await expect(
        page.locator('[data-slot="skill-row"][data-skill="house-style"] [data-slot="skill-badge"]'),
      ).toHaveText('model only')
    })

    await test.step('`skill` refuses a disable-model-invocation skill by name', async () => {
      const sessionId = await chatOn(page, request)
      const response = await request.post(`/v1/sessions/${sessionId}/events`, {
        data: {
          events: [
            {
              type: 'user.message',
              content: [{ type: 'text', text: '__skill__ summarize-thread' }],
            },
          ],
        },
      })
      expect(response.status(), await response.text()).toBe(200)
      await waitForIdle(request, sessionId)
      const events = await readEvents(request, sessionId)
      const result = events.find(
        (event) =>
          event.type === 'agent.tool_result' && JSON.stringify(event).includes('summarize-thread'),
      )
      expect(result, 'the skill tool refused it').toBeDefined()
      expect(JSON.stringify(result)).toContain('disable-model-invocation')
    })

    await test.step('the model reads a command-only skill’s reference once the user has run it', async () => {
      const sessionId = await chatOn(page, request)
      // The user runs the command themselves — the one way a `disable-model-invocation` skill
      // is meant to be started. Its body lands in the log.
      const started = await request.post(`/v1/sessions/${sessionId}/events`, {
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
      expect(started.status(), await started.text()).toBe(200)
      await waitForIdle(request, sessionId)

      // The instructions name `references/format.md`; from this request on the model may read
      // it (the earlier step proved the same tool still refuses a skill the user never ran).
      const asked = await request.post(`/v1/sessions/${sessionId}/events`, {
        data: {
          events: [
            {
              type: 'user.message',
              content: [
                { type: 'text', text: '__skill_read__ summarize-thread references/format.md' },
              ],
            },
          ],
        },
      })
      expect(asked.status(), await asked.text()).toBe(200)
      await waitForIdle(request, sessionId)

      const results = (await readEvents(request, sessionId))
        .filter((event) => event.type === 'agent.tool_result')
        .map((event) => JSON.stringify(event))
        .join('\n')
      expect(results).toContain('One decision per line')
      expect(results).not.toContain('disable-model-invocation')
    })

    await test.step('a user-invocable: false skill typed anyway is a 400 that stores nothing', async () => {
      const sessionId = await chatOn(page, request)
      const before = (await readEvents(request, sessionId)).length
      const response = await request.post(`/v1/sessions/${sessionId}/events`, {
        data: {
          events: [
            {
              type: 'user.message',
              content: [{ type: 'text', text: '/house-style shorten this' }],
              skill: { name: 'house-style', arguments: 'shorten this' },
            },
          ],
        },
      })
      expect(response.status(), await response.text()).toBe(400)
      const body = (await response.json()) as { error: { type: string } }
      expect(body.error.type).toBe('invalid_request_error')
      // Nothing was appended.
      expect((await readEvents(request, sessionId)).length).toBe(before)
    })
  })

  test('S9 a refresh shows the changes and replaces nothing until it is confirmed', async ({
    page,
    request,
  }) => {
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    // The repository is reset to its first commit, so "nothing upstream" is true whatever a
    // scenario that ran before this one pushed.
    const fixture = await ensureRepo()
    await fixture.commit(SKILLS_FILES, 'back to the starting point')
    await ensureSkills(request, ['release-notes', 'summarize-thread', 'house-style'])

    // A chat that loads the skill **before** anything moves: it is the "older chat" the last
    // step reads back, and the commit it loaded is the one it must still name afterwards.
    const chat = await createChat(request, QA_MODEL)
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

    await test.step('nothing upstream is `unchanged`, and the confirm is still offered', async () => {
      await openSkillsCard(page)
      await page.getByRole('button', { name: 'Refresh release-notes' }).click()
      await expect(page.locator('[data-slot="skill-refresh-summary"]')).toHaveText('unchanged')
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.locator('[data-slot="skill-refresh"]')).toBeHidden()
    })

    const before = await fixture.head()

    await test.step('a push is a diff: added, removed and changed, with the SKILL.md diff', async () => {
      await fixture.commit(SKILLS_FILES_CHANGED, 'more release-note detail')
      await openSkillsCard(page)
      await page.getByRole('button', { name: 'Refresh release-notes' }).click()
      const panel = page.locator('[data-slot="skill-refresh"]')
      await expect(panel.locator('[data-slot="skill-refresh-summary"]')).toHaveText(
        '1 file added, 1 file removed, 1 file changed',
      )
      await expect(panel.locator('[data-slot="skill-refresh-files"]')).toContainText(
        'references/format.md',
      )
      await expect(panel.locator('[data-slot="skill-refresh-files"]')).toContainText(
        'scripts/publish.sh',
      )
      await expect(panel.locator('[data-slot="skill-refresh-diff"]')).toContainText('newest first')
    })

    await test.step('cancelling replaces nothing', async () => {
      await page.getByRole('button', { name: 'Cancel' }).click()
      await openSkillsCard(page)
      // The stored source still names the commit the skill was imported at.
      await expect(
        page.locator('[data-slot="skill-row"][data-skill="release-notes"]'),
      ).toContainText((before ?? '').slice(0, 7))
    })

    await test.step('confirming replaces the snapshot at the previewed commit', async () => {
      await page.getByRole('button', { name: 'Refresh release-notes' }).click()
      await page.getByRole('button', { name: 'Replace with this version' }).click()
      await expect(page.locator('[data-slot="skill-refresh"]')).toBeHidden()
      await expectNoErrorBanner(page)
      await expect(
        page.locator('[data-slot="skill-row"][data-skill="release-notes"]'),
      ).toContainText((await fixture.head()).slice(0, 7))
    })

    await test.step('an older chat that loaded the skill replays unchanged', async () => {
      // The log holds what the model was given (K7), and a refresh under a chat does not
      // rewrite it: the body this chat loaded before the push is still the body it holds, at
      // the commit it was loaded from.
      const loaded = await loadedSkills(request, chat.id)
      expect(loaded[0]?.content).toContain('Write the release notes for v0.9')
      expect(loaded[0]?.content, 'the body the chat loaded, not the refreshed one').not.toContain(
        'newest first',
      )
      expect(loaded[0]?.commit_sha).toBe(before)
      expect(loaded[0]?.commit_sha).not.toBe(await fixture.head())
    })
  })

  test('S10 disabling and removing a skill take it out of the menu and the offer', async ({
    page,
    request,
  }) => {
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    await ensureSkills(request, ['release-notes', 'summarize-thread', 'house-style'])
    const sessionId = await chatOn(page, request)
    const input = composer(page)

    await test.step('disabled: out of the `/` menu, and `skill` refuses it', async () => {
      await openSkillsCard(page)
      const toggle = page.getByRole('checkbox', { name: 'Enable release-notes' })
      await toggle.click()
      await expect(toggle).not.toBeChecked()

      await page.goto(`/#/s/${sessionId}`)
      await input.fill('/')
      await expect(
        page
          .getByRole('listbox', { name: 'Slash commands' })
          .locator('[data-command="release-notes"]'),
      ).toHaveCount(0)
      await input.press('Escape')

      // The listing a request's `skill` tool carries is the enabled ones, so the model
      // reading it by name is refused rather than served.
      const response = await request.post(`/v1/sessions/${sessionId}/events`, {
        data: {
          events: [
            { type: 'user.message', content: [{ type: 'text', text: '__skill__ release-notes' }] },
          ],
        },
      })
      expect(response.status(), await response.text()).toBe(200)
      await waitForIdle(request, sessionId)
      const events = await readEvents(request, sessionId)
      expect(JSON.stringify(events.filter((e) => e.type === 'agent.tool_result'))).toContain(
        'release-notes',
      )
      // An invocation of a skill that is off is refused too, and stores nothing.
      const invocation = await request.post(`/v1/sessions/${sessionId}/events`, {
        data: {
          events: [
            {
              type: 'user.message',
              content: [{ type: 'text', text: '/release-notes v2' }],
              skill: { name: 'release-notes', arguments: 'v2' },
            },
          ],
        },
      })
      expect(invocation.status(), await invocation.text()).toBe(400)
    })

    await test.step('enabled again: back in the menu', async () => {
      await openSkillsCard(page)
      const toggle = page.getByRole('checkbox', { name: 'Enable release-notes' })
      await toggle.click()
      await expect(toggle).toBeChecked()
      await page.goto(`/#/s/${sessionId}`)
      await input.fill('/')
      await expect(
        page
          .getByRole('listbox', { name: 'Slash commands' })
          .locator('[data-command="release-notes"]'),
      ).toBeVisible()
      await input.press('Escape')
    })

    await test.step('removed: gone from the list and the menu', async () => {
      await openSkillsCard(page)
      await page.getByRole('button', { name: 'Delete release-notes' }).click()
      // The in-page confirm replaces the two actions, and its accessible name is the same
      // `Delete <name>` the row's own button carries.
      await page.getByRole('button', { name: 'Delete release-notes' }).click()
      await expect(page.locator('[data-slot="skill-row"][data-skill="release-notes"]')).toHaveCount(
        0,
      )

      await page.goto(`/#/s/${sessionId}`)
      await input.fill('/')
      await expect(
        page
          .getByRole('listbox', { name: 'Slash commands' })
          .locator('[data-command="release-notes"]'),
      ).toHaveCount(0)
      await input.press('Escape')
      await expectNoErrorBanner(page)
    })
  })

  test('S11 a mode turns a skill on and another off, and a chat follows it live', async ({
    page,
    request,
  }) => {
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    await ensureSkills(request, ['release-notes', 'summarize-thread', 'house-style'])

    // A chat may not start on a mode whose model has no stored credential
    // (`requireUsableMode`'s 422), so this scenario needs an account with one. The model id
    // itself is free text — the mock answers the turn whatever it says.
    const credentials = await request.get('/v1/provider-credentials')
    const providers = ((await credentials.json()) as { data: { name: string }[] }).data
    test.skip(
      providers.length === 0,
      'a mode whose model has no credential is refused with a 422 — this stack has none',
    )
    const provider = providers[0]?.name ?? 'custom'
    const modeModel = `${provider}/a-mode-model`

    const listing = await request.get('/v1/me/skills')
    const skills = ((await listing.json()) as { data: { id: string; name: string }[] }).data
    const byName = new Map(skills.map((skill) => [skill.name, skill.id]))
    const summarize = byName.get('summarize-thread')
    const house = byName.get('house-style')
    const release = byName.get('release-notes')
    expect(summarize, 'the fixture import left summarize-thread stored').toBeDefined()
    expect(house, 'the fixture import left house-style stored').toBeDefined()
    expect(release, 'the fixture import left release-notes stored').toBeDefined()

    // `release-notes` starts **off** for the reader; the mode turns it on. Together with
    // `summarize-thread` (stored on, the mode turns it off) that is both directions the `/`
    // menu has to follow (K8).
    const off = await request.post(`/v1/me/skills/${release ?? ''}`, { data: { enabled: false } })
    expect(off.status(), await off.text()).toBe(200)

    const created = await request.post('/v1/me/modes', {
      data: {
        name: 'no-thread-summary',
        model: modeModel,
        tools: {
          builtin: {},
          skills: { [summarize ?? '']: false, [house ?? '']: true, [release ?? '']: true },
        },
      },
    })
    expect(created.status(), await created.text()).toBe(201)
    const mode = (await created.json()) as { id: string }

    await test.step('the Modes list names what the mode overrides', async () => {
      await page.goto('/#/settings')
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
      // The row's one-line summary names each skill the mode overrides, by the reader's name
      // rather than by the opaque `skl_` id (K8).
      await expect(page.locator('[data-slot="mode-tools"]')).toContainText('summarize-thread off')
      await expect(page.locator('[data-slot="mode-tools"]')).toContainText('house-style on')
    })

    await test.step('a chat on the mode follows it: one off, one on', async () => {
      // A chat that follows the mode and nothing else: the mode is what makes it runnable.
      const session = await request.post('/v1/sessions', { data: { mode: mode.id } })
      expect(session.status(), await session.text()).toBe(201)
      const id = ((await session.json()) as { id: string }).id

      // `house-style` is on for this mode, so the model may read it…
      const on = await request.post(`/v1/sessions/${id}/events`, {
        data: {
          events: [
            { type: 'user.message', content: [{ type: 'text', text: '__skill__ house-style' }] },
          ],
        },
      })
      expect(on.status(), await on.text()).toBe(200)
      await waitForIdle(request, id)
      expect(
        (await readEvents(request, id))
          .filter((event) => event.type === 'agent.tool_result')
          .map((event) => JSON.stringify(event))
          .join('\n'),
      ).toContain('House style')

      // …and `summarize-thread` is off, so a slash invocation of it is refused before anything
      // is stored — the in-force answer is what the route checks against (K8).
      const off = await request.post(`/v1/sessions/${id}/events`, {
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
      expect(off.status(), await off.text()).toBe(400)

      // The `/` menu is the **effective** set, not the stored switches: `release-notes` is
      // stored off but this mode turns it on, and `summarize-thread` is stored on but the mode
      // turns it off — the same answer the route above just gave (K8).
      await page.goto(`/#/s/${id}`)
      const input = composer(page)
      await input.fill('/')
      const menu = page.getByRole('listbox', { name: 'Slash commands' })
      await expect(menu.locator('[data-command="release-notes"]')).toBeVisible()
      await expect(menu.locator('[data-command="summarize-thread"]')).toHaveCount(0)
      await expectNoErrorBanner(page)
    })

    await test.step('editing the mode applies to the next request', async () => {
      const updated = await request.post(`/v1/me/modes/${mode.id}`, {
        data: { tools: { builtin: {}, skills: { [summarize ?? '']: true } } },
      })
      expect(updated.status(), await updated.text()).toBe(200)

      const sessions = await request.get('/v1/sessions?limit=100')
      const id = (
        (await sessions.json()) as { data: { id: string; mode: string | null }[] }
      ).data.find((session) => session.mode === mode.id)?.id
      expect(id, 'the chat the mode was created for').toBeDefined()

      const now = await request.post(`/v1/sessions/${id ?? ''}/events`, {
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
      expect(now.status(), await now.text()).toBe(200)
      // The mode was edited between the two invocations, and this request is the one that has
      // to follow it (K8) — read off the log rather than off a session resource.
      const loaded = await waitForLoaded(request, id ?? '', 1)
      expect(loaded.map((event) => event.name)).toEqual(['summarize-thread'])
    })

    await test.step('a mode naming a deleted skill is ignored, not refused', async () => {
      const deleted = byName.get('house-style') ?? ''
      await request.delete(`/v1/me/skills/${deleted}`)
      const still = await request.post(`/v1/me/modes/${mode.id}`, {
        data: { tools: { builtin: {}, skills: { [deleted]: true } } },
      })
      expect(still.status(), await still.text()).toBe(200)
      const read = await request.get(`/v1/me/modes/${mode.id}`)
      expect(read.status(), await read.text()).toBe(200)
    })
  })

  test('S11b a subagent type carries its own skills into the child', async ({ request }) => {
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    await ensureSkills(request, ['release-notes', 'house-style'])

    // A type is a mode, and a mode whose model has no credential cannot start a helper
    // (`usableModeModel`'s rule) — S11's own skip, for the same reason.
    const credentials = await request.get('/v1/provider-credentials')
    const providers = ((await credentials.json()) as { data: { name: string }[] }).data
    test.skip(
      providers.length === 0,
      'a mode whose model has no credential cannot start a subagent — this stack has none',
    )
    const provider = providers[0]?.name ?? 'custom'

    const listing = await request.get('/v1/me/skills')
    const skills = ((await listing.json()) as { data: { id: string; name: string }[] }).data
    const byName = new Map(skills.map((skill) => [skill.name, skill.id]))
    const release = byName.get('release-notes')
    const house = byName.get('house-style')
    expect(release, 'the fixture import left release-notes stored').toBeDefined()
    expect(house, 'the fixture import left house-style stored').toBeDefined()

    // One type, one skill off and one on — the same patch a chat on the mode follows.
    const created = await request.post('/v1/me/modes', {
      data: {
        name: 'subagent-style',
        model: `${provider}/a-mode-model`,
        subagent_description: 'Reads the house style',
        tools: { builtin: {}, skills: { [release ?? '']: false, [house ?? '']: true } },
      },
    })
    expect(created.status(), await created.text()).toBe(201)
    const mode = (await created.json()) as { id: string }

    const parent = await createChat(request, QA_MODEL)
    const sent = await request.post(`/v1/sessions/${parent.id}/events`, {
      data: {
        events: [
          {
            type: 'user.message',
            content: [{ type: 'text', text: '__agent__ subagent-style | Read the house style' }],
          },
        ],
      },
    })
    expect(sent.status(), await sent.text()).toBe(200)

    // The type started a child, and the child was created **on the mode** (#344) — which is
    // what makes the mode's skill patch reach its listing.
    const started = await waitForEvent(
      request,
      parent.id,
      (event) => event.type === 'session.task_started',
    )
    expect(started.task_type).toBe('subagent-style')
    const childId = started.child_session_id as string
    expect(childId).toBeTruthy()

    const child = await request.get(`/v1/sessions/${childId}`)
    expect(child.status(), await child.text()).toBe(200)
    const childSession = (await child.json()) as {
      mode: string | null
      parent_session_id: string | null
    }
    expect(childSession.mode).toBe(mode.id)
    expect(childSession.parent_session_id).toBe(parent.id)

    // The skill the type turns on is offered to the child at all: the request's own offer
    // names it (#349 K8; #352 K6), before any message this scenario sends.
    const offered = await waitForEvent(
      request,
      childId,
      (event) =>
        event.type === 'span.model_request_start' &&
        Array.isArray(event.tools) &&
        (event.tools as { name: string }[]).some((tool) => tool.name === 'skill'),
    )
    expect(offered).toBeTruthy()

    // Let the child's prompt turn end, so the next message is a turn of its own.
    await waitForEvent(request, childId, (event) => event.type === 'session.status_idle')

    await test.step('the skill the type turns on reads', async () => {
      const before = (await readEvents(request, childId)).filter(
        (event) => event.type === 'agent.tool_result',
      ).length
      const response = await request.post(`/v1/sessions/${childId}/events`, {
        data: {
          events: [
            { type: 'user.message', content: [{ type: 'text', text: '__skill__ house-style' }] },
          ],
        },
      })
      expect(response.status(), await response.text()).toBe(200)
      const results = await waitForResults(request, childId, before + 1)
      const result = results[before] ?? {}
      expect(result.is_error).toBe(false)
      expect(JSON.stringify(result)).toContain('House style')
    })

    await test.step('the skill the type turns off is not in the child at all', async () => {
      const before = (await readEvents(request, childId)).filter(
        (event) => event.type === 'agent.tool_result',
      ).length
      const response = await request.post(`/v1/sessions/${childId}/events`, {
        data: {
          events: [
            { type: 'user.message', content: [{ type: 'text', text: '__skill__ release-notes' }] },
          ],
        },
      })
      expect(response.status(), await response.text()).toBe(200)
      const results = await waitForResults(request, childId, before + 1)
      const result = results[before] ?? {}
      expect(result.is_error).toBe(true)
      expect(JSON.stringify(result)).toContain('No skill named')
      expect(JSON.stringify(result)).toContain('house-style')
    })

    await request.delete(`/v1/sessions/${parent.id}`)
  })

  test('S14 the four views in three themes at a desktop and a narrow width', async ({
    page,
    request,
  }) => {
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    test.setTimeout(300_000)
    await ensureSkills(request, ['release-notes', 'summarize-thread', 'house-style'])
    const url = (await ensureRepo()).url
    const sessionId = await chatOn(page, request)

    /** Capture `name` in every theme, at both widths, re-building the view after each reload. */
    const shoot = async (
      name: string,
      setup: () => Promise<void>,
      anchor?: string,
    ): Promise<void> => {
      for (const theme of THEMES) {
        await setStoredTheme(request, theme)
        await page.reload()
        await setup()
        for (const { width, height, label } of WIDTHS) {
          await page.setViewportSize({ width, height })
          if (anchor !== undefined) {
            await page.locator(anchor).first().scrollIntoViewIfNeeded()
          }
          await shot(page, `${name}-${theme}-${label}`)
        }
      }
      await page.setViewportSize({ width: WIDTHS[0].width, height: WIDTHS[0].height })
    }

    await shoot('skills-list', () => openSkillsCard(page), '[data-slot="skill-row"]')

    await shoot(
      'import-preview',
      async () => {
        await openSkillsCard(page)
        await preview(page, url)
        const first = page.locator('[data-slot="skill-candidate"]').first()
        await first.getByRole('button', { name: /files?$/ }).click()
      },
      '[data-slot="skill-import-preview"]',
    )

    await page.getByRole('button', { name: 'Cancel' }).click()

    await shoot(
      'slash-menu',
      async () => {
        await page.goto(`/#/s/${sessionId}`)
        await composer(page).fill('/')
        await expect(page.getByRole('listbox', { name: 'Slash commands' })).toBeVisible()
      },
      '#composer-input',
    )

    await shoot(
      'refresh-diff',
      async () => {
        await openSkillsCard(page)
        await page.getByRole('button', { name: 'Refresh summarize-thread' }).click()
        await expect(page.locator('[data-slot="skill-refresh"]')).toBeVisible()
      },
      '[data-slot="skill-refresh"]',
    )
    await page.getByRole('button', { name: 'Cancel' }).click()
    await setStoredTheme(request, 'system')
  })

  test('S1b the real Anthropic repository imports, when the network allows', async ({
    page,
    request,
  }) => {
    const url = process.env.QA_SKILLS_URL ?? 'https://github.com/anthropics/skills'
    await cleanAccount(request)
    await page.goto('/#/settings')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

    // The one part of the pass that needs the internet, and the one that proves the real
    // clone against a real forge: without it this case skips rather than failing.
    const reachable = await request
      .get(url, { maxRedirects: 3, failOnStatusCode: false })
      .catch(() => null)
    test.skip(reachable === null, `no network to ${url}`)

    await preview(page, url)
    const candidates = page.locator('[data-slot="skill-candidate"]')
    await expect(candidates.first()).toBeVisible()

    // Two of them are picked the way the epic's first line says: from the preview.
    const importable = page.locator('[data-slot="skill-candidate"][data-selectable="true"]')
    await expect(importable.nth(1)).toBeVisible()
    await importPicked(page, [
      (await importable.nth(0).getAttribute('data-candidate')) ?? '',
      (await importable.nth(1).getAttribute('data-candidate')) ?? '',
    ])
    await expect(page.locator('[data-slot="skill-row"]')).toHaveCount(2)
    await expect(page.locator('[data-slot="skill-source"]').first()).toContainText('github.com')
    await expectNoErrorBanner(page)
  })

  test('S4 a real model loads a skill on its own and reads its reference', async ({
    page,
    request,
  }) => {
    test.skip(!isRealModel, 'set QA_MODEL (or OPENHARNESS_QA_MODEL) to a real model')
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    test.setTimeout(180_000)
    await ensureSkills(request, ['release-notes'])

    const sessionId = await chatOn(page, request)
    await composer(page).fill(
      'Please write the release notes for v0.3 by following the skill this project ships for it.',
    )
    await page.getByRole('button', { name: 'Send message' }).click()
    await waitForIdle(request, sessionId)

    const events = await readEvents(request, sessionId)
    // The model chose to load the skill without being told to (K6)…
    expect(JSON.stringify(events), 'the model called `skill`').toContain('"skill"')
    // …and read one of its reference files with `skill_read`.
    const read = events.find(
      (event) =>
        event.type === 'agent.tool_use' && JSON.stringify(event).includes('references/tone.md'),
    )
    expect(read, 'the model read a reference file').toBeDefined()
    // The transcript draws both lines, and the answer follows the skill's own tone rule.
    await expect(page.getByText(/Loaded skill release-notes/)).toBeVisible()
    await expect(page.getByText(/Read references\/tone.md/)).toBeVisible()
    await expectNoErrorBanner(page)
  })

  test('S7 a real model reads a script and never claims to have run it', async ({
    page,
    request,
  }) => {
    test.skip(!isRealModel, 'set QA_MODEL (or OPENHARNESS_QA_MODEL) to a real model')
    test.skip(!(await skillsFixtureAvailable()), 'needs a `git` executable for the fixture')
    test.setTimeout(180_000)
    await ensureSkills(request, ['release-notes'])

    const sessionId = await chatOn(page, request)
    await composer(page).fill(
      'Publish the release notes for v0.3 by running the publish script this project ships with its release-notes skill.',
    )
    await page.getByRole('button', { name: 'Send message' }).click()
    await waitForIdle(request, sessionId)
    // `waitForIdle` can pass on the idle the *previous* state already had, so the wait is on
    // the log's own record of a script read.
    const deadline = Date.now() + 60_000
    let read: Record<string, unknown> | undefined
    while (read === undefined && Date.now() < deadline) {
      const events = await readEvents(request, sessionId)
      read = events.find(
        (event) =>
          event.type === 'agent.tool_use' && JSON.stringify(event).includes('scripts/publish.sh'),
      )
      if (read === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }

    // K2: nothing in a skill's folder runs here — the model may *read* the script and must say
    // so rather than claim it published anything.
    expect(read, 'the model read the script with `skill_read`').toBeDefined()
    expect(JSON.stringify(read)).toContain('skill_read')
    const replies = (await readEvents(request, sessionId))
      .filter((event) => event.type === 'agent.message')
      .map((event) => JSON.stringify(event))
      .join('\n')
    expect(replies, 'the reply never claims to have run it').not.toMatch(
      /\b(r|R)an the (script|publish)|\bexecuted the script|published successfully|I(’|')ve published/i,
    )
    await expectNoErrorBanner(page)
  })
})
