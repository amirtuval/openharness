import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GithubOptions, GoogleOptions, MicrosoftOptions } from 'better-auth/social-providers'

import {
  MICROSOFT_REFUSAL_LOG,
  githubVerifiedPrimaryEmail,
  googleEmailVerified,
  microsoftClaimType,
  microsoftEmailVerified,
  microsoftRefusalDetail,
  providerOptions,
  refusedEmailError,
  type GithubEmail,
} from './auth-profile'
import { jsonLogger } from './observability/logging'
import type { Logger } from './types'

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

/**
 * The warning a refused Microsoft sign-in writes.
 *
 * A refusal is otherwise silent, so "the optional claim is configured in the portal and it
 * still refuses" has no answer anywhere. This line has to answer it while keeping the same
 * rule as every other log line: it says what the token *carried* — names and types — and
 * never what the claims meant. The tests parse the real Cloud Logging logger, so what they
 * assert is the line the deployment would actually write.
 */
describe('the Microsoft refusal warning', () => {
  /** The consumer tenant id: every personal Microsoft account carries it as `tid`. */
  const CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad'
  const ISSUER = `https://login.microsoftonline.com/${CONSUMER_TENANT_ID}/v2.0`
  const credentials = {
    microsoft: { clientId: 'ms-id', clientSecret: 'ms-secret', tenantId: 'common' },
  }

  /** A {@link jsonLogger} whose parsed lines are kept, with a fixed clock. */
  function capturing(): { logger: Logger; lines: Record<string, unknown>[] } {
    const lines: Record<string, unknown>[] = []
    const logger = jsonLogger({
      write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      now: () => new Date('2026-10-05T12:34:56.789Z'),
      projectId: 'openharness-staging',
    })
    return { logger, lines }
  }

  it('logs a warning with the claim names and types of the refused token, and no value', async () => {
    const { logger, lines } = capturing()
    const microsoft = providerOptions(credentials, logger)['microsoft'] as MicrosoftOptions

    await expect(
      microsoft.getUserInfo?.({
        idToken: idToken({
          aud: 'ms-id',
          iss: ISSUER,
          tid: CONSUMER_TENANT_ID,
          oid: 'oid-1',
          email: 'Victim@Example.com',
          name: 'Victim Person',
          preferred_username: 'victim@example.com',
          verified_primary_email: ['someone-else@example.com'],
        }),
        accessToken: undefined,
      }),
    ).rejects.toMatchObject({ body: { code: 'email_not_verified' } })

    expect(lines).toHaveLength(1)
    const line = lines[0] ?? {}
    // The line is a Cloud Logging warning, and the claim *names* are sorted and complete.
    expect(line['severity']).toBe('WARNING')
    expect(line['message']).toBe(MICROSOFT_REFUSAL_LOG)
    expect(line['provider']).toBe('microsoft')
    expect(line['claimNames']).toEqual([
      'aud',
      'email',
      'iss',
      'name',
      'oid',
      'preferred_username',
      'tid',
      'verified_primary_email',
    ])
    // The two identifiers that are not personal data, and that say which account class this
    // was: the consumer tenant, so a personal account, not a work/school one.
    expect(line['tid']).toBe(CONSUMER_TENANT_ID)
    expect(line['iss']).toBe(ISSUER)
    // Every claim the rule reads is absent from this token — which is exactly the answer the
    // portal question needs.
    expect(line['claimTypes']).toEqual({
      email_verified: 'absent',
      xms_edov: 'absent',
      verified_primary_email: 'array(1)',
      verified_secondary_email: 'absent',
    })
    expect(line['emailInVerifiedPrimary']).toBe(false)
    expect(line['emailInVerifiedSecondary']).toBe(false)
    expect(line['hasEmail']).toBe(true)

    // The whole point of the payload: nothing that identifies the person is on the line.
    const serialized = JSON.stringify(line)
    expect(serialized).not.toContain('Victim@Example.com')
    expect(serialized).not.toContain('victim@example.com')
    expect(serialized).not.toContain('Victim Person')
    expect(serialized).not.toContain('someone-else@example.com')
  })

  it('reports the type of every claim that did arrive, not only the absent ones', async () => {
    const { logger, lines } = capturing()
    const microsoft = providerOptions(credentials, logger)['microsoft'] as MicrosoftOptions

    // A token that carries all four claims and still proves nothing: `'false'`/`false` are
    // not affirmative, and neither list holds this address.
    await expect(
      microsoft.getUserInfo?.({
        idToken: idToken({
          oid: 'oid-2',
          tid: CONSUMER_TENANT_ID,
          iss: ISSUER,
          email: 'victim@example.com',
          email_verified: 'false',
          xms_edov: false,
          verified_primary_email: ['one@example.com', 'two@example.com'],
          verified_secondary_email: 'three@example.com',
        }),
        accessToken: undefined,
      }),
    ).rejects.toMatchObject({ body: { code: 'email_not_verified' } })

    expect(lines).toHaveLength(1)
    expect(lines[0]?.['claimTypes']).toEqual({
      email_verified: 'string',
      xms_edov: 'boolean',
      verified_primary_email: 'array(2)',
      verified_secondary_email: 'string',
    })
    expect(lines[0]?.['hasEmail']).toBe(true)
  })

  it('writes nothing when the sign-in is accepted', async () => {
    const { logger, lines } = capturing()
    const microsoft = providerOptions(credentials, logger)['microsoft'] as MicrosoftOptions

    const accepted = await microsoft.getUserInfo?.({
      idToken: idToken({ oid: 'oid-3', email: 'ada@example.com', email_verified: true }),
      accessToken: undefined,
    })

    expect(accepted?.user.email).toBe('ada@example.com')
    expect(lines).toEqual([])
  })

  it('describes a bare token without reading a value out of it', () => {
    // The shape is fixed, so a log query does not have to cope with missing fields.
    expect(microsoftRefusalDetail({})).toEqual({
      provider: 'microsoft',
      claimNames: [],
      tid: null,
      iss: null,
      claimTypes: {
        email_verified: 'absent',
        xms_edov: 'absent',
        verified_primary_email: 'absent',
        verified_secondary_email: 'absent',
      },
      emailInVerifiedPrimary: false,
      emailInVerifiedSecondary: false,
      hasEmail: false,
    })
    // A claim whose type is neither the boolean nor the list the rule expects still reports
    // its shape rather than its value.
    expect(microsoftClaimType(true)).toBe('boolean')
    expect(microsoftClaimType([])).toBe('array(0)')
    expect(microsoftClaimType(7)).toBe('number')
  })
})
