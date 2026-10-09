import { describe, expect, it } from 'vitest'

import { e2eHarness } from './harness'

/**
 * The dev login's boot guard (epic #65, A7).
 *
 * `OPENHARNESS_DEV_LOGIN=1` is a fixed password on a well-known address, so the server may
 * only come up with it on a loopback URL: the guard is what keeps a deployment from ever
 * serving it. This is the real process, so the test watches a boot that has to **fail** —
 * which is also why it is its own file: the failing server is a child that exits, not one of
 * the harness's running ones.
 *
 * The harness starts servers on `http://127.0.0.1:<port>` by default, which is exactly the
 * shape the guard allows — every other test in this suite is the other half of this one.
 */

const harness = e2eHarness('dev-login-guard')

describe('the dev-login boot guard (A7)', () => {
  it('refuses to boot with the dev login on a non-localhost public URL', async () => {
    const failure = await harness
      .server({ publicUrl: 'https://openharness.example.com', devLogin: true })
      .then(() => null)
      .catch((error: unknown) => error)

    expect(failure, 'a public URL with the dev login must not come up').toBeInstanceOf(Error)
    const message = (failure as Error).message
    // The harness's readiness failure carries the child's whole output, so the guard's own
    // sentence is in there — naming the variable and the URL it refused.
    expect(message).toContain('OPENHARNESS_DEV_LOGIN')
    expect(message).toContain('localhost')
    expect(message).toContain('https://openharness.example.com')
  })

  it('is the flag that enables it: without it, no password sign-in at all', async () => {
    // The boot the guard permits — a loopback public URL with a provider configured, since
    // a server with no provider and no dev login has no way to sign in and refuses to boot —
    // comes up, and the flag is what decides whether the dev login exists: with it off,
    // nothing about the documented credentials works.
    const server = await harness.server({
      devLogin: false,
      env: { GOOGLE_CLIENT_ID: 'dummy', GOOGLE_CLIENT_SECRET: 'dummy' },
    })

    const config = await fetch(`${server.baseUrl}/v1/auth-config`)
    expect(await config.json()).toEqual({ providers: ['google'], dev_login: false })

    const attempt = await fetch(`${server.baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      // The trusted origin, so the refusal is about the flag and not the CSRF check: the
      // server runs in production mode (#79), where a sign-in without it is refused before
      // the password path is even reached.
      headers: { 'content-type': 'application/json', origin: server.baseUrl },
      body: JSON.stringify({ email: 'dev@localhost', password: 'dev' }),
    })
    expect(attempt.ok).toBe(false)
  })
})
