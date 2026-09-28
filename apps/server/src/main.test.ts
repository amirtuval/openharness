import { afterEach, describe, expect, it } from 'vitest'
import { API_VERSION_PREFIX, EVENT_TYPES } from '@openharness/protocol'
import { InMemorySessionStore } from '@openharness/session'

import { main, startServer } from './main'
import type { Logger } from './types'
import { createScriptedModel, readHistory, testConfig, waitFor, waitForIdle } from './test-support'

/**
 * Starting and stopping the server for real: an ephemeral port, the store it runs against,
 * and a shutdown that leaves the log in a state a client can read.
 */

const started: { shutdown: () => Promise<void> }[] = []

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()?.shutdown()
  }
})

/** A logger that keeps what it was told, so a test can assert on the startup lines. */
function recordingLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  }
}

describe('startServer', () => {
  it('listens on an ephemeral port and answers /health', async () => {
    const server = await startServer({
      config: testConfig(),
      store: new InMemorySessionStore(),
      model: createScriptedModel().factory,
      logger: recordingLogger(),
    })
    started.push(server)

    const response = await fetch(`http://127.0.0.1:${server.port}/health`)

    expect(response.status).toBe(200)
    expect(server.port).toBeGreaterThan(0)
  })

  it('warns loudly when it runs on the in-memory store', async () => {
    const logger = recordingLogger()
    const server = await startServer({
      config: testConfig(),
      model: createScriptedModel().factory,
      logger,
    })
    started.push(server)

    const warnings = logger.lines.filter((line) => line.startsWith('warn'))
    expect(warnings.join('\n')).toContain('DATABASE_URL')
    expect(warnings.join('\n')).toContain('IN-MEMORY')
    expect(warnings.join('\n')).toContain('lost')
  })

  it('recovers a session a previous process left open', async () => {
    const store = new InMemorySessionStore()
    const agent = await store.createAgent({ name: 'Agent', model: { id: 'test/model' } })
    const session = await store.createSession(agent.id)
    await store.appendEvents(session.id, [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'before the crash' }] },
      { type: EVENT_TYPES.sessionStatusRunning },
      { type: EVENT_TYPES.modelRequestStart },
    ])

    const server = await startServer({
      config: testConfig(),
      store,
      model: createScriptedModel({ text: ['recovered after restart'] }).factory,
      logger: recordingLogger(),
    })
    started.push(server)

    await waitForIdle(store, session.id)
    const history = await readHistory(store, session.id)
    expect(
      history.some(
        (event) => event.type === EVENT_TYPES.modelRequestEnd && event.error?.type === 'brain_lost',
      ),
    ).toBe(true)
    expect(history.at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
  })

  it('fails the boot without starting any work when the port is taken', async () => {
    const first = await startServer({
      config: testConfig(),
      store: new InMemorySessionStore(),
      model: createScriptedModel().factory,
      logger: recordingLogger(),
    })
    started.push(first)
    const store = new InMemorySessionStore()
    const agent = await store.createAgent({ name: 'Agent', model: { id: 'test/model' } })
    const session = await store.createSession(agent.id)
    await store.appendEvents(session.id, [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'left over' }] },
      { type: EVENT_TYPES.sessionStatusRunning },
      { type: EVENT_TYPES.modelRequestStart },
    ])
    const model = createScriptedModel({ text: ['never sent'] })

    await expect(
      startServer({
        config: { ...testConfig(), port: first.port },
        store,
        model: model.factory,
        logger: recordingLogger(),
      }),
    ).rejects.toThrow(/EADDRINUSE/)

    // The session that needed work is exactly as it was: nothing was recovered for a server
    // that never came up.
    expect(model.requests).toBe(0)
    expect(await readHistory(store, session.id)).toHaveLength(3)
  })

  it('drains a turn in flight on shutdown', async () => {
    const store = new InMemorySessionStore()
    const server = await startServer({
      config: testConfig({ drainTimeoutMs: 3000 }),
      store,
      model: createScriptedModel({ text: ['one ', 'two ', 'three'], delayMs: 20 }).factory,
      logger: recordingLogger(),
    })
    started.push(server)
    const agent = await store.createAgent({ name: 'Agent', model: { id: 'test/model' } })
    const session = await store.createSession(agent.id)

    await fetch(
      `http://127.0.0.1:${server.port}${API_VERSION_PREFIX}/sessions/${session.id}/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [{ type: 'user.message', content: [{ type: 'text', text: 'hi' }] }],
        }),
      },
    )
    await waitFor(async () => (await store.getTurnState(session.id)).state !== 'idle')

    await server.shutdown()

    expect((await store.getTurnState(session.id)).state).toBe('idle')
    expect((await readHistory(store, session.id)).at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
  })

  it('stops listening after shutdown', async () => {
    const server = await startServer({
      config: testConfig(),
      store: new InMemorySessionStore(),
      model: createScriptedModel().factory,
      logger: recordingLogger(),
    })
    const url = `http://127.0.0.1:${server.port}/health`

    await server.shutdown()
    await server.shutdown()

    await expect(fetch(url)).rejects.toThrow()
  })

  it('serves the web app and the API on the same port', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const webDir = await mkdtemp(join(tmpdir(), 'openharness-main-'))
    await writeFile(join(webDir, 'index.html'), '<html>app</html>')
    try {
      const server = await startServer({
        config: testConfig({ webDir }),
        store: new InMemorySessionStore(),
        model: createScriptedModel().factory,
        logger: recordingLogger(),
      })
      started.push(server)

      const shell = await fetch(`http://127.0.0.1:${server.port}/`)
      const health = await fetch(`http://127.0.0.1:${server.port}/health`)

      await expect(shell.text()).resolves.toContain('app')
      expect(health.status).toBe(200)
    } finally {
      await rm(webDir, { recursive: true, force: true })
    }
  })
})

describe('main', () => {
  it('reads the environment and starts a server from it', async () => {
    const logger = recordingLogger()
    const server = await main({ PORT: '0', OPENHARNESS_TEST_MODEL: 'mock' }, { logger })
    started.push(server)

    expect(server.port).toBeGreaterThan(0)
    const response = await fetch(`http://127.0.0.1:${server.port}/health`)
    expect(response.status).toBe(200)
    expect(logger.lines.join('\n')).toContain('model: TEST MODEL')
    expect(logger.lines.join('\n')).toContain('store: in-memory')
  })

  it('refuses a test-model value it does not know', async () => {
    await expect(
      main({ PORT: '0', OPENHARNESS_TEST_MODEL: 'maybe' }, { logger: recordingLogger() }),
    ).rejects.toThrow(/OPENHARNESS_TEST_MODEL/)
  })
})
