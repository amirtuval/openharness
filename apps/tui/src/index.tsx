#!/usr/bin/env node
import { createClient, type Client } from '@openharness/client'
import { render, type Instance } from 'ink'
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { App, type ExitPayload } from './app'
import { parseArgs, type ChatOptions } from './args'
import { openBrowser } from './browser'
import { offerSignIn, runLogin, runLogout, runWhoami, type AuthIo } from './commands/auth'
import { runAgents, runSessionDelete, runSessions } from './commands/list'
import { runModes } from './commands/modes'
import { runDefaultModel } from './commands/preferences'
import { mountProvidersAdd, runProvidersList, runProvidersRemove } from './commands/providers'
import { createNpmPort, runUpdate } from './commands/update'
import { modelLabel } from './components/status-line'
import { resolveConfig, type ResolvedConfig } from './config'
import { openCredentials, type CredentialStore } from './credentials'
import { createDevClient, FAKE_BANNER, isFakeMode } from './dev/fake'
import { describeError, notSignedInMessage, type ErrorContext } from './errors'
import { HELP_TEXT } from './help'
import { openHistory, type PromptHistory } from './history'
import { resolveTerminalTheme } from './markdown/theme'
import { installSignals } from './signals'
import { restoreTerminal } from './terminal'
import {
  autoUpdate as runAutoUpdate,
  detectGlobalInstall,
  type AutoUpdateHook,
} from './update/index'
import { readVersion } from './version'

/** This package's name; lets a dependent prove the import resolved. */
export const PACKAGE_NAME = '@openh/cli'

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
  /**
   * The auto-update entry point (#157).
   *
   * The real one spawns npm, so a test that calls `run()` hands it a stand-in and watches what
   * it is asked — which commands reach it, and with which environment — instead of touching
   * the network. Its default is the real updater, and nothing else about `run()` changes.
   */
  readonly autoUpdate?: AutoUpdateHook | undefined
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

  // The auto-update (#157), before anything renders: this is the one moment a notice can be
  // printed without landing in the middle of the chat's Ink UI or `oh login`'s device flow,
  // and the check it may start never blocks what comes next. `--version` and `--help` returned
  // above, so the one line they are is never joined by another.
  const autoUpdate = options.autoUpdate ?? runAutoUpdate
  autoUpdate({
    command: command.kind,
    env,
    configAutoUpdate: config.autoUpdate,
    scriptPath: process.argv[1],
    runningVersion: readVersion(),
    stdout: out,
    stderr: err,
  })

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
      case 'modes':
        return await runModes(connected.client, { stdout: out, stderr: err, context })
      case 'providers':
        return await runProvidersList(connected.client, { stdout: out, stderr: err, context })
      case 'providers-add':
        return await runProvidersAdd(
          connected,
          config,
          command.provider,
          context,
          credentials.store,
          { stdin, stdout, stderr, env },
        )
      case 'providers-remove':
        return await runProvidersRemove(
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
          command.provider,
          { yes: command.yes },
        )
      case 'default-model':
        return await runDefaultModel(
          connected.client,
          { stdout: out, stderr: err, context },
          command.model,
        )
      case 'chat':
        return await runChat(connected, config, command.options, context, credentials.store, {
          stdin,
          stdout,
          stderr,
          env,
        })
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
      case 'update': {
        // `oh update` needs no server: it is npm, in the foreground, with npm's own progress.
        // Its one precondition is that this `oh` is a global install — the same question the
        // background check asks, here answered before anything is spawned.
        const isGlobalInstall = await detectGlobalInstall({ env, scriptPath: process.argv[1] })
        return await runUpdate({
          stdout: out,
          stderr: err,
          runningVersion: readVersion(),
          isGlobalInstall,
          npm: createNpmPort({
            env,
            progress: {
              stdout: (chunk) => {
                stdout.write(chunk)
              },
              stderr: (chunk) => {
                stderr.write(chunk)
              },
            },
          }),
        })
      }
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
    const fake = await createDevClient(env)
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

