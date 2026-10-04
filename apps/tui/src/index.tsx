#!/usr/bin/env node
import { createClient, type Client } from '@openharness/client'
import { render, type Instance } from 'ink'
import { pathToFileURL } from 'node:url'

import { App, type ExitPayload } from './app'
import { parseArgs, type ChatOptions } from './args'
import { openBrowser } from './browser'
import { runLogin, runLogout, runWhoami, type AuthIo } from './commands/auth'
import { runAgents, runSessionDelete, runSessions } from './commands/list'
import { runDefaultModel } from './commands/preferences'
import { resolveConfig, type ResolvedConfig } from './config'
import { openCredentials, type CredentialStore } from './credentials'
import { createDevClient, FAKE_BANNER, isFakeMode } from './dev/fake'
import { describeError, type ErrorContext } from './errors'
import { HELP_TEXT } from './help'
import { installSignals } from './signals'
import { restoreTerminal } from './terminal'
import { readVersion } from './version'

/** This package's name; lets a dependent prove the import resolved. */
export const PACKAGE_NAME = '@openharness/cli'

export { App } from './app'
export type { AppProps, ExitPayload } from './app'
export { parseArgs } from './args'
export type { ChatOptions, CliCommand, GlobalOptions, LoginOptions, ParseOutcome } from './args'
export { createChatSession } from './chat/session'
export type { ChatSession, ChatViewState, Notice } from './chat/session'
export { resolveConfig } from './config'
export type { ResolvedConfig } from './config'
export { describeError } from './errors'
export type { ErrorReport } from './errors'
export { readVersion } from './version'

/** The streams `run` writes to and reads from; they default to the process's. */
export interface RunOptions {
  readonly stdin?: NodeJS.ReadStream | undefined
  readonly stdout?: NodeJS.WriteStream | undefined
  readonly stderr?: NodeJS.WriteStream | undefined
  /** The environment to read the configuration from; defaults to `process.env`. */
  readonly env?: Record<string, string | undefined> | undefined
}

/**
 * Run `oh` once and return the exit code.
 *
 * The codes, and who returns them:
 *
 * - `0` — the command did what it was asked, including a chat the user ended and a `logout`
 *   whose server-side revoke could not be reached (the token is still gone locally);
 * - `1` — the server, the network or the sign-in state said no: a 401 is the "not signed in
 *   to <server>. Run `oh login`." case;
 * - `2` — the command line itself was wrong, so nothing was attempted — or the config or
 *   credentials file could not be used, and the message names it;
 * - `130` / `143` — the process was signalled (`SIGINT` outside raw mode, `SIGTERM`), which
 *   also cancels a running `oh login`.
 *
 * @param argv the arguments after `oh`
 */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const env = options.env ?? process.env

  const out = (line: string): void => {
    stdout.write(`${line}\n`)
  }
  const err = (line: string): void => {
    stderr.write(`${line}\n`)
  }

  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    err(`oh: ${parsed.error}`)
    return 2
  }

  const { command } = parsed
  if (command.kind === 'help') {
    stdout.write(HELP_TEXT)
    return 0
  }
  if (command.kind === 'version') {
    out(readVersion())
    return 0
  }

  const resolved = resolveConfig({ flags: { server: command.options.server }, env })
  if (!resolved.ok) {
    err(`oh: ${resolved.error}`)
    return 2
  }

  const credentials = openCredentials({ env })
  if (!credentials.ok) {
    err(`oh: ${credentials.error}`)
    return 2
  }

  const config = resolved.config
  const context: ErrorContext = { server: config.server, debug: command.options.debug }
  if (command.options.debug) {
    err(`oh: ${describeConfig(config)}`)
  }

  try {
    const connected = await connect(config, env, credentials.store)

    switch (command.kind) {
      case 'sessions':
        return await runSessions(connected.client, { stdout: out, stderr: err, context })
      case 'sessions-delete':
        return await runSessionDelete(
          connected.client,
          {
            stdout: out,
            stderr: err,
            context,
            // The question goes out without a newline so the answer lands on its line.
            prompt: (text) => {
              stdout.write(text)
            },
            stdin,
          },
          command.id,
          { yes: command.yes },
        )
      case 'agents':
        return await runAgents(connected.client, { stdout: out, stderr: err, context })
      case 'default-model':
        return await runDefaultModel(
          connected.client,
          { stdout: out, stderr: err, context },
          command.model,
        )
      case 'chat':
        return await runChat(connected, command.options, context, { stdin, stdout, stderr })
      case 'login': {
        // Ctrl+C during the poll is a cancellation, not a crash: abort the poll with the exit
        // code the signal deserves, and let the handler leave the process alone otherwise.
        const controller = new AbortController()
        const stopSignals = installSignals(process, {
          onInterrupt: () => {
            controller.abort(130)
          },
          onTerminate: () => {
            controller.abort(143)
          },
        })
        try {
          return await runLogin({
            ...authIo(connected, config, credentials.store, out, err, context),
            noBrowser: command.options.noBrowser,
            openBrowser: (url) => openBrowser(url, { env }),
            signal: controller.signal,
          })
        } finally {
          stopSignals()
        }
      }
      case 'logout':
        return await runLogout(authIo(connected, config, credentials.store, out, err, context))
      case 'whoami':
        return await runWhoami(authIo(connected, config, credentials.store, out, err, context))
    }
  } catch (error) {
    report(err, error, context)
    return 1
  }
}

