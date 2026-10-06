import type { Page } from '@playwright/test'

import { expect, shot, signInWithDevForm, test } from './support'

/**
 * W15 — the sign-in page (epic #65, A1/A3/A7).
 *
 * The one page every scenario in this pass normally skips past, because the fixtures sign the
 * browser in before it loads. Here it is on purpose: a context with no session at all, and the
 * two ways in the page offers — the social providers, and the development login.
 *
 * The provider buttons only exist when the server has credentials for them, so that half of
 * the scenario skips unless the stack was started with dummy client ids (see `e2e/AGENTS.md`):
 *
 * ```bash
 * GOOGLE_CLIENT_ID=dummy GOOGLE_CLIENT_SECRET=dummy \
 *   GITHUB_CLIENT_ID=dummy GITHUB_CLIENT_SECRET=dummy \
 *   MICROSOFT_CLIENT_ID=dummy MICROSOFT_CLIENT_SECRET=dummy \
 *   docker compose up --build -d
 * ```
 *
 * Real sign-ins with Google, GitHub and Microsoft are checked by hand (they need real OAuth
 * apps); this scenario proves the page offers what the server reports.
 */
test.describe('W15 sign-in', () => {
  test('offers the configured providers and the dev form, and signs in', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await page.goto('/#/signin')
      await expect(page.getByRole('heading', { name: 'Sign in to openharness' })).toBeVisible()

      await test.step('the dev form is there (A7)', async () => {
        await expect(page.getByText('Development login')).toBeVisible()
        await expect(page.getByLabel('Username')).toBeVisible()
        await expect(page.getByLabel('Username')).toHaveAttribute('placeholder', 'dev@localhost')
        await expect(page.getByLabel('Password')).toBeVisible()
      })

      await test.step('the provider buttons match what the server has configured', async () => {
        // Read as the page's own request: no session, the same call the screen makes.
        const anonymous = await context.request.get('/v1/auth-config')
        expect(anonymous.status()).toBe(200)
        const config = (await anonymous.json()) as { providers: string[]; dev_login: boolean }
        expect(config.dev_login).toBe(true)

        const labels: Record<string, string> = {
          google: 'Sign in with Google',
          github: 'Sign in with GitHub',
          microsoft: 'Sign in with Microsoft',
        }
        test.skip(
          config.providers.length === 0,
          'the stack was started without provider client ids; see the note at the top of this file',
        )
        for (const provider of config.providers) {
          await expect(
            page.getByRole('button', { name: labels[provider] ?? '' }),
            `${provider} is configured, so its button is offered`,
          ).toBeVisible()
        }
      })

      await test.step('a wrong password is refused, without signing anybody in', async () => {
        await page.getByLabel('Username').fill('dev@localhost')
        await page.getByLabel('Password').fill('not-the-password')
        await page.getByRole('button', { name: 'Sign in', exact: true }).click()
        await expect(page.getByRole('alert')).toContainText(/sign-in failed/i)
        // Still the sign-in page: a refused attempt signs nobody in.
        await expect(page.getByRole('heading', { name: 'Sign in to openharness' })).toBeVisible()
      })

      await test.step('the dev user signs in and lands in the app', async () => {
        await signInWithDevForm(page)

        // The shell replaces the sign-in page, and the sidebar knows who it is (A2: a session
        // cookie; the URL never moved).
        await expect(page.getByRole('heading', { name: 'Sign in to openharness' })).toHaveCount(0)
        // The sidebar's own control, which only exists for a signed-in person.
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
      })

      await test.step('already signed in, #/signin goes home', async () => {
        await page.goto('/#/signin')
        await expect(page.getByRole('heading', { name: 'Sign in to openharness' })).toHaveCount(0)
      })
    } finally {
      await context.close()
    }
  })
})

/** One way the server can be configured to sign in, and a name for the report. */
interface ProviderSetup {
  /** What this setup is, for the test name and the screenshot. */
  readonly label: string
  /** The providers `GET /v1/auth-config` answers with. */
  readonly providers: readonly string[]
  /** Whether the server reports the dev form too. */
  readonly devLogin: boolean
}

/**
 * The setups the card's spacing is checked in.
 *
 * One, two and three providers are the three shapes the stack draws (a server can have any
 * subset), and the last one is the card as a developer sees it, with the form below the
 * buttons — the buttons' spacing is the same either way, and the card's own rhythm is what
 * makes that true.
 */
const PROVIDER_SETUPS: readonly ProviderSetup[] = [
  { label: 'one provider', providers: ['github'], devLogin: false },
  { label: 'two providers', providers: ['google', 'microsoft'], devLogin: false },
  { label: 'three providers', providers: ['google', 'github', 'microsoft'], devLogin: false },
  {
    label: 'three providers and the dev form',
    providers: ['google', 'github', 'microsoft'],
    devLogin: true,
  },
]

/** The widths the report was made at: a desktop, and the phone the layout has to hold on. */
const WIDTHS = [
  { label: 'desktop', width: 1280, height: 800 },
  { label: 'phone', width: 390, height: 844 },
]

/** How far apart the buttons are, in CSS px, and how far the card's edges are from them. */
interface CardSpacing {
  /** The card's top border to the first button. */
  readonly above: number
  /** The last button to whatever the card puts below the stack. */
  readonly below: number
  /** Each gap between consecutive buttons, in order. */
  readonly between: readonly number[]
}

