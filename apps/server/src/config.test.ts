import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_COMPACTION_THRESHOLD, DEFAULT_MAX_TOOL_STEPS } from '@openharness/brain'
import { DEFAULT_PARTITION_COUNT } from '@openharness/protocol'
import { DEFAULT_KEY_CACHE_TTL_MS } from '@openharness/vault'

import { DEFAULT_COMPACT_INTERVAL_MS, DEFAULT_DELTA_RETENTION_MS } from './compaction'
import { DEFAULT_HEARTBEAT_MS, DEFAULT_LEASE_TTL_MS, DEFAULT_SWEEP_MS } from './partition-scheduler'

import { DEFAULT_MAX_CONCURRENT_SESSIONS } from './scheduler'
import { DEFAULT_DRAIN_TIMEOUT_MS } from './runner'
import {
  DEFAULT_KEY_PROVIDER,
  DEFAULT_LOG_FORMAT,
  DEFAULT_PORT,
  DEFAULT_SEARCH_DAILY_LIMIT,
  DEFAULT_SCHEDULER,
  DEFAULT_TRACE_SAMPLE_RATE,
  DEFAULT_TRACING,
  DEFAULT_TRUSTED_PROXY_HOPS,
  defaultInstanceId,
  describeConfig,
  readSecret,
  readServerConfig,
  secretFileVar,
  usesTestModel,
} from './config'

/**
 * Reading the environment: what is unset, what is empty, and what is wrong — because a
 * configuration mistake should stop the process at boot rather than surprise a user later.
 */

/** The three variables every boot needs (A2/A5), so a test's own variables stand out. */
const REQUIRED = {
  BETTER_AUTH_SECRET: 'a-test-secret-that-is-long-enough-for-better-auth',
  BETTER_AUTH_URL: 'http://localhost:3000',
  OPENHARNESS_SECRETS_KEY: 'b3Blbmhhcm5lc3MtdGVzdC1zZWNyZXRzLWtleS0zMmI=',
}

/** The operator's search key a test sets (epic #303, #305). A shape, never a real key. */
const SEARCH_KEY = 'brave-test-key'

/** A Cloud KMS key resource name, the shape `OPENHARNESS_KMS_KEY` takes (#150). Not a secret. */
const KMS_KEY =
  'projects/openharness-dev/locations/global/keyRings/openharness/cryptoKeys/credentials'

/**
 * {@link REQUIRED} plus whatever the test is about, with the dev login on: every boot needs a
 * way to sign in, and a test that is not about sign-in should not have to configure a
 * provider. A test that *is* about the sign-in rules overrides `OPENHARNESS_DEV_LOGIN` (an
 * empty value counts as unset) or sets provider credentials of its own.
 */
function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...REQUIRED, OPENHARNESS_DEV_LOGIN: '1', ...extra }
}

