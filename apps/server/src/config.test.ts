import { describe, expect, it } from 'vitest'

import { DEFAULT_PARTITION_COUNT } from '@openharness/protocol'

import { DEFAULT_COMPACT_INTERVAL_MS, DEFAULT_DELTA_RETENTION_MS } from './compaction'
import { DEFAULT_HEARTBEAT_MS, DEFAULT_LEASE_TTL_MS, DEFAULT_SWEEP_MS } from './partition-scheduler'
import { DEFAULT_MAX_CONCURRENT_SESSIONS } from './scheduler'
import { DEFAULT_DRAIN_TIMEOUT_MS } from './runner'
import {
  DEFAULT_PORT,
  DEFAULT_SCHEDULER,
  defaultInstanceId,
  describeConfig,
  readServerConfig,
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
      secretsKey: REQUIRED.OPENHARNESS_SECRETS_KEY,
      devLogin: true,
      google: undefined,
      github: undefined,
      microsoft: undefined,
      testModel: undefined,
      webDir: undefined,
      corsOrigins: [],
      maxConcurrentSessions: DEFAULT_MAX_CONCURRENT_SESSIONS,
      drainTimeoutMs: DEFAULT_DRAIN_TIMEOUT_MS,
      instanceId: config.instanceId,
      partitions: DEFAULT_PARTITION_COUNT,
      leaseTtlMs: DEFAULT_LEASE_TTL_MS,
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
      sweepMs: DEFAULT_SWEEP_MS,
      deltaRetentionMs: DEFAULT_DELTA_RETENTION_MS,
      compactIntervalMs: DEFAULT_COMPACT_INTERVAL_MS,
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
        OPENHARNESS_CORS_ORIGINS: 'http://a.test, http://b.test',
        OPENHARNESS_MAX_CONCURRENT_SESSIONS: '12',
        OPENHARNESS_DRAIN_TIMEOUT_MS: '250',
        SCHEDULER: 'postgres',
        OPENHARNESS_INSTANCE_ID: 'instance-a',
        OPENHARNESS_PARTITIONS: '8',
        OPENHARNESS_LEASE_TTL_MS: '900',
        OPENHARNESS_HEARTBEAT_MS: '300',
        OPENHARNESS_SWEEP_MS: '450',
        OPENHARNESS_DELTA_RETENTION_MS: '120000',
        OPENHARNESS_COMPACT_INTERVAL_MS: '60000',
      }),
    )

    expect(config).toEqual({
      port: 8080,
      databaseUrl: 'postgres://localhost/openharness',
      scheduler: 'postgres',
      betterAuthSecret: REQUIRED.BETTER_AUTH_SECRET,
      betterAuthUrl: REQUIRED.BETTER_AUTH_URL,
      secretsKey: REQUIRED.OPENHARNESS_SECRETS_KEY,
      devLogin: true,
      google: { clientId: 'g-id', clientSecret: 'g-secret' },
      github: { clientId: 'gh-id', clientSecret: 'gh-secret' },
      microsoft: { clientId: 'ms-id', clientSecret: 'ms-secret', tenantId: 'contoso' },
      testModel: 'mock',
      webDir: '/srv/web',
      corsOrigins: ['http://a.test', 'http://b.test'],
      maxConcurrentSessions: 12,
      drainTimeoutMs: 250,
      instanceId: 'instance-a',
      partitions: 8,
      leaseTtlMs: 900,
      heartbeatMs: 300,
      sweepMs: 450,
      deltaRetentionMs: 120_000,
      compactIntervalMs: 60_000,
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

  it('refuses a retention window that is not a count of milliseconds', () => {
    expect(() => readServerConfig(env({ OPENHARNESS_DELTA_RETENTION_MS: '-1' }))).toThrow(
      /OPENHARNESS_DELTA_RETENTION_MS/,
    )
    expect(() => readServerConfig(env({ OPENHARNESS_COMPACT_INTERVAL_MS: 'soon' }))).toThrow(
      /OPENHARNESS_COMPACT_INTERVAL_MS/,
    )
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

describe('describeConfig', () => {
  it('says which store, model and sign-in the server will run with', () => {
    const lines = describeConfig(readServerConfig(env({ OPENHARNESS_TEST_MODEL: 'mock' })))

    expect(lines.join('\n')).toContain('store: in-memory')
    expect(lines.join('\n')).toContain('model: TEST MODEL')
    // No providers only comes up when the dev login is the way in.
    expect(lines.join('\n')).toContain('sign-in: no social providers configured')
    expect(lines.join('\n')).toContain('dev login: ENABLED')
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
