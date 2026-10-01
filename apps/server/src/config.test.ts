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

describe('readServerConfig', () => {
  it('fills in the defaults for an empty environment', () => {
    const config = readServerConfig({})

    expect(config).toEqual({
      port: DEFAULT_PORT,
      databaseUrl: undefined,
      scheduler: DEFAULT_SCHEDULER,
      apiKey: undefined,
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
    expect(readServerConfig({}).instanceId).not.toBe(defaultInstanceId())
  })

  it('reads every variable', () => {
    const config = readServerConfig({
      PORT: '8080',
      DATABASE_URL: 'postgres://localhost/openharness',
      OPENHARNESS_API_KEY: 'oh_key',
      OPENHARNESS_TEST_MODEL: 'mock',
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
    })

    expect(config).toEqual({
      port: 8080,
      databaseUrl: 'postgres://localhost/openharness',
      scheduler: 'postgres',
      apiKey: 'oh_key',
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
    const config = readServerConfig({
      OPENHARNESS_DELTA_RETENTION_MS: '0',
      OPENHARNESS_COMPACT_INTERVAL_MS: '0',
    })

    expect(config.deltaRetentionMs).toBe(0)
    expect(config.compactIntervalMs).toBe(0)
  })

  it('refuses a retention window that is not a count of milliseconds', () => {
    expect(() => readServerConfig({ OPENHARNESS_DELTA_RETENTION_MS: '-1' })).toThrow(
      /OPENHARNESS_DELTA_RETENTION_MS/,
    )
    expect(() => readServerConfig({ OPENHARNESS_COMPACT_INTERVAL_MS: 'soon' })).toThrow(
      /OPENHARNESS_COMPACT_INTERVAL_MS/,
    )
  })

  it('refuses a scheduler it does not have', () => {
    expect(() => readServerConfig({ SCHEDULER: 'postgresql' })).toThrow(/SCHEDULER/)
  })

  it('refuses the postgres scheduler without a database to lease partitions in', () => {
    // Partition leases live in the database, so this is a configuration nobody can mean:
    // the process does not come up rather than running turns nobody owns.
    expect(() => readServerConfig({ SCHEDULER: 'postgres' })).toThrow(/DATABASE_URL/)
    expect(
      readServerConfig({
        SCHEDULER: 'postgres',
        DATABASE_URL: 'postgres://localhost/openharness',
      }).scheduler,
    ).toBe('postgres')
  })

  it('refuses a heartbeat that would outlive the lease it renews', () => {
    const env = { OPENHARNESS_LEASE_TTL_MS: '1000', OPENHARNESS_HEARTBEAT_MS: '1000' }
    expect(() => readServerConfig(env)).toThrow(/OPENHARNESS_HEARTBEAT_MS/)
    expect(() =>
      readServerConfig({ OPENHARNESS_LEASE_TTL_MS: '1000', OPENHARNESS_HEARTBEAT_MS: '2500' }),
    ).toThrow(/OPENHARNESS_HEARTBEAT_MS/)
    expect(
      readServerConfig({ OPENHARNESS_LEASE_TTL_MS: '1000', OPENHARNESS_HEARTBEAT_MS: '999' })
        .heartbeatMs,
    ).toBe(999)
  })

  it('refuses a partition count below one', () => {
    expect(() => readServerConfig({ OPENHARNESS_PARTITIONS: '0' })).toThrow(
      /OPENHARNESS_PARTITIONS/,
    )
  })

  it('treats an empty variable as unset', () => {
    const config = readServerConfig({ PORT: '', DATABASE_URL: '  ', OPENHARNESS_API_KEY: '' })

    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.databaseUrl).toBeUndefined()
    expect(config.apiKey).toBeUndefined()
  })

  it('allows port 0, so a test can ask for an ephemeral one', () => {
    expect(readServerConfig({ PORT: '0' }).port).toBe(0)
  })

  it('refuses a port that is not a port', () => {
    expect(() => readServerConfig({ PORT: 'http' })).toThrow(/PORT/)
    expect(() => readServerConfig({ PORT: '70000' })).toThrow(/PORT/)
    expect(() => readServerConfig({ PORT: '-1' })).toThrow(/PORT/)
  })

  it('refuses a concurrency limit below one', () => {
    expect(() => readServerConfig({ OPENHARNESS_MAX_CONCURRENT_SESSIONS: '0' })).toThrow(
      /OPENHARNESS_MAX_CONCURRENT_SESSIONS/,
    )
  })

  it('drops empty entries from the CORS list', () => {
    expect(readServerConfig({ OPENHARNESS_CORS_ORIGINS: 'http://a.test,,' }).corsOrigins).toEqual([
      'http://a.test',
    ])
  })
})

describe('describeConfig', () => {
  it('says which store, model and auth the server will run with', () => {
    const lines = describeConfig(readServerConfig({ OPENHARNESS_TEST_MODEL: 'mock' }))

    expect(lines.join('\n')).toContain('store: in-memory')
    expect(lines.join('\n')).toContain('model: TEST MODEL')
    expect(lines.join('\n')).toContain('auth: open')
  })

  it('names postgres and the key when both are configured', () => {
    const lines = describeConfig(
      readServerConfig({ DATABASE_URL: 'postgres://localhost/x', OPENHARNESS_API_KEY: 'k' }),
    )

    expect(lines.join('\n')).toContain('store: postgres')
    expect(lines.join('\n')).toContain('auth: x-api-key')
  })

  it('says which scheduler and which partition space the server runs', () => {
    const local = describeConfig(readServerConfig({}))
    expect(local.join('\n')).toContain('scheduler: local')

    const partitioned = describeConfig(
      readServerConfig({
        SCHEDULER: 'postgres',
        DATABASE_URL: 'postgres://localhost/x',
        OPENHARNESS_INSTANCE_ID: 'instance-a',
        OPENHARNESS_PARTITIONS: '8',
        OPENHARNESS_LEASE_TTL_MS: '900',
        OPENHARNESS_HEARTBEAT_MS: '300',
        OPENHARNESS_SWEEP_MS: '450',
      }),
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
      readServerConfig({
        OPENHARNESS_DELTA_RETENTION_MS: '60000',
        OPENHARNESS_COMPACT_INTERVAL_MS: '5000',
      }),
    ).join('\n')
    expect(retaining).toContain('compaction: every 5000ms')
    expect(retaining).toContain('retaining superseded chunks 60000ms')

    expect(
      describeConfig(readServerConfig({ OPENHARNESS_COMPACT_INTERVAL_MS: '0' })).join('\n'),
    ).toContain('compaction: disabled')
  })
})
