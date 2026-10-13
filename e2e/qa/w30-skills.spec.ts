import { readFileSync } from 'node:fs'
import { request as httpRequest, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { join } from 'node:path'

import { createGitFixture, gitAvailable } from '@openharness/hands/testing'
import type { GitFixture } from '@openharness/hands/testing'
import type { APIRequestContext, Page } from '@playwright/test'

import { composer, expect, expectNoErrorBanner, setStoredTheme, shot, test } from './support'

/**
 * W30 — the skills screens (epic #349; issue #353), hands-on against the real stack.
 *
 * Everything here goes through the **real** server: the real import (a `git` repository served
 * on loopback by `@openharness/hands/testing`'s fixture, cloned by the real
 * `isomorphic-git`/`safeFetch` path), the real `/` menu, the real refresh diff. The stack needs
 * `OPENHARNESS_TEST_MODEL=mock` (no provider key is needed for a turn) and
 * `OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS=1`, because the fixture is a loopback address.
 *
 * The pass is also the screenshots for the issue's report: four views — the Skills list, the
 * import preview, the refresh diff and the `/` menu — in the three themes at a desktop and a
 * ~400px width each, written to `docs/screenshots/353/` with `QA_SHOT_DIR`.
 *
 * A scenario that wants the real Anthropic repository sets `QA_SKILLS_URL` (or runs on a
 * machine whose network reaches github.com); without it that step is skipped and the fixture
 * is the only source, so the pass never depends on the internet.
 */

/** The repository the fixture serves: two skills, one of them command-only. */
const FIXTURE_FILES = {
  'skills/release-notes/SKILL.md': [
    '---',
    'name: release-notes',
    'description: Writes the release notes for a version from the commits since the last tag.',
    'argument-hint: version',
    '---',
    '',
    '# Release notes',
    '',
    'Write the release notes for $ARGUMENTS, one paragraph per change.',
    '',
    'See reference.md for the tone we use.',
    '',
  ].join('\n'),
  'skills/release-notes/reference.md': '# Tone\n\nPlain words, no marketing.\n',
  'skills/summarize-thread/SKILL.md': [
    '---',
    'name: summarize-thread',
    'description: Summarizes a long thread into its decisions.',
    'disable-model-invocation: true',
    '---',
    '',
    '# Summarize a thread',
    '',
    'Read the thread and list its decisions.',
    '',
  ].join('\n'),
}

/** The same repository after a push: `SKILL.md` edited and a file added. */
const CHANGED_FILES = {
  ...FIXTURE_FILES,
  'skills/release-notes/SKILL.md': [
    '---',
    'name: release-notes',
    'description: Writes the release notes for a version from the commits since the last tag.',
    'argument-hint: version',
    '---',
    '',
    '# Release notes',
    '',
    'Write the release notes for $ARGUMENTS, one paragraph per change, newest first.',
    '',
    'See reference.md for the tone we use and CHANGELOG.md for the format.',
    '',
  ].join('\n'),
  'skills/release-notes/CHANGELOG.md': '# Changelog\n\n- one line per change\n',
}

/** The themes every view is captured in, the same three the app ships (epic #201, X3). */
const THEMES = ['light', 'dim', 'dark'] as const

/** The two widths every view is captured at: a desktop and a narrow phone-ish one. */
const WIDTHS = [
  { width: 1280, height: 900, label: 'desktop' },
  { width: 400, height: 780, label: 'narrow' },
] as const

/**
 * Capture a view in all three themes, at a desktop and a ~400px width.
 *
 * The theme is set **through the account** (`setStoredTheme` — the same write Settings →
 * Appearance makes) and the page is reloaded before each capture, because the account's stored
 * theme wins over anything a spec could set in the page. A reload drops whatever the view was
 * showing, so `setup` puts it back every time: the import panel is re-previewed, the refresh
 * panel re-opened, and a chat re-entered — which is also why each capture is a real interaction
 * rather than a state painted once.
 *
 * @param page the page to capture
 * @param name the file name, without the theme and width suffixes
 * @param request the signed-in API context, for the theme write
 * @param setup what puts the view back after the reload
 * @param anchor what the view is about, scrolled to before the capture
 */
async function shoot(
  page: Page,
  name: string,
  request: APIRequestContext,
  setup: () => Promise<void>,
  anchor?: string,
): Promise<void> {
  for (const theme of THEMES) {
    await setStoredTheme(request, theme)
    // A reload is what makes the account's theme the painted one, and it is also what resets
    // the view: `setup` builds it again from the route.
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

/** Frame the Skills card: the settings pane, scrolled to the card, with any notice dismissed. */
async function openSkillsCard(page: Page): Promise<void> {
  await page.goto('/#/settings')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  const dismiss = page.getByRole('button', { name: 'Dismiss notice' })
  if (await dismiss.count()) {
    await dismiss.click()
  }
  const card = page.locator('[data-slot="skill-row"]').first()
  if (await card.count()) {
    await card.scrollIntoViewIfNeeded()
  }
}

/** The Skills card's Import panel: the URL, then Preview. */
async function preview(page: Page, url: string): Promise<void> {
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await page.getByLabel('Repository URL').fill(url)
  await page.getByRole('button', { name: 'Preview' }).click()
  await expect(page.locator('[data-slot="skill-import-preview"]')).toBeVisible()
}

/** The import preview, re-established on the Skills card — what `shoot` calls after a reload. */
async function showImportPreview(page: Page, url: string): Promise<void> {
  await openSkillsCard(page)
  await preview(page, url)
  // The first candidate's `SKILL.md` is open, so the screenshot shows what a reader reviews.
  await page
    .getByRole('button', { name: /^1 file$|^2 files$/ })
    .first()
    .click()
  await expect(page.locator('[data-slot="skill-candidate-skill-md"]').first()).toBeVisible()
}

/**
 * The fixture, behind an **https** front on loopback.
 *
 * The import route takes an `https://` URL and nothing else (K3), and the fixture serves plain
 * HTTP — so the pass puts a TLS-terminating proxy in front of it, using a certificate from
 * `QA_SKILLS_FIXTURE_TLS` (a directory holding `cert.pem` and `key.pem`). The stack must trust
 * that certificate (`NODE_EXTRA_CA_CERTS=<dir>/cert.pem` on the server), and must allow private
 * addresses (`OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS=1`), which is what lets it dial loopback
 * at all. Without the variable the fixture flow is skipped and only the real repository is
 * imported.
 *
 * @param repo the fixture to front
 * @param tlsDir the directory holding the certificate and its key
 */
async function httpsFixture(
  repo: GitFixture,
  tlsDir: string,
): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const target = new URL(repo.url)
  const server: Server = createHttpsServer(
    {
      cert: readFileSync(join(tlsDir, 'cert.pem')),
      key: readFileSync(join(tlsDir, 'key.pem')),
    },
    (incoming, outgoing) => {
      // Everything the git client sends is proxied as it arrived — the smart-HTTP handshake is
      // a plain GET and a POST, and both have to reach the fixture's real server.
      const forwarded = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: incoming.url,
          method: incoming.method,
          headers: incoming.headers,
        },
        (answer) => {
          outgoing.writeHead(answer.statusCode ?? 502, answer.headers)
          answer.pipe(outgoing)
        },
      )
      forwarded.on('error', () => {
        outgoing.writeHead(502)
        outgoing.end()
      })
      incoming.pipe(forwarded)
    },
  )
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `https://127.0.0.1:${port}${target.pathname}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/**
 * Empty the account's skills and chats, so the pass starts from the state it shows.
 *
 * A QA stack is shared and long-lived — a previous run's chat would sit in the sidebar of every
 * screenshot, and its skills would read as names already taken — so the pass cleans up after
 * whoever ran before it, through the same routes a person's own delete uses.
 */
async function cleanAccount(request: APIRequestContext): Promise<void> {
  const skills = await request.get('/v1/me/skills')
  for (const skill of ((await skills.json()) as { data: { id: string }[] }).data) {
    await request.delete(`/v1/me/skills/${skill.id}`)
  }
  const sessions = await request.get('/v1/sessions?limit=100')
  for (const session of ((await sessions.json()) as { data: { id: string }[] }).data) {
    await request.delete(`/v1/sessions/${session.id}`)
  }
}

test.describe('W30 the skills screens', () => {
  test('W30a import two from a repository, run one from /, then refresh it', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const tlsDir = process.env.QA_SKILLS_FIXTURE_TLS
    test.skip(tlsDir === undefined, 'set QA_SKILLS_FIXTURE_TLS (a directory with cert.pem)')
    test.skip(!(await gitAvailable()), 'needs a `git` executable for the fixture')
    await cleanAccount(request)
    const repo = await createGitFixture({ files: FIXTURE_FILES })
    const front = await httpsFixture(repo, tlsDir ?? '')
    try {
      await test.step('Settings → Skills starts empty', async () => {
        await page.goto('/#/settings')
        await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
        await expect(page.getByText(/No skills yet/)).toBeVisible()
        await expectNoErrorBanner(page)
      })

      await test.step('the import previews the repository’s candidates', async () => {
        await preview(page, front.url)
        const candidates = page.locator('[data-slot="skill-candidate"]')
        await expect(candidates).toHaveCount(2)
        await expect(candidates.nth(0)).toHaveAttribute('data-selectable', 'true')
        // The command-only skill is importable too: `disable-model-invocation` is the user's
        // own command, which is exactly what the menu is for.
        await expect(candidates.nth(1)).toHaveAttribute('data-selectable', 'true')
        // Its description, and its `SKILL.md` behind the disclosure.
        await page
          .getByRole('button', { name: /1 file|2 files/ })
          .first()
          .click()
        await expect(page.locator('[data-slot="skill-candidate-skill-md"]').first()).toBeVisible()
        await shoot(
          page,
          'import-preview',
          request,
          () => showImportPreview(page, front.url),
          '[data-slot="skill-import-preview"]',
        )

        await page.getByRole('button', { name: 'Import 2 skills' }).click()
      })

      await test.step('the two skills are listed, with their source and their badge', async () => {
        const rows = page.locator('[data-slot="skill-row"]')
        await expect(rows).toHaveCount(2)
        await expect(
          page.locator('[data-slot="skill-row"][data-skill="release-notes"]'),
        ).toBeVisible()
        const commandOnly = page.locator('[data-slot="skill-row"][data-skill="summarize-thread"]')
        await expect(commandOnly.getByText('command only')).toBeVisible()
        // The source line names the repository and the short commit.
        await expect(page.locator('[data-slot="skill-source"]').first()).toContainText('127.0.0.1')
        await shoot(
          page,
          'skills-list',
          request,
          () => openSkillsCard(page),
          '[data-slot="skill-row"]',
        )
      })

      await test.step('a skill is switched off and on again', async () => {
        // The switch is a controlled input whose state is the server's answer, so the click is
        // the action and the assertion is what waits for it — not `uncheck`, which would expect
        // the state to have changed by the time the click returns.
        const toggle = page.getByRole('checkbox', { name: 'Enable summarize-thread' })
        await toggle.click()
        await expect(toggle).not.toBeChecked()
        await toggle.click()
        await expect(toggle).toBeChecked()
        await expectNoErrorBanner(page)
      })

      await test.step('typing / opens the menu, and the skill runs with its arguments', async () => {
        // A chat from the default model, since a mock pass has no catalog of its own.
        await page.goto('/#/new')
        const input = composer(page)
        await input.fill('/')
        await expect(page.getByRole('listbox', { name: 'Slash commands' })).toBeVisible()
        // The built-in `/compact` is a row of the same menu (K7), and so is the reader's own
        // skill — with its `argument-hint` on the row.
        await expect(page.getByRole('option', { name: /compact/ })).toBeVisible()
        await expect(page.getByRole('option', { name: /release-notes/ })).toBeVisible()
        await shoot(
          page,
          'slash-menu',
          request,
          async () => {
            await page.goto('/#/new')
            await composer(page).fill('/')
            await expect(page.getByRole('listbox', { name: 'Slash commands' })).toBeVisible()
          },
          '#composer-input',
        )

        // The pick fills the box and shows the skill's own `argument-hint` as the placeholder;
        // the send then carries the skill, and the transcript draws the chip.
        await page.getByRole('option', { name: /release-notes/ }).click()
        await expect(input).toHaveValue('/release-notes ')
        await expect(input).toHaveAttribute('placeholder', 'version')
        await input.fill('/release-notes v1.2')
        await page.getByRole('button', { name: 'Send message' }).click()
        await expect(page.locator('[data-slot="message-skill"]')).toBeVisible()
        await expect(page.getByText('/release-notes v1.2').first()).toBeVisible()

        // Where the chat landed, so the invocation view can be re-entered after a reload.
        const sessionHash = new URL(page.url()).hash
        await shoot(
          page,
          'slash-invocation',
          request,
          async () => {
            await page.goto(sessionHash)
            await expect(page.locator('[data-slot="message-skill"]')).toBeVisible()
          },
          '[data-slot="message-skill"]',
        )
      })

      await test.step('a push to the repository shows up as a refresh diff', async () => {
        await repo.commit(CHANGED_FILES, 'more release-note detail')
        await page.goto('/#/settings')
        await page.getByRole('button', { name: 'Refresh release-notes' }).click()
        const panel = page.locator('[data-slot="skill-refresh"]')
        await expect(panel).toBeVisible()
        await expect(panel.locator('[data-slot="skill-refresh-summary"]')).toHaveText(
          '1 file added, 1 file changed',
        )
        await expect(panel.locator('[data-slot="skill-refresh-diff"]')).toBeVisible()
        await shoot(
          page,
          'refresh-diff',
          request,
          async () => {
            await openSkillsCard(page)
            await page.getByRole('button', { name: 'Refresh release-notes' }).click()
            await expect(page.locator('[data-slot="skill-refresh-diff"]')).toBeVisible()
          },
          '[data-slot="skill-refresh"]',
        )

        await page.getByRole('button', { name: 'Replace with this version' }).click()
        await expect(panel).toBeHidden()
        await expectNoErrorBanner(page)
      })

      await test.step('a refresh of an unchanged skill says so', async () => {
        await page.getByRole('button', { name: 'Refresh release-notes' }).click()
        await expect(page.locator('[data-slot="skill-refresh-summary"]')).toHaveText('unchanged')
        await page.getByRole('button', { name: 'Cancel' }).click()
      })

      expect(consoleErrors.filter((entry) => !/favicon/i.test(entry))).toEqual([])
    } finally {
      await front.close()
      await repo.close()
    }
  })

  test('W30b imports from the real Anthropic repository when the network allows', async ({
    page,
    request,
  }) => {
    const url = process.env.QA_SKILLS_URL ?? 'https://github.com/anthropics/skills'
    await page.goto('/#/settings')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

    const reachable = await request
      .get(url, { maxRedirects: 3, failOnStatusCode: false })
      .catch(() => null)
    test.skip(reachable === null, `no network to ${url}`)

    await preview(page, url)
    const candidates = page.locator('[data-slot="skill-candidate"]')
    await expect(candidates.first()).toBeVisible()

    // Two of the repository's skills are picked, the way the hands-on asks: everything the
    // preview ticked is cleared, then the first two that can really be imported are ticked.
    const importable = page.locator('[data-slot="skill-candidate"][data-selectable="true"]')
    await expect(importable.nth(1)).toBeVisible()
    const boxes = page.locator(
      '[data-slot="skill-candidate"][data-selectable="true"] input[type=checkbox]',
    )
    for (const box of await boxes.all()) {
      if (await box.isChecked()) {
        await box.uncheck()
      }
    }
    await boxes.nth(0).check()
    await boxes.nth(1).check()
    await page.getByRole('button', { name: 'Import 2 skills' }).click()
    await expect(page.locator('[data-slot="skill-import-preview"]')).toBeHidden()
    // Both arrived with a source line naming the repository.
    await expect(page.locator('[data-slot="skill-row"]')).not.toHaveCount(0)
    await expectNoErrorBanner(page)
  })
})
