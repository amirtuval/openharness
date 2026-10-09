import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { InMemorySessionStore } from '@openharness/session'

import { READINESS_QUERY_TIMEOUT_MS, checkDatabase, startServer } from './main'
import { silentLogger, type Logger } from './types'
import {
  POSTGRES_STARTUP_TIMEOUT_MS,
  createScriptedModel,
  createTestApp,
  postgresSource,
  resolveTestSessionCredential,
  startPostgres,
  testConfig,
  type PostgresFixture,
  type TestContext,
} from './test-support'

/**
 * `GET /ready`, the readiness probe (#151): the store's answer and the drain, and nothing
 * else — no session, no logging, no cache. `/health` stays the liveness probe beside it.
 *
 * The two probes answer different questions, and the tests pin the difference: `/health`
 * never changes its answer while the process lives, `/ready` says "no" the moment the store
 * cannot answer or a shutdown begins.
 */

let context: TestContext | undefined

afterEach(async () => {
  await context?.close()
  context = undefined
})

function setup(options: Parameters<typeof createTestApp>[0] = {}): TestContext {
  context = createTestApp(options)
  return context
}

describe('GET /ready (#151)', () => {
  it('answers 200 {status:"ok"} while the store answers and nothing is draining', async () => {
    const test = setup()

    // No session, exactly as a load balancer's probe runs it.
    const response = await test.anonymous('/ready')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('answers 503 when the store cannot answer', async () => {
    const test = setup({
      readiness: { isDraining: () => false, check: () => Promise.resolve(false) },
    })

    const response = await test.anonymous('/ready')

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ status: 'unavailable' })
  })

  it('answers 503 while draining, without asking the store at all', async () => {
    const check = vi.fn(() => Promise.resolve(true))
    const test = setup({ readiness: { isDraining: () => true, check } })

    const response = await test.anonymous('/ready')

    expect(response.status).toBe(503)
    // Draining is the answer; the database is not consulted — shutdown may already be
    // closing it.
    expect(check).not.toHaveBeenCalled()
  })

  it('keeps /health a liveness check: 200 even while draining or with the store down', async () => {
    const draining = setup({
      readiness: { isDraining: () => true, check: () => Promise.resolve(false) },
    })

    const response = await draining.anonymous('/health')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('logs nothing for either probe', async () => {
    const lines: string[] = []
    const record = (level: string) => (message: string) => {
      lines.push(`${level}: ${message}`)
    }
    const logger: Logger = {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    }
    const test = setup({ logger })

    await test.anonymous('/ready')
    await test.anonymous('/ready')
    await test.anonymous('/health')

    expect(lines).toEqual([])
  })
})

describe('the shutdown drain flips /ready (#151)', () => {
  it('answers 200 on a running server and 503 from the moment shutdown() begins', async () => {
    const started = await startServer({
      config: { ...testConfig(), port: 0 },
      store: new InMemorySessionStore(),
      model: createScriptedModel().factory,
      resolveCredential: resolveTestSessionCredential,
      logger: silentLogger,
    })
    try {
      const ready = await fetch(`http://127.0.0.1:${started.port}/ready`)
      expect(ready.status).toBe(200)
      await expect(ready.json()).resolves.toEqual({ status: 'ok' })

      const stopping = started.shutdown()

      // Draining now: the load balancer must stop sending traffic before the listener and
      // the store go away. `/health` stays what it was — the process is alive.
      const draining = await started.app.request('/ready')
      expect(draining.status).toBe(503)
      const alive = await started.app.request('/health')
      expect(alive.status).toBe(200)

      await stopping

      // And after the drain the probe still answers — 503, not a hang against a closed
      // store — because draining is decided before the store is ever asked.
      const after = await started.app.request('/ready')
      expect(after.status).toBe(503)
    } finally {
      await started.shutdown()
    }
  })
})

describe('checkDatabase (#151)', () => {
  it('answers true for a query that resolves', async () => {
    await expect(
      checkDatabase({ query: () => Promise.resolve({ rows: [{ '?column?': 1 }] }) }),
    ).resolves.toBe(true)
  })

  it('answers false for a query that rejects — the database is gone, the probe is not', async () => {
    await expect(
      checkDatabase({ query: () => Promise.reject(new Error('connection refused')) }),
    ).resolves.toBe(false)
  })

  it('gives up after about two seconds and answers false', async () => {
    vi.useFakeTimers()
    try {
      const pending = checkDatabase({ query: () => new Promise(() => {}) })

      await vi.advanceTimersByTimeAsync(READINESS_QUERY_TIMEOUT_MS)

      await expect(pending).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not leave its timer behind when the query answers first', async () => {
    vi.useFakeTimers()
    try {
      await expect(checkDatabase({ query: () => Promise.resolve({ rows: [] }) })).resolves.toBe(
        true,
      )

      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

const SOURCE = postgresSource()

if (SOURCE === null) {
  describe.skip('GET /ready against Postgres (skipped: no DATABASE_URL and no Docker daemon)', () => {
    it('would ask the database a trivial query', () => {
      expect.unreachable('unreachable: the suite is skipped')
    })
  })
} else {
  describe('GET /ready against Postgres (#151)', () => {
    let db: PostgresFixture

    beforeAll(async () => {
      db = await startPostgres()
    }, POSTGRES_STARTUP_TIMEOUT_MS)

    afterAll(async () => {
      await db.close()
    })

    it('answers 200 while select 1 reaches the database, and 503 once the drain begins', async () => {
      const started = await startServer({
        config: { ...testConfig(), port: 0, databaseUrl: db.connectionString },
        model: createScriptedModel().factory,
        resolveCredential: resolveTestSessionCredential,
        logger: silentLogger,
      })
      try {
        // The real check: the app's readiness asks the pool this server built, and real
        // Postgres answers it.
        const ready = await started.app.request('/ready')
        expect(ready.status).toBe(200)
        await expect(ready.json()).resolves.toEqual({ status: 'ok' })

        const stopping = started.shutdown()
        const draining = await started.app.request('/ready')
        expect(draining.status).toBe(503)
        await stopping
      } finally {
        await started.shutdown()
      }
    })
  })
}
