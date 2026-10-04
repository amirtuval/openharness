import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Client } from '@openharness/client'
import { AuthenticationError } from '@openharness/client'
import { createFakeClient, FAKE_SESSION_TOKEN } from '@openharness/client/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openCredentials, type CredentialStore } from '../credentials'
import { runLogin, runLogout, runWhoami, type AuthIo, type LoginIo } from './auth'

const SERVER = 'http://localhost:3000'
const OTHER_SERVER = 'https://oh.example.test'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'oh-auth-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** A store in the temp directory, read fresh from disk. */
function credentials(): CredentialStore {
  const outcome = openCredentials({ path: join(directory, 'credentials.json') })
  if (!outcome.ok) throw new Error(`expected a store, got: ${outcome.error}`)
  return outcome.store
}

/** The file's permission bits, e.g. `0o600`. */
function tokenFileMode(): number {
  return statSync(join(directory, 'credentials.json')).mode & 0o777
}

/** The auth commands driven with recorded output. */
interface Harness {
  io: AuthIo
  out: string[]
  err: string[]
}

function harness(client: Client, store: CredentialStore, overrides: Partial<AuthIo> = {}): Harness {
  const out: string[] = []
  const err: string[] = []
  const io: AuthIo = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    context: { server: SERVER },
    server: SERVER,
    store,
    createApiClient: () => client,
    ...overrides,
  }
  return { io, out, err }
}

/** {@link harness} for `oh login`, where a browser must not open unless a test says so. */
function loginHarness(
  client: Client,
  store: CredentialStore,
  overrides: Partial<LoginIo> = {},
): Harness & { io: LoginIo } {
  const base = harness(client, store, overrides)
  const io: LoginIo = {
    ...base.io,
    noBrowser: true,
    openBrowser: () => {
      throw new Error('the test did not expect a browser to open')
    },
    ...overrides,
  }
  return { ...base, io }
}

