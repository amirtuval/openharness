import type { BetterAuthOptions } from 'better-auth'
import { APIError } from 'better-auth/api'
import { google, microsoft } from 'better-auth/social-providers'
import type {
  GithubOptions,
  GithubProfile as GithubProviderProfile,
  GoogleOptions,
  MicrosoftOptions,
} from 'better-auth/social-providers'

/**
 * Who a sign-in is: the verified email (epic #65, A3), enforced per provider.
 *
 * Google, GitHub and Microsoft are only ways to prove an email address; the address is the
 * identity, and it has to be one the provider *verified*. Each provider reports that
 * differently, and one of them (Microsoft Entra) is not trustworthy about it by default —
 * the "nOAuth" class of account takeover, where an attacker signs up for an Entra account
 * carrying the victim's address without ever proving they own it. So every provider gets a
 * rule here, applied before Better Auth is allowed to create or link anything:
 *
 * - **google** — `email_verified` must be true.
 * - **github** — the *primary* email must be verified; a verified secondary address does not
 *   stand in for it, and neither does the profile's public email.
 * - **microsoft** — the claims must assert ownership: `email_verified`, the
 *   `verified_primary_email`/`verified_secondary_email` lists (personal accounts), or the
 *   `xms_edov` claim Entra sets when the email ownership was verified. Anything else is
 *   refused.
 *
 * The rules themselves are pure functions over the provider's profile, so a test can hand
 * them a mocked profile without a network; {@link providerOptions} wires them into the
 * provider clients Better Auth calls.
 */

/** The `provider` names the social sign-in exposes; also what `GET /v1/auth-config` lists. */
export const SOCIAL_PROVIDERS = ['google', 'github', 'microsoft'] as const

/** A social provider's name. */
export type SocialProviderName = (typeof SOCIAL_PROVIDERS)[number]

/** One entry of GitHub's `/user/emails`, which is where "verified" is actually recorded. */
export interface GithubEmail {
  readonly email: string
  /** GitHub's primary address for the account — the only one a sign-in may use. */
  readonly primary?: boolean
  readonly verified?: boolean
}

/** The GitHub profile fields this rule needs, from `/user`. */
export interface GithubProfile {
  readonly name?: string | null
  readonly login?: string
  readonly email?: string | null
  readonly avatar_url?: string | null
}

/** The Microsoft ID-token claims this rule needs. */
export interface MicrosoftClaims {
  readonly email?: string
  readonly email_verified?: boolean | string
  readonly xms_edov?: boolean | string
  /** Entra's lists of addresses Microsoft has verified ownership of. */
  readonly verified_primary_email?: string | string[]
  readonly verified_secondary_email?: string | string[]
}

/** The Google ID-token claims this rule needs. */
export interface GoogleClaims {
  readonly email?: string
  readonly email_verified?: boolean | string
  readonly name?: string
  readonly picture?: string
}

/**
 * The email a GitHub sign-in proves, or `null` when there is none.
 *
 * The rule is the primary address **and** verified: the account's other addresses do not stand
 * in for it, so a profile whose primary is unverified is refused rather than quietly resolved
 * through a secondary.
 */
export function githubVerifiedPrimaryEmail(emails: readonly GithubEmail[]): string | null {
  const primary = emails.find((entry) => entry.primary === true)
  if (primary === undefined || primary.verified !== true) {
    return null
  }
  return typeof primary.email === 'string' && primary.email.length > 0 ? primary.email : null
}

/** Whether Microsoft asserted that it verified this email address. */
export function microsoftEmailVerified(claims: MicrosoftClaims): boolean {
  if (truthyClaim(claims.email_verified) || truthyClaim(claims.xms_edov)) {
    return true
  }
  const email = claims.email?.toLowerCase()
  if (email === undefined || email === '') {
    return false
  }
  // Personal Microsoft accounts assert ownership through these lists rather than a boolean.
  return (
    includesEmail(claims.verified_primary_email, email) ||
    includesEmail(claims.verified_secondary_email, email)
  )
}

/** Whether Google verified this email address. */
export function googleEmailVerified(claims: GoogleClaims): boolean {
  return truthyClaim(claims.email_verified)
}

/**
 * The error every provider rule refuses with.
 *
 * An `APIError` is what Better Auth's callback surface understands: the sign-in ends with a
 * clear message and a 403, and nothing — no user, no account link, no session — is created.
 */
export function refusedEmailError(provider: SocialProviderName, detail: string): APIError {
  return new APIError('FORBIDDEN', {
    code: 'email_not_verified',
    message:
      `${provider} did not verify this email address, so the sign-in was refused ` +
      `(${detail}). openharness only signs in email addresses a provider has verified.`,
  })
}

