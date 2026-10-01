#!/usr/bin/env node
import { createClient, type Client } from '@openharness/client'
import { render, type Instance } from 'ink'
import { pathToFileURL } from 'node:url'

import { App, type ExitPayload } from './app'
import { parseArgs, type ChatOptions } from './args'
import { runAgents, runSessions } from './commands/list'
import { resolveConfig, type ResolvedConfig } from './config'
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
export type { ChatOptions, CliCommand, GlobalOptions, ParseOutcome } from './args'
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
 * - `0` — the command did what it was asked, including a chat the user ended;
 * - `1` — the server, the config or the network said no;
 * - `2` — the command line itself was wrong, so nothing was attempted;
 * - `130` / `143` — the process was signalled (`SIGINT` outside raw mode, `SIGTERM`).
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

  const resolved = resolveConfig({
    flags: { server: command.options.server, apiKey: command.options.apiKey },
    env,
  })
  if (!resolved.ok) {
    err(`oh: ${resolved.error}`)
    return 2
  }

  const config = resolved.config
  const context: ErrorContext = { server: config.server, debug: command.options.debug }
  if (command.options.debug) {
    err(`oh: ${describeConfig(config)}`)
  }

  try {
    const connected = await connect(config, env)

    switch (command.kind) {
      case 'sessions':
        return await runSessions(connected.client, { stdout: out, stderr: err, context })
      case 'agents':
        return await runAgents(connected.client, { stdout: out, stderr: err, context })
      case 'chat':
        return await runChat(connected, command.options, context, { stdin, stdout, stderr })
    }
  } catch (error) {
    report(err, error, context)
    return 1
  }
}

/** A client, and what the status line should say about where it came from. */
interface Connected {
  readonly client: Client
  readonly banner?: string | undefined
}

/** Build the client the rest of the run uses: the fake in dev mode, the real one otherwise. */
async function connect(
  config: ResolvedConfig,
  env: Record<string, string | undefined>,
): Promise<Connected> {
  if (isFakeMode(env)) {
    return { client: await createDevClient(), banner: FAKE_BANNER }
  }
  return { client: createClient({ baseUrl: config.server }) }
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

    if (payload?.sessionId !== undefined && code === 0) {
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
  const candidate = result as { code?: unknown; sessionId?: unknown }
  if (typeof candidate.code !== 'number') return undefined
  return {
    code: candidate.code,
    sessionId: typeof candidate.sessionId === 'string' ? candidate.sessionId : undefined,
  }
}

/** The `--debug` line: the settings that were resolved, and where each came from. */
function describeConfig(config: ResolvedConfig): string {
  const key = config.apiKey === undefined ? 'no api key' : `api key from ${config.sources.apiKey}`
  return `server ${config.server} (${config.sources.server}), ${key}`
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
