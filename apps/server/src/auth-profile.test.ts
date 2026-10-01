import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GithubOptions, GoogleOptions, MicrosoftOptions } from 'better-auth/social-providers'

import {
  githubVerifiedPrimaryEmail,
  googleEmailVerified,
  microsoftEmailVerified,
  providerOptions,
  refusedEmailError,
  type GithubEmail,
} from './auth-profile'

/**
 * The identity rules (epic #65, A3), with mocked provider profiles.
 *
 * Every provider is only a way to prove an email address, and the address has to be one the
 * provider *verified* — the rule each provider gets is tested here against a profile that is
 * verified, one that is not, and the edge cases in between (Microsoft's claims are the wide
 * one: the `xms_edov` flag, the verified-address lists and the plain boolean all count).
 */

/** A JWT-shaped id token carrying `claims`. Only the payload is read (no signature check). */
function idToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.signature`
}

describe('the Microsoft rule (the nOAuth guard)', () => {
  it('accepts an email Microsoft asserts as verified', () => {
    expect(microsoftEmailVerified({ email: 'ada@example.com', email_verified: true })).toBe(true)
    // Personal accounts assert ownership through the verified lists.
    expect(
      microsoftEmailVerified({
        email: 'ada@example.com',
        verified_primary_email: ['ada@example.com'],
      }),
    ).toBe(true)
    expect(
      microsoftEmailVerified({
        email: 'ada@example.com',
        verified_secondary_email: ['ada@example.com'],
      }),
    ).toBe(true)
    // The `xms_edov` claim Entra sets when email ownership was verified; it may be a string
    // in a token that went through a JSON boundary.
    expect(microsoftEmailVerified({ email: 'ada@example.com', xms_edov: true })).toBe(true)
    expect(microsoftEmailVerified({ email: 'ada@example.com', xms_edov: 'true' })).toBe(true)
    // A verified list that is a single string rather than an array.
    expect(
      microsoftEmailVerified({
        email: 'ada@example.com',
        verified_primary_email: 'ada@example.com',
      }),
    ).toBe(true)
  })

  it('refuses an email nothing asserts as verified', () => {
    expect(microsoftEmailVerified({ email: 'victim@example.com' })).toBe(false)
    expect(microsoftEmailVerified({ email: 'victim@example.com', email_verified: false })).toBe(
      false,
    )
    expect(
      microsoftEmailVerified({
        email: 'victim@example.com',
        verified_primary_email: ['someone-else@example.com'],
      }),
    ).toBe(false)
    // A different address verified does not stand in for this one.
    expect(
      microsoftEmailVerified({
        email: 'victim@example.com',
        verified_secondary_email: ['other@example.com'],
      }),
    ).toBe(false)
    expect(microsoftEmailVerified({})).toBe(false)
    expect(microsoftEmailVerified({ email: '' })).toBe(false)
    // The comparison is case-insensitive, like every email.
    expect(
      microsoftEmailVerified({
        email: 'Ada@Example.com',
        verified_primary_email: ['ada@example.com'],
      }),
    ).toBe(true)
  })
})

describe('the GitHub rule', () => {
  it('accepts only the primary address when it is verified', () => {
    const emails: GithubEmail[] = [
      { email: 'secondary@example.com', primary: false, verified: true },
      { email: 'ada@example.com', primary: true, verified: true },
    ]
    expect(githubVerifiedPrimaryEmail(emails)).toBe('ada@example.com')
  })

  it('refuses when the primary is unverified, or there is none', () => {
    // A verified secondary does not stand in for an unverified primary — that is exactly the
    // case where the account's own address was never proved.
    expect(
      githubVerifiedPrimaryEmail([
        { email: 'secondary@example.com', primary: false, verified: true },
        { email: 'ada@example.com', primary: true, verified: false },
      ]),
    ).toBeNull()
    expect(githubVerifiedPrimaryEmail([{ email: 'a@example.com', verified: true }])).toBeNull()
    expect(githubVerifiedPrimaryEmail([])).toBeNull()
    expect(githubVerifiedPrimaryEmail([{ email: '', primary: true, verified: true }])).toBeNull()
  })
})

describe('the Google rule', () => {
  it('accepts only email_verified', () => {
    expect(googleEmailVerified({ email: 'ada@example.com', email_verified: true })).toBe(true)
    expect(googleEmailVerified({ email: 'ada@example.com', email_verified: false })).toBe(false)
    expect(googleEmailVerified({ email: 'ada@example.com' })).toBe(false)
    expect(googleEmailVerified({ email: 'ada@example.com', email_verified: 'true' })).toBe(true)
  })
})

describe('providerOptions', () => {
  const credentials = {
    google: { clientId: 'g-id', clientSecret: 'g-secret' },
    github: { clientId: 'gh-id', clientSecret: 'gh-secret' },
    microsoft: { clientId: 'ms-id', clientSecret: 'ms-secret', tenantId: 'common' },
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists only the providers that have credentials', () => {
    expect(Object.keys(providerOptions({}))).toEqual([])
    expect(Object.keys(providerOptions({ github: credentials.github }))).toEqual(['github'])
    expect(Object.keys(providerOptions(credentials)).sort()).toEqual([
      'github',
      'google',
      'microsoft',
    ])
  })

  it('refuses a Microsoft sign-in whose claims assert no verified email', async () => {
    const providers = providerOptions(credentials)
    const microsoft = providers['microsoft'] as MicrosoftOptions

    await expect(
      microsoft.getUserInfo?.({
        idToken: idToken({ oid: 'oid-1', email: 'victim@example.com', name: 'Victim' }),
        accessToken: undefined,
      }),
    ).rejects.toMatchObject({
      body: { code: 'email_not_verified' },
    })

    const accepted = await microsoft.getUserInfo?.({
      idToken: idToken({
        oid: 'oid-1',
        email: 'ada@example.com',
        email_verified: true,
        name: 'Ada',
      }),
      accessToken: undefined,
    })
    expect(accepted?.user.email).toBe('ada@example.com')
    expect(accepted?.user.emailVerified).toBe(true)
  })

  it('accepts a Microsoft personal account through its verified list', async () => {
    const providers = providerOptions(credentials)
    const microsoft = providers['microsoft'] as MicrosoftOptions

    const accepted = await microsoft.getUserInfo?.({
      idToken: idToken({
        oid: 'oid-2',
        email: 'ada@outlook.com',
        verified_primary_email: ['ada@outlook.com'],
      }),
      accessToken: undefined,
    })

    expect(accepted?.user.email).toBe('ada@outlook.com')
  })

  it('refuses a Google sign-in whose id token says email_verified: false', async () => {
    const providers = providerOptions(credentials)
    const google = providers['google'] as GoogleOptions

    await expect(
      google.getUserInfo?.({
        idToken: idToken({ email: 'victim@example.com', email_verified: false }),
      }),
    ).rejects.toMatchObject({ body: { code: 'email_not_verified' } })

    const accepted = await google.getUserInfo?.({
      idToken: idToken({ email: 'ada@example.com', email_verified: true }),
    })
    expect(accepted?.user.emailVerified).toBe(true)
  })

  it('reads GitHub’s emails and refuses an unverified primary', async () => {
    const providers = providerOptions(credentials)
    const github = providers['github'] as GithubOptions

    const stub = (emails: GithubEmail[]): void => {
      vi.stubGlobal('fetch', (url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              String(url).endsWith('/user/emails')
                ? emails
                : { id: 7, login: 'ada', name: 'Ada', avatar_url: null, email: null },
            ),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      )
    }

    stub([
      { email: 'ada@example.com', primary: true, verified: true },
      { email: 'old@example.com', primary: false, verified: true },
    ])
    const accepted = await github.getUserInfo?.({ accessToken: 'token' })
    expect(accepted?.user.email).toBe('ada@example.com')
    expect(accepted?.user.emailVerified).toBe(true)

    stub([{ email: 'victim@example.com', primary: true, verified: false }])
    await expect(github.getUserInfo?.({ accessToken: 'token' })).rejects.toMatchObject({
      body: { code: 'email_not_verified' },
    })
  })

  it('describes a refusal clearly, without ever naming a key', () => {
    const error = refusedEmailError('microsoft', 'the id_token asserts no verified email')

    expect(error.body?.code).toBe('email_not_verified')
    expect(error.body?.message).toContain('microsoft')
    expect(error.body?.message).toContain('verified')
  })
})
