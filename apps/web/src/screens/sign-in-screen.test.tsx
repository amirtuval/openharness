import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mockAuthClient } from '../test-support/better-auth-client-mock'
import { makeFake, renderApp, signInFake } from '../test-support/render-app'

/**
 * Signing in, and the states around it.
 *
 * The server's `GET /v1/auth-config` is stubbed at `fetch` — it is the one request the app
 * makes outside `@openharness/client` — and Better Auth is mocked at the module boundary by
 * the setup file, so the tests drive the same calls the app makes and can see their
 * arguments.
 */

/** Answer `GET /v1/auth-config` the way the server would. */
function serveAuthConfig(config: { providers: string[]; dev_login: boolean }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(config), { status: 200 }))),
  )
}

describe('SignInScreen', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is where an unauthenticated reader lands, and says so', async () => {
    serveAuthConfig({ providers: ['github'], dev_login: false })
    const fake = makeFake({ authenticated: false })

    renderApp(fake, { hash: '#/settings' })

    expect(
      await screen.findByRole('heading', { name: 'Sign in to openharness' }),
    ).toBeInTheDocument()
    // The app itself is not behind it: no sidebar, no screens.
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'New chat' })).not.toBeInTheDocument()
  })

  it('draws one button per enabled provider, with a mark and a spoken label', async () => {
    serveAuthConfig({ providers: ['google', 'microsoft'], dev_login: false })
    const fake = makeFake({ authenticated: false })

    renderApp(fake)

    const google = await screen.findByRole('button', { name: 'Sign in with Google' })
    const microsoft = screen.getByRole('button', { name: 'Sign in with Microsoft' })
    expect(google.querySelector('svg')).not.toBeNull()
    expect(microsoft.querySelector('svg')).not.toBeNull()
    // Only the enabled ones: the server decides, and GitHub is not configured.
    expect(screen.queryByRole('button', { name: 'Sign in with GitHub' })).not.toBeInTheDocument()
  })

  it('leaves the space above the first provider button to the card itself (#187)', async () => {
    serveAuthConfig({ providers: ['google', 'github', 'microsoft'], dev_login: false })

    renderApp(makeFake({ authenticated: false }))

    const buttons = await screen.findAllByRole('button', { name: /^Sign in with / })
    expect(buttons).toHaveLength(3)
    const first = screen.getByRole('button', { name: 'Sign in with Google' })
    const last = screen.getByRole('button', { name: 'Sign in with Microsoft' })
    const card = first.closest('[data-slot="card"]')
    expect(card).not.toBeNull()
    if (card === null) {
      throw new Error('the provider buttons are not inside a card')
    }

    // The regression: a `pt-6` on the `CardContent` the buttons live in put a second 24px on
    // top of the card's own `py-6`, so the first button sat 48px from the top border against
    // 24px below the last one. jsdom has no layout (see `App.test.tsx`), so the offsets are
    // computed from the classes that make them — the same arithmetic the browser does — and
    // `e2e/qa/w15-sign-in.spec.ts` measures the pixels of the same two offsets.
    expect(spaceFromCardBorder(card, first, 'top')).toBe(spaceFromCardBorder(card, last, 'bottom'))

    // Still 8px apart, which is deliberate: stacked buttons sit close, and only the
    // top/bottom asymmetry was the bug.
    expect(first.parentElement).toHaveClass('gap-2')
  })

  it('shows the dev form only when the server reports dev_login', async () => {
    serveAuthConfig({ providers: ['github'], dev_login: true })
    const withDev = makeFake({ authenticated: false })
    const first = renderApp(withDev)

    expect(await screen.findByLabelText('Username')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    first.unmount()

    serveAuthConfig({ providers: ['github'], dev_login: false })
    const withoutDev = makeFake({ authenticated: false })
    renderApp(withoutDev)

    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
  })

  it('leaves for the provider, telling it to come back to the route the reader was on', async () => {
    const user = userEvent.setup({ delay: null })
    serveAuthConfig({ providers: ['google'], dev_login: false })
    const fake = makeFake({ authenticated: false })

    renderApp(fake, { hash: '#/settings' })
    await user.click(await screen.findByRole('button', { name: 'Sign in with Google' }))

    expect(mockAuthClient.signIn.social).toHaveBeenCalledWith({
      provider: 'google',
      callbackURL: `${window.location.origin}/#/settings`,
    })
  })

  it('signs in with the dev form and puts the reader back on their route', async () => {
    const user = userEvent.setup({ delay: null })
    serveAuthConfig({ providers: [], dev_login: true })
    const fake = makeFake({ authenticated: false })
    // The server would set the session cookie on a successful sign-in; the fake's session is
    // its `authenticated` flag, so the mocked call is where it flips back on.
    mockAuthClient.signIn.email.mockImplementationOnce(async () => {
      await signInFake(fake)
      return { data: {}, error: null }
    })

    renderApp(fake, { hash: `#/s/${fake.session.id}` })
    await user.type(await screen.findByLabelText('Username'), 'dev@localhost')
    await user.type(screen.getByLabelText('Password'), 'dev')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(mockAuthClient.signIn.email).toHaveBeenCalledWith({
      email: 'dev@localhost',
      password: 'dev',
    })
    // Back on the chat the reader was trying to open — the same hash, now with a session.
    expect(await screen.findByRole('heading', { name: 'Claude Sonnet 5' })).toBeInTheDocument()
    expect(window.location.hash).toBe(`#/s/${fake.session.id}`)
  })

  it('reports a failed sign-in inline', async () => {
    const user = userEvent.setup({ delay: null })
    serveAuthConfig({ providers: ['github'], dev_login: true })
    mockAuthClient.signIn.email.mockResolvedValueOnce({
      data: null,
      error: { message: 'Invalid email or password.' },
    })
    const fake = makeFake({ authenticated: false })

    renderApp(fake)
    await user.type(await screen.findByLabelText('Username'), 'dev@localhost')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Sign-in failed')
    expect(alert).toHaveTextContent('Invalid email or password.')
    // Still on the sign-in page, with the form as it was.
    expect(screen.getByLabelText('Username')).toHaveValue('dev@localhost')
  })

  it('reports a provider that cannot be started', async () => {
    const user = userEvent.setup({ delay: null })
    serveAuthConfig({ providers: ['github'], dev_login: false })
    mockAuthClient.signIn.social.mockResolvedValueOnce({
      data: null,
      error: { message: 'provider is not configured' },
    })
    const fake = makeFake({ authenticated: false })

    renderApp(fake)
    await user.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('provider is not configured')
  })

  it('follows the next route back once there is a session', async () => {
    serveAuthConfig({ providers: [], dev_login: true })
    const fake = makeFake()

    renderApp(fake, { hash: '#/signin?next=%23%2Fsettings' })

    await waitFor(() => {
      expect(window.location.hash).toBe('#/settings')
    })
  })

  it('signs out from the sidebar, and lands back on the sign-in page', async () => {
    const user = userEvent.setup({ delay: null })
    serveAuthConfig({ providers: ['github'], dev_login: false })
    const fake = makeFake()

    renderApp(fake, { hash: '#/settings' })
    expect(await screen.findByRole('link', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByText(fake.user.email)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(mockAuthClient.signOut).toHaveBeenCalled()
    expect(
      await screen.findByRole('heading', { name: 'Sign in to openharness' }),
    ).toBeInTheDocument()
  })

  it('routes to sign-in when a later call 401s, not only the startup read', async () => {
    const user = userEvent.setup({ delay: null })
    serveAuthConfig({ providers: ['github'], dev_login: false })
    // New chat is immediate (U2): the default is loaded while the session is still good; the
    // create-and-send that follows is not.
    const fake = makeFake({ preferences: { default_model: 'anthropic/claude-sonnet-5' } })

    renderApp(fake, { hash: '#/new' })
    await screen.findByLabelText('Message')

    // The session is revoked behind the app's back — a sign-out in another tab, an expired
    // cookie. The next write answers 401, and that is the whole trigger.
    await fake.auth.signOut()
    await user.type(screen.getByLabelText('Message'), 'hello?')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(
      await screen.findByRole('heading', { name: 'Sign in to openharness' }),
    ).toBeInTheDocument()
  })

  it('says so when the auth config cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('not json', { status: 502 }))),
    )
    const fake = makeFake({ authenticated: false })

    renderApp(fake)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load the sign-in options')
    expect(within(alert).getByText(/502/)).toBeInTheDocument()
  })
})

