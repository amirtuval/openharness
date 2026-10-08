/**
 * What the message view draws with (epic #201, X4).
 *
 * Two decisions live here, and they are different ones:
 *
 * - **Colour is ANSI named colours only** — the 16 the terminal's own theme defines, so `oh`
 *   looks like the terminal it is in rather than like this package. There is no hex in a
 *   message; the one place that is allowed its own values is a code block's syntax theme,
 *   which has to look the same *on* a light background as on a dark one.
 * - **Colour is off** when `NO_COLOR` says so. That is not a theme — it is the absence of
 *   one — so it is a flag carried beside the background rather than a third palette.
 *
 * The background matters for the syntax theme and nothing else: the terminal's own colours
 * are already readable on the terminal's own background, which is the whole point of asking
 * for them by name. A dark code theme on a light terminal is a wall of pale text, so the
 * theme is picked from the background the terminal reports.
 */

/** The `theme` key of the config file: `auto` detects, the other two say so outright. */
export type ThemeSetting = 'auto' | 'light' | 'dark'

/** Which way round the terminal is: what a syntax theme has to be readable against. */
export type TerminalBackground = 'light' | 'dark'

/** The resolved theme: the background, and whether anything is drawn in colour at all. */
export interface TerminalTheme {
  /** The background the syntax theme was chosen for. */
  readonly background: TerminalBackground
  /** False under `NO_COLOR`: every colour is dropped, the layout is not. */
  readonly color: boolean
}

/** The theme every caller gets when nobody said anything: a dark terminal, in colour. */
export const DEFAULT_THEME: TerminalTheme = { background: 'dark', color: true }

/** The environment variable that turns colour off, by being there at all. */
export const NO_COLOR_ENV = 'NO_COLOR'

/** The environment variable a terminal sets to say what it is: `fg;bg`, as palette indexes. */
export const COLORFGBG_ENV = 'COLORFGBG'

/**
 * Resolve `theme` against the environment.
 *
 * `auto` reads `COLORFGBG`, which the terminal sets to `<foreground>;<background>` as palette
 * indexes — VTE, iTerm2, Konsole and xterm all write it — and falls back to dark, which is
 * what most terminals are and what a wrong guess costs least on. An explicit `light`/`dark`
 * in the config is not second-guessed: it is the override for a terminal that reports
 * nothing, or reports it wrongly.
 *
 * The alternative detection, an OSC 11 query ("what colour is your background?"), is
 * deliberately not used: it means writing an escape sequence and reading stdin **before**
 * Ink takes the terminal over, which can swallow a keystroke, leaves stray bytes in a
 * transcript when the terminal does not answer, and delays the first frame by exactly the
 * timeout it waits — the three things X4 forbids. The config key is the way out for the
 * terminals `COLORFGBG` does not reach.
 */
export function resolveTerminalTheme(
  setting: ThemeSetting = 'auto',
  env: Record<string, string | undefined> = process.env,
): TerminalTheme {
  return {
    background: setting === 'auto' ? detectBackground(env) : setting,
    color: colorEnabled(env),
  }
}

/**
 * The background `COLORFGBG` reports, or dark.
 *
 * The variable is `<fg>;<bg>` — more than two fields happen (rxvt writes three) — so the
 * *last* one is the background, and it is a palette index: 0-6 and 8 are the dark half, 7
 * (white) and 9-15 (the bright ones) the light half. Anything unparsable is dark, because a
 * wrong guess costs one syntax palette and the caller can always say so in the config.
 */
export function detectBackground(
  env: Record<string, string | undefined> = process.env,
): TerminalBackground {
  const value = env[COLORFGBG_ENV]?.trim()
  if (value === undefined || value === '') return 'dark'

  const fields = value.split(';')
  const background = Number.parseInt(fields[fields.length - 1] ?? '', 10)
  if (!Number.isInteger(background)) return 'dark'

  return background === 7 || background >= 9 ? 'light' : 'dark'
}

/**
 * Whether colour may be drawn at all.
 *
 * `NO_COLOR` is present-and-not-empty: the convention (no-color.org) is that the variable is
 * what turns colour off, so `NO_COLOR=` — a shell that exported an empty string — is not a
 * request for anything.
 */
export function colorEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[NO_COLOR_ENV]
  return value === undefined || value === ''
}

/** A colour, or nothing at all: the one place `NO_COLOR` is consulted. */
export function paint(theme: TerminalTheme, color: string | undefined): string | undefined {
  return theme.color ? color : undefined
}

