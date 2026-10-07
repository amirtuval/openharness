import type { ChatSession, Notice } from './session'

/**
 * The chat's slash commands: one registry, one description of each, and the rule that reads
 * what the user typed into the prompt (#207).
 *
 * `/model` used to be a `text.trim() === '/model'` in the screen and a picker drawn as a
 * one-off. It is a command here like any other, and the screen knows nothing about which
 * commands exist: it parses the prompt against {@link CHAT_COMMANDS} and runs what comes
 * back. The model picker is still the first command with real behaviour — it takes over the
 * input area through the prompt slot (`components/prompt-slot.tsx`), which is the same
 * mechanism a `/providers` key entry (#210, X7), an `ask_user` question and an approval
 * (phase 5) will use.
 *
 * Everything here is a plain value or a plain function, so the registry, the parse and the
 * "did you mean" are tested without Ink.
 */

/**
 * What a command is given to act on: the chat itself, and the handful of things only the
 * screen can do.
 *
 * The context is the commands' whole surface — a command that needs something the context
 * does not offer has to grow the context, which is the point of having one.
 */
export interface CommandContext {
  /** The chat the command runs in; what `/new` reads the model to start on from. */
  readonly session: ChatSession
  /**
   * Open the model picker in the prompt slot. The pick is pending rather than applied, so
   * the status line says when it lands (epic #116 U3).
   */
  readonly pickModel: () => void
  /** Leave this chat and open a new one in `modelId` — `/new`. */
  readonly newChat: (modelId: string) => void
  /** Wipe the screen, the session untouched — the Ctrl+L wipe, by another name. */
  readonly clearScreen: () => void
  /** Leave the chat, the way the second idle Ctrl+C does. */
  readonly exit: () => void
  /** Put a line above the status bar: the `/help` block, or a mistake worth naming. */
  readonly showNotice: (notice: Notice) => void
}

/** One slash command: what it is called, what it does, and how it runs. */
export interface ChatCommand {
  /** The name without its slash, as it is typed and listed. */
  readonly name: string
  /** Other names for the same command (no slash either), e.g. `quit` for `exit`. */
  readonly aliases?: readonly string[] | undefined
  /** The one line the menu and `/help` show beside the name. */
  readonly description: string
  /**
   * An argument hint for the menu's usage column, e.g. `<id>`. `undefined` for a command
   * that takes none — the menu then shows nothing to type after the name. No command takes
   * arguments yet; the column is here for the ones that will (`/mode` in phase 4).
   */
  readonly args?: string | undefined
  /**
   * Do it. `args` is what followed the name on the line, trimmed — the empty string when
   * the command was run from the menu.
   */
  readonly run: (context: CommandContext, args: string) => void | Promise<void>
}

/**
 * Every command a chat offers, in the order the menu lists them.
 *
 * `/model` first: it is the one the registry replaces, and the one a chat reaches for most.
 */
export const CHAT_COMMANDS: readonly ChatCommand[] = [
  {
    name: 'model',
    description: 'pick a model; it applies from the next message',
    run: (context) => {
      context.pickModel()
    },
  },
  {
    name: 'new',
    description: 'start a new chat on the current model',
    run: (context) => {
      context.newChat(currentModelOf(context.session))
    },
  },
  {
    name: 'clear',
    description: 'clear the screen; the session stays',
    run: (context) => {
      context.clearScreen()
    },
  },
  {
    name: 'help',
    description: 'list the commands and the keys',
    run: (context) => {
      context.showNotice(helpNotice())
    },
  },
  {
    name: 'exit',
    aliases: ['quit'],
    description: 'leave the chat',
    run: (context) => {
      context.exit()
    },
  },
]

/**
 * What the prompt and the screen bind, for `/help` and for `oh --help` — one list, printed
 * in two places, so the two cannot come to disagree about a key.
 */