describe('runLogin', () => {
  it('prints the URL and code, opens the browser, stores the token and says who signed in', async () => {
    const fake = createFakeClient({ authenticated: false })
    fake.scriptDeviceLogin({ pendingPolls: 2, outcome: 'approved' })
    const store = credentials()
    const opened: string[] = []
    // The client the login's last request is made with must be the one carrying the token it
    // just received (the review of #105, P2): a shared fake would sign itself in on approval,
    // so the assertable part is the token each call carried and whose `me()` answered.
    const tokens: (string | undefined)[] = []
    const anonymous: Client = {
      ...fake,
      me: () => Promise.reject(new AuthenticationError('Not signed in.')),
    }
    const { io, out } = loginHarness(fake, store, {
      noBrowser: false,
      openBrowser: (url) => {
        opened.push(url)
        return { opened: true, command: 'xdg-open' }
      },
      createApiClient: (token) => {
        tokens.push(token)
        return token === undefined
          ? anonymous
          : { ...fake, me: () => Promise.resolve({ ...fake.user, email: 'via-token@example.com' }) }
      },
    })

    const code = await runLogin(io)

    expect(code).toBe(0)
    const text = out.join('\n')
    expect(text).toContain('http://localhost:3000/#/device?user_code=FAKE-CODE')
    expect(text).toContain('FAKE-CODE')
    expect(opened).toEqual(['http://localhost:3000/#/device?user_code=FAKE-CODE'])
    // The name comes from the client holding the new token, not from the anonymous one.
    expect(text).toContain(`Logged in as via-token@example.com on ${SERVER}`)
    // start and poll are anonymous; only the closing `me()` carries the token.
    expect(tokens).toEqual([undefined, undefined, FAKE_SESSION_TOKEN])
    expect(store.tokenFor(SERVER)).toBe(FAKE_SESSION_TOKEN)
    expect(tokenFileMode()).toBe(0o600)
  })

  it('--no-browser prints the URL and the code instead of opening anything', async () => {
    const fake = createFakeClient({ authenticated: false })
    fake.scriptDeviceLogin({ outcome: 'approved' })
    const { io, out } = loginHarness(fake, credentials())

    const code = await runLogin(io)

    expect(code).toBe(0)
    expect(out.join('\n')).toContain('http://localhost:3000/#/device?user_code=FAKE-CODE')
    expect(out.join('\n')).toContain('FAKE-CODE')
  })

  it('still succeeds when no browser could be opened', async () => {
    const fake = createFakeClient({ authenticated: false })
    fake.scriptDeviceLogin({ outcome: 'approved' })
    const { io, out } = loginHarness(fake, credentials(), {
      noBrowser: false,
      openBrowser: () => ({ opened: false, reason: 'no-display' }),
    })

    const code = await runLogin(io)

    expect(code).toBe(0)
    expect(out.join('\n')).toContain(`Logged in as ${fake.user.email} on ${SERVER}`)
  })

  it('falls back to verificationUri when the server sends no complete one', async () => {
    const fake = createFakeClient()
    const opened: string[] = []
    const client: Client = {
      ...fake,
      auth: {
        ...fake.auth,
        startDeviceLogin: () =>
          Promise.resolve({
            deviceCode: 'device-1',
            userCode: 'WXYZ-9876',
            verificationUri: 'http://localhost:3000/device',
            verificationUriComplete: undefined,
            interval: 0,
            expiresIn: 600,
          }),
        pollDeviceLogin: () => Promise.resolve('token-from-poll'),
      },
    }
    const { io, out } = loginHarness(client, credentials(), {
      noBrowser: false,
      openBrowser: (url) => {
        opened.push(url)
        return { opened: true, command: 'xdg-open' }
      },
    })

    const code = await runLogin(io)

    expect(code).toBe(0)
    expect(opened).toEqual(['http://localhost:3000/device'])
    expect(out.join('\n')).toContain('WXYZ-9876')
  })

  it('reports an expired code and stores nothing', async () => {
    const fake = createFakeClient({ authenticated: false })
    fake.scriptDeviceLogin({ outcome: 'expired' })
    const store = credentials()
    const { io, err } = loginHarness(fake, store)

    const code = await runLogin(io)

    expect(code).toBe(1)
    expect(err.join('\n')).toContain('expired')
    expect(err.join('\n')).toContain('oh login')
    expect(store.tokenFor(SERVER)).toBeUndefined()
  })

  it('reports a denied login and stores nothing', async () => {
    const fake = createFakeClient({ authenticated: false })
    fake.scriptDeviceLogin({ outcome: 'denied' })
    const store = credentials()
    const { io, err } = loginHarness(fake, store)

    const code = await runLogin(io)

    expect(code).toBe(1)
    expect(err.join('\n')).toContain('denied')
    expect(store.tokenFor(SERVER)).toBeUndefined()
  })

  it.each([
    [130, 'Ctrl+C'],
    [143, 'SIGTERM'],
  ])('a %s (%s) mid-poll cancels the login and exits with it', async (reason) => {
    const fake = createFakeClient({ authenticated: false })
    fake.scriptDeviceLogin({ interval: 0, pendingPolls: 100 })
    const controller = new AbortController()
    let polls = 0
    const client: Client = {
      ...fake,
      auth: {
        ...fake.auth,
        // The poll is in flight — the server would answer `authorization_pending` — when the
        // signal lands, and the pending request rejects the way the real client's does: its
        // loop checks the signal after every wait (`throwIfAborted`). runLogin reads the exit
        // code from the signal's reason, not the error. This is the mid-poll cancels the
        // pre-aborted test never reached (#105, P2).
        pollDeviceLogin: (code, options) => {
          polls += 1
          controller.abort(reason)
          return Promise.reject(
            new Error(`the poll was cancelled (${String(options?.signal?.reason)})`),
          )
        },
      },
    }
    const { io, out, err } = loginHarness(client, credentials(), { signal: controller.signal })

    expect(await runLogin(io)).toBe(reason)
    if (reason === 130) {
      expect(err.join('\n')).toContain('login cancelled')
    }
    // It was cancelled mid-poll, not before it: the flow got as far as asking and waiting.
    expect(polls).toBe(1)
    expect(out.join('\n')).toContain('Waiting for approval')
  })

  it('reports a token it could not store, and does not pretend to be signed in', async () => {
    const fake = createFakeClient({ authenticated: false })
    fake.scriptDeviceLogin({ outcome: 'approved' })
    const store = credentials()
    const failing: CredentialStore = {
      ...store,
      save: () => {
        throw new Error(`could not write ${store.path}: ENOSPC`)
      },
    }
    const { io, out, err } = loginHarness(fake, failing)

    const code = await runLogin(io)

    expect(code).toBe(1)
    expect(out.join('\n')).not.toContain('Logged in')
    expect(err.join('\n')).toContain('could not write')
    expect(store.tokenFor(SERVER)).toBeUndefined()
  })

  it('reports a server that is not there, with the URL', async () => {
    const fake = createFakeClient()
    const { io, err } = loginHarness(
      {
        ...fake,
        auth: {
          ...fake.auth,
          startDeviceLogin: () => Promise.reject(new TypeError('fetch failed')),
        },
      },
      credentials(),
    )

    const code = await runLogin(io)

    expect(code).toBe(1)
    expect(err.join('\n')).toContain('could not reach the server')
  })
})

