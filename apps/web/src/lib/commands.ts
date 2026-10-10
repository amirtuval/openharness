/**
 * The composer's slash commands (epic #277, K8; #283).
 *
 * The box is a message box first: text that is not a command is sent as words, exactly as it
 * was typed. A line that opens with one of {@link COMPOSER_COMMANDS} is run instead — the one
 * command today is `/compact [instructions]`, which asks the brain to summarize the older
 * history now — and {@link commandHint} is what puts the usage above the box while the reader
 * is still typing it.
 *
 * Only the exact spelling is a command (`/compact`, lower case). `/Comp`, `/compactx` and a
 * bare `/` are ordinary messages, so nothing a reader might write as prose is swallowed — and
 * the shell's own `/` shortcut (focus the box) is a keypress that never reaches here.
 */

/** One command the composer offers, and how the hint names it. */
export interface ComposerCommand {
  /** The name without its slash — the token that selects it. */
  readonly name: string
  /** The usage line the hint shows, brackets and all. */
  readonly usage: string
  /** One line saying what running it does. */
  readonly description: string
}

/**
 * Every slash command the composer runs, in the order a hint would list them.
 *
 * One entry today; the shape is a list so a second command is a row here rather than a second
 * parser. It is deliberately separate from the TUI's registry (`apps/tui/src/chat/commands.ts`):
 * the two frontends share the API, not their input handling — a terminal and a text box offer
 * different commands and print them differently.
 */
export const COMPOSER_COMMANDS: readonly ComposerCommand[] = [
  {
    name: 'compact',
    usage: '/compact [instructions]',
    description: 'Summarize the older history now',
  },
]

/** What a line in the composer means: a message to send, or the compaction to run. */
export type ParsedComposerInput =
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'compact'; readonly instructions: string | undefined }

/**
 * Read a composer line: the `/compact` command, or a message.
 *
 * The instructions are everything after the command, trimmed; a bare `/compact` carries none,
 * so the brain compacts without guidance. `/compact` with nothing but spaces is the same as
 * the bare form, and a line that names no command is a message — the text is returned exactly
 * as it was given, because trimming a message is the send path's business.
 *
 * @param value the composer's current text
 */
export function parseComposerInput(value: string): ParsedComposerInput {
  const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(value.trim())
  if (match === null) {
    return { kind: 'message', text: value }
  }
  const instructions = (match[1] ?? '').trim()
  return { kind: 'compact', instructions: instructions === '' ? undefined : instructions }
}

/**
 * The hint for what is being typed, or `null` when nothing is.
 *
 * Shown while the first token is a prefix of a command's name — `/c`, `/co`, … `/compact` — and
 * while the command's arguments are being typed. A bare `/` is no hint (it is one keystroke
 * from a message), and an unknown command is none either: the line stays an ordinary message,
 * and a hint about a command that would not run would be a lie.
 *
 * @param value the composer's current text
 */
export function commandHint(value: string): ComposerCommand | null {
  const trimmed = value.trimStart()
  if (!trimmed.startsWith('/')) {
    return null
  }
  const token = trimmed.split(/\s/, 1)[0] ?? ''
  if (token.length < 2) {
    return null
  }
  return COMPOSER_COMMANDS.find((command) => `/${command.name}`.startsWith(token)) ?? null
}
