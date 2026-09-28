import { pathToFileURL } from 'node:url'

import { main } from './main'

/**
 * `@openharness/server` — the runnable openharness server.
 *
 * The HTTP API the protocol describes, the SSE stream over a session's event log, and the
 * scheduler that runs brains against it. `node dist/index.js` reads the environment and starts
 * everything (see `AGENTS.md` for the variables and `docs/api.md` for the routes).
 *
 * ```ts
 * import { createApp } from '@openharness/server'
 *
 * const app = createApp({ store, scheduler, apiKey: 'oh_…' })
 * ```
 *
 * The three pieces a host wires together:
 *
 * - **{@link createApp}** — the routes, against any `SessionStore` and `SessionScheduler`.
 * - **{@link LocalScheduler}** — the single-process scheduler, on top of {@link SessionRunner},
 *   which owns the per-session turn loop.
 * - **{@link startServer}** (and {@link main}) — the whole thing: store, migrations, model,
 *   scheduler, listener and a graceful shutdown.
 */

/** This package's name; a cheap way for a dependent to prove the import resolved. */
export const PACKAGE_NAME = '@openharness/server'

export { createApp, isApiPath, type AppOptions } from './app'
export {
  ENV_VARS,
  DEFAULT_PORT,
  DEFAULT_SCHEDULER,
  defaultInstanceId,
  describeConfig,
  readServerConfig,
  usesTestModel,
  type SchedulerKind,
  type ServerConfig,
} from './config'
export { HttpError, invalidRequest, notFoundError } from './http/errors'
export { main, startServer, type StartServerOptions, type StartedServer } from './main'
export {
  createMockModelFactory,
  MOCK_ECHO_CHUNKS,
  MOCK_MODEL_ENV_VALUE,
  MOCK_MODEL_USAGE,
  MOCK_RETRYABLE_MARKER,
  MOCK_SLOW_CHUNKS,
  MOCK_SLOW_MARKER,
  MOCK_SLOW_TOTAL_MS,
  MOCK_TERMINAL_MARKER,
  planFor,
} from './mock-model'
export { resolveModelFactory, type ResolvedModel } from './model'
export {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_SWEEP_MS,
  PostgresPartitionScheduler,
  type PostgresPartitionSchedulerOptions,
} from './partition-scheduler'
export { DEFAULT_MAX_CONCURRENT_PASSES, PassQueue, type PassContext } from './pass-queue'
export { DEFAULT_DRAIN_TIMEOUT_MS, SessionRunner } from './runner'
export type { RunSessionOptions, SessionRunnerOptions } from './runner'
export {
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  LocalScheduler,
  partitions,
  type LocalSchedulerOptions,
  type SessionScheduler,
  type StopSchedulerOptions,
} from './scheduler'
export { SSE_KEEPALIVE, SSE_KEEPALIVE_MS, createSessionEventStream } from './sse'
export { consoleLogger, silentLogger, type AppEnv, type Logger } from './types'

// `node dist/index.js` starts the server; importing this module never does.
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error('the server could not start', error)
    process.exitCode = 1
  })
}