/** A client, and what the status line should say about where it came from. */
interface Connected {
  /** The client for the selected server, carrying the stored token when there is one. */
  readonly client: Client
  /** A client carrying `token` (or none): the log-in flow needs both sides of that. */
  readonly clientFor: (token: string | undefined) => Client
  readonly banner?: string | undefined
}

/**
 * Build the clients the rest of the run uses: the fake in dev mode, real ones otherwise.
 *
 * The real client is built per call and reads the credentials file through the caller: a
 * stored token is sent as `Authorization: Bearer`, and no token means the request simply has
 * no session — the server's 401 is what becomes "not signed in".
 */
async function connect(
  config: ResolvedConfig,
  env: Record<string, string | undefined>,
  store: CredentialStore,
): Promise<Connected> {
  if (isFakeMode(env)) {
    // The fake ignores the token entirely — it answers for its seeded user — and its device
    // flow is scripted, so `login`, `logout` and `whoami` run against it like against a server.
    const fake = await createDevClient()
    return { client: fake, clientFor: () => fake, banner: FAKE_BANNER }
  }
  const clientFor = (token: string | undefined): Client =>
    createClient({ baseUrl: config.server, token })
  return { client: clientFor(store.tokenFor(config.server)), clientFor }
}

/** The shared half of the three auth commands' inputs. */
function authIo(
  connected: Connected,
  config: ResolvedConfig,
  store: CredentialStore,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
  context: ErrorContext,
): AuthIo {
  return {
    stdout,
    stderr,
    context,
    server: config.server,
    store,
    createApiClient: connected.clientFor,
  }
}

/** The streams the chat renders into. */
interface ChatStreams {
  readonly stdin: NodeJS.ReadStream
  readonly stdout: NodeJS.WriteStream
  readonly stderr: NodeJS.WriteStream
}

/**
 * Mount the chat and wait for it to end.
 *
 * The terminal is the thing to be careful with here. `exitOnCtrlC` is off because Ctrl+C
 * means "interrupt" before it means "quit", so Ink will not unmount itself: the app asks
 * for the exit when the rules say so, and every other way out — a signal, an exception —
 * goes through {@link quit} or the `finally` below, each of which gives the terminal back.
 */
async function runChat(
  connected: Connected,
  options: ChatOptions,
  context: ErrorContext,
  streams: ChatStreams,
): Promise<number> {
  if (streams.stdin.isTTY !== true) {
    // Ink would say this itself, and say it in its own words, after mounting an app that
    // cannot read a key. A chat needs a terminal; the listings do not, so point at those.
    streams.stderr.write(
      'oh: the chat needs a terminal, and stdin is not one.\n' +
        '  run oh from a terminal, or use `oh sessions` / `oh agents`, which print and stop.\n',
    )
    return 2
  }

  const restore = (): void => {
    restoreTerminal({ stdin: streams.stdin, stdout: streams.stdout })
  }

  let instance: Instance | undefined
  let signalCode: number | undefined

  const quit = (code: number): void => {
    signalCode = code
    restore()
    if (instance === undefined) {
      // Signalled in the instant between installing these handlers and mounting: nothing
      // is rendered, and nothing is going to be.
      process.exit(code)
    }
    instance.unmount()
  }

  const stopSignals = installSignals(process, {
    onInterrupt: () => {
      quit(130)
    },
    onTerminate: () => {
      quit(143)
    },
  })

  // The last resort. Whatever ends the process — an unhandled rejection, a `SIGHUP` this
  // did not catch, `process.exit` from somewhere else — raw mode is left off.
  const onProcessExit = (): void => {
    restore()
  }
  process.once('exit', onProcessExit)

  try {
    instance = render(
      <App
        client={connected.client}
        options={options}
        context={context}
        banner={connected.banner}
      />,
      {
        stdin: streams.stdin,
        stdout: streams.stdout,
        stderr: streams.stderr,
        exitOnCtrlC: false,
      },
    )

    const payload = toExitPayload(await instance.waitUntilExit())
    const code = signalCode ?? payload?.code ?? 0

    if (payload?.deleted === true && code === 0) {
      // The chat was deleted while it was open (epic #116 U5): there is no id to resume.
      streams.stdout.write('\nThis chat was deleted; it is gone.\n')
    } else if (payload?.sessionId !== undefined && code === 0) {
      streams.stdout.write(`\nResume this session with: oh -s ${payload.sessionId}\n`)
    }

    return code
  } finally {
    stopSignals()
    process.off('exit', onProcessExit)
    restore()
  }
}

/** What `exit()` was called with, when it looks like ours. */
function toExitPayload(result: unknown): ExitPayload | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const candidate = result as { code?: unknown; sessionId?: unknown; deleted?: unknown }
  if (typeof candidate.code !== 'number') return undefined
  return {
    code: candidate.code,
    sessionId: typeof candidate.sessionId === 'string' ? candidate.sessionId : undefined,
    deleted: candidate.deleted === true ? true : undefined,
  }
}

/** The `--debug` line: the settings that were resolved, and where each came from. */
function describeConfig(config: ResolvedConfig): string {
  return `server ${config.server} (${config.sources.server})`
}

/** Print a failure: the message, the hints worth acting on, and the stack under `--debug`. */
function report(write: (line: string) => void, error: unknown, context: ErrorContext): void {
  const described = describeError(error, context)
  write(`oh: ${described.message}`)
  for (const hint of described.hints) write(`  ${hint}`)
  if (described.stack !== undefined) write(described.stack)
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  process.exitCode = await run(process.argv.slice(2))
}
