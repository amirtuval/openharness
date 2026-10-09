import { createClient, DeviceLoginError, OPENHARNESS_CLI_CLIENT_ID } from '@openharness/client'
import { describe, expect, it } from 'vitest'

import {
  DEV_LOGIN_STORED_EMAIL,
  e2eHarness,
  withDatabaseClient,
  type ServerProcess,
} from './harness'

/**
 * `oh login`, over a real server (epic #65, A6 — RFC 8628).
 *
 * The flow the CLI runs, end to end: ask for a device code, have a signed-in person approve it
 * in the web app, poll, and hold a session token. The CLI's own half is `@openharness/client`'s
 * device-flow helper — the same calls `oh login` makes — and the browser's half is the three
 * endpoints the approval page calls (`/device` verifies and claims the code for the signed-in
 * person, `/device/approve` and `/device/deny` decide it), so a regression that only shows up
 * where the two halves meet is what this file is for.
 *
 * The refusals are tested as carefully as the success: a denied request, a code nobody issued,
 * a code that lapsed, a code only its owner may decide, and a code that has already been
 * redeemed must each answer exactly what RFC 8628 says, because every one of them is a way a
 * login could go wrong quietly.
 */

const harness = e2eHarness('device-flow')

/** Poll the token endpoint by hand — for the answers the client's own loop swallows. */
async function pollRaw(
  server: ServerProcess,
  deviceCode: string,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${server.baseUrl}/api/auth/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: OPENHARNESS_CLI_CLIENT_ID,
    }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** What the browser's approval page calls: verify (and claim), then decide. */