/** What the chat renders into, and where the files it touches are read from. */
interface ChatStreams {
  readonly stdin: NodeJS.ReadStream
  readonly stdout: NodeJS.WriteStream
  readonly stderr: NodeJS.WriteStream
  /** The environment the prompt history's path comes from. */
  readonly env: Record<string, string | undefined>
}

/**
 * The chat, and the sign-in it may have to do first (#210, epic #201 X7).
 *
 * A signed-out `oh` used to end at "not signed in … Run `oh login`." — a command the reader
 * had to know and run, from a prompt that could have just asked. Now the 401 the chat's first
 * request gets is an offer: `Sign in now? [Y/n]`, the device flow the CLI already has, and the
 * chat again on the token it stored. The offer and the flow are plain terminal IO, outside the
 * Ink UI, which is why the app leaves with `needsSignIn` and this loop mounts it a second time
 * rather than a screen inside it doing the work.
 *
 * A run with no terminal never reaches any of that: the chat needs a TTY to read a key, and
 * that check — with today's message and exit code — is the first thing here.
 */
async function runChat(
  connected: Connected,
  config: ResolvedConfig,
  options: ChatOptions,
  context: ErrorContext,
  store: CredentialStore,
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

  // The theme the transcript is drawn with (epic #201, X4): the config file's `theme` key,
  // resolved against what the environment says — `NO_COLOR`, and the background the terminal
  // reports. It is resolved once, here, rather than read per message: neither the environment
  // nor the config file changes under a running chat, and a settled message keeps the theme
  // it was drawn with, exactly as it keeps its width.
  const theme = resolveTerminalTheme(config.theme, streams.env)
  const openUrl = (url: string): boolean => openBrowser(url, { env: streams.env }).opened

  let current = connected
  for (;;) {
    const mounted = await mountChat(current, config, options, context, {
      ...streams,
      theme,
      openUrl,
    })

    if (mounted.payload?.needsSignIn !== true) {
      announceSession(streams, mounted)
      return mounted.code
    }

    // The session was refused, or there was none: ask, and run the device flow here rather
    // than inside the UI. A "no" (or a failed sign-in) ends it the way it always did — the
    // not-signed-in line, exit 1 — rather than printing a resume hint for a chat that never
    // started.
    const token = await askToSignIn(config, store, connected, context, streams)
    if (token === undefined) {
      streams.stderr.write(`oh: ${notSignedInMessage(config.server)}\n`)
      return 1
    }
    current = { ...current, client: connected.clientFor(token) }
  }
}

/** Say what happened to the session on the way out — the resume hint, or that it is gone. */
function announceSession(streams: ChatStreams, mounted: ChatMount): void {
  if (mounted.payload?.deleted === true && mounted.code === 0) {
    // The chat was deleted while it was open (epic #116 U5): there is no id to resume.
    streams.stdout.write('\nThis chat was deleted; it is gone.\n')
  } else if (mounted.payload?.sessionId !== undefined && mounted.code === 0) {
    streams.stdout.write(`\nResume this session with: oh -s ${mounted.payload.sessionId}\n`)
  }
}

/** How one mount of the chat ended. */
interface ChatMount {
  readonly code: number
  readonly payload: ExitPayload | undefined
}

/** What {@link mountChat} needs on top of the streams: the theme and the browser opener. */
interface ChatMountOptions extends ChatStreams {
  readonly theme: ReturnType<typeof resolveTerminalTheme>
  readonly openUrl: (url: string) => boolean
}

/**
 * Mount the chat once and wait for it to end.
 *
 * The terminal is the thing to be careful with here. `exitOnCtrlC` is off because Ctrl+C
 * means "interrupt" before it means "quit", so Ink will not unmount itself: the app asks
 * for the exit when the rules say so, and every other way out — a signal, an exception —
 * goes through {@link quit} or the `finally` below, each of which gives the terminal back.
 */
