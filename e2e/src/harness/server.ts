import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ENV_VARS, MOCK_MODEL_ENV_VALUE } from '@openharness/server'

import { sleep } from './wait'

/**
 * Running the server under test: the **built** output, in its own process, on a real port.
 *
 * The e2e suite runs the server the way a deployment does — `node apps/server/dist/index.js`
 * with an environment — rather than calling `startServer()` in-process. That is the whole
 * point of the package: a process boundary is what makes "the brain died" something a test
 * can produce (a `SIGKILL`), and it is what makes the assertions about shutdown, restart and
 * resume mean anything.
 *
 * The entry point is resolved *through the package* (`import.meta.resolve`, which reads
 * `@openharness/server`'s `exports` map), so the harness never hard-codes where a build put
 * its files — and `@openharness/e2e` depending on the server is what makes turbo build it
 * before this package's tests run.
 */

/**
 * The signing secret the e2e servers boot with. Fixed, because it has to survive a restart
 * (the failover suite kills servers and starts new ones mid-scenario) and be shared between
 * them; not a secret anyone should reuse: this is a test process's environment.
 */
export const E2E_BETTER_AUTH_SECRET = 'e2e-better-auth-secret-that-is-long-enough'

/** The vault key the e2e servers seal provider credentials with (32 bytes, base64). */
export const E2E_SECRETS_KEY = 'b3Blbmhhcm5lc3MtdGVzdC1zZWNyZXRzLWtleS0zMmI='

/** The base URL a server on `port` answers on. */
export function baseUrlFor(port: number): string {
  return `http://127.0.0.1:${port}`
}

/** How long to wait for a server to answer `/health` before giving up on it. */
const DEFAULT_READY_TIMEOUT_MS = 30_000

/** How long a killed process is given to be reaped. */
const KILL_TIMEOUT_MS = 10_000

/** How often `waitForOutput` looks again. */
const OUTPUT_POLL_MS = 20

/** What a `kill` waits for. */
export interface ProcessExit {
  /** The exit code, when the process exited on its own. */
  readonly code: number | null
  /** The signal that ended it, when one did. */
  readonly signal: NodeJS.Signals | null
}

/** Everything {@link startServerProcess} can be told. */
export interface ServerProcessOptions {
  /** The Postgres database to run against. The server migrates it on boot. */
  readonly databaseUrl: string
  /**
   * The public URL Better Auth is based at. `http://127.0.0.1:<port>` by default — the
   * listener's own address, which is what a browser would see and what the dev login is
   * allowed on (A7).
   */
  readonly publicUrl?: string
  /** Turn the dev login on (default) and seed its user (A7). */
  readonly devLogin?: boolean
  /** Serve a built web app from this directory at `/`. */
  readonly webDir?: string
  /** The port to listen on; a free one is picked when this is omitted. */
  readonly port?: number
  /**
   * Run the deterministic test model (`OPENHARNESS_TEST_MODEL=mock`). On by default: every
   * test that is not a provider smoke test wants the mock, and forgetting to ask for it would
   * send the suite at a real provider.
   */
  readonly mockModel?: boolean
  /**
   * Extra environment for the child process. Applied last, so it can override anything the
   * harness sets — that is how the failover test passes `SCHEDULER=postgres` and short lease
   * timings.
   */
  readonly env?: Readonly<Record<string, string>>
  /** How long to wait for `/health`; {@link DEFAULT_READY_TIMEOUT_MS} by default. */
  readonly readyTimeoutMs?: number
}

/** A running server process, and the ways a test talks to it. */
export interface ServerProcess {
  /** The port it listens on. */
  readonly port: number
  /** `http://127.0.0.1:<port>`, the base URL the client is built with. */
  readonly baseUrl: string
  /** The process id. */
  readonly pid: number
  /** Everything the process has written to stdout and stderr so far, uncut. */
  output(): string
  /** Whether the process is still running. */
  isRunning(): boolean
  /** Resolve when the process has written something matching `pattern`. */
  waitForOutput(pattern: RegExp, options?: { readonly timeoutMs?: number }): Promise<void>
  /** Resolve when the process exits. */
  readonly exit: Promise<ProcessExit>
  /** Kill the process and its children. Idempotent; resolves once it is gone. */
  kill(signal?: NodeJS.Signals): Promise<void>
}

/** The servers started and not yet killed, so a crashed worker cannot leak one. */
const runningProcesses = new Set<ServerProcess>()

/** Kill everything {@link startServerProcess} started. For a teardown that must not leak. */
export async function stopAllServerProcesses(): Promise<void> {
  await Promise.all([...runningProcesses].map(async (server) => server.kill()))
}

/**
 * Start the built server on a free port and wait until it answers `/health`.
 *
 * @param options the database to run against, and anything else to configure
 * @throws Error when the server exits before becoming ready, carrying the whole log
 */
export async function startServerProcess(options: ServerProcessOptions): Promise<ServerProcess> {
  const port = options.port ?? (await freePort())
  const baseUrl = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [serverEntryPath()], {
    env: serverEnvironment(options, port),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group: killing the server takes down anything it spawned, and a
    // `SIGKILL` to the group cannot be missed by a child that is mid-fork.
    detached: true,
  })

  const server = createServerProcess(child, port, baseUrl)
  runningProcesses.add(server)
  try {
    await waitForHealth(server, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
  } catch (error) {
    await server.kill()
    throw error
  }
  return server
}