async function deviceApi(
  server: ServerProcess,
  token: string,
  request: { readonly userCode: string; readonly decision?: 'approve' | 'deny' },
): Promise<Response> {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  if (request.decision !== undefined) {
    return fetch(`${server.baseUrl}/api/auth/device/${request.decision}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userCode: request.userCode }),
    })
  }
  return fetch(
    `${server.baseUrl}/api/auth/device?user_code=${encodeURIComponent(request.userCode)}`,
    {
      headers,
    },
  )
}

describe('the device flow (A6)', () => {
  it('hands the CLI a code, a verification URL, and a ten-minute lifetime', async () => {
    const server = await harness.server()
    const started = await createClient({ baseUrl: server.baseUrl }).auth.startDeviceLogin()

    // The code the terminal shows — no ambiguous letters or digits (Better Auth's alphabet) —
    // and the URL it prints: the web app's hash route, with the code **inside the fragment**,
    // where the app's router reads it (the server rewrites the field Better Auth built; see
    // `deviceVerificationUriComplete`).
    expect(started.userCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
    expect(started.deviceCode.length).toBeGreaterThan(0)
    expect(started.verificationUri).toBe(`${server.baseUrl}/#/device`)
    expect(started.verificationUriComplete).toBe(
      `${server.baseUrl}/#/device?user_code=${encodeURIComponent(started.userCode)}`,
    )
    expect(started.expiresIn).toBe(600)
    expect(started.interval).toBeGreaterThan(0)

    // Only the CLI's own client id is accepted (A6): another app is refused before a code is
    // made, and the CLI's id is the one constant both sides share.
    const other = await fetch(`${server.baseUrl}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'some-other-app' }),
    })
    expect(other.status).toBe(400)
    expect(((await other.json()) as Record<string, unknown>).error).toBe('invalid_client')
  })

  it('signs the CLI in when the browser approves, and a code is redeemed once', async () => {
    const server = await harness.server()
    const dev = await harness.user(server)
    const started = await createClient({ baseUrl: server.baseUrl }).auth.startDeviceLogin()

    // The approval page's calls: verify (which claims the code for the signed-in person and
    // shows it to them), then approve.
    const verified = await deviceApi(server, dev.token, { userCode: started.userCode })
    expect(verified.status).toBe(200)
    expect(await verified.json()).toMatchObject({
      user_code: started.userCode,
      status: 'pending',
      client_id: OPENHARNESS_CLI_CLIENT_ID,
      scope: 'openid profile email',
    })
    const approved = await deviceApi(server, dev.token, {
      userCode: started.userCode,
      decision: 'approve',
    })
    expect(approved.status).toBe(200)

    // The CLI polls and gets its session.
    const token = await createClient({ baseUrl: server.baseUrl }).auth.pollDeviceLogin(
      started.deviceCode,
      { interval: 0 },
    )
    const signedIn = createClient({ baseUrl: server.baseUrl, token })
    expect((await signedIn.me()).email).toBe(DEV_LOGIN_STORED_EMAIL)

    // And a device code is redeemed once: the same code answers `invalid_grant` afterwards, so
    // a poll racing another cannot mint a second session.
    const again = await pollRaw(server, started.deviceCode)
    expect(again.status).toBe(400)
    expect(again.body.error).toBe('invalid_grant')
    expect(again.body.access_token).toBeUndefined()
  })

  it('tells the CLI the request was denied', async () => {
    const server = await harness.server()
    const dev = await harness.user(server)
    const started = await createClient({ baseUrl: server.baseUrl }).auth.startDeviceLogin()

    await deviceApi(server, dev.token, { userCode: started.userCode })
    const denied = await deviceApi(server, dev.token, {
      userCode: started.userCode,
      decision: 'deny',
    })
    expect(denied.status).toBe(200)

    const failure = await createClient({ baseUrl: server.baseUrl })
      .auth.pollDeviceLogin(started.deviceCode, { interval: 0 })
      .then(() => null)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DeviceLoginError)
    expect((failure as DeviceLoginError).code).toBe('access_denied')
  })

  it('keeps a pending code from being a session', async () => {
    const server = await harness.server()
    const started = await createClient({ baseUrl: server.baseUrl }).auth.startDeviceLogin()

    // Nobody has approved it: the answer is the RFC's "keep polling" and nothing else — in
    // particular, no token.
    const pending = await pollRaw(server, started.deviceCode)
    expect(pending.status).toBe(400)
    expect(pending.body.error).toBe('authorization_pending')
    expect(pending.body.access_token).toBeUndefined()
  })

  it('refuses a code that has lapsed, and forgets it', async () => {
    const server = await harness.server()
    const database = await harness.database()
    const started = await createClient({ baseUrl: server.baseUrl }).auth.startDeviceLogin()

    // Ten minutes is not something a test waits out: the row's expiry is moved into the past,
    // which is the same state a person who left the terminal open would find.
    await withDatabaseClient(
      async (client) => {
        await client.query(
          `update "deviceCode" set "expiresAt" = now() - interval '1 minute' where "deviceCode" = $1`,
          [started.deviceCode],
        )
      },
      { database: database.name },
    )

    const lapsed = await pollRaw(server, started.deviceCode)
    expect(lapsed.status).toBe(400)
    expect(lapsed.body.error).toBe('expired_token')

    // The plugin deletes a lapsed record as it refuses it: the code is unusable, and the row
    // does not linger.
    const rows = await withDatabaseClient(
      async (client) =>
        client.query('select 1 from "deviceCode" where "deviceCode" = $1', [started.deviceCode]),
      { database: database.name },
    )
    expect(rows.rowCount).toBe(0)
  })

  it('refuses a code nobody issued, and an approval nobody may make', async () => {
    const server = await harness.server()
    const dev = await harness.user(server)

    const bogusPoll = await pollRaw(server, 'device-code-that-does-not-exist')
    expect(bogusPoll.status).toBe(400)
    expect(bogusPoll.body.error).toBe('invalid_grant')

    const bogusApproval = await deviceApi(server, dev.token, {
      userCode: 'ZZZZZZZZ',
      decision: 'approve',
    })
    expect(bogusApproval.status).toBe(400)
    expect(((await bogusApproval.json()) as Record<string, unknown>).error).toBe('invalid_request')

    // Deciding needs a session at all: an anonymous caller cannot approve anything.
    const anonymous = await fetch(`${server.baseUrl}/api/auth/device/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userCode: 'ZZZZZZZZ' }),
    })
    expect(anonymous.status).toBe(401)

    // A code another person claimed is not one this person may decide (A4's rule applied to
    // the flow): the first person to verify it owns it, and anybody else is told so.
    const started = await createClient({ baseUrl: server.baseUrl }).auth.startDeviceLogin()
    expect((await deviceApi(server, dev.token, { userCode: started.userCode })).status).toBe(200)
    const other = await harness.user(server, { email: 'other@device.test', password: 'other-pass' })
    const stranger = await deviceApi(server, other.token, {
      userCode: started.userCode,
      decision: 'approve',
    })
    expect(stranger.status).toBe(403)
    expect(((await stranger.json()) as Record<string, unknown>).error).toBe('access_denied')
  })
})