/**
 * The space, in px, between a card's own border and a button inside it, on one edge.
 *
 * jsdom has no layout, so the offsets a browser would measure are computed from the Tailwind
 * classes that make them: the spacing scale is 4px a step (`py-6` is 24px) and an arbitrary
 * value (`pt-[18px]`, `py-[1.5rem]`) is read as written. Every element from the card down to
 * the button contributes its padding on that edge — a class the reader below cannot parse
 * becomes `NaN`, which fails the comparison rather than silently passing it.
 */
function spaceFromCardBorder(card: Element, button: Element, edge: 'top' | 'bottom'): number {
  const names = edge === 'top' ? ['p', 'pt', 'py'] : ['p', 'pb', 'py']
  let total = 0
  for (
    let element: Element | null = button.parentElement;
    element !== null;
    element = element.parentElement
  ) {
    for (const name of element.classList) {
      const [prefix, ...rest] = name.split('-')
      if (prefix !== undefined && names.includes(prefix)) {
        total += spacingPx(rest.join('-'))
      }
    }
    if (element === card) {
      return total
    }
  }
  throw new Error('the button is not inside the card')
}

/** A Tailwind spacing value in px: a scale step (`6`), or an arbitrary `[18px]`/`[1.5rem]`. */
function spacingPx(value: string): number {
  const arbitrary = /^\[(\d+(?:\.\d+)?)(px|rem)\]$/u.exec(value)
  if (arbitrary !== null) {
    return arbitrary[2] === 'rem' ? Number(arbitrary[1]) * 16 : Number(arbitrary[1])
  }
  return Number(value) * 4
}