describe('readServerConfig', () => {
  it('fills in the defaults for a minimal environment', () => {
    const config = readServerConfig(env())

    expect(config).toEqual({
      port: DEFAULT_PORT,
      databaseUrl: undefined,
      scheduler: DEFAULT_SCHEDULER,
      betterAuthSecret: REQUIRED.BETTER_AUTH_SECRET,
      betterAuthUrl: REQUIRED.BETTER_AUTH_URL,
      keyProvider: DEFAULT_KEY_PROVIDER,
      secretsKey: REQUIRED.OPENHARNESS_SECRETS_KEY,
      kmsKey: undefined,
      keyCacheTtlMs: DEFAULT_KEY_CACHE_TTL_MS,
      devLogin: true,
      google: undefined,
      github: undefined,
      microsoft: undefined,
      testModel: undefined,
      webDir: undefined,
      allowPrivateProviderUrls: false,
      trustedProxyHops: DEFAULT_TRUSTED_PROXY_HOPS,
      corsOrigins: [],
      maxConcurrentSessions: DEFAULT_MAX_CONCURRENT_SESSIONS,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
      search: null,
      drainTimeoutMs: DEFAULT_DRAIN_TIMEOUT_MS,
      instanceId: config.instanceId,
      partitions: DEFAULT_PARTITION_COUNT,
      leaseTtlMs: DEFAULT_LEASE_TTL_MS,
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
      sweepMs: DEFAULT_SWEEP_MS,
      deltaRetentionMs: DEFAULT_DELTA_RETENTION_MS,
      compactIntervalMs: DEFAULT_COMPACT_INTERVAL_MS,
      compactionThreshold: DEFAULT_COMPACTION_THRESHOLD,
      logFormat: DEFAULT_LOG_FORMAT,
      tracing: DEFAULT_TRACING,
      traceSampleRate: DEFAULT_TRACE_SAMPLE_RATE,
      gcpProjectId: undefined,
    })
    // The instance id is generated, so it is only asserted to look like one: this host, this
    // process, and a suffix that makes two instances on the host unique.
    expect(config.instanceId).toMatch(new RegExp(`-${String(process.pid)}-[0-9a-f]{8}$`))
  })

  it('generates a different instance id for every read', () => {
    expect(readServerConfig(env()).instanceId).not.toBe(defaultInstanceId())
  })

  it('reads every variable', () => {
    const config = readServerConfig(
      env({
        PORT: '8080',
        DATABASE_URL: 'postgres://localhost/openharness',
        OPENHARNESS_DEV_LOGIN: '1',
        OPENHARNESS_TEST_MODEL: 'mock',
        GOOGLE_CLIENT_ID: 'g-id',
        GOOGLE_CLIENT_SECRET: 'g-secret',
        GITHUB_CLIENT_ID: 'gh-id',
        GITHUB_CLIENT_SECRET: 'gh-secret',
        MICROSOFT_CLIENT_ID: 'ms-id',
        MICROSOFT_CLIENT_SECRET: 'ms-secret',
        MICROSOFT_TENANT_ID: 'contoso',
        OPENHARNESS_WEB_DIR: '/srv/web',
        OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS: '1',
        OPENHARNESS_TRUSTED_PROXY_HOPS: '2',
        OPENHARNESS_CORS_ORIGINS: 'http://a.test, http://b.test',
        OPENHARNESS_MAX_CONCURRENT_SESSIONS: '12',
        OPENHARNESS_MAX_TOOL_STEPS: '7',
        OPENHARNESS_DRAIN_TIMEOUT_MS: '250',
        SCHEDULER: 'postgres',
        OPENHARNESS_INSTANCE_ID: 'instance-a',
        OPENHARNESS_PARTITIONS: '8',
        OPENHARNESS_LEASE_TTL_MS: '900',
        OPENHARNESS_HEARTBEAT_MS: '300',
        OPENHARNESS_SWEEP_MS: '450',
        OPENHARNESS_DELTA_RETENTION_MS: '120000',
        OPENHARNESS_COMPACT_INTERVAL_MS: '60000',
        OPENHARNESS_KEY_PROVIDER: 'local',
        OPENHARNESS_KEY_CACHE_TTL_MS: '120000',
        OPENHARNESS_LOG_FORMAT: 'json',
        OPENHARNESS_TRACING: 'cloud-trace',
        OPENHARNESS_TRACE_SAMPLE_RATE: '0.5',
        GOOGLE_CLOUD_PROJECT: 'openharness-dev',
        OPENHARNESS_SEARCH_PROVIDER: 'brave',
        OPENHARNESS_SEARCH_API_KEY: SEARCH_KEY,
        OPENHARNESS_SEARCH_DAILY_LIMIT: '25',
      }),
    )

    expect(config).toEqual({
      port: 8080,
      databaseUrl: 'postgres://localhost/openharness',
      scheduler: 'postgres',
      betterAuthSecret: REQUIRED.BETTER_AUTH_SECRET,
      betterAuthUrl: REQUIRED.BETTER_AUTH_URL,
      keyProvider: 'local',
      secretsKey: REQUIRED.OPENHARNESS_SECRETS_KEY,
      kmsKey: undefined,
      keyCacheTtlMs: 120_000,
      devLogin: true,
      google: { clientId: 'g-id', clientSecret: 'g-secret' },
      github: { clientId: 'gh-id', clientSecret: 'gh-secret' },
      microsoft: { clientId: 'ms-id', clientSecret: 'ms-secret', tenantId: 'contoso' },
      testModel: 'mock',
      webDir: '/srv/web',
      allowPrivateProviderUrls: true,
      trustedProxyHops: 2,
      corsOrigins: ['http://a.test', 'http://b.test'],
      maxConcurrentSessions: 12,
      maxToolSteps: 7,
      search: { provider: 'brave', apiKey: SEARCH_KEY, dailyLimit: 25 },
      drainTimeoutMs: 250,
      instanceId: 'instance-a',
      partitions: 8,
      leaseTtlMs: 900,
      heartbeatMs: 300,
      sweepMs: 450,
      deltaRetentionMs: 120_000,
      compactIntervalMs: 60_000,
      compactionThreshold: 0.7,
      logFormat: 'json',
      tracing: 'cloud-trace',
      traceSampleRate: 0.5,
      gcpProjectId: 'openharness-dev',
    })
    expect(usesTestModel(config)).toBe(true)
  })

  it('allows a retention window of zero and an interval that disables compaction', () => {
    const config = readServerConfig(
      env({
        OPENHARNESS_DELTA_RETENTION_MS: '0',
        OPENHARNESS_COMPACT_INTERVAL_MS: '0',
      }),
    )

    expect(config.deltaRetentionMs).toBe(0)
    expect(config.compactIntervalMs).toBe(0)
  })

  it('turns search on with a key, and refuses a provider without one', () => {
    // A key alone names the one provider this build has an adapter for.
    expect(readServerConfig(env({ OPENHARNESS_SEARCH_API_KEY: SEARCH_KEY })).search).toEqual({
      provider: 'brave',
      apiKey: SEARCH_KEY,
      dailyLimit: DEFAULT_SEARCH_DAILY_LIMIT,
    })
    // A provider named without a key is the configuration mistake it is: the operator asked for
    // search and gave no way to authenticate, so the boot says which variable is missing.
    expect(() => readServerConfig(env({ OPENHARNESS_SEARCH_PROVIDER: 'brave' }))).toThrow(
      /OPENHARNESS_SEARCH_API_KEY/,
    )
    expect(() =>
      readServerConfig(
        env({ OPENHARNESS_SEARCH_API_KEY: SEARCH_KEY, OPENHARNESS_SEARCH_PROVIDER: 'exa' }),
      ),
    ).toThrow(/OPENHARNESS_SEARCH_PROVIDER/)
    // Zero is a limit: the tool stays configured and answers every call with the notice.
    expect(
      readServerConfig(
        env({ OPENHARNESS_SEARCH_API_KEY: SEARCH_KEY, OPENHARNESS_SEARCH_DAILY_LIMIT: '0' }),
      ).search?.dailyLimit,
    ).toBe(0)
    expect(() =>
      readServerConfig(
        env({ OPENHARNESS_SEARCH_API_KEY: SEARCH_KEY, OPENHARNESS_SEARCH_DAILY_LIMIT: '-1' }),
      ),
    ).toThrow(/OPENHARNESS_SEARCH_DAILY_LIMIT/)
  })

  it('refuses a retention window that is not a count of milliseconds', () => {
    expect(() => readServerConfig(env({ OPENHARNESS_DELTA_RETENTION_MS: '-1' }))).toThrow(
      /OPENHARNESS_DELTA_RETENTION_MS/,
    )
    expect(() => readServerConfig(env({ OPENHARNESS_COMPACT_INTERVAL_MS: 'soon' }))).toThrow(
      /OPENHARNESS_COMPACT_INTERVAL_MS/,
    )
  })

  it('refuses a compaction threshold outside the fraction it is', () => {
    // The trigger is a share of the chat model's budget, so a value outside 0..1 is a setting
    // nobody meant — a negative one would compact before every request, and one above 1 would
    // never fire before the provider refuses the request itself (epic #277, K2).
    expect(() => readServerConfig(env({ OPENHARNESS_COMPACTION_THRESHOLD: '-0.1' }))).toThrow(
      /OPENHARNESS_COMPACTION_THRESHOLD/,
    )
    expect(() => readServerConfig(env({ OPENHARNESS_COMPACTION_THRESHOLD: '1.5' }))).toThrow(
      /OPENHARNESS_COMPACTION_THRESHOLD/,
    )
    expect(() => readServerConfig(env({ OPENHARNESS_COMPACTION_THRESHOLD: 'most' }))).toThrow(
      /OPENHARNESS_COMPACTION_THRESHOLD/,
    )
    // The two ends are legitimate: 0 compacts as soon as there is a context to summarize, and 1
    // only once a request is already over the model's budget.
    expect(
      readServerConfig(env({ OPENHARNESS_COMPACTION_THRESHOLD: '0' })).compactionThreshold,
    ).toBe(0)
    expect(
      readServerConfig(env({ OPENHARNESS_COMPACTION_THRESHOLD: '0.5' })).compactionThreshold,
    ).toBe(0.5)
    expect(readServerConfig(env({})).compactionThreshold).toBe(0.7)
  })

  it('refuses a scheduler it does not have', () => {
    expect(() => readServerConfig(env({ SCHEDULER: 'postgresql' }))).toThrow(/SCHEDULER/)
  })

  it('refuses the postgres scheduler without a database to lease partitions in', () => {
    // Partition leases live in the database, so this is a configuration nobody can mean:
    // the process does not come up rather than running turns nobody owns.
    expect(() => readServerConfig(env({ SCHEDULER: 'postgres' }))).toThrow(/DATABASE_URL/)
    expect(
      readServerConfig(
        env({ SCHEDULER: 'postgres', DATABASE_URL: 'postgres://localhost/openharness' }),
      ).scheduler,
    ).toBe('postgres')
  })

  it('refuses a heartbeat that would outlive the lease it renews', () => {
    const conflict = env({ OPENHARNESS_LEASE_TTL_MS: '1000', OPENHARNESS_HEARTBEAT_MS: '1000' })
    expect(() => readServerConfig(conflict)).toThrow(/OPENHARNESS_HEARTBEAT_MS/)
    expect(() =>
      readServerConfig(env({ OPENHARNESS_LEASE_TTL_MS: '1000', OPENHARNESS_HEARTBEAT_MS: '2500' })),
    ).toThrow(/OPENHARNESS_HEARTBEAT_MS/)
    expect(
      readServerConfig(env({ OPENHARNESS_LEASE_TTL_MS: '1000', OPENHARNESS_HEARTBEAT_MS: '999' }))
        .heartbeatMs,
    ).toBe(999)
  })

  it('refuses a partition count below one', () => {
    expect(() => readServerConfig(env({ OPENHARNESS_PARTITIONS: '0' }))).toThrow(
      /OPENHARNESS_PARTITIONS/,
    )
  })

  it('refuses private custom-provider URLs by default, and allows them when told (#249, M4)', () => {
    expect(readServerConfig(env()).allowPrivateProviderUrls).toBe(false)
    // Reached only for the custom OpenAI-compatible credential type; off unless set.
    expect(
      readServerConfig(env({ OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS: '1' }))
        .allowPrivateProviderUrls,
    ).toBe(true)
    expect(
      readServerConfig(env({ OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS: 'true' }))
        .allowPrivateProviderUrls,
    ).toBe(true)
    for (const value of ['yes', '0', 'on']) {
      expect(() =>
        readServerConfig(env({ OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS: value })),
      ).toThrow(/OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS/)
    }
  })

  it('trusts no forwarding headers by default, and as many proxies as it is told (#151)', () => {
    expect(readServerConfig(env()).trustedProxyHops).toBe(DEFAULT_TRUSTED_PROXY_HOPS)
    // Behind GCLB the load balancer is the one proxy appending to the chain.
    expect(readServerConfig(env({ OPENHARNESS_TRUSTED_PROXY_HOPS: '1' })).trustedProxyHops).toBe(1)
    // Zero is a value, not an absence: "do not trust the header".
    expect(readServerConfig(env({ OPENHARNESS_TRUSTED_PROXY_HOPS: '0' })).trustedProxyHops).toBe(0)
  })

  it('refuses a trusted-proxy hop count that is not a non-negative integer', () => {
    for (const value of ['-1', 'one', '1.5']) {
      expect(() => readServerConfig(env({ OPENHARNESS_TRUSTED_PROXY_HOPS: value }))).toThrow(
        /OPENHARNESS_TRUSTED_PROXY_HOPS/,
      )
    }
  })

  it('treats an empty variable as unset', () => {
    const config = readServerConfig(
      env({
        PORT: '',
        DATABASE_URL: '  ',
        // Empty counts as unset, so this turns the dev login off — a provider carries the
        // boot instead (a boot with neither is the next test).
        OPENHARNESS_DEV_LOGIN: '',
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
      }),
    )

    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.databaseUrl).toBeUndefined()
    expect(config.devLogin).toBe(false)
  })

  it('allows port 0, so a test can ask for an ephemeral one', () => {
    expect(readServerConfig(env({ PORT: '0' })).port).toBe(0)
  })

  it('refuses a port that is not a port', () => {
    expect(() => readServerConfig(env({ PORT: 'http' }))).toThrow(/PORT/)
    expect(() => readServerConfig(env({ PORT: '70000' }))).toThrow(/PORT/)
    expect(() => readServerConfig(env({ PORT: '-1' }))).toThrow(/PORT/)
  })

  it('refuses a tool-step budget below one (epic #303)', () => {
    expect(() => readServerConfig(env({ OPENHARNESS_MAX_TOOL_STEPS: '0' }))).toThrow(
      /OPENHARNESS_MAX_TOOL_STEPS/,
    )
    expect(() => readServerConfig(env({ OPENHARNESS_MAX_TOOL_STEPS: 'many' }))).toThrow(
      /OPENHARNESS_MAX_TOOL_STEPS/,
    )
  })

  it('refuses a concurrency limit below one', () => {
    expect(() => readServerConfig(env({ OPENHARNESS_MAX_CONCURRENT_SESSIONS: '0' }))).toThrow(
      /OPENHARNESS_MAX_CONCURRENT_SESSIONS/,
    )
  })

  it('drops empty entries from the CORS list', () => {
    expect(
      readServerConfig(env({ OPENHARNESS_CORS_ORIGINS: 'http://a.test,,' })).corsOrigins,
    ).toEqual(['http://a.test'])
  })

  it('requires the signing secret, the public URL and the vault key', () => {
    // A2/A5: without the first two nobody could sign in, without the third no credential
    // could be stored. The boot fails and names the variable.
    expect(() => readServerConfig({})).toThrow(/BETTER_AUTH_SECRET/)
    expect(() => readServerConfig({ BETTER_AUTH_SECRET: 'x'.repeat(32) })).toThrow(
      /BETTER_AUTH_URL/,
    )
    expect(() =>
      readServerConfig({ BETTER_AUTH_SECRET: 'x'.repeat(32), BETTER_AUTH_URL: 'http://x.test' }),
    ).toThrow(/OPENHARNESS_SECRETS_KEY/)
    expect(() => readServerConfig(env({ OPENHARNESS_SECRETS_KEY: 'not-base64!!' }))).toThrow(
      /OPENHARNESS_SECRETS_KEY/,
    )
    expect(() =>
      readServerConfig(env({ OPENHARNESS_SECRETS_KEY: Buffer.from('short').toString('base64') })),
    ).toThrow(/OPENHARNESS_SECRETS_KEY/)
  })

  it('defaults the vault key provider to local, with the environment key', () => {
    const config = readServerConfig(env())
    expect(config.keyProvider).toBe('local')
    expect(config.secretsKey).toBe(REQUIRED.OPENHARNESS_SECRETS_KEY)
    expect(config.kmsKey).toBeUndefined()
  })

  it('takes the gcp-kms provider with a Cloud KMS key, and without OPENHARNESS_SECRETS_KEY', () => {
    // #150, D6: in staging and production the master key lives in Cloud KMS, so the
    // environment key is not required — and a leftover one in the environment is ignored.
    const config = readServerConfig(
      env({
        OPENHARNESS_KEY_PROVIDER: 'gcp-kms',
        OPENHARNESS_KMS_KEY: KMS_KEY,
        OPENHARNESS_SECRETS_KEY: '',
      }),
    )
    expect(config.keyProvider).toBe('gcp-kms')
    expect(config.secretsKey).toBeUndefined()
    expect(config.kmsKey).toBe(KMS_KEY)

    const withLeftoverKey = readServerConfig(
      env({ OPENHARNESS_KEY_PROVIDER: 'gcp-kms', OPENHARNESS_KMS_KEY: KMS_KEY }),
    )
    expect(withLeftoverKey.secretsKey).toBeUndefined()
  })

  it('refuses gcp-kms without a Cloud KMS key', () => {
    expect(() =>
      readServerConfig(env({ OPENHARNESS_KEY_PROVIDER: 'gcp-kms', OPENHARNESS_SECRETS_KEY: '' })),
    ).toThrow(/OPENHARNESS_KMS_KEY/)
  })

  it('refuses a Cloud KMS key that does not name a key', () => {
    for (const kmsKey of [
      'credentials',
      'projects/p/locations/l/keyRings/r',
      // A key *version*: rotation would then need a data migration.
      `${KMS_KEY}/cryptoKeyVersions/1`,
    ]) {
      expect(() =>
        readServerConfig(env({ OPENHARNESS_KEY_PROVIDER: 'gcp-kms', OPENHARNESS_KMS_KEY: kmsKey })),
      ).toThrow(/OPENHARNESS_KMS_KEY/)
    }
  })

  it('refuses a key provider it does not have', () => {
    expect(() => readServerConfig(env({ OPENHARNESS_KEY_PROVIDER: 'vault' }))).toThrow(
      /OPENHARNESS_KEY_PROVIDER/,
    )
  })

  it('takes a key-cache TTL of zero and refuses one that is not a count of milliseconds', () => {
    expect(readServerConfig(env({ OPENHARNESS_KEY_CACHE_TTL_MS: '0' })).keyCacheTtlMs).toBe(0)
    expect(() => readServerConfig(env({ OPENHARNESS_KEY_CACHE_TTL_MS: '-1' }))).toThrow(
      /OPENHARNESS_KEY_CACHE_TTL_MS/,
    )
    expect(() => readServerConfig(env({ OPENHARNESS_KEY_CACHE_TTL_MS: 'soon' }))).toThrow(
      /OPENHARNESS_KEY_CACHE_TTL_MS/,
    )
  })

  it('enables the dev login only on a localhost public URL', () => {
    // A7: a fixed password on a well-known address is for a laptop.
    for (const url of [
      'http://localhost:3000',
      'http://localhost',
      'http://127.0.0.1:8080',
      'http://[::1]:3000',
      'https://localhost:51234',
    ]) {
      expect(
        readServerConfig(env({ OPENHARNESS_DEV_LOGIN: '1', BETTER_AUTH_URL: url })).devLogin,
      ).toBe(true)
    }
    for (const url of [
      'https://openharness.example',
      'http://10.0.0.5:3000',
      'http://localhost.evil.test',
    ]) {
      expect(() =>
        readServerConfig(env({ OPENHARNESS_DEV_LOGIN: '1', BETTER_AUTH_URL: url })),
      ).toThrow(/OPENHARNESS_DEV_LOGIN/)
    }
    // Off is always allowed, wherever the deployment lives — as long as a provider is the
    // way in instead.
    expect(
      readServerConfig(
        env({
          BETTER_AUTH_URL: 'https://openharness.example',
          OPENHARNESS_DEV_LOGIN: '',
          GITHUB_CLIENT_ID: 'id',
          GITHUB_CLIENT_SECRET: 'secret',
        }),
      ).devLogin,
    ).toBe(false)
  })

  it('refuses a dev-login flag that is not a flag', () => {
    expect(() => readServerConfig(env({ OPENHARNESS_DEV_LOGIN: 'yes' }))).toThrow(
      /OPENHARNESS_DEV_LOGIN/,
    )
    expect(readServerConfig(env({ OPENHARNESS_DEV_LOGIN: 'true' })).devLogin).toBe(true)
  })

  it('refuses a boot with no way to sign in at all', () => {
    // Every route is behind a session, so no provider and no dev login is a server nobody
    // could ever sign in to: the boot fails with the variables to set, rather than coming up
    // and answering 401 forever.
    const message =
      'no way to sign in: configure at least one provider (GOOGLE_CLIENT_ID/_SECRET, ' +
      'GITHUB_CLIENT_ID/_SECRET or MICROSOFT_CLIENT_ID/_SECRET), or set ' +
      'OPENHARNESS_DEV_LOGIN=1 for local development (localhost only)'
    // Unset and set-but-empty are the same thing.
    expect(() => readServerConfig({ ...REQUIRED })).toThrow(message)
    expect(() => readServerConfig(env({ OPENHARNESS_DEV_LOGIN: '' }))).toThrow(message)
  })

  it('allows the dev login as the only way in, on a localhost URL', () => {
    const config = readServerConfig(env({ OPENHARNESS_DEV_LOGIN: '1' }))

    expect(config.devLogin).toBe(true)
    expect(config.google).toBeUndefined()
    expect(config.github).toBeUndefined()
    expect(config.microsoft).toBeUndefined()
  })

  it('allows a single provider with the dev login off', () => {
    const config = readServerConfig(
      env({
        OPENHARNESS_DEV_LOGIN: '',
        MICROSOFT_CLIENT_ID: 'id',
        MICROSOFT_CLIENT_SECRET: 'secret',
      }),
    )

    expect(config.devLogin).toBe(false)
    expect(config.microsoft).toEqual({ clientId: 'id', clientSecret: 'secret', tenantId: 'common' })
  })

  it('names the missing half of a half-configured provider even with no other way in', () => {
    // The specific mistake beats the general one: the message says which variable is missing.
    expect(() =>
      readServerConfig(env({ OPENHARNESS_DEV_LOGIN: '', GOOGLE_CLIENT_ID: 'id' })),
    ).toThrow(/GOOGLE_CLIENT_SECRET/)
  })

  it('enables a provider only when both of its variables are set', () => {
    expect(() => readServerConfig(env({ GOOGLE_CLIENT_ID: 'id' }))).toThrow(/GOOGLE_CLIENT_SECRET/)
    expect(() => readServerConfig(env({ GITHUB_CLIENT_SECRET: 'secret' }))).toThrow(
      /GITHUB_CLIENT_ID/,
    )
    const config = readServerConfig(
      env({ MICROSOFT_CLIENT_ID: 'id', MICROSOFT_CLIENT_SECRET: 's' }),
    )
    expect(config.microsoft).toEqual({ clientId: 'id', clientSecret: 's', tenantId: 'common' })
  })
})

