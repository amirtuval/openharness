import {
  QA_MODEL,
  composer,
  createAgent,
  createSession,
  expect,
  expectNoErrorBanner,
  openChat,
  sendFromComposer,
  shot,
  status,
  test,
  uniqueName,
  waitForAnswer,
} from './support'

/** W13 — layout at two widths, and the keyboard the composer promises. */
test.describe('W13 layout and keyboard', () => {
  test('W13 desktop and narrow widths, Enter / Shift+Enter, Tab order', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const agent = await createAgent(request, {
      name: uniqueName('QA W13'),
      model: QA_MODEL,
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)
    await expectNoErrorBanner(page)
    await sendFromComposer(page, 'a message so the conversation is not empty')

    await test.step('desktop width', async () => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect(page.getByRole('navigation', { name: 'Chats' })).toBeVisible()
      await shot(page, 'w13-01-desktop-1440')
    })

    await test.step('narrow width', async () => {
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(composer(page)).toBeVisible()
      await shot(page, 'w13-02-narrow-390')

      const overflow = await page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      }))
      expect(overflow.documentWidth, 'the page does not scroll sideways').toBeLessThanOrEqual(
        overflow.viewportWidth,
      )
    })

    await page.setViewportSize({ width: 1280, height: 800 })

    await test.step('Enter sends, Shift+Enter adds a line', async () => {
      const input = composer(page)
      await input.click()
      await input.pressSequentially('first line')
      await input.press('Shift+Enter')
      await input.pressSequentially('second line')

      await expect(input).toHaveValue('first line\nsecond line')
      expect(await page.locator('article[data-role="user"]').count(), 'not sent yet').toBe(1)

      await input.press('Enter')
      await expect(input).toHaveValue('')
      await expect(page.locator('article[data-role="user"]').last()).toContainText('first line')
      await expect(page.locator('article[data-role="user"]').last()).toContainText('second line')
      await shot(page, 'w13-03-newline-then-sent')
    })

    await test.step('Tab order', async () => {
      // The turn the step above just sent has to be over: while one is running the control
      // next to the composer is Stop, which is the right answer to "what is beside the
      // composer" and the wrong answer to this question.
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
      const focusedNow = async (): Promise<string> =>
        page.evaluate(() => {
          const element = document.activeElement as HTMLElement | null
          return element === null
            ? 'none'
            : `${element.tagName.toLowerCase()}#${element.id}[${element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 24) ?? ''}]`
        })

      await page.locator('body').click({ position: { x: 5, y: 5 } })
      const order: string[] = []
      for (let index = 0; index < 8; index += 1) {
        await page.keyboard.press('Tab')
        order.push(await focusedNow())
      }
      console.log('tab order from the top:', order.join(' → '))
      // The sidebar comes first, which is where it is on the page.
      expect(order[0]).toContain('openharness')
      expect(order[1]).toContain('New chat')

      // And the composer hands the keyboard to the buttons next to it.
      await composer(page).click()
      await composer(page).fill('something to enable Send')
      await page.keyboard.press('Tab')
      expect(await focusedNow(), 'Tab from the composer reaches Send').toContain('Send message')
      await composer(page).fill('')
    })

    await expectNoErrorBanner(page)

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  // Regression coverage for issue #26: at 390 px the sidebar used to keep its 256 px and the
  // chat pane was left with ~134 px (one word per line, a 58 px composer). Fixed by PR #33,
  // which turns the same panel into an overlay drawer below `md`.
  test('W13b at 390 px the chat keeps the viewport and the list is a drawer', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const agent = await createAgent(request, {
      name: uniqueName('QA W13b'),
      model: QA_MODEL,
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)
    await expectNoErrorBanner(page)
    await sendFromComposer(page, 'a message so the conversation is not empty')
    await waitForAnswer(page, 'a message so the conversation is not empty')
    await expectNoErrorBanner(page)

    await page.setViewportSize({ width: 390, height: 844 })

    // The panel and the control that opens it. `#app-sidebar` is the `aside` the shell moves
    // over the content below `md`; the button is the one the top bar shows at that width.
    const drawer = page.locator('#app-sidebar')
    const menu = page.getByRole('button', { name: 'Navigation' })

    await test.step('the sidebar gives up its column', async () => {
      await expect(drawer, 'the 256px column is gone at this width').toBeHidden()

      const widths = await page.evaluate(() => ({
        main: document.querySelector('main')?.getBoundingClientRect().width ?? 0,
        composer: document.querySelector('#composer-input')?.getBoundingClientRect().width ?? 0,
      }))
      // The bug's numbers were main 134 px and composer 58 px on a 390 px viewport.
      expect(widths.main, 'the chat pane has the viewport').toBeGreaterThan(300)
      expect(widths.composer, 'the composer is a usable width').toBeGreaterThan(250)
      await shot(page, 'w13-04-narrow-390-chat')
    })

    await test.step('the drawer opens', async () => {
      await menu.click()
      await expect(menu).toHaveAttribute('aria-expanded', 'true')
      await expect(drawer).toBeVisible()
      await expect(drawer.getByRole('navigation', { name: 'Chats' })).toBeVisible()
      await expect(drawer.locator(`a[href="#/s/${session.id}"]`)).toHaveAttribute(
        'aria-current',
        'page',
      )
      await shot(page, 'w13-05-narrow-390-drawer-open')
    })

    await test.step('Escape closes it', async () => {
      await page.keyboard.press('Escape')
      await expect(drawer).toBeHidden()
      await expect(menu).toHaveAttribute('aria-expanded', 'false')
    })

    await test.step('the backdrop closes it too', async () => {
      await menu.click()
      await expect(drawer).toBeVisible()
      // The scrim covers the viewport and the drawer sits above it on the left, so the part
      // of it a thumb reaches is the strip to the right of the panel.
      await page.locator('[data-slot="sidebar-backdrop"]').click({ position: { x: 340, y: 500 } })
      await expect(drawer).toBeHidden()
      await expect(menu).toHaveAttribute('aria-expanded', 'false')
    })

    await test.step('nothing was pushed sideways, then or now', async () => {
      const overflow = await page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      }))
      expect(overflow.documentWidth, 'the page does not scroll sideways').toBeLessThanOrEqual(
        overflow.viewportWidth,
      )
    })

    await expectNoErrorBanner(page)

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
