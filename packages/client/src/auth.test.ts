import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from './client'
import { ApiError, ResponseValidationError } from './errors'
import { DeviceLoginError, OPENHARNESS_CLI_CLIENT_ID } from './resources/auth'
import { createMockFetch, errorResponse, jsonResponse } from './test-support/mock-fetch'

const BASE_URL = 'https://api.test'

/** A client whose `fetch` answers from the script the test gives it. */
function clientWith(handler: Parameters<typeof createMockFetch>[0]) {
  const mock = createMockFetch(handler)
  const client = createClient({ baseUrl: BASE_URL, token: 'oh_token', fetch: mock.fetch })
  return { client, mock }
}

/** The body of `POST /api/auth/device/code`, RFC 8628 §3.2. */
function deviceCodeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device_code: 'dev_code_1',
    user_code: 'WXYZ-1234',
    verification_uri: `${BASE_URL}/device`,
    verification_uri_complete: `${BASE_URL}/device?user_code=WXYZ-1234`,
    expires_in: 600,
    interval: 5,
    ...overrides,
  }
}

/** The body of a successful `POST /api/auth/device/token`, RFC 8628 §3.5. */
function deviceTokenBody(token = 'session_token_1'): Record<string, unknown> {
  return { access_token: token, token_type: 'Bearer', expires_in: 604_800, scope: '' }
}

/** The `{ error, error_description }` body a polling error answers with. */
function deviceErrorBody(error: string): Record<string, unknown> {
  return { error, error_description: `The flow says ${error}.` }
}

/** The JSON body of a recorded request. */
function bodyOf(init: RequestInit | undefined): unknown {
  const body = init?.body
  return JSON.parse(typeof body === 'string' ? body : '') as unknown
}

afterEach(() => {
  vi.useRealTimers()
})

describe('startDeviceLogin', () => {
  it('asks for a device code with the CLI client id and reads the response', async () => {
    const { client, mock } = clientWith(() => jsonResponse(deviceCodeBody()))

    const start = await client.auth.startDeviceLogin()

    expect(start).toEqual({
      deviceCode: 'dev_code_1',
      userCode: 'WXYZ-1234',
      verificationUri: `${BASE_URL}/device`,
      verificationUriComplete: `${BASE_URL}/device?user_code=WXYZ-1234`,
      interval: 5,
      expiresIn: 600,
    })
    expect(mock.requests[0]?.init?.method).toBe('POST')
    expect(mock.urlOf(0)).toBe(`${BASE_URL}/api/auth/device/code`)
    expect(bodyOf(mock.requests[0]?.init)).toEqual({
      client_id: OPENHARNESS_CLI_CLIENT_ID,
      scope: 'openid profile email',
    })
  })

  it('reports a missing verification_uri_complete as undefined', async () => {
    const withoutComplete = deviceCodeBody()
    delete withoutComplete.verification_uri_complete
    const { client } = clientWith(() => jsonResponse(withoutComplete))

    const start = await client.auth.startDeviceLogin()

    expect(start.verificationUriComplete).toBeUndefined()
  })

  it('rejects a body that is not a device-code response', async () => {
    const { client } = clientWith(() => jsonResponse({ device_code: 'dev_code_1' }))

    await expect(client.auth.startDeviceLogin()).rejects.toBeInstanceOf(ResponseValidationError)
  })
})