/** The path of the built server, resolved through the `@openharness/server` package. */
export function serverEntryPath(): string {
  return fileURLToPath(import.meta.resolve('@openharness/server'))
}

/**
 * The directory of the built web app, resolved through the `@openharness/web` package.
 *
 * `@openharness/web` exports its `index.html`, so this is the file beside its `assets/` — the
 * same directory `OPENHARNESS_WEB_DIR` is pointed at in the container and in these tests.
 */
export function webAppDir(): string {
  return dirname(fileURLToPath(import.meta.resolve('@openharness/web')))
}

/** The environment the child is started with. */
function serverEnvironment(options: ServerProcessOptions, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    // Everything the harness decides itself is dropped first, so a variable left over in the
    // developer's shell cannot change what a test runs. Provider credentials (`ANTHROPIC_…`)
    // are not `OPENHARNESS_*` and pass through, which is what the smoke test needs.
    if (
      name.startsWith('OPENHARNESS_') ||
      name.startsWith('BETTER_AUTH_') ||
      name === ENV_VARS.databaseUrl ||
      name === 'PORT'
    ) {
      continue
    }
    env[name] = value
  }
  env[ENV_VARS.databaseUrl] = options.databaseUrl
  env[ENV_VARS.port] = String(port)
  env[ENV_VARS.betterAuthUrl] = options.publicUrl ?? baseUrlFor(port)
  env[ENV_VARS.betterAuthSecret] = E2E_BETTER_AUTH_SECRET
  env[ENV_VARS.secretsKey] = E2E_SECRETS_KEY
  if (options.devLogin !== false) {
    env[ENV_VARS.devLogin] = '1'
  }
  if (options.mockModel !== false) {
    env[ENV_VARS.testModel] = MOCK_MODEL_ENV_VALUE
  }
  if (options.webDir !== undefined) {
    env[ENV_VARS.webDir] = options.webDir
  }
  return { ...env, ...options.env }
}

/** Wrap the child in the handle the rest of the harness uses. */
function createServerProcess(child: ChildProcess, port: number, baseUrl: string): ServerProcess {
  const pid = child.pid
  if (pid === undefined) {
    throw new Error('the server process could not be started: it has no pid')
  }

  let log = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    log += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    log += chunk.toString()
  })

  let exited = false
  const exit = new Promise<ProcessExit>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true
      resolve({ code, signal })
    })
  })

  const server: ServerProcess = {
    port,
    baseUrl,
    pid,
    output: () => log,
    isRunning: () => !exited && child.exitCode === null && child.signalCode === null,
    waitForOutput: async (pattern, options = {}) => {
      const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
      while (!pattern.test(log)) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for the server process to log ${String(pattern)}. Its output was:\n${log}`,
          )
        }
        await sleep(OUTPUT_POLL_MS)
      }
    },
    exit,
    kill: async (signal: NodeJS.Signals = 'SIGKILL') => {
      if (!server.isRunning()) {
        await exit
        return
      }
      try {
        // The negative pid is the process group `detached: true` created.
        process.kill(-pid, signal)
      } catch {
        child.kill(signal)
      }
      const reaped = await Promise.race([exit, sleep(KILL_TIMEOUT_MS).then(() => null)])
      if (reaped === null) {
        throw new Error(`the server process ${pid} did not exit within ${KILL_TIMEOUT_MS}ms`)
      }
    },
  }
  // Registered after the handle exists, because the registry holds handles: a process that
  // exits on its own — a boot failure, or a test that killed it — must leave the list too.
  void exit.then(() => {
    runningProcesses.delete(server)
  })
  return server
}

/**
 * Poll `/health` until the server answers, or fail with what it logged.
 *
 * `/health` is the readiness signal on purpose: it is the one route that never needs a key,
 * and the server answers it after the store is open, the migrations are applied and the
 * scheduler has started — the point at which the rest of the API is worth talking to.
 */
async function waitForHealth(server: ServerProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!server.isRunning()) {
      const { code, signal } = await server.exit
      throw new Error(
        `the server exited before it answered /health (code ${String(code)}, signal ${String(signal)}). ` +
          `Its output was:\n${server.output()}`,
      )
    }
    try {
      const response = await fetch(`${server.baseUrl}/health`)
      if (response.ok && (await isHealthy(response))) {
        return
      }
    } catch {
      // Not listening yet, or listening but not answering: try again until the deadline.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the server did not answer /health within ${timeoutMs}ms. Its output was:\n${server.output()}`,
      )
    }
    await sleep(OUTPUT_POLL_MS)
  }
}

/** Whether a `/health` answer says the server is up. */
async function isHealthy(response: Response): Promise<boolean> {
  const body: unknown = await response.json().catch(() => null)
  return typeof body === 'object' && body !== null && 'status' in body && body.status === 'ok'
}

/** A port nothing is listening on: bound briefly, then released for the server to take. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const address = probe.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve()
    })
  })
  return port
}
