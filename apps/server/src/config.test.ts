import { describe, expect, it } from 'vitest'

import { DEFAULT_MAX_CONCURRENT_SESSIONS } from './scheduler'
import { DEFAULT_DRAIN_TIMEOUT_MS } from './runner'
import { DEFAULT_PORT, describeConfig, readServerConfig, usesTestModel } from './config'

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
      apiKey: undefined,
      testModel: undefined,
      webDir: undefined,
      corsOrigins: [],
      maxConcurrentSessions: DEFAULT_MAX_CONCURRENT_SESSIONS,
      drainTimeoutMs: DEFAULT_DRAIN_TIMEOUT_MS,
    })
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
    })

    expect(config).toEqual({
      port: 8080,
      databaseUrl: 'postgres://localhost/openharness',
      apiKey: 'oh_key',
      testModel: 'mock',
      webDir: '/srv/web',
      corsOrigins: ['http://a.test', 'http://b.test'],
      maxConcurrentSessions: 12,
      drainTimeoutMs: 250,
    })
    expect(usesTestModel(config)).toBe(true)
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
})
