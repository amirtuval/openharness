import { parseArgs as parseNodeArgs, type ParseArgsConfig } from 'node:util'

import {
  COMPACTION_THRESHOLD_MAX,
  COMPACTION_THRESHOLD_MIN,
  SUMMARY_MAX_PASSES_MAX,
  SUMMARY_MAX_PASSES_MIN,
  SUMMARY_MODEL_SAME_AS_CHAT,
} from '@openharness/protocol'
import type { ToolPermission } from '@openharness/protocol'

import { HELP_TEXT } from './help'

/** Flags every command takes: where the server is, and how to talk to it. */
export interface GlobalOptions {
  /** `--server <url>`. */
  readonly server?: string | undefined
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
  /** `--model <provider/model>`: the model a new chat runs, skipping the picker. */
  readonly model?: string | undefined
  /** `--mode <name>`: a mode a new chat follows, instead of a model (#245, M6). */
  readonly mode?: string | undefined
}

/**
 * The compaction settings `oh settings` writes (epic #277, C3; #282).
 *
 * A field is a key **only when its flag was given**, because the server merges: an absent flag
 * leaves the stored choice alone, and `default` on a nullable control is how it is cleared back
 * to the server's own value.
 */
export interface SettingsPatch {
  /** The share of the budget that triggers a summary, 0.3–0.95, or `null` for the default. */
  readonly threshold?: number | null
  /** The model that writes summaries: `same-as-chat`, or a `provider/model` id. */
  readonly summaryModel?: string
  /** How many passes the summary model may take, 1–10, or `null` for the engine's default. */
  readonly summaryPasses?: number | null
}

/**
 * What `oh tools` changes (epic #303, X4; #307; #308).
 *
 * A tool's whole setting is `{ enabled, policy }`, and a flag names at most one of them: the
 * command reads the stored entry first and keeps the half the flags did not mention, so
 * `oh tools web_search --off` does not make a reader repeat the permission.
 */
export interface ToolsPatch {
  /** The tool to change; absent is a plain read of every tool. */
  readonly name?: string | undefined
  /** `--on` / `--off`, or absent to keep what the tool is set to. */
  readonly enabled?: boolean | undefined
  /** `--policy allow|ask|deny`, or absent to keep the stored permission. */
  readonly policy?: ToolPermission | undefined
}

/** Flags `oh login` takes on top of the global ones. */
export interface LoginOptions extends GlobalOptions {
  /** `--no-browser`: print the URL and the code, and do not open a browser. */
  readonly noBrowser: boolean
}

/**
 * What the command line asked for.
 *
 * Only the commands the v1 CLI has: a chat, the two listings (plus `sessions delete`), the
 * three auth commands, `default-model`, and the two that print something and stop. Anything
 * else is a usage error (see {@link parseArgs}).
 */
export type CliCommand =
  | { readonly kind: 'chat'; readonly options: ChatOptions }
  | { readonly kind: 'sessions'; readonly options: GlobalOptions }
  | {
      readonly kind: 'sessions-delete'
      readonly id: string
      readonly yes: boolean
      readonly options: GlobalOptions
    }
  | { readonly kind: 'agents'; readonly options: GlobalOptions }
  | { readonly kind: 'modes'; readonly options: GlobalOptions }
  | { readonly kind: 'providers'; readonly options: GlobalOptions }
  | {
      readonly kind: 'providers-add'
      readonly provider?: string | undefined
      readonly options: GlobalOptions
    }
  | {
      readonly kind: 'providers-remove'
      readonly provider: string
      readonly yes: boolean
      readonly options: GlobalOptions
    }
  | {
      readonly kind: 'default-model'
      readonly model?: string | undefined
      readonly options: GlobalOptions
    }
  | {
      readonly kind: 'settings'
      /** The compaction fields the flags asked to change; empty for a plain read (#282). */
      readonly patch: SettingsPatch
      readonly options: GlobalOptions
    }
  | {
      readonly kind: 'tools'
      /** The one tool a flag changes, if any; no name is a plain read (#303 X4; #307; #308). */
      readonly patch: ToolsPatch
      readonly options: GlobalOptions
    }
  | { readonly kind: 'login'; readonly options: LoginOptions }
  | { readonly kind: 'logout'; readonly options: GlobalOptions }
  | { readonly kind: 'whoami'; readonly options: GlobalOptions }
  | { readonly kind: 'update'; readonly options: GlobalOptions }
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
const SUBCOMMANDS = [
  'sessions',
  'agents',
  'modes',
  'providers',
  'default-model',
  'settings',
  'tools',
  'login',
  'logout',
  'whoami',
  'update',
] as const

