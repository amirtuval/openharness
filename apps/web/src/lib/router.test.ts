import { describe, expect, it } from 'vitest'

import { chatHash, parseRoute, routeToHash, type Route } from './router'

describe('parseRoute', () => {
  it('reads the hash routes', () => {
    expect(parseRoute('')).toEqual({ name: 'home' })
    expect(parseRoute('#/')).toEqual({ name: 'home' })
    expect(parseRoute('#/new')).toEqual({ name: 'new' })
    expect(parseRoute('#/agents')).toEqual({ name: 'agents' })
    expect(parseRoute('#/settings')).toEqual({ name: 'settings' })
    expect(parseRoute('#/s/sesn_01H')).toEqual({ name: 'chat', sessionId: 'sesn_01H' })
  })

  it('falls back to home for anything it does not know', () => {
    expect(parseRoute('#/nonsense')).toEqual({ name: 'home' })
    expect(parseRoute('#/s/')).toEqual({ name: 'home' })
    expect(parseRoute('#/s')).toEqual({ name: 'home' })
  })

  it('decodes a session id from the hash', () => {
    expect(parseRoute(`#/s/${encodeURIComponent('sesn_a/b')}`)).toEqual({
      name: 'chat',
      sessionId: 'sesn_a/b',
    })
  })

  it('round-trips every route', () => {
    const routes: Route[] = [
      { name: 'home' },
      { name: 'new' },
      { name: 'agents' },
      { name: 'settings' },
      { name: 'chat', sessionId: 'sesn_01H' },
    ]

    for (const route of routes) {
      expect(parseRoute(routeToHash(route))).toEqual(route)
    }
  })

  it('builds a chat link', () => {
    expect(chatHash('sesn_01H')).toBe('#/s/sesn_01H')
  })
})