/**
 * The band a user's message is drawn on (issue #229).
 *
 * A band rather than a label, because a label is a character and a background is not: nothing
 * in front of the user's words, so selecting them and pasting them gives the words and only
 * the words. The colour is the terminal's own, like every other one in the transcript (X4):
 * *bright black* is a shade of a dark terminal's background and *white* of a light one's, so
 * the band is a band on either without `oh` naming a colour of its own. The text on it is left
 * at the terminal's default foreground, which is the one colour guaranteed readable on both.
 *
 * The name is the **foreground** spelling of the colour, because that is what Ink's
 * `backgroundColor` prop takes: it prefixes a `bg` of its own (`blackBright` → `bgBlackBright`,
 * the `\e[100m` a terminal paints a subtle band with). Under `NO_COLOR` there is no band at
 * all — `message-view.tsx` puts a dim `›` above the message instead, which is not colour.
 */
export function messageBand(theme: TerminalTheme): string | undefined {
  if (!theme.color) return undefined
  return theme.background === 'light' ? 'white' : 'blackBright'
}

/**
 * The named colours the transcript and the status line draw with.
 *
 * Every one of them is one of the sixteen the terminal theme defines, so `oh` wears the
 * terminal's colours and not its own. `chrome` is bright black — the one a reader reads as
 * "structure, not content" — which is why the rules, the table borders, the quote bars and
 * the code block's label all take it, and it is a *named* colour like the rest: it is the
 * terminal that decides what bright black looks like.
 */
export const PALETTE = {
  /** Headings. */
  heading: 'blue',
  /** Link text and inline code, the two things a reader is meant to try out. */
  link: 'blue',
  code: 'magenta',
  /** Rules, table borders, quote bars, a code block's label, a link's URL. */
  chrome: 'gray',
  /**
   * The status line's "something is happening": a turn that is working or retrying (#208).
   * Amber rather than anything louder — a chat spends most of its life here.
   */
  busy: 'yellow',
  /** A turn that did not finish the way anyone wanted: an interrupt (#208). */
  alarm: 'red',
} as const

/** One colour of a syntax theme, as highlight.js classifies code. */
type SyntaxPalette = Readonly<Record<string, string>>

/**
 * The code theme, per background.
 *
 * This is the one place X4 lets a hex value in, and it has to: sixteen terminal colours are
 * not a syntax theme — a comment, a string and a keyword would be three of eight, and which
 * three depends on the user's theme rather than on the language. The two palettes are the
 * familiar light/dark pairing (the GitHub ones), so the code looks the way it does in every
 * other tool; everything *around* the code is named colours, so the frame follows the
 * terminal.
 */
const SYNTAX: Readonly<Record<TerminalBackground, SyntaxPalette>> = {
  dark: {
    keyword: '#ff7b72',
    'template-tag': '#ff7b72',
    'template-variable': '#ff7b72',
    doctag: '#ff7b72',
    built_in: '#79c0ff',
    type: '#79c0ff',
    literal: '#79c0ff',
    number: '#79c0ff',
    string: '#a5d6ff',
    regexp: '#a5d6ff',
    char: '#a5d6ff',
    comment: '#8b949e',
    quote: '#8b949e',
    meta: '#8b949e',
    title: '#d2a8ff',
    section: '#d2a8ff',
    variable: '#ffa657',
    attr: '#79c0ff',
    attribute: '#79c0ff',
    property: '#79c0ff',
    tag: '#7ee787',
    name: '#7ee787',
    'selector-tag': '#7ee787',
    'selector-class': '#7ee787',
    'selector-id': '#7ee787',
    symbol: '#79c0ff',
    bullet: '#79c0ff',
    addition: '#aff5b4',
    deletion: '#ffdcd7',
    link: '#a5d6ff',
  },
  light: {
    keyword: '#cf222e',
    'template-tag': '#cf222e',
    'template-variable': '#cf222e',
    doctag: '#cf222e',
    built_in: '#0550ae',
    type: '#0550ae',
    literal: '#0550ae',
    number: '#0550ae',
    string: '#0a3069',
    regexp: '#0a3069',
    char: '#0a3069',
    comment: '#6e7781',
    quote: '#6e7781',
    meta: '#6e7781',
    title: '#8250df',
    section: '#8250df',
    variable: '#953800',
    attr: '#0550ae',
    attribute: '#0550ae',
    property: '#0550ae',
    tag: '#116329',
    name: '#116329',
    'selector-tag': '#116329',
    'selector-class': '#116329',
    'selector-id': '#116329',
    symbol: '#0550ae',
    bullet: '#0550ae',
    addition: '#116329',
    deletion: '#82071e',
    link: '#0a3069',
  },
}

/**
 * The colour a syntax scope is drawn in — highlight.js's class name without its `hljs-`
 * prefix, e.g. `keyword`, `string`, `title.function`.
 *
 * Nothing when the theme is not naming one (punctuation, operators and plain identifiers are
 * the terminal's own foreground) and nothing at all under `NO_COLOR`, which is how a code
 * block loses its colours and keeps its frame and its indentation.
 */
export function syntaxColor(theme: TerminalTheme, scope: string): string | undefined {
  if (!theme.color) return undefined
  return SYNTAX[theme.background][scope]
}