type Subcommand = (typeof SUBCOMMANDS)[number]

/** What each subcommand does, for the message a flag it does not take gets. */
const SUBCOMMAND_BLURBS: Record<Subcommand, string> = {
  sessions: 'it lists what the server has, or deletes one with `delete <id>`',
  agents: 'it lists what the server has',
  modes: 'it lists your modes and what each resolves to',
  providers: 'it lists the model-provider keys, or manages them with `add` and `remove <provider>`',
  'default-model': 'it gets or sets the default model',
  settings: 'it prints the context settings, and sets them with its flags',
  tools: 'it prints which tools your chats may use, and sets one with --on/--off/--policy',
  login: 'it signs you in through the browser',
  logout: 'it ends the session and forgets the token',
  whoami: 'it prints the signed-in user',
  update: 'it installs the newest published version',
}

const OPTIONS = {
  version: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
  session: { type: 'string', short: 's' },
  continue: { type: 'boolean', short: 'c' },
  agent: { type: 'string' },
  model: { type: 'string' },
  mode: { type: 'string' },
  server: { type: 'string' },
  yes: { type: 'boolean' },
  'no-browser': { type: 'boolean' },
  debug: { type: 'boolean' },
  // `oh settings` (#282). `--summary-model` is spelled out rather than sharing `--model`,
  // which is the chat's own flag: a chat's model and the summary's are different settings.
  threshold: { type: 'string' },
  'summary-model': { type: 'string' },
  'summary-passes': { type: 'string' },
  // `oh tools` (#308): on/off and the permission a call is evaluated under. `--on` and `--off`
  // are two flags rather than `--enabled=<bool>` because that is how a person types it.
  on: { type: 'boolean' },
  off: { type: 'boolean' },
  policy: { type: 'string' },
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

    if (subcommand === 'sessions') {
      return parseSessions(extra, values, global)
    }

    if (subcommand === 'providers') {
      return parseProviders(extra, values, global)
    }

    if (subcommand === 'default-model') {
      return parseDefaultModel(extra, values, global)
    }

    if (subcommand === 'settings') {
      return parseSettings(extra, values, global)
    }

    if (subcommand === 'tools') {
      return parseTools(extra, values, global)
    }

    if (extra.length > 0) {
      return {
        ok: false,
        error: `\`oh ${subcommand}\` takes no arguments, got '${extra.join(' ')}'.`,
      }
    }

    const conflicting = wrongFlagFor(subcommand, values)
    if (conflicting !== undefined) {
      return {
        ok: false,
        error: `\`oh ${subcommand}\` does not take ${conflicting}; ${SUBCOMMAND_BLURBS[subcommand]}.`,
      }
    }

    if (subcommand === 'login') {
      return {
        ok: true,
        command: {
          kind: 'login',
          options: { ...global, noBrowser: values['no-browser'] === true },
        },
      }
    }

    return { ok: true, command: { kind: subcommand, options: global } }
  }

  const settingsFlag = settingsFlagIn(values)
  if (settingsFlag !== undefined) {
    return { ok: false, error: `${settingsFlag} only makes sense with \`oh settings\`.` }
  }

  const toolsFlag = toolsFlagIn(values)
  if (toolsFlag !== undefined) {
    return { ok: false, error: `${toolsFlag} only makes sense with \`oh tools\`.` }
  }

  if (values['no-browser'] === true) {
    return { ok: false, error: '--no-browser only makes sense with `oh login`.' }
  }

  if (values.yes === true) {
    return {
      ok: false,
      error:
        '--yes only makes sense with `oh sessions delete <id>` or `oh providers remove <provider>`.',
    }
  }

  if (values.model !== undefined && values.model.trim() === '') {
    return {
      ok: false,
      error: '--model needs a model id, like --model openai/gpt-4.1-mini.',
    }
  }

  if (values.mode !== undefined && values.mode.trim() === '') {
    return {
      ok: false,
      error: '--mode needs a mode name, like --mode smart.',
    }
  }

  if (values.model !== undefined && values.mode !== undefined) {
    return {
      ok: false,
      error: 'use either --model or --mode, not both: a chat follows a model or a mode.',
    }
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
        model: values.model,
        mode: values.mode,
      },
    },
  }
}

/**
 * `oh sessions` in both shapes: a bare listing, and `oh sessions delete <id> [--yes]`.
 *
 * The bare listing takes no argument at all; `delete` takes exactly one, the session id, and
 * `--yes` is the only flag either shape accepts (plus the global ones).
 */