/** What {@link providerOptions} needs: the client id/secret of each enabled provider. */
export interface SocialProviderCredentials {
  readonly google?: { readonly clientId: string; readonly clientSecret: string }
  readonly github?: { readonly clientId: string; readonly clientSecret: string }
  readonly microsoft?: {
    readonly clientId: string
    readonly clientSecret: string
    /** The Entra tenant, `common` (multi-tenant) by default. */
    readonly tenantId: string
  }
}

/**
 * The `socialProviders` block of the Better Auth configuration.
 *
 * Each provider is listed only when its credentials are configured, and each carries the
 * A3 rule as its `getUserInfo`: the profile is read normally, the rule decides, and a profile
 * without a verified email refuses the whole sign-in. `mapProfileToUser` is not used, because
 * a rule that only rewrites fields cannot say no.
 */
export function providerOptions(
  credentials: SocialProviderCredentials,
): NonNullable<BetterAuthOptions['socialProviders']> {
  const providers: Record<string, GoogleOptions | GithubOptions | MicrosoftOptions> = {}
  if (credentials.google !== undefined) {
    providers['google'] = googleProviderOptions(credentials.google)
  }
  if (credentials.github !== undefined) {
    providers['github'] = githubProviderOptions(credentials.github)
  }
  if (credentials.microsoft !== undefined) {
    providers['microsoft'] = microsoftProviderOptions(credentials.microsoft)
  }
  return providers
}

/** Google: refuse unless `email_verified` (A3). */
function googleProviderOptions(credentials: {
  clientId: string
  clientSecret: string
}): GoogleOptions {
  const base = google({ ...credentials })
  return {
    ...credentials,
    async getUserInfo(token) {
      const info = await base.getUserInfo(token)
      if (info === null) {
        return null
      }
      if (!googleEmailVerified(info.data)) {
        throw refusedEmailError('google', 'the id_token does not assert email_verified')
      }
      return { user: { ...info.user, emailVerified: true }, data: info.data }
    },
  }
}

/**
 * GitHub: the primary, verified email — and only it.
 *
 * Better Auth's own GitHub client falls back to the first address when there is no primary,
 * so this reads the profile and `/user/emails` itself, picks the primary, and refuses when it
 * is not verified.
 */
function githubProviderOptions(credentials: {
  clientId: string
  clientSecret: string
}): GithubOptions {
  return {
    ...credentials,
    async getUserInfo(token) {
      const [profile, emails] = await Promise.all([
        githubJson<GithubProviderProfile>('https://api.github.com/user', token.accessToken ?? ''),
        githubJson<GithubEmail[]>('https://api.github.com/user/emails', token.accessToken ?? ''),
      ])
      if (profile === null) {
        return null
      }
      const email = emails === null ? null : githubVerifiedPrimaryEmail(emails)
      if (email === null) {
        throw refusedEmailError('github', 'the primary email is missing or unverified')
      }
      return {
        user: {
          name: profile.name ?? profile.login ?? '',
          email,
          image: profile.avatar_url ?? undefined,
          emailVerified: true,
        },
        // The provider's own profile shape, with the resolved address added: the account-key
        // resolver reads `data.id`, so the raw profile has to pass through.
        data: { ...profile, email },
      }
    },
  }
}

/** Microsoft: refuse unless the claims assert a verified email — the nOAuth guard (A3). */
function microsoftProviderOptions(credentials: {
  clientId: string
  clientSecret: string
  tenantId: string
}): MicrosoftOptions {
  const base = microsoft({ ...credentials })
  return {
    ...credentials,
    async getUserInfo(token) {
      const info = await base.getUserInfo(token)
      if (info === null) {
        return null
      }
      if (!microsoftEmailVerified(info.data)) {
        throw refusedEmailError(
          'microsoft',
          'the id_token asserts no verified email (no email_verified, xms_edov or verified list)',
        )
      }
      return { user: { ...info.user, emailVerified: true }, data: info.data }
    },
  }
}

/** A `GET` to a GitHub endpoint as JSON, or `null` when it does not answer 2xx. */
async function githubJson<T>(url: string, accessToken: string): Promise<T | null> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'openharness',
    },
  })
  if (!response.ok) {
    return null
  }
  return (await response.json()) as T
}

/** A claim that may be a boolean or a string: `true` only for an explicit affirmative. */
function truthyClaim(value: boolean | string | undefined): boolean {
  return value === true || value === 'true'
}

/** Whether an Entra verified-address claim (a string or a list) holds this address. */
function includesEmail(claim: string | string[] | undefined, email: string): boolean {
  if (claim === undefined) {
    return false
  }
  const addresses = Array.isArray(claim) ? claim : [claim]
  return addresses.some((address) => address.toLowerCase() === email)
}