/**
 * Secrets delivered as files (#154): `<NAME>_FILE` is how a deployment mounts a secret from a
 * manager instead of putting it in the environment. The chart gives the container
 * `DATABASE_URL_FILE=/var/run/secrets/openharness/database-url` and no `DATABASE_URL`.
 */
describe('secrets from files', () => {
  /** A scratch directory, removed when the test that made it is done. */
  function scratch(): string {
    return mkdtempSync(join(tmpdir(), 'openharness-secret-'))
  }

  it('reads a secret from the file its _FILE variable names, trimming one newline', () => {
    const dir = scratch()
    try {
      const path = join(dir, 'database-url')
      writeFileSync(path, 'postgres://user:pw@host:5432/db\n')

      expect(readSecret({ DATABASE_URL_FILE: path }, 'DATABASE_URL')).toBe(
        'postgres://user:pw@host:5432/db',
      )
      // A file written without the trailing newline is the same secret.
      writeFileSync(path, 'postgres://user:pw@host:5432/db')
      expect(readSecret({ DATABASE_URL_FILE: path }, 'DATABASE_URL')).toBe(
        'postgres://user:pw@host:5432/db',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the file variable as <NAME>_FILE', () => {
    expect(secretFileVar('BETTER_AUTH_SECRET')).toBe('BETTER_AUTH_SECRET_FILE')
  })

  it('treats a file that is empty or only a newline as unset', () => {
    const dir = scratch()
    try {
      const path = join(dir, 'secret')
      writeFileSync(path, '')
      expect(readSecret({ BETTER_AUTH_SECRET_FILE: path }, 'BETTER_AUTH_SECRET')).toBeUndefined()
      writeFileSync(path, '\n')
      expect(readSecret({ BETTER_AUTH_SECRET_FILE: path }, 'BETTER_AUTH_SECRET')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a secret that is set both inline and as a file', () => {
    const dir = scratch()
    try {
      const path = join(dir, 'secret')
      writeFileSync(path, 'from-the-file')
      expect(() =>
        readSecret(
          { BETTER_AUTH_SECRET: 'from-the-env', BETTER_AUTH_SECRET_FILE: path },
          'BETTER_AUTH_SECRET',
        ),
      ).toThrow(/BETTER_AUTH_SECRET_FILE/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails the boot, naming the variable and the path, when the file cannot be read', () => {
    const dir = scratch()
    try {
      // A directory is a path a read cannot succeed on (EISDIR) whatever the uid, so the test
      // does not depend on running unprivileged.
      const error = (() => {
        try {
          readServerConfig(env({ DATABASE_URL_FILE: dir }))
          return undefined
        } catch (thrown) {
          return thrown as Error
        }
      })()
      expect(error?.message).toContain('DATABASE_URL_FILE')
      expect(error?.message).toContain(dir)
      // Never the content: this message goes to logs, and the read produced nothing to put there.
      expect(error?.message).not.toMatch(/postgres(ql)?:\/\//)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('delivers the required secrets and provider client secrets from files', () => {
    const dir = scratch()
    try {
      const store = join(dir, 'database-url')
      const authSecret = join(dir, 'better-auth-secret')
      const secretsKey = join(dir, 'secrets-key')
      const googleSecret = join(dir, 'google-secret')
      writeFileSync(store, 'postgres://user:pw@host:5432/db\n')
      writeFileSync(authSecret, `${'s'.repeat(32)}\n`)
      writeFileSync(secretsKey, `${REQUIRED.OPENHARNESS_SECRETS_KEY}\n`)
      writeFileSync(googleSecret, 'google-client-secret\n')

      const config = readServerConfig({
        DATABASE_URL_FILE: store,
        BETTER_AUTH_SECRET_FILE: authSecret,
        OPENHARNESS_SECRETS_KEY_FILE: secretsKey,
        // The other half of the provider still comes from the environment (a client id is not
        // a secret); the dev login is off, so Google is what makes the boot possible.
        GOOGLE_CLIENT_ID: 'google-client-id',
        GOOGLE_CLIENT_SECRET_FILE: googleSecret,
        BETTER_AUTH_URL: 'https://app.test',
      })

      expect(config.databaseUrl).toBe('postgres://user:pw@host:5432/db')
      expect(config.betterAuthSecret).toBe('s'.repeat(32))
      expect(config.secretsKey).toBe(REQUIRED.OPENHARNESS_SECRETS_KEY)
      expect(config.google).toEqual({
        clientId: 'google-client-id',
        clientSecret: 'google-client-secret',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still names a missing required secret, and its file form, when neither is set', () => {
    expect(() => readServerConfig({})).toThrow(/BETTER_AUTH_SECRET_FILE/)
  })
})

describe('observability (#158)', () => {
  it('defaults to the readable log format, tracing off, and a tenth of traces', () => {
    const config = readServerConfig(env())
    expect(config.logFormat).toBe('text')
    expect(config.tracing).toBe('off')
    expect(config.traceSampleRate).toBe(0.1)
    expect(config.gcpProjectId).toBeUndefined()
  })

  it('takes the JSON format and Cloud Trace, with a sample rate and the project', () => {
    const config = readServerConfig(
      env({
        OPENHARNESS_LOG_FORMAT: 'json',
        OPENHARNESS_TRACING: 'cloud-trace',
        OPENHARNESS_TRACE_SAMPLE_RATE: '0.25',
        GOOGLE_CLOUD_PROJECT: 'openharness-dev',
      }),
    )
    expect(config.logFormat).toBe('json')
    expect(config.tracing).toBe('cloud-trace')
    expect(config.traceSampleRate).toBe(0.25)
    expect(config.gcpProjectId).toBe('openharness-dev')
  })

  it('takes a sample rate of zero and of one, and refuses anything outside', () => {
    expect(readServerConfig(env({ OPENHARNESS_TRACE_SAMPLE_RATE: '0' })).traceSampleRate).toBe(0)
    expect(readServerConfig(env({ OPENHARNESS_TRACE_SAMPLE_RATE: '1' })).traceSampleRate).toBe(1)
    expect(() => readServerConfig(env({ OPENHARNESS_TRACE_SAMPLE_RATE: '1.5' }))).toThrow(/0\.\.1/)
    expect(() => readServerConfig(env({ OPENHARNESS_TRACE_SAMPLE_RATE: 'half' }))).toThrow(
      /OPENHARNESS_TRACE_SAMPLE_RATE/,
    )
  })

  it('refuses a log format or a trace mode it does not have', () => {
    expect(() => readServerConfig(env({ OPENHARNESS_LOG_FORMAT: 'yaml' }))).toThrow(/text, json/)
    expect(() => readServerConfig(env({ OPENHARNESS_TRACING: 'jaeger' }))).toThrow(
      /off, cloud-trace/,
    )
  })
})

describe('describeConfig', () => {
  it('says which log format and which tracing the server runs (#158)', () => {
    const text = describeConfig(readServerConfig(env())).join('\n')
    expect(text).toContain('logs: text')
    expect(text).toContain('tracing: off')
    const json = describeConfig(
      readServerConfig(
        env({
          OPENHARNESS_LOG_FORMAT: 'json',
          OPENHARNESS_TRACING: 'cloud-trace',
          OPENHARNESS_TRACE_SAMPLE_RATE: '0.5',
        }),
      ),
    ).join('\n')
    expect(json).toContain('JSON')
    expect(json).toContain('tracing: Cloud Trace (OPENHARNESS_TRACE_SAMPLE_RATE=0.5)')
  })

  it('says which store, model and sign-in the server will run with', () => {
    const lines = describeConfig(readServerConfig(env({ OPENHARNESS_TEST_MODEL: 'mock' })))

    expect(lines.join('\n')).toContain('store: in-memory')
    expect(lines.join('\n')).toContain('model: TEST MODEL')
    // No providers only comes up when the dev login is the way in.
    expect(lines.join('\n')).toContain('sign-in: no social providers configured')
    expect(lines.join('\n')).toContain('dev login: ENABLED')
    expect(lines.join('\n')).toContain('vault keys: local')
  })

  it('names the Cloud KMS key, and never the local key value', () => {
    const gcp = describeConfig(
      readServerConfig(env({ OPENHARNESS_KEY_PROVIDER: 'gcp-kms', OPENHARNESS_KMS_KEY: KMS_KEY })),
    ).join('\n')
    expect(gcp).toContain('vault keys: Cloud KMS key')
    expect(gcp).toContain(KMS_KEY)

    // The local provider's line says which variable the key comes from — a key value must
    // never reach a log line.
    const local = describeConfig(readServerConfig(env())).join('\n')
    expect(local).toContain('vault keys: local')
    expect(local).not.toContain(REQUIRED.OPENHARNESS_SECRETS_KEY)
  })

  it('names postgres, the providers and no dev login when they are configured', () => {
    const lines = describeConfig(
      readServerConfig(
        env({
          DATABASE_URL: 'postgres://localhost/x',
          GOOGLE_CLIENT_ID: 'g',
          GOOGLE_CLIENT_SECRET: 'gs',
          OPENHARNESS_DEV_LOGIN: '',
        }),
      ),
    ).join('\n')

    expect(lines).toContain('store: postgres')
    expect(lines).toContain('sign-in: google')
    expect(lines).toContain('dev login: off')
  })

  it('says which scheduler and which partition space the server runs', () => {
    const local = describeConfig(readServerConfig(env()))
    expect(local.join('\n')).toContain('scheduler: local')

    const partitioned = describeConfig(
      readServerConfig(
        env({
          SCHEDULER: 'postgres',
          DATABASE_URL: 'postgres://localhost/x',
          OPENHARNESS_INSTANCE_ID: 'instance-a',
          OPENHARNESS_PARTITIONS: '8',
          OPENHARNESS_LEASE_TTL_MS: '900',
          OPENHARNESS_HEARTBEAT_MS: '300',
          OPENHARNESS_SWEEP_MS: '450',
        }),
      ),
    )
    const line = partitioned.join('\n')
    expect(line).toContain('scheduler: postgres')
    expect(line).toContain('instance-a')
    expect(line).toContain('8 partitions')
    expect(line).toContain('lease 900ms')
    expect(line).toContain('heartbeat 300ms')
    expect(line).toContain('sweep 450ms')
  })

  it('says how often superseded chunks are compacted, and when that is off', () => {
    const retaining = describeConfig(
      readServerConfig(
        env({
          OPENHARNESS_DELTA_RETENTION_MS: '60000',
          OPENHARNESS_COMPACT_INTERVAL_MS: '5000',
        }),
      ),
    ).join('\n')
    expect(retaining).toContain('compaction: every 5000ms')
    expect(retaining).toContain('retaining superseded chunks 60000ms')

    expect(
      describeConfig(readServerConfig(env({ OPENHARNESS_COMPACT_INTERVAL_MS: '0' }))).join('\n'),
    ).toContain('compaction: disabled')
  })
})