function parseSessions(
  extra: readonly string[],
  values: ReturnType<typeof parseOptions>['values'],
  global: GlobalOptions,
): ParseOutcome {
  const [action, ...rest] = extra

  if (action === undefined) {
    if (values.yes === true) {
      return {
        ok: false,
        error: '--yes only makes sense with `oh sessions delete <id>`.',
      }
    }
    const conflicting = wrongFlagFor('sessions', values)
    if (conflicting !== undefined) {
      return {
        ok: false,
        error: `\`oh sessions\` does not take ${conflicting}; ${SUBCOMMAND_BLURBS.sessions}.`,
      }
    }
    return { ok: true, command: { kind: 'sessions', options: global } }
  }

  if (action !== 'delete') {
    return {
      ok: false,
      error: `unknown \`oh sessions\` argument '${action}'. \`oh sessions\` lists the sessions; \`oh sessions delete <id>\` deletes one.`,
    }
  }

  const [id, ...overflow] = rest
  if (id === undefined) {
    return {
      ok: false,
      error: '`oh sessions delete` needs the session id: oh sessions delete <id>.',
    }
  }
  if (overflow.length > 0) {
    return {
      ok: false,
      error: `\`oh sessions delete\` takes one session id, got '${[id, ...overflow].join(' ')}'.`,
    }
  }

  const conflicting = wrongFlagFor('sessions', values)
  if (conflicting !== undefined) {
    return {
      ok: false,
      error: `\`oh sessions delete\` does not take ${conflicting}; it deletes one chat.`,
    }
  }

  return {
    ok: true,
    command: { kind: 'sessions-delete', id, yes: values.yes === true, options: global },
  }
}

/**
 * `oh providers` in all three shapes (#210): a bare listing (or `list`), `add [provider]`, and
 * `remove <provider> [--yes]`.
 *
 * A bare `oh providers` is the listing, the way a bare `oh sessions` is — the common case is
 * reading what is there. `add` takes at most one argument, the provider to start on; `remove`
 * takes exactly one, the provider to forget, and `--yes` is the only flag the command accepts
 * besides the global ones.
 */
function parseProviders(
  extra: readonly string[],
  values: ReturnType<typeof parseOptions>['values'],
  global: GlobalOptions,
): ParseOutcome {
  const [action, ...rest] = extra

  if (action === undefined || action === 'list') {
    if (action === 'list' && rest.length > 0) {
      return {
        ok: false,
        error: `\`oh providers list\` takes no arguments, got '${rest.join(' ')}'.`,
      }
    }
    if (values.yes === true) {
      return {
        ok: false,
        error: '--yes only makes sense with `oh providers remove <provider>`.',
      }
    }
    const conflicting = wrongFlagFor('providers', values)
    if (conflicting !== undefined) {
      return {
        ok: false,
        error: `\`oh providers\` does not take ${conflicting}; ${SUBCOMMAND_BLURBS.providers}.`,
      }
    }
    return { ok: true, command: { kind: 'providers', options: global } }
  }

  if (action === 'add') {
    const [provider, ...overflow] = rest
    if (overflow.length > 0) {
      return {
        ok: false,
        error: `\`oh providers add\` takes at most one provider, got '${rest.join(' ')}'.`,
      }
    }
    if (provider !== undefined && provider.trim() === '') {
      return {
        ok: false,
        error: '`oh providers add` needs a provider name, like `oh providers add anthropic`.',
      }
    }
    if (values.yes === true) {
      return { ok: false, error: '--yes only makes sense with `oh providers remove <provider>`.' }
    }
    const conflicting = wrongFlagFor('providers', values)
    if (conflicting !== undefined) {
      return {
        ok: false,
        error: `\`oh providers add\` does not take ${conflicting}; it connects a provider.`,
      }
    }
    return { ok: true, command: { kind: 'providers-add', provider, options: global } }
  }

  if (action === 'remove') {
    const [provider, ...overflow] = rest
    if (provider === undefined) {
      return {
        ok: false,
        error: '`oh providers remove` needs the provider: oh providers remove <provider>.',
      }
    }
    if (overflow.length > 0) {
      return {
        ok: false,
        error: `\`oh providers remove\` takes one provider, got '${[provider, ...overflow].join(' ')}'.`,
      }
    }
    const conflicting = wrongFlagFor('providers', values)
    if (conflicting !== undefined) {
      return {
        ok: false,
        error: `\`oh providers remove\` does not take ${conflicting}; it forgets one key.`,
      }
    }
    return {
      ok: true,
      command: { kind: 'providers-remove', provider, yes: values.yes === true, options: global },
    }
  }

  return {
    ok: false,
    error: `unknown \`oh providers\` argument '${action}'. \`oh providers\` lists the keys; \`oh providers add [provider]\` connects one; \`oh providers remove <provider>\` forgets one.`,
  }
}

