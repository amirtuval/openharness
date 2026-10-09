import { describe, expect, it } from 'vitest'

import { DEV_LOGIN_EMAIL, DEV_LOGIN_PASSWORD, e2eHarness, type ServerProcess } from './harness'

/**
 * The harness's own sign-in against the server's rate limit (A2; the e2e section of the #105
 * review).
 *
 * `/api/auth/sign-in/email` allows three attempts per ten seconds per address — the
 * brute-force rule — and the harness's per-file session cache keeps a well-behaved file
 * inside that budget. A file that mixes several people trips its own limit, though, and a
 * 429 is not a failure of the credentials: `signIn` waits the window the server named
 * (`X-Retry-After`, the QA fixtures' pattern) and tries again, nothing else is ever retried.
 *
 * This test spends the budget for real — until the server refuses — and then signs in more
 * users than one window allows, back to back. Every one of those starts inside the window
 * that just refused a sign-in, so signing all of them in can only pass if the wait happens;
 * the same file failed before the harness learned to wait.
 */

const harness = e2eHarness('harness-signin')

/** One raw sign-in, the way the harness's own sends it. */
function rawSignIn(server: ServerProcess): Promise<Response> {
  return fetch(`${server.baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.baseUrl },
    body: JSON.stringify({ email: DEV_LOGIN_EMAIL, password: DEV_LOGIN_PASSWORD }),
  })
}

describe('the harness sign-in and the sign-in rate limit (A2)', () => {
  it('waits the window out and signs in more users than the limit allows', async () => {
    const server = await harness.server()

    // Spend the window until the server says no. A fast lane reaches the refusal on the
    // fourth attempt; a box slow enough that an attempt outlives the window keeps spending
    // it until the refusals arrive — either way the loop ends on one, not on a guess about
    // how fast the machine is.
    let refusals = 0
    for (let attempt = 0; attempt < 12 && refusals === 0; attempt += 1) {
      const response = await rawSignIn(server)
      if (response.status === 429) {
        // The wait the harness honors: present, and a real number of seconds this time.
        expect(Number(response.headers.get('x-retry-after'))).toBeGreaterThanOrEqual(0)
        refusals += 1
        break
      }
      expect([attempt, response.status]).toEqual([attempt, 200])
      await response.arrayBuffer()
    }
    expect(refusals, 'the sign-in limit never tripped').toBe(1)

    // More accounts than one window allows, back to back: the window is warm from the probe,
    // so at least one of these is refused first and only the wait can make it succeed. All
    // four must end up signed in, each on a session of its own.
    const names = ['one', 'two', 'three', 'four']
    const people = []
    for (const name of names) {
      people.push(
        await harness.user(server, {
          email: `${name}@harness-signin.test`,
          password: `${name}-password`,
        }),
      )
    }
    expect(people.map((person) => person.user.email)).toEqual(
      names.map((name) => `${name}@harness-signin.test`),
    )
    expect(new Set(people.map((person) => person.token)).size).toBe(names.length)
  })
})
