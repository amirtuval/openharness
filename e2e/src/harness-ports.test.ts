import { describe, expect, it } from 'vitest'

import { e2eHarness, startServerProcess } from './harness'

/**
 * A start on a port that is already taken (#123).
 *
 * `startServerProcess` picks its port by probing — bind `0`, read the port back, close — and
 * the child binds it a whole boot later, so in a parallel run another test's probe can be
 * handed the same port first. What must not happen is what used to: the readiness check
 * polled `/health` on the port, the *other* server answered it, and the start returned
 * success for a child that had died of `EADDRINUSE` — the test then talked to a different
 * file's server (the shape CI saw in `dev-login-guard`: a server with the dev login on and
 * no providers where the test had started one with Google and without the login).
 *
 * This is the deterministic half of that race as a test: hold the port with a running server,
 * and a start on the same port has to fail, carrying its own boot log.
 */
const harness = e2eHarness('harness-ports')

describe('a start on a port another server already holds (#123)', () => {
  it('fails with the boot log instead of adopting the server that holds the port', async () => {
    const database = await harness.database()
    const occupant = await harness.server()

    const failure = await startServerProcess({
      databaseUrl: database.url,
      port: occupant.port,
    }).then(
      (server) => server,
      (error: unknown) => error,
    )

    expect(failure, 'a start on a held port must not come up').toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('EADDRINUSE')
  })
})
