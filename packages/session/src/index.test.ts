import { describe, expect, it } from 'vitest'

import {
  AgentNotFoundError,
  DuplicateEventIdError,
  FencedError,
  InMemorySessionStore,
  PACKAGE_NAME,
  SessionNotFoundError,
  isFencedError,
  systemClock,
  timestampAt,
} from './index'

describe('@openharness/session', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@openharness/session')
  })

  it('exports the contract, the in-memory store and the errors', () => {
    expect(typeof InMemorySessionStore).toBe('function')
    expect(new InMemorySessionStore()).toBeInstanceOf(InMemorySessionStore)
    expect(typeof FencedError).toBe('function')
    expect(typeof SessionNotFoundError).toBe('function')
    expect(typeof AgentNotFoundError).toBe('function')
    expect(typeof DuplicateEventIdError).toBe('function')
    expect(typeof isFencedError).toBe('function')
  })

  it('exports the clock helpers a store is built with', () => {
    expect(timestampAt(0)).toBe('1970-01-01T00:00:00.000Z')
    expect(typeof systemClock()).toBe('number')
  })
})
