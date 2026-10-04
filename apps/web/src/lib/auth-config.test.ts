import { ApiError, ResponseValidationError, type FetchLike } from '@openharness/client'
import { describe, expect, it } from 'vitest'

import { AuthConfigSchema, fetchAuthConfig } from './auth-config'

/**
 * `GET /v1/auth-config`, and the rule the schema promises: an unknown provider name is
 * **dropped, not fatal** (#105, P2). The schema used to be `z.array(z.enum(...))`, so one
 * name from a newer server failed the whole parse and the sign-in page showed an error
 * instead of the providers it does know. A test with an unknown name pins the fix.
 */

/** A `fetch` that answers one JSON body. */
function responding(body: unknown, status = 200): FetchLike {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
}

describe('AuthConfigSchema', () => {
  it('keeps the known provider names and drops the unknown ones', () => {
    const parsed = AuthConfigSchema.safeParse({
      providers: ['google', 'bitbucket', 'github'],
      dev_login: true,
    })

    expect(parsed.success).toBe(true)
    expect(parsed.success ? parsed.data.providers : null).toEqual(['google', 'github'])
  })

  it('answers a config of nothing but unknown names with an empty list, not a failure', () => {
    const parsed = AuthConfigSchema.safeParse({ providers: ['ollama'], dev_login: false })

    expect(parsed.success).toBe(true)
    expect(parsed.success ? parsed.data.providers : null).toEqual([])
  })

  it('still refuses a body that is not a config at all', () => {
    // No `dev_login`: a config without it would leave the sign-in page unable to draw itself.
    expect(AuthConfigSchema.safeParse({ providers: ['google'] }).success).toBe(false)
    // `providers` that is not a list of names.
    expect(AuthConfigSchema.safeParse({ providers: 'google', dev_login: true }).success).toBe(false)
    expect(AuthConfigSchema.safeParse({ providers: [7], dev_login: true }).success).toBe(false)
  })
})

describe('fetchAuthConfig', () => {
  it('drops an unknown provider from the server answer, keeping the known ones', async () => {
    const config = await fetchAuthConfig({
      baseUrl: 'https://api.example.com',
      fetch: responding({ providers: ['github', 'future-provider'], dev_login: false }),
    })

    expect(config).toEqual({ providers: ['github'], dev_login: false })
  })

  it('keeps a non-2xx answer an ApiError, and a bad body a validation error', async () => {
    await expect(
      fetchAuthConfig({ baseUrl: '', fetch: responding({}, 502) }),
    ).rejects.toBeInstanceOf(ApiError)
    await expect(
      fetchAuthConfig({ baseUrl: '', fetch: responding({ providers: [] }) }),
    ).rejects.toBeInstanceOf(ResponseValidationError)
  })
})