/**
 * `oh default-model [provider/model]`: no argument prints the stored default, one sets it.
 *
 * The id is not validated here beyond being non-empty — the server owns the shape rule (a
 * `provider/model` router id), and it answers a bad one with a message worth printing.
 */
function parseDefaultModel(
  extra: readonly string[],
  values: ReturnType<typeof parseOptions>['values'],
  global: GlobalOptions,
): ParseOutcome {
  const [model, ...overflow] = extra
  if (overflow.length > 0) {
    return {
      ok: false,
      error: `\`oh default-model\` takes at most one model id, got '${extra.join(' ')}'.`,
    }
  }
  if (model !== undefined && model.trim() === '') {
    return {
      ok: false,
      error: '`oh default-model` needs a model id, like anthropic/claude-sonnet-5.',
    }
  }

  const conflicting = wrongFlagFor('default-model', values)
  if (conflicting !== undefined) {
    return {
      ok: false,
      error: `\`oh default-model\` does not take ${conflicting}; ${SUBCOMMAND_BLURBS['default-model']}.`,
    }
  }

  return { ok: true, command: { kind: 'default-model', model, options: global } }
}

/**
 * `oh settings [--threshold <share>] [--summary-model <id|same-as-chat>]
 * [--summary-passes <n|default>]` (epic #277, C3; #282).
 *
 * With no flags it prints the context settings; each flag sets one, and the flags may be
 * combined. The values are validated here rather than left to the server because a typo like
 * `--threshold 5` (meaning 50%) is worth catching before a request, and the messages can name
 * the flag and the range. `default` clears a nullable control back to the server's own value.
 */
function parseSettings(
  extra: readonly string[],
  values: ReturnType<typeof parseOptions>['values'],
  global: GlobalOptions,
): ParseOutcome {
  if (extra.length > 0) {
    return {
      ok: false,
      error: `\`oh settings\` takes no arguments, got '${extra.join(' ')}'. Set a value with a flag, like --threshold 0.5.`,
    }
  }

  const conflicting = wrongFlagFor('settings', values)
  if (conflicting !== undefined) {
    return {
      ok: false,
      error: `\`oh settings\` does not take ${conflicting}; ${SUBCOMMAND_BLURBS.settings}.`,
    }
  }

  const patch: {
    threshold?: number | null
    summaryModel?: string
    summaryPasses?: number | null
  } = {}

  if (values.threshold !== undefined) {
    const raw = values.threshold.trim()
    if (raw === '') {
      return { ok: false, error: '--threshold needs a share, like --threshold 0.5.' }
    }
    if (raw === CLEAR_WORD) {
      patch.threshold = null
    } else {
      const value = Number(raw)
      if (
        !Number.isFinite(value) ||
        value < COMPACTION_THRESHOLD_MIN ||
        value > COMPACTION_THRESHOLD_MAX
      ) {
        return {
          ok: false,
          error: `--threshold needs a share between ${COMPACTION_THRESHOLD_MIN} and ${COMPACTION_THRESHOLD_MAX} (0.7 is 70%), or 'default'.`,
        }
      }
      patch.threshold = value
    }
  }

  if (values['summary-model'] !== undefined) {
    const model = values['summary-model'].trim()
    if (model === '') {
      return {
        ok: false,
        error: `--summary-model needs a model id, or '${SUMMARY_MODEL_SAME_AS_CHAT}'.`,
      }
    }
    patch.summaryModel = model
  }

  if (values['summary-passes'] !== undefined) {
    const raw = values['summary-passes'].trim()
    if (raw === '') {
      return { ok: false, error: '--summary-passes needs a number, like --summary-passes 5.' }
    }
    if (raw === CLEAR_WORD) {
      patch.summaryPasses = null
    } else {
      const value = Number(raw)
      if (
        !Number.isInteger(value) ||
        value < SUMMARY_MAX_PASSES_MIN ||
        value > SUMMARY_MAX_PASSES_MAX
      ) {
        return {
          ok: false,
          error: `--summary-passes needs a whole number between ${SUMMARY_MAX_PASSES_MIN} and ${SUMMARY_MAX_PASSES_MAX}, or 'default'.`,
        }
      }
      patch.summaryPasses = value
    }
  }

  return { ok: true, command: { kind: 'settings', patch, options: global } }
}