async function mountChat(
  connected: Connected,
  config: ResolvedConfig,
  options: ChatOptions,
  context: ErrorContext,
  streams: ChatMountOptions,
): Promise<ChatMount> {
  // The prompt's history (#206). It is handed over as a function rather than awaited here:
  // it needs a `client.me()`, and waiting for that before the screen is drawn would leave
  // `oh` silent, instead of saying "connecting to <server>…", for as long as the server
  // takes to answer.
  const loadHistory = (): Promise<PromptHistory | undefined> =>
    openChatHistory(connected.client, config.server, streams.env)

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
        theme={streams.theme}
        openUrl={streams.openUrl}
        offerSignIn
        loadHistory={loadHistory}
      />,
      {
        stdin: streams.stdin,
        stdout: streams.stdout,
        stderr: streams.stderr,
        exitOnCtrlC: false,
      },
    )

    const payload = toExitPayload(await instance.waitUntilExit())
    return { code: signalCode ?? payload?.code ?? 0, payload }
  } finally {
    stopSignals()
    process.off('exit', onProcessExit)
    restore()
  }
}

/**
 * Ask `Sign in now? [Y/n]` and run the device flow, in plain terminal IO (#210).
 *
 * The prompt and the flow are deliberately outside Ink: the device flow prints a URL and a
 * code, and a screen that owned the input area would have to grow a second rendering of all
 * of it. `oh login` is the same code (`commands/auth.ts`), reached from a chat that found no
 * session — and Ctrl+C during the poll cancels it with the code the signal deserves, exactly
 * as `oh login` does.
 *
 * @returns the token the run stored, or `undefined` when the reader said no or the login did
 *   not finish.
 */
async function askToSignIn(
  config: ResolvedConfig,
  store: CredentialStore,
  connected: Connected,
  context: ErrorContext,
  streams: ChatStreams,
): Promise<string | undefined> {
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
    return await offerSignIn({
      stdout: (line) => {
        streams.stdout.write(`${line}\n`)
      },
      stderr: (line) => {
        streams.stderr.write(`${line}\n`)
      },
      prompt: (text) => {
        streams.stdout.write(text)
      },
      context,
      server: config.server,
      store,
      createApiClient: connected.clientFor,
      openBrowser: (url) => openBrowser(url, { env: streams.env }),
      stdin: streams.stdin,
      signal: controller.signal,
    })
  } finally {
    stopSignals()
  }
}

/**
 * `oh providers add [provider]` (#210): the connect flow, and the sign-in it may need first.
 *
 * A credential write requires a **fresh** session (epic #65, A2), so the flow's own 401 is
 * the same offer the chat makes: the screen leaves with `stale-session`, the run signs in
 * outside the UI, and the flow is mounted again. A reader who has never signed in therefore
 * reaches a stored key without ever typing `oh login`.
 */
async function runProvidersAdd(
  connected: Connected,
  config: ResolvedConfig,
  provider: string | undefined,
  context: ErrorContext,
  store: CredentialStore,
  streams: ChatStreams,
): Promise<number> {
  if (streams.stdin.isTTY !== true) {
    streams.stderr.write(
      'oh: `oh providers add` needs a terminal, and stdin is not one.\n' +
        '  a key is typed into a hidden prompt, which a pipe cannot answer.\n',
    )
    return 2
  }

  const openUrl = (url: string): boolean => openBrowser(url, { env: streams.env }).opened
  let current = connected

  for (;;) {
    const outcome = await mountProvidersAdd({
      client: current.client,
      context,
      provider,
      openUrl,
      stdin: streams.stdin,
      stdout: streams.stdout,
      stderr: streams.stderr,
    })

    if (outcome.kind === 'cancelled') {
      streams.stdout.write('Not added.\n')
      return 0
    }
    if (outcome.kind === 'saved') {
      streams.stdout.write(`${await describeSavedDefault(current.client)}\n`)
      return 0
    }

    const token = await askToSignIn(config, store, connected, context, streams)
    if (token === undefined) {
      streams.stderr.write(`oh: ${notSignedInMessage(config.server)}\n`)
      return 1
    }
    current = { ...current, client: connected.clientFor(token) }
  }
}