export const CHAT_KEYS: readonly { readonly keys: string; readonly description: string }[] = [
  { keys: 'Enter', description: 'send — also while a reply streams, which is steering' },
  { keys: 'Ctrl+J, Alt+Enter', description: 'insert a newline' },
  { keys: '←/→', description: 'move the cursor' },
  { keys: 'Home/End, Ctrl+A/E', description: 'the start and the end of the line' },
  { keys: 'Backspace, Delete', description: 'delete behind the cursor, and at it' },
  { keys: 'Ctrl+U, Ctrl+K', description: 'delete to the start of the line, and to its end' },
  { keys: 'Ctrl+W, Alt+Backspace', description: 'delete the word before the cursor' },
  { keys: 'Alt+B, Alt+F, Ctrl+←/→', description: 'jump a word back and forward' },
  {
    keys: '↑/↓',
    description:
      "the menu's commands while it is open, otherwise the buffer's lines and the history",
  },
  { keys: 'Tab', description: 'complete the command the menu has selected' },
  { keys: 'Esc', description: 'close the command menu, keeping what is typed' },
  { keys: 'Ctrl+L', description: 'clear the screen; the session stays' },
  { keys: 'Ctrl+C', description: 'interrupt the reply; press twice when idle to exit' },
]

/** What a line typed into the prompt turned out to be. */
export type ChatInput =
  /** A message for the model, exactly as it should be sent. */
  | { readonly kind: 'message'; readonly text: string }
  /** A command, with what followed its name. */
  | { readonly kind: 'command'; readonly command: ChatCommand; readonly args: string }
  /** A `/` line that named nothing; `suggestion` is the closest command, if any. */
  | {
      readonly kind: 'unknown'
      readonly name: string
      readonly suggestion: ChatCommand | undefined
    }

/**
 * Read what the user typed (#207).
 *
 * - **`//…` is a message.** The first slash comes off and the rest goes to the model, which
 *   is how a line that would otherwise look like a command gets sent. Nothing else about it
 *   is special: the message keeps every other character, whitespace included.
 * - **`/name args` is a command** when `name` — up to the first whitespace — is one of the
 *   registry's, by name or by alias. The rest of the line is its arguments, trimmed.
 * - **`/name` that is nobody's is unknown**: the screen names the mistake and offers the
 *   closest match, and nothing goes to the model. A command that is *nearly* right is the
 *   one case where sending it would be worse than refusing: the model would answer about it.
 * - **Anything else is a message**, verbatim.
 *
 * The command is the whole line: `/model` must start it. That is the menu's rule too (it
 * opens on a buffer that starts with `/`), so what the menu offers and what submitting does
 * cannot disagree. A trailing `\n` or space is still `/model` — the name ends at whitespace.
 */
export function parseChatInput(text: string, commands: readonly ChatCommand[]): ChatInput {
  if (text.startsWith('//')) {
    return { kind: 'message', text: text.slice(1) }
  }
  if (!text.startsWith('/')) {
    return { kind: 'message', text }
  }

  const rest = text.slice(1)
  const name = rest.split(/\s/u)[0] ?? ''
  const command = findCommand(name, commands)
  if (command !== undefined) {
    return { kind: 'command', command, args: rest.slice(name.length).trim() }
  }
  return { kind: 'unknown', name, suggestion: closestCommand(name, commands) }
}

/** The command `name` is, by name or by alias. */
export function findCommand(
  name: string,
  commands: readonly ChatCommand[] = CHAT_COMMANDS,
): ChatCommand | undefined {
  return commands.find((command) => command.name === name || (command.aliases ?? []).includes(name))
}

/**
 * The command a mistyped name was most likely meant to be.
 *
 * Edit distance, ties going to the registry's order — which is the order the menu lists them
 * in, so the suggestion is the higher of two equally close ones, where a user looking at the
 * menu would find it first. A name with nothing in it suggests nothing: there is no typo to
 * correct.
 */
export function closestCommand(
  name: string,
  commands: readonly ChatCommand[] = CHAT_COMMANDS,
): ChatCommand | undefined {
  if (name === '') return undefined

  let best: ChatCommand | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const command of commands) {
    for (const candidate of [command.name, ...(command.aliases ?? [])]) {
      const distance = editDistance(name.toLowerCase(), candidate.toLowerCase())
      if (distance < bestDistance) {
        best = command
        bestDistance = distance
      }
    }
  }
  return best
}

/**
 * The commands a `/` line completes to: a name or an alias that starts with what has been
 * typed so far, in registry order. Not a substring match — a command menu that offers
 * `/model` for `/dl` is offering noise.
 */
