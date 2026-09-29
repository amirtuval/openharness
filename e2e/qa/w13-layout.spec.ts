import {
  composer,
  createAgent,
  createSession,
  expect,
  openChat,
  sendFromComposer,
  shot,
  test,
  uniqueName,
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
      model: 'anthropic/claude-sonnet-5',
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)
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

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
