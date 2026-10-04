import { ApiError, ResponseValidationError, type FetchLike } from '@openharness/client'
import { describe, expect, it, vi } from 'vitest'

import { AUTH_CONFIG_PATH, AuthConfigSchema, fetchAuthConfig } from './auth-config'

/**
 * `GET /v1/auth-config`, and the rule its comment states: a provider name this app does not
 * know is **dropped**, not fatal — a newer server may offer one this build cannot draw a
 * button for, and the buttons for the ones it does know still work.
 */

/** A `fetch` that answers one JSON body. */
function jsonFetch(body: unknown, status = 200): FetchLike {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  )
}

describe('AuthConfigSchema', () => {
  it('keeps the known providers and drops the unknown ones', () => {
    const parsed = AuthConfigSchema.parse({
      providers: ['bitbucket', 'google', 'apple', 'github'],
      dev_login: true,
    })

    expect(parsed.providers).toEqual(['google', 'github'])
    expect(parsed.dev_login).toBe(true)
  })

  it('accepts a config whose providers are all unknown — the deployment just has none to draw', () => {
    expect(AuthConfigSchema.parse({ providers: ['okta'], dev_login: false }).providers).toEqual([])
  })

  it('still refuses a body that is not an auth config', () => {
    expect(AuthConfigSchema.safeParse({ providers: 'google', dev_login: true }).success).toBe(false)
    expect(AuthConfigSchema.safeParse({ providers: ['google'] }).success).toBe(false)
    expect(AuthConfigSchema.safeParse({ providers: [7], dev_login: false }).success).toBe(false)
  })
})

describe('fetchAuthConfig', () => {
  it('reads the config from the configured server, with the cookie', async () => {
    const fetchImpl = jsonFetch({ providers: ['github', 'okta'], dev_login: false })

    const config = await fetchAuthConfig({ baseUrl: 'http://server.example/', fetch: fetchImpl })

    expect(fetchImpl).toHaveBeenCalledWith(`http://server.example${AUTH_CONFIG_PATH}`, {
      headers: { accept: 'application/json' },
      credentials: 'include',
    })
    // The unknown name is gone by the time the page sees the config.
    expect(config).toEqual({ providers: ['github'], dev_login: false })
  })

  it('refuses a body that is not an auth config, rather than drawing nothing', async () => {
    await expect(
      fetchAuthConfig({ baseUrl: '', fetch: jsonFetch({ providers: 1, dev_login: false }) }),
    ).rejects.toBeInstanceOf(ResponseValidationError)
  })

  it('maps a non-2xx to the ApiError its status names', async () => {
    const failure = fetchAuthConfig({ baseUrl: '', fetch: jsonFetch({}, 502) })

    await expect(failure).rejects.toBeInstanceOf(ApiError)
    await expect(failure).rejects.toMatchObject({ status: 502 })
  })
})
