import { parseArgs as parseNodeArgs, type ParseArgsConfig } from 'node:util'

import { HELP_TEXT } from './help'

/** Flags every command takes: where the server is, and how to talk to it. */
export interface GlobalOptions {
  /** `--server <url>`. */
  readonly server?: string | undefined
  /** `--api-key <key>`. */
  readonly apiKey?: string | undefined
  /** `--debug`: show stack traces, and say where each setting came from. */
  readonly debug: boolean
}

/** Flags the chat takes on top of the global ones. */
export interface ChatOptions extends GlobalOptions {
  /** `--session <id>` / `-s`: resume a session instead of starting one. */
  readonly session?: string | undefined
  /** `--continue` / `-c`: resume the most recent session. */
  readonly continue: boolean
  /** `--agent <id|name>`: which agent to start a session with. */
  readonly agent?: string | undefined
}

/**
 * What the command line asked for.
 *
 * Only the commands the v1 CLI has: a chat, the two listings, and the two that print
 * something and stop. Anything else is a usage error (see {@link parseArgs}).
 */
export type CliCommand =
  | { readonly kind: 'chat'; readonly options: ChatOptions }
  | { readonly kind: 'sessions'; readonly options: GlobalOptions }
  | { readonly kind: 'agents'; readonly options: GlobalOptions }
  | { readonly kind: 'version' }
  | { readonly kind: 'help' }

/**
 * The result of parsing: a command, or a message to print before exiting with code 2.
 *
 * Nothing throws for a bad command line — the caller owns the exit code, and a test can
 * assert on the message.
 */
export type ParseOutcome =
  | { readonly ok: true; readonly command: CliCommand }
  | { readonly ok: false; readonly error: string }

/** The commands that are words rather than flags, e.g. `oh sessions`. */
const SUBCOMMANDS = ['sessions', 'agents'] as const

type Subcommand = (typeof SUBCOMMANDS)[number]

const OPTIONS = {
  version: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
  session: { type: 'string', short: 's' },
  continue: { type: 'boolean', short: 'c' },
  agent: { type: 'string' },
  server: { type: 'string' },
  'api-key': { type: 'string' },
  debug: { type: 'boolean' },
} as const satisfies ParseArgsConfig['options']

/**
 * Parse the `oh` command line.
 *
 * `node:util`'s `parseArgs` does the work, in strict mode: an unknown flag is an error
 * rather than a positional in disguise, which is what makes `--sessoin=x` fail loudly
 * instead of silently starting a new chat.
 *
 * @param argv the arguments after `oh` — `process.argv.slice(2)`
 */
export function parseArgs(argv: readonly string[]): ParseOutcome {
  let parsed: ReturnType<typeof parseOptions>
  try {
    parsed = parseOptions(argv)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `${detail}\n\n${HELP_TEXT}` }
  }

  const values = parsed.values

  if (values.help) {
    return { ok: true, command: { kind: 'help' } }
  }

  if (values.version) {
    return { ok: true, command: { kind: 'version' } }
  }

  const global: GlobalOptions = {
    server: values.server,
    apiKey: values['api-key'],
    debug: values.debug === true,
  }

  const [subcommand, ...extra] = parsed.positionals

  if (subcommand !== undefined) {
    if (!isSubcommand(subcommand)) {
      return {
        ok: false,
        error: `unknown command '${subcommand}'. Expected one of: ${SUBCOMMANDS.join(', ')}, or no command at all for a new chat. Run \`oh --help\` for usage.`,
      }
    }

    if (extra.length > 0) {
      return {
        ok: false,
        error: `\`oh ${subcommand}\` takes no arguments, got '${extra.join(' ')}'.`,
      }
    }

    const conflicting = chatOnlyFlag(values)
    if (conflicting !== undefined) {
      return {
        ok: false,
        error: `\`oh ${subcommand}\` does not take ${conflicting}; it lists what the server has.`,
      }
    }

    return { ok: true, command: { kind: subcommand, options: global } }
  }

  if (values.session !== undefined && values.continue === true) {
    return {
      ok: false,
      error: 'use either --session <id> or --continue, not both: they name different sessions.',
    }
  }

  return {
    ok: true,
    command: {
      kind: 'chat',
      options: {
        ...global,
        session: values.session,
        continue: values.continue === true,
        agent: values.agent,
      },
    },
  }
}

/**
 * `parseArgs` in strict mode, over this CLI's flag table. A named function so the inferred
 * value types survive: an annotated `ReturnType<...>` would widen the string flags back into
 * `string | boolean`.
 */
function parseOptions(argv: readonly string[]) {
  return parseNodeArgs({
    args: [...argv],
    options: OPTIONS,
    strict: true,
    allowPositionals: true,
  })
}

/** The chat-only flags a positional subcommand was given, or `undefined` when it got none. */
function chatOnlyFlag(values: ReturnType<typeof parseOptions>['values']): string | undefined {
  if (values.session !== undefined) return `--session <id>`
  if (values.continue === true) return '--continue'
  if (values.agent !== undefined) return '--agent <id|name>'
  return undefined
}

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value)
}
