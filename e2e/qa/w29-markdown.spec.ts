import {
  BASE_URL,
  composer,
  createChat,
  expect,
  expectNoConsoleErrors,
  expectNoErrorBanner,
  isRealModel,
  openChat,
  paintedTheme,
  sendFromComposer,
  setStoredTheme,
  shot,
  storedTheme,
  test,
  waitForAnswer,
} from './support'

/**
 * W29 — markdown in the web chat (epic #201, X9; issue #204).
 *
 * What a browser can prove that the unit tests cannot: that the highlighting really loaded in
 * the built bundle, that it is painted in all three themes, that the copy button puts the
 * *text* on the real clipboard, and that a reply with a fence still open looks like a code
 * block rather than like the text it is made of.
 *
 * The markdown is sent rather than asked for where the stack runs the mock model, which echoes
 * its prompt — the same trick W2 uses. A real model is asked to reproduce it and nothing else,
 * because what this scenario is about is the renderer, not what a provider chooses to write.
 */

/** A reply with every element the renderer has to get right. */
const MARKDOWN = [
  '# Deploy notes',
  '',
  '- first, a list',
  '- then a `table`, which scrolls',
  '',
  '| package | what it holds |',
  '| --- | --- |',
  '| `@openharness/client` | the transcript reducer every frontend reads |',
  '| `@openharness/protocol` | the event and session schemas, verbatim |',
  '| `@openharness/session` | the append-only log, which nothing ever rewrites |',
  '',
  '```typescript',
  'export function greeting(name: string): string {',
  '  return `hello ${name}`',
  '}',
  '```',
  '',
  '```bash',
  'yarn install --immutable',
  'yarn turbo run build test --filter=@openharness/web...',
  '```',
  '',
  'Read [the docs](https://example.com/docs) for the rest.',
].join('\n')

/** What the mock needs to hear to answer with {@link MARKDOWN}; a real model is asked for it. */
const PROMPT = isRealModel
  ? `Reply with exactly this markdown and nothing else — no code fence around it, no commentary:\n\n${MARKDOWN}`
  : MARKDOWN

test.describe('W29 markdown', () => {
  test('W29 code is highlighted, copyable and themed; tables scroll; links leave the tab', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const previousTheme = await storedTheme(request)
    const chat = await createChat(request)
    // The clipboard is the browser's, not the app's: reading it back is the only way to know
    // the button copied anything, and Chromium only allows that with the permission granted.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: BASE_URL,
    })

    try {
      await openChat(page, chat.id)
      await sendFromComposer(page, PROMPT)
      await waitForAnswer(page, '# Deploy notes')
      await expect(page.getByRole('status', { name: 'Status: Idle' })).toBeVisible()

      const reply = page.locator('article[data-role="agent"]').last()
      const typescript = reply.locator('[data-slot="code-block"][data-language="typescript"]')
      const bash = reply.locator('[data-slot="code-block"][data-language="bash"]')

      await test.step('both fences are blocks, with their language in the header', async () => {
        await expect(typescript).toBeVisible()
        await expect(bash).toBeVisible()
        await expect(typescript.locator('[data-slot="code-language"]')).toHaveText('typescript')
        await expect(bash.locator('[data-slot="code-language"]')).toHaveText('bash')
        await expect(typescript).toContainText('export function greeting')
      })

      await test.step('the tokens carry a variable for each of the three themes', async () => {
        // Shiki writes `--shiki-light`, `--shiki-dim` and `--shiki-dark` on every token and
        // `index.css` picks one per `[data-theme]`; if the highlighter never loaded, the block
        // is plain text and none of them is there.
        const tokens = typescript.locator('[data-slot="code-token"]')
        await expect(tokens.first()).toHaveAttribute('style', /--shiki-light/)
        await expect(tokens.first()).toHaveAttribute('style', /--shiki-dim/)
        await expect(tokens.first()).toHaveAttribute('style', /--shiki-dark/)
      })

      await test.step('a long line scrolls sideways rather than wrapping', async () => {
        const code = bash.locator('pre')
        expect(await code.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('pre')
        expect(await code.evaluate((element) => getComputedStyle(element).overflowX)).toBe('auto')
      })

      await test.step('the table has a scroll container of its own', async () => {
        const table = reply.locator('table')
        await expect(table).toBeVisible()
        expect(
          await table.evaluate((element) => {
            const container = element.parentElement
            return container === null ? null : getComputedStyle(container).overflowX
          }),
        ).toBe('auto')
      })

      await test.step('Copy puts the code on the clipboard and says so', async () => {
        await bash.getByRole('button', { name: 'Copy' }).click()
        await expect(bash.getByRole('button', { name: 'Copied' })).toBeVisible()
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          'yarn install --immutable\nyarn turbo run build test --filter=@openharness/web...\n',
        )
      })

      await test.step('links leave the tab, without a referrer', async () => {
        const link = reply.getByRole('link', { name: 'the docs' })
        await expect(link).toHaveAttribute('href', 'https://example.com/docs')
        await expect(link).toHaveAttribute('target', '_blank')
        await expect(link).toHaveAttribute('rel', 'noreferrer')
      })

      await test.step('a screenshot in each theme (#201, X3)', async () => {
        for (const theme of ['light', 'dim', 'dark'] as const) {
          await setStoredTheme(request, theme)
          await page.reload()
          await expect(page.getByRole('status', { name: /^Status: / })).toBeVisible()
          expect(await paintedTheme(page)).toBe(theme)
          await expect(
            page.locator('[data-slot="code-block"][data-language="typescript"]'),
          ).toBeVisible()
          await shot(page, `w29-code-${theme}`)
        }
      })

      await expectNoErrorBanner(page)
      expectNoConsoleErrors(consoleErrors)
    } finally {
      await setStoredTheme(request, previousTheme)
    }
  })

  test('W29 a reply with its fence still open is a code block mid-stream', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const chat = await createChat(request)
    await openChat(page, chat.id)

    // The prompt *is* the markdown, so the reply streams back through a fence on its way in.
    await sendFromComposer(page, PROMPT)

    const streaming = page.locator('article[data-role="agent"][data-streaming="true"]')
    await expect(streaming).toBeVisible({ timeout: 60_000 })

    // The block exists while the reply is still arriving, and holds what has arrived so far:
    // this is the whole of the streaming-safety rule — CommonMark closes an unterminated
    // fence where the text ends, so the reader watches the block form instead of watching a
    // stray ``` and a paragraph.
    const block = streaming.locator('[data-slot="code-block"]').last()
    await expect(block).toBeVisible()
    await expect(block).toContainText('yarn install --immutable')
    await shot(page, 'w29-mid-stream-open-fence')

    await expect(composer(page)).toBeEnabled()
    await expect(page.getByRole('status', { name: 'Status: Idle' })).toBeVisible({
      timeout: 60_000,
    })
    await expectNoErrorBanner(page)
    expectNoConsoleErrors(consoleErrors)
  })
})
