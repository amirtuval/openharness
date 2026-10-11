import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { deviceHash } from '../lib/router'
import { mockAuthClient } from '../test-support/better-auth-client-mock'
import { makeFake, renderApp, signInFake } from '../test-support/render-app'

/**
 * The device-approval page (epic #65, A6) — what `oh login` opens in the browser.
 *
 * The page is the lock `oh login`'s code opens: it shows the code, asks the reader to check
 * it against their terminal, and approves or denies. Better Auth's verify/approve/deny calls
 * are the mocked module boundary; everything else is the real app.
 */

const USER_CODE = 'WXYZ-1234'
const DEVICE_HASH = deviceHash(USER_CODE)

describe('DeviceScreen', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the code large, confirms it against the terminal, and approves', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()

    renderApp(fake, { hash: DEVICE_HASH })

    // The code is on screen — and verifying it, which is what claims it for this session,
    // came first.
    const code = await screen.findByText(USER_CODE)
    expect(code).toHaveAttribute('data-slot', 'device-user-code')
    expect(mockAuthClient.device).toHaveBeenCalledWith({ query: { user_code: USER_CODE } })
    expect(screen.getByText('Does this code match your terminal?')).toBeInTheDocument()

    // `findBy`, not `getBy`: the code and the sentence above are drawn while the verification
    // is still in flight, and the buttons appear only once it answers — a `getBy` here is a
    // race a loaded runner loses (the same trap `AGENTS.md` names).
    await user.click(await screen.findByRole('button', { name: 'Approve' }))

    expect(mockAuthClient.device.approve).toHaveBeenCalledWith({ userCode: USER_CODE })
    expect(await screen.findByText('Approved')).toBeInTheDocument()
    expect(screen.getByText(/Return to your terminal/)).toBeInTheDocument()
    expect(mockAuthClient.device.deny).not.toHaveBeenCalled()
  })

  it('denies when the code is not the one in the terminal', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()

    renderApp(fake, { hash: DEVICE_HASH })
    await user.click(await screen.findByRole('button', { name: 'Deny' }))

    expect(mockAuthClient.device.deny).toHaveBeenCalledWith({ userCode: USER_CODE })
    expect(await screen.findByText('Denied')).toBeInTheDocument()
    expect(mockAuthClient.device.approve).not.toHaveBeenCalled()
  })

  it('shows an invalid or expired code as a failure, not a decision', async () => {
    mockAuthClient.device.mockResolvedValueOnce({
      data: null,
      error: { message: 'Invalid user code.' },
    })
    const fake = makeFake()

    renderApp(fake, { hash: DEVICE_HASH })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Device login failed')
    expect(alert).toHaveTextContent('Invalid user code.')
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  // The device endpoints answer with the OAuth pair `{"error": …, "error_description": …}`,
  // a body with no `message` — what the page used to drop on the floor (issue #80). The
  // codes below are the ones the server actually sends, captured during the #74 pass.

  it('reads a code the server never issued as the server’s own sentence', async () => {
    mockAuthClient.device.mockResolvedValueOnce({
      data: null,
      error: {
        error: 'invalid_request',
        error_description: 'Invalid user code',
        status: 400,
        statusText: 'Bad Request',
      },
    })
    const fake = makeFake()

    renderApp(fake, { hash: DEVICE_HASH })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/not one this server issued/)
    expect(alert).not.toHaveTextContent('The sign-in request failed.')
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  it('says an expired code means running `oh login` again', async () => {
    mockAuthClient.device.mockResolvedValueOnce({
      data: null,
      error: {
        error: 'expired_token',
        error_description: 'User code has expired',
        status: 400,
        statusText: 'Bad Request',
      },
    })
    const fake = makeFake()

    renderApp(fake, { hash: DEVICE_HASH })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This code has expired. Run `oh login` again for a fresh one.')
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  it('shows a rate-limit answer with the wait it names', async () => {
    mockAuthClient.device.mockResolvedValueOnce({
      data: null,
      error: {
        message: 'Too many requests. Please try again later.',
        status: 429,
        statusText: 'Too Many Requests',
        retry_after: 30,
      },
    })
    const fake = makeFake()

    renderApp(fake, { hash: DEVICE_HASH })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Too many requests — try again in 30 seconds.')
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  it('maps a refused approval, and keeps a code’s other refusals in the server’s words', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    mockAuthClient.device.approve.mockResolvedValueOnce({
      data: null,
      error: {
        error: 'access_denied',
        error_description: 'You are not authorized to approve this device authorization',
        status: 403,
      },
    })

    const first = renderApp(fake, { hash: DEVICE_HASH })
    await user.click(await screen.findByRole('button', { name: 'Approve' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'The server refused this request. Run `oh login` again to start over.',
    )
    expect(screen.queryByText('Approved')).not.toBeInTheDocument()
    first.unmount()

    // `invalid_request` covers more than a wrong code: a code that was already decided says
    // so in its description, and that is what the reader sees.
    mockAuthClient.device.approve.mockResolvedValueOnce({
      data: null,
      error: {
        error: 'invalid_request',
        error_description: 'Device code already processed',
        status: 400,
      },
    })
    renderApp(fake, { hash: DEVICE_HASH })
    await user.click(await screen.findByRole('button', { name: 'Approve' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Device code already processed')
  })

  it('reports a failed deny through the same mapping', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    mockAuthClient.device.deny.mockResolvedValueOnce({
      data: null,
      error: { error: 'expired_token', error_description: 'User code has expired', status: 400 },
    })

    renderApp(fake, { hash: DEVICE_HASH })
    await user.click(await screen.findByRole('button', { name: 'Deny' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This code has expired. Run `oh login` again for a fresh one.',
    )
  })

  it('falls back to the description, then the code, then the stand-in', async () => {
    const fake = makeFake()

    // Each section scripts the answer itself (not `…Once`) because a second `renderApp` in
    // one test mounts the screen twice: the fresh shell's session check briefly steps through
    // the checking state, so the device effect runs again with the client already checked.
    // A description with no mapped code: the server's own explanation is shown.
    mockAuthClient.device.mockResolvedValue({
      data: null,
      error: {
        error: 'server_error',
        error_description: 'The device store is unreachable',
        status: 500,
      },
    })
    const described = renderApp(fake, { hash: DEVICE_HASH })
    expect(await screen.findByRole('alert')).toHaveTextContent('The device store is unreachable')
    described.unmount()

    // A bare code: better the code than no reason at all.
    mockAuthClient.device.mockResolvedValue({
      data: null,
      error: { error: 'server_error', status: 500 },
    })
    const bare = renderApp(fake, { hash: DEVICE_HASH })
    expect(await screen.findByRole('alert')).toHaveTextContent('server_error')
    bare.unmount()

    // Nothing to go on: the stand-in.
    mockAuthClient.device.mockResolvedValue({ data: null, error: {} })
    renderApp(fake, { hash: DEVICE_HASH })
    expect(await screen.findByRole('alert')).toHaveTextContent('The sign-in request failed.')
  })

  it('reports a code that was already decided', async () => {
    mockAuthClient.device.mockResolvedValueOnce({ data: { status: 'approved' }, error: null })
    const fake = makeFake()

    renderApp(fake, { hash: DEVICE_HASH })

    expect(await screen.findByText('Approved')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument()
  })

  it('asks for a code when the page was opened without one', async () => {
    const fake = makeFake()

    renderApp(fake, { hash: '#/device' })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/needs the code from your terminal/)
    expect(mockAuthClient.device).not.toHaveBeenCalled()
  })

  it('signs the reader in first, then comes back to the code', async () => {
    const user = userEvent.setup({ delay: null })
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ providers: [], dev_login: true }), { status: 200 }),
        ),
      ),
    )
    const fake = makeFake({ authenticated: false })
    mockAuthClient.signIn.email.mockImplementationOnce(async () => {
      await signInFake(fake)
      return { data: {}, error: null }
    })

    renderApp(fake, { hash: DEVICE_HASH })

    // Signed out: the sign-in page, not the approval — a device code is claimed by the
    // session that approves it, so there has to be one.
    expect(
      await screen.findByRole('heading', { name: 'Sign in to openharness' }),
    ).toBeInTheDocument()

    await user.type(screen.getByLabelText('Username'), 'dev@localhost')
    await user.type(screen.getByLabelText('Password'), 'dev')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    // Back on the approval page, with the code from the URL still in hand.
    expect(await screen.findByText(USER_CODE)).toBeInTheDocument()
    expect(mockAuthClient.device).toHaveBeenCalledWith({ query: { user_code: USER_CODE } })
  })

  it('carries the device route through a social sign-in', async () => {
    const user = userEvent.setup({ delay: null })
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ providers: ['github'], dev_login: false }), {
            status: 200,
          }),
        ),
      ),
    )
    const fake = makeFake({ authenticated: false })

    renderApp(fake, { hash: DEVICE_HASH })
    await user.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }))

    expect(mockAuthClient.signIn.social).toHaveBeenCalledWith({
      provider: 'github',
      callbackURL: `${window.location.origin}/${DEVICE_HASH}`,
    })
  })

  it('sends the reader to sign in when the session ended under it, and back here after', async () => {
    const user = userEvent.setup({ delay: null })
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ providers: ['github'], dev_login: false }), {
            status: 200,
          }),
        ),
      ),
    )
    mockAuthClient.device.mockResolvedValueOnce({
      data: null,
      error: { message: 'Authentication required', status: 401 },
    })
    const fake = makeFake()

    renderApp(fake, { hash: DEVICE_HASH })

    // A dead session is not a bad code: the sign-in page takes over.
    expect(
      await screen.findByRole('heading', { name: 'Sign in to openharness' }),
    ).toBeInTheDocument()

    // And the approval page is where signing in comes back to — the code is still in the URL.
    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub' }))
    expect(mockAuthClient.signIn.social).toHaveBeenCalledWith({
      provider: 'github',
      callbackURL: `${window.location.origin}/${DEVICE_HASH}`,
    })
  })

  it('shows a failed approval instead of claiming success', async () => {
    const user = userEvent.setup({ delay: null })
    mockAuthClient.device.approve.mockResolvedValueOnce({
      data: null,
      error: { message: 'You are not authorized to approve this device authorization' },
    })
    const fake = makeFake()

    renderApp(fake, { hash: DEVICE_HASH })
    await user.click(await screen.findByRole('button', { name: 'Approve' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Device login failed')
    expect(within(alert).getByText(/not authorized/)).toBeInTheDocument()
    expect(screen.queryByText('Approved')).not.toBeInTheDocument()
  })
})