/**
 * The line `oh providers add` ends a successful save on (#210): the default the server picked,
 * named the way the catalog names it.
 *
 * The read is best-effort — the key is already stored, and the confirmation is a courtesy —
 * so a server that cannot answer costs the sentence, not the exit code.
 */
async function describeSavedDefault(client: Client): Promise<string> {
  try {
    const [preferences, catalog] = await Promise.all([
      client.preferences.get(),
      client.models.list(),
    ])
    return preferences.default_model === null
      ? "You're set: no default model was picked — `oh` will ask which to use."
      : `You're set: default model ${modelLabel(preferences.default_model, catalog.data)}.`
  } catch {
    return "You're set: the key is saved."
  }
}

/**
 * The prompt history for this chat: one list per server **and user** (#206).
 *
 * The user half needs a name, and the only one the CLI has is what the server calls the
 * caller — so this asks `client.me()`. Two accounts on one server sign in with different
 * tokens but share this machine, and without the user id they would share a history.
 *
 * A server that will not name the caller gets no history rather than a failed chat: the
 * request that failed is about to fail the chat anyway, in its own words, and the list of
 * old prompts is not worth a message of its own. The same goes for a `me()` that answers
 * something unexpected.
 */
async function openChatHistory(
  client: Client,
  server: string,
  env: Record<string, string | undefined>,
): Promise<PromptHistory | undefined> {
  try {
    const me = await client.me()
    return openHistory({ env, server, user: me.id })
  } catch {
    return undefined
  }
}

/** What `exit()` was called with, when it looks like ours. */
function toExitPayload(result: unknown): ExitPayload | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const candidate = result as {
    code?: unknown
    sessionId?: unknown
    deleted?: unknown
    needsSignIn?: unknown
  }
  if (typeof candidate.code !== 'number') return undefined
  return {
    code: candidate.code,
    sessionId: typeof candidate.sessionId === 'string' ? candidate.sessionId : undefined,
    deleted: candidate.deleted === true ? true : undefined,
    needsSignIn: candidate.needsSignIn === true ? true : undefined,
  }
}

/** The `--debug` line: the settings that were resolved, and where each came from. */
function describeConfig(config: ResolvedConfig): string {
  return `server ${config.server} (${config.sources.server}), theme ${config.theme}`
}

/** Print a failure: the message, the hints worth acting on, and the stack under `--debug`. */
function report(write: (line: string) => void, error: unknown, context: ErrorContext): void {
  const described = describeError(error, context)
  write(`oh: ${described.message}`)
  for (const hint of described.hints) write(`  ${hint}`)
  if (described.stack !== undefined) write(described.stack)
}

/**
 * Is this module the process's entry point?
 *
 * Usually a plain URL comparison is enough, but npm installs a package's `bin` as a
 * **symlink** (`node_modules/.bin/oh` → `../@openh/cli/dist/index.js`, and the same shape
 * under a global prefix), and Node resolves the entry to its real path: `import.meta.url` is
 * `apps/tui/dist/index.js` while `process.argv[1]` is still the `.bin/oh` symlink — so the
 * string comparison says "not the entry point" and an installed `oh` would silently do
 * nothing (#152). The realpath comparison is the one that holds however it was reached;
 * the string comparison stays as the cheap, exact case.
 *
 * Exported (with its two inputs) so the tests can exercise it; `run()` itself is the module
 * run only when this answers true.
 */
export function isDirectRun(
  entry: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): boolean {
  if (entry === undefined) return false
  if (moduleUrl === pathToFileURL(entry).href) return true
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

if (isDirectRun()) {
  process.exitCode = await run(process.argv.slice(2))
}