describe('pollDeviceLogin', () => {
  it('waits the interval before the first poll, then returns the session token', async () => {
    vi.useFakeTimers()
    const { client, mock } = clientWith(() => jsonResponse(deviceTokenBody()))

    // The assertion is attached before any timer runs, so a rejection cannot surface as an
    // unhandled one while the clock is being advanced.
    const polling = client.auth.pollDeviceLogin('dev_code_1', { interval: 4 })
    const resolved = expect(polling).resolves.toBe('session_token_1')
    await vi.advanceTimersByTimeAsync(3_999)
    expect(mock.requests).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    await resolved
    expect(mock.requests).toHaveLength(1)
    expect(mock.requests[0]?.init?.method).toBe('POST')
    expect(mock.urlOf(0)).toBe(`${BASE_URL}/api/auth/device/token`)
    expect(bodyOf(mock.requests[0]?.init)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'dev_code_1',
      client_id: OPENHARNESS_CLI_CLIENT_ID,
    })
  })

  it('keeps polling while the authorization is pending', async () => {
    vi.useFakeTimers()
    const { client, mock } = clientWith((_request, call) =>
      call < 2
        ? jsonResponse(deviceErrorBody('authorization_pending'), 400)
        : jsonResponse(deviceTokenBody()),
    )

    const polling = client.auth.pollDeviceLogin('dev_code_1', { interval: 1 })
    const resolved = expect(polling).resolves.toBe('session_token_1')
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await resolved
    expect(mock.requests).toHaveLength(3)
  })

  it('adds five seconds to the interval on slow_down', async () => {
    vi.useFakeTimers()
    const { client, mock } = clientWith((_request, call) =>
      call === 0
        ? jsonResponse(deviceErrorBody('slow_down'), 400)
        : jsonResponse(deviceTokenBody()),
    )

    const polling = client.auth.pollDeviceLogin('dev_code_1', { interval: 1 })
    const resolved = expect(polling).resolves.toBe('session_token_1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mock.requests).toHaveLength(1)

    // The next wait is 1 + 5 seconds; five more are not enough.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mock.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await resolved
    expect(mock.requests).toHaveLength(2)
  })

  it('defaults to RFC 8628 five seconds when no interval is given', async () => {
    vi.useFakeTimers()
    const { client, mock } = clientWith(() => jsonResponse(deviceTokenBody()))

    const polling = client.auth.pollDeviceLogin('dev_code_1')
    const resolved = expect(polling).resolves.toBe('session_token_1')
    await vi.advanceTimersByTimeAsync(4_999)
    expect(mock.requests).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await resolved
  })

  it('throws a DeviceLoginError on expired_token and access_denied', async () => {
    const expired = clientWith(() => jsonResponse(deviceErrorBody('expired_token'), 400))
    const denied = clientWith(() => jsonResponse(deviceErrorBody('access_denied'), 400))

    const expiredPolling = expired.client.auth.pollDeviceLogin('dev_code_1', { interval: 0 })
    const expiredInstance = expect(expiredPolling).rejects.toBeInstanceOf(DeviceLoginError)
    const expiredCode = expect(expiredPolling).rejects.toMatchObject({
      name: 'DeviceLoginError',
      code: 'expired_token',
      description: 'The flow says expired_token.',
    })
    const deniedPolling = denied.client.auth.pollDeviceLogin('dev_code_1', { interval: 0 })
    const deniedCode = expect(deniedPolling).rejects.toMatchObject({ code: 'access_denied' })

    await expiredInstance
    await expiredCode
    await deniedCode
  })

  it('throws an ApiError when the failure is not the device vocabulary', async () => {
    const { client } = clientWith(() => errorResponse(503, 'overloaded_error', 'Come back later.'))

    const polling = client.auth.pollDeviceLogin('dev_code_1', { interval: 0 })

    await expect(polling).rejects.toBeInstanceOf(ApiError)
    await expect(polling).rejects.toMatchObject({ status: 503, retryable: true })
  })

  it('rejects a 2xx that carries no access_token', async () => {
    const { client } = clientWith(() => jsonResponse({ token_type: 'Bearer' }))

    const polling = client.auth.pollDeviceLogin('dev_code_1', { interval: 0 })

    await expect(polling).rejects.toBeInstanceOf(ResponseValidationError)
  })

  it('stops on an abort without sending the next poll', async () => {
    vi.useFakeTimers()
    const { client, mock } = clientWith(() => jsonResponse(deviceTokenBody()))
    const controller = new AbortController()

    const polling = client.auth.pollDeviceLogin('dev_code_1', {
      interval: 60,
      signal: controller.signal,
    })
    controller.abort()

    await expect(polling).rejects.toMatchObject({ name: 'AbortError' })
    expect(mock.requests).toHaveLength(0)
  })
})

describe('signOut', () => {
  it('revokes the session with the bearer token', async () => {
    const { client, mock } = clientWith(() => new Response(null, { status: 204 }))

    await expect(client.auth.signOut()).resolves.toBeUndefined()
    expect(mock.requests[0]?.init?.method).toBe('POST')
    expect(mock.urlOf(0)).toBe(`${BASE_URL}/api/auth/sign-out`)
    expect(mock.requests[0]?.headers.get('authorization')).toBe('Bearer oh_token')
    expect(mock.requests[0]?.init?.credentials).toBe('include')
  })

  it('accepts a 200 with a success body, which needs no parsing', async () => {
    const { client } = clientWith(() => jsonResponse({ success: true }))

    await expect(client.auth.signOut()).resolves.toBeUndefined()
  })

  it('throws when the server refuses the sign-out', async () => {
    const { client } = clientWith(() => errorResponse(401, 'authentication_error', 'No session.'))

    await expect(client.auth.signOut()).rejects.toMatchObject({ status: 401 })
  })
})