describe('runLogout', () => {
  it('revokes the session on the server and forgets the token', async () => {
    const fake = createFakeClient()
    const store = credentials()
    store.save(SERVER, 'oh_session_stored')
    const { io, out } = harness(fake, store)

    const code = await runLogout(io)

    expect(code).toBe(0)
    expect(out.join('\n')).toContain(`Logged out of ${SERVER}.`)
    expect(store.tokenFor(SERVER)).toBeUndefined()
    // The fake was signed in before, and its `signOut` is what revoked that.
    await expect(fake.me()).rejects.toBeInstanceOf(AuthenticationError)
  })

  it('deletes the token locally when the server cannot be reached, with a warning', async () => {
    const fake = createFakeClient()
    const store = credentials()
    store.save(SERVER, 'oh_session_stored')
    const { io, out, err } = harness(
      {
        ...fake,
        auth: { ...fake.auth, signOut: () => Promise.reject(new TypeError('fetch failed')) },
      },
      store,
    )

    const code = await runLogout(io)

    expect(code).toBe(0)
    expect(out.join('\n')).toContain(`Logged out of ${SERVER}.`)
    expect(err.join('\n')).toContain('could not revoke the session')
    expect(err.join('\n')).toContain('deleted locally')
    expect(store.tokenFor(SERVER)).toBeUndefined()
  })

  it('treats an already-revoked session as logged out, without a warning', async () => {
    const fake = createFakeClient()
    const store = credentials()
    store.save(SERVER, 'oh_session_stored')
    const { io, err } = harness(
      {
        ...fake,
        auth: {
          ...fake.auth,
          signOut: () => Promise.reject(new AuthenticationError('Not signed in.')),
        },
      },
      store,
    )

    const code = await runLogout(io)

    expect(code).toBe(0)
    expect(err).toEqual([])
    expect(store.tokenFor(SERVER)).toBeUndefined()
  })

  it('says so when there is no token for the server', async () => {
    const { io, err } = harness(createFakeClient(), credentials())

    const code = await runLogout(io)

    expect(code).toBe(1)
    expect(err.join('\n')).toContain(`not signed in to ${SERVER}`)
  })

  it('forgets only the server it was used with', async () => {
    const fake = createFakeClient()
    const store = credentials()
    store.save(SERVER, 'token-one')
    store.save(OTHER_SERVER, 'token-two')
    const { io } = harness(fake, store)

    expect(await runLogout(io)).toBe(0)

    expect(store.tokenFor(SERVER)).toBeUndefined()
    expect(store.tokenFor(OTHER_SERVER)).toBe('token-two')
  })
})

describe('runWhoami', () => {
  it('prints the email and the server, using the stored token', async () => {
    const fake = createFakeClient()
    const store = credentials()
    store.save(SERVER, 'oh_session_stored')
    const tokens: (string | undefined)[] = []
    const { io, out } = harness(fake, store, {
      createApiClient: (token) => {
        tokens.push(token)
        return fake
      },
    })

    const code = await runWhoami(io)

    expect(code).toBe(0)
    expect(out.join('\n')).toContain(`Logged in as ${fake.user.email} on ${SERVER}`)
    expect(tokens).toEqual(['oh_session_stored'])
  })

  it('is the not-signed-in error without a token', async () => {
    const { io, err } = harness(createFakeClient(), credentials())

    const code = await runWhoami(io)

    expect(code).toBe(1)
    expect(err.join('\n')).toContain(`not signed in to ${SERVER}. Run \`oh login\`.`)
  })

  it('is the not-signed-in error when the server rejects the stored token', async () => {
    const fake = createFakeClient()
    const store = credentials()
    store.save(SERVER, 'stale-token')
    const { io, err } = harness(
      { ...fake, me: () => Promise.reject(new AuthenticationError('Token revoked.')) },
      store,
    )

    const code = await runWhoami(io)

    expect(code).toBe(1)
    expect(err.join('\n')).toContain(`not signed in to ${SERVER}. Run \`oh login\`.`)
  })

  it('uses the token of the selected server', async () => {
    const fake = createFakeClient()
    const store = credentials()
    store.save(SERVER, 'token-one')
    store.save(OTHER_SERVER, 'token-two')
    const tokens: (string | undefined)[] = []
    const { io } = harness(fake, store, {
      server: OTHER_SERVER,
      createApiClient: (token) => {
        tokens.push(token)
        return fake
      },
    })

    const code = await runWhoami(io)

    expect(code).toBe(0)
    expect(tokens).toEqual(['token-two'])
  })
})