/**
 * `oh tools [name] [--on|--off] [--policy <allow|ask|deny>]` (epic #303, X4; #307; #308).
 *
 * With no name it prints every tool and the reader's choices. A name with `--on`/`--off` or
 * `--policy` changes that one tool; the flags are validated here so a typo names the flag and
 * its values rather than coming back a 400. `--on` and `--off` together, or a setting flag with
 * no tool to apply it to, is a usage error rather than a guess.
 */
function parseTools(
  extra: readonly string[],
  values: ReturnType<typeof parseOptions>['values'],
  global: GlobalOptions,
): ParseOutcome {
  const [name, ...overflow] = extra
  if (overflow.length > 0) {
    return {
      ok: false,
      error: `\`oh tools\` takes at most one tool name, got '${extra.join(' ')}'.`,
    }
  }
  if (values.on === true && values.off === true) {
    return { ok: false, error: 'use either --on or --off, not both.' }
  }

  const setsSomething = values.on === true || values.off === true || values.policy !== undefined
  if (setsSomething && name === undefined) {
    return {
      ok: false,
      error: 'name a tool to change, like `oh tools web_search --off`.',
    }
  }

  const conflicting = wrongFlagFor('tools', values)
  if (conflicting !== undefined) {
    return {
      ok: false,
      error: `\`oh tools\` does not take ${conflicting}; ${SUBCOMMAND_BLURBS.tools}.`,
    }
  }

  const patch: {
    name?: string
    enabled?: boolean
    policy?: ToolPermission
  } = {}
  if (name !== undefined) {
    if (name.trim() === '') {
      return { ok: false, error: '`oh tools` needs a tool name, like web_search.' }
    }
    patch.name = name
  }
  if (values.on === true) {
    patch.enabled = true
  }
  if (values.off === true) {
    patch.enabled = false
  }
  if (values.policy !== undefined) {
    const policy = values.policy.trim()
    if (!TOOL_PERMISSION_WORDS.includes(policy as ToolPermission)) {
      return {
        ok: false,
        error: `--policy needs one of ${TOOL_PERMISSION_WORDS.join(', ')}, got '${values.policy}'.`,
      }
    }
    patch.policy = policy as ToolPermission
  }

  return { ok: true, command: { kind: 'tools', patch, options: global } }
}

/** The permission words `--policy` accepts — the protocol's own three, spelled out. */
const TOOL_PERMISSION_WORDS: readonly ToolPermission[] = ['allow', 'ask', 'deny']

/** The word a nullable setting takes to mean "follow the default" (K2/K5). */
const CLEAR_WORD = 'default'

/** The setting flags, in the order their messages name them. */
function settingsFlagIn(values: ReturnType<typeof parseOptions>['values']): string | undefined {
  if (values.threshold !== undefined) return '--threshold <share>'
  if (values['summary-model'] !== undefined) return '--summary-model <id>'
  if (values['summary-passes'] !== undefined) return '--summary-passes <n>'
  return undefined
}

/** The tool flags, in the order their messages name them. */
function toolsFlagIn(values: ReturnType<typeof parseOptions>['values']): string | undefined {
  if (values.on === true) return '--on'
  if (values.off === true) return '--off'
  if (values.policy !== undefined) return '--policy <allow|ask|deny>'
  return undefined
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

/** The flag a subcommand cannot take, or `undefined` when everything it got fits. */
function wrongFlagFor(
  subcommand: Subcommand,
  values: ReturnType<typeof parseOptions>['values'],
): string | undefined {
  if (values.session !== undefined) return `--session <id>`
  if (values.continue === true) return '--continue'
  if (values.agent !== undefined) return `--agent <id|name>`
  if (values.model !== undefined) return `--model <provider/model>`
  if (values.mode !== undefined) return `--mode <name>`
  // The `oh settings` flags, which every other command rejects — the chat path checks them
  // itself, before this is ever called.
  if (subcommand !== 'settings') {
    const setting = settingsFlagIn(values)
    if (setting !== undefined) return setting
  }
  // `oh tools`' own flags (#308), rejected everywhere else the same way.
  if (subcommand !== 'tools') {
    const tool = toolsFlagIn(values)
    if (tool !== undefined) return tool
  }
  if (
    values.yes === true &&
    subcommand !== 'sessions' &&
    // `oh providers remove` is the other command that asks a question to skip; the bare
    // listing and `oh providers add` reject it themselves, in `parseProviders`.
    subcommand !== 'providers'
  ) {
    return '--yes'
  }
  if (values['no-browser'] === true && subcommand !== 'login') return '--no-browser'
  return undefined
}

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value)
}