/**
 * Measure the sign-in card off the live page.
 *
 * The provider stack is the card's *first* content: the dev form, when the server offers it,
 * is a later section of the same card, so its Sign in button is not one of the buttons being
 * measured. The space below the last button is the card's own bottom border when the stack is
 * the card's only content, and the top of the next section when there is one — either way,
 * the next edge the reader sees.
 *
 * Measured from the card's *border box* — the edge the report is about, and the one either of
 * us can see — so the two outer numbers carry the card's 1px border and the gaps between the
 * buttons do not, which is why the comparisons below allow 1px.
 */
async function cardSpacing(page: Page): Promise<CardSpacing> {
  return page.evaluate((): CardSpacing => {
    const card = document.querySelector('[data-slot="card"]')
    if (card === null) {
      throw new Error('the sign-in card is not on the page')
    }
    const content = card.querySelector('[data-slot="card-content"]')
    if (content === null) {
      throw new Error('the sign-in card has no content')
    }
    const buttons = [...content.querySelectorAll('[data-slot="button"]')].map((button) =>
      button.getBoundingClientRect(),
    )
    const first = buttons.at(0)
    const last = buttons.at(-1)
    if (first === undefined || last === undefined) {
      throw new Error('the sign-in card has no provider buttons')
    }
    const cardBox = card.getBoundingClientRect()
    const next = content.nextElementSibling
    const below =
      next === null ? cardBox.bottom - last.bottom : next.getBoundingClientRect().top - last.bottom
    const between: number[] = []
    let previous: DOMRect | undefined
    for (const button of buttons) {
      if (previous !== undefined) {
        between.push(button.top - previous.bottom)
      }
      previous = button
    }
    return { above: first.top - cardBox.top, below, between }
  })
}

/**
 * Assert the card's space is the same everywhere: above the first button, between the
 * buttons, and below the last one.
 *
 * The tolerance is the card's own 1px border: the measurement above carries it at both outer
 * edges, and the gaps between the buttons do not.
 */
function expectEvenSpacing(spacing: CardSpacing, where: string, within = 1): void {
  for (const gap of spacing.between) {
    expect(
      Math.abs(gap - spacing.above),
      `${where}: the gap between buttons is ${gap}px, but the card's top border is ${spacing.above}px from the first one`,
    ).toBeLessThanOrEqual(within)
  }
  expect(
    Math.abs(spacing.below - spacing.above),
    `${where}: the card's bottom border is ${spacing.below}px from the last button, its top border ${spacing.above}px from the first`,
  ).toBeLessThanOrEqual(within)
}

/**
 * W15b — the sign-in card's spacing (#187).
 *
 * Reported on staging: the card carried a 48px gap above the first provider button against
 * 24px below the last one and 8px between the buttons, because `CardContent` had a `pt-6` on
 * top of the card's own `py-6` — a doubled padding, visible as a hole at the top of the card.
 *
 * jsdom has no layout, so `apps/web`'s own tests cannot see this (they say so themselves);
 * the measurement has to be a browser's. The card's spacing is a property of the component's
 * classes, so the *number* of providers does not have to come from the stack under test —
 * the config is stubbed per context and the same page is measured for each setup.
 */
test.describe('W15b sign-in card spacing (#187)', () => {
  test('the space inside the card is even, whatever the server offers', async ({ browser }) => {
    for (const setup of PROVIDER_SETUPS) {
      for (const size of WIDTHS) {
        await test.step(`${setup.label}, ${size.label} (${size.width}px)`, async () => {
          // A context of its own per step: no session cookie, so the page is the sign-in
          // page, and the config for this step is the only thing the app is answered with.
          const context = await browser.newContext({
            viewport: { width: size.width, height: size.height },
          })
          try {
            await context.route('**/v1/auth-config', (route) =>
              route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ providers: setup.providers, dev_login: setup.devLogin }),
              }),
            )
            const page = await context.newPage()
            await page.goto('/#/signin')
            await expect(
              page.getByRole('heading', { name: 'Sign in to openharness' }),
            ).toBeVisible()
            // Every configured provider has its button, so the card is drawn.
            await expect(page.getByRole('button', { name: /^Sign in with / })).toHaveCount(
              setup.providers.length,
            )

            const spacing = await cardSpacing(page)
            console.log(
              `W15b ${setup.label} at ${size.width}px: ${JSON.stringify(spacing)} (border included)`,
            )
            await shot(page, `w15b-${setup.label.replaceAll(' ', '-')}-${size.width}`)
            expectEvenSpacing(spacing, `${setup.label} at ${size.width}px`)
          } finally {
            await context.close()
          }
        })
      }
    }
  })

  test('an auth config that cannot be read leaves an empty card, not a padded one', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    try {
      await context.route('**/v1/auth-config', (route) =>
        route.fulfill({ status: 502, contentType: 'text/plain', body: 'not json' }),
      )
      const page = await context.newPage()
      await page.goto('/#/signin')

      // The failure is reported above the card (the page's own error surface), and the card
      // itself is empty — so its height is its padding and nothing else. A doubled padding
      // is the whole of #187, and this is that with no buttons to measure.
      await expect(page.getByRole('alert')).toContainText('Could not load the sign-in options')
      const card = await page.evaluate(() => {
        const element = document.querySelector('[data-slot="card"]')
        if (element === null) {
          throw new Error('the sign-in card is not on the page')
        }
        const style = getComputedStyle(element)
        const box = element.getBoundingClientRect()
        return {
          inside:
            box.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth),
          padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
        }
      })
      console.log(`W15b unreadable config: ${JSON.stringify(card)}`)
      await shot(page, 'w15b-unreadable-config-1280')
      expect(
        Math.abs(card.inside - card.padding),
        `the empty card is ${card.inside}px tall inside its border, its padding is ${card.padding}px`,
      ).toBeLessThanOrEqual(1)
    } finally {
      await context.close()
    }
  })
})