export function filterCommands(
  query: string,
  commands: readonly ChatCommand[] = CHAT_COMMANDS,
): readonly ChatCommand[] {
  const needle = query.toLowerCase()
  return commands.filter(
    (command) =>
      command.name.toLowerCase().startsWith(needle) ||
      (command.aliases ?? []).some((alias) => alias.toLowerCase().startsWith(needle)),
  )
}

/**
 * The word a `/` line is completing, or `null` when the buffer is not one (#207).
 *
 * `''` is the query of a bare `/`: every command matches. A buffer that has grown past the
 * name — a space, a newline — is not a command line any more, so the menu closes and the
 * line's own text is left alone.
 */
export function commandQuery(value: string): string | null {
  if (!value.startsWith('/') || value.startsWith('//') || /\s/u.test(value)) return null
  return value.slice(1)
}

/** How a command is written in the menu and in `/help`: `/name`, its arguments, its aliases. */
export function commandUsage(command: ChatCommand): string {
  const name = `/${command.name}`
  const args = command.args === undefined ? '' : ` ${command.args}`
  const aliases = command.aliases ?? []
  const also = aliases.length === 0 ? '' : ` (${aliases.map((alias) => `/${alias}`).join(', ')})`
  return `${name}${args}${also}`
}

/**
 * How wide the usage column has to be, over a *whole* registry.
 *
 * The menu pads every row to this rather than to the widest row it is showing: the column
 * would otherwise jump left and right as the filter narrowed, which is exactly the sort of
 * movement that makes a list hard to read.
 */
export function commandUsageWidth(commands: readonly ChatCommand[] = CHAT_COMMANDS): number {
  return commands.reduce((widest, command) => Math.max(widest, commandUsage(command).length), 0)
}

/**
 * The whole in-chat reference, one line each, columns aligned: every command, then every key.
 *
 * `/help` and `oh --help` both print this, which is what keeps the two honest — a command
 * the menu offers is a command the help text names, and a key the prompt binds is a key the
 * help text lists.
 */
export function chatReferenceLines(
  commands: readonly ChatCommand[] = CHAT_COMMANDS,
  keys: readonly { readonly keys: string; readonly description: string }[] = CHAT_KEYS,
): readonly string[] {
  const rows = [
    ...commands.map((command) => ({ label: commandUsage(command), text: command.description })),
    ...keys.map((key) => ({ label: key.keys, text: key.description })),
  ]
  const width = rows.reduce((widest, row) => Math.max(widest, row.label.length), 0)
  return rows.map((row) => `${row.label.padEnd(width)}  ${row.text}`)
}

/** The `/help` block: the commands, then the keys. */
export function helpNotice(): Notice {
  return { kind: 'info', text: 'Commands and keys', hints: chatReferenceLines() }
}

/**
 * What an unknown `/command` gets instead of a message to the model.
 *
 * The closest match is named for any name there is one for, however far off it is: this
 * registry is five short words, and `/zzz`'s nearest is still a better answer than nothing.
 */
export function unknownCommandNotice(name: string, suggestion: ChatCommand | undefined): Notice {
  const hints = ['/help lists the commands.']
  if (name === '') {
    return { kind: 'error', text: 'Unknown command.', hints }
  }
  const text = `Unknown command /${name}.`
  return {
    kind: 'error',
    text: suggestion === undefined ? text : `${text} Did you mean /${suggestion.name}?`,
    hints,
  }
}

/**
 * The model a chat runs: a `/model` pick that no message has carried yet, then the model the
 * log last said the session runs, then the session's own (epic #116 U3).
 *
 * This is what the status line names and what `/new` starts the next chat on, so the two
 * cannot disagree about which model is "current".
 */
export function currentModelOf(session: ChatSession): string {
  const state = session.getState()
  return state.pendingModel ?? state.transcript.model ?? session.session.model.id
}

/**
 * The number of single-character edits between two words — what "did you mean" is measured
 * in. One row of the matrix at a time: only the row above is ever read, and the words here
 * are command names.
 */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (let down = 1; down <= a.length; down++) {
    const current = [down]
    for (let across = 1; across <= b.length; across++) {
      const substitute = (previous[across - 1] ?? 0) + (a[down - 1] === b[across - 1] ? 0 : 1)
      current[across] = Math.min(
        (previous[across] ?? 0) + 1,
        (current[across - 1] ?? 0) + 1,
        substitute,
      )
    }
    previous = current
  }

  return previous[b.length] ?? 0
}
