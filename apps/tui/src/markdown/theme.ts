/**
 * What the message view draws with (epic #201, X4; issue #231).
 *
 * Three decisions live here, and they are different ones:
 *
 * - **Foreground colour is ANSI named colours only** — the 16 the terminal's own theme defines,
 *   so `oh` looks like the terminal it is in rather than like this package. The one place that
 *   is allowed its own values is a code block's syntax theme, which has to look the same *on* a
 *   light background as on a dark one.
 * - **A background may be 24-bit** (#231). The sixteen named colours have no subtle gray — the
 *   nearest one, *bright black*, is a heavy band — so a user's band and a code block's panel are
 *   *derived* from the detected background instead: a tint a shade off the terminal's own, in
 *   24-bit where the terminal can mix one, in the 256-colour gray ramp where it can mix that,
 *   and the named colours `oh` has always used where it can mix neither.
 * - **Colour is off** when `NO_COLOR` says so. That is not a theme — it is the absence of one —
 *   so it is a flag carried beside the background rather than a third palette.
 *
 * The background matters for the syntax theme, the tints and nothing else: the terminal's own
 * colours are already readable on the terminal's own background, which is the whole point of
 * asking for them by name. A dark code theme on a light terminal is a wall of pale text, so the
 * theme is picked from the background the terminal reports.
 */

/** The `theme` key of the config file: `auto` detects, the other two say so outright. */
export type ThemeSetting = 'auto' | 'light' | 'dark'

/** Which way round the terminal is: what a syntax theme has to be readable against. */
export type TerminalBackground = 'light' | 'dark'

/**
 * How much colour the terminal can show, as chalk counts it: 3 for 24-bit, 2 for the 256-colour
 * palette, 1 for the sixteen named ones, 0 for none.
 *
 * The transcript tells only the top two apart — below them the named colours it has always
 * drawn with are what there is, and a derived tint is not available — but the two are not the
 * same question to the eye: `#2a2b33` is the tint a 24-bit terminal gets and `ansi256(236)` the
 * nearest gray a 256-colour one can mix (issue #231).
 */
export type ColorLevel = 0 | 1 | 2 | 3

/** The resolved theme: the background, the colour budget, and whether colour is drawn at all. */
export interface TerminalTheme {
  /** The background the syntax theme was chosen for. */
  readonly background: TerminalBackground
  /** False under `NO_COLOR`: every colour is dropped, the layout is not. */
  readonly color: boolean
  /** How much colour the terminal can show: what the band and the panel are drawn with (#231). */
  readonly level: ColorLevel
}

/** The theme every caller gets when nobody said anything: a dark terminal, in full colour. */
export const DEFAULT_THEME: TerminalTheme = { background: 'dark', color: true, level: 3 }

/** The environment variable that turns colour off, by being there at all. */
export const NO_COLOR_ENV = 'NO_COLOR'

/** The environment variable a terminal sets to say what it is: `fg;bg`, as palette indexes. */
export const COLORFGBG_ENV = 'COLORFGBG'

/** The environment variable a terminal sets to say it has more than sixteen colours. */
export const COLORTERM_ENV = 'COLORTERM'

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
    level: detectColorLevel(env),
  }
}

/**
 * How much colour `env` says the terminal can show.
 *
 * `COLORTERM` is the variable every modern terminal sets to say it is 24-bit — `truecolor` and
 * `24bit` are two spellings of one thing, and some terminals write them in caps — and `TERM`'s
 * `-256color` suffix is the older way of saying the palette is the 256 one. Everything else is
 * the sixteen named colours, which `oh` has always drawn with and never had to ask about (X4):
 * a terminal that says nothing gets the named colours and loses only the tints by it.
 *
 * `NO_COLOR` wins over all of it, and is the one answer that is not a budget but an absence:
 * level 0 is "no colour at all", which is what {@link colorEnabled} says too.
 */
export function detectColorLevel(
  env: Record<string, string | undefined> = process.env,
): ColorLevel {
  if (!colorEnabled(env)) return 0

  const colorTerm = env[COLORTERM_ENV]?.trim().toLowerCase()
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return 3

  if (env.TERM?.toLowerCase().includes('256color') === true) return 2

  return 1
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
 * One derived tint, in the two spellings a terminal might be able to mix it in.
 *
 * `ansi256` is an index into the 232-255 gray ramp — `8 + 10 * (index - 232)` of each channel,
 * the twenty-four grays every 256-colour terminal has — so `236` is `#303030` and `254` is
 * `#e4e4e4`. Nothing in the 6×6×6 cube above it is a gray, which is why the ramp is the one
 * that is named here (issue #231).
 */
interface Tint {
  /** The 24-bit value, for a terminal that can mix it (`level` 3). */
  readonly hex: string
  /** The nearest gray of the 232-255 ramp, for one that can mix that (`level` 2). */
  readonly ansi256: number
}

/**
 * The tints the transcript derives from the terminal's background (issue #231).
 *
 * **A band and a panel are not the same shade, and the difference is the point.** On a dark
 * terminal the band is a couple of steps *off* the background — `#2a2b33`, violet-leaning so it
 * sits with the rest of the app — and the panel is a step *toward* black (`#1f2026`), so a code
 * block reads as inset in the page rather than laid on it. On a light terminal both are darker
 * than the page and the panel is the lighter of the two (`#f5f5f8` against `#ececf2`), which is
 * the same "the panel is the quieter surface" the other way up.
 *
 * The 256-colour indexes are the nearest gray of that ramp to each hex, and they keep that
 * relationship: 236 over 235 on dark, 254 under 255 on light.
 */
const TINTS: Readonly<Record<TerminalBackground, Readonly<Record<'band' | 'panel', Tint>>>> = {
  dark: {
    band: { hex: '#2a2b33', ansi256: 236 },
    panel: { hex: '#1f2026', ansi256: 235 },
  },
  light: {
    band: { hex: '#ececf2', ansi256: 254 },
    panel: { hex: '#f5f5f8', ansi256: 255 },
  },
}

/**
 * `tint` in the best spelling this terminal can mix, or nothing at all.
 *
 * The 24-bit value goes to a `level` 3 terminal as a hex string, which Ink hands to chalk and
 * chalk writes as `38;2;…`; the gray index goes to a `level` 2 one as `ansi256(n)`, **not** as
 * the hex a step above, because chalk would downgrade a hex through its own 6×6×6 mapping and
 * land on a colour with a hue in it. Level 1 and 0 cannot mix a gray that is not one of the
 * sixteen, so they get nothing here and the callers fall back to the named colours.
 */
function tintColor(theme: TerminalTheme, tint: Tint): string | undefined {
  if (!theme.color) return undefined
  if (theme.level >= 3) return tint.hex
  if (theme.level === 2) return `ansi256(${tint.ansi256})`
  return undefined
}

/**
 * The band a user's message is drawn on (issues #229, #231).
 *
 * A band rather than a label, because a label is a character and a background is not: nothing
 * in front of the user's words, so selecting them and pasting them gives the words and only
 * the words. The text on it is left at the terminal's default foreground, the one colour
 * guaranteed readable on the background the terminal already chose.
 *
 * **The shade is derived, not named** (#231): bright black is the nearest named colour, and a
 * reader looking at it said the band was "too bright" — the sixteen-colour palette simply has
 * no subtle gray in it. So where the terminal can mix one the band is {@link TINTS}'s, and only
 * a terminal that can mix neither (`level` 0 or 1) keeps the named colour it always had, in the
 * **foreground** spelling Ink's `backgroundColor` prop takes (`blackBright` → `bgBlackBright`).
 * Under `NO_COLOR` there is no band at all — `message-view.tsx` puts a dim `›` above the
 * message instead, which is not colour.
 */
export function messageBand(theme: TerminalTheme): string | undefined {
  if (!theme.color) return undefined
  return tintColor(theme, TINTS[theme.background].band) ?? bandFallback(theme)
}

/**
 * The code block's tinted panel (#231), or nothing where there is no tint to draw it with.
 *
 * `undefined` is the signal `render.ts` reads: a `NO_COLOR` terminal, or one that can mix
 * neither 24-bit nor the 256-colour ramp, gets the label-line fallback instead of a panel,
 * because a panel made of a *named* colour would be the heavy band #231 is about.
 */
export function codePanel(theme: TerminalTheme): string | undefined {
  return tintColor(theme, TINTS[theme.background].panel)
}

/** The band for a terminal with no tints: the named colour `oh` has always drawn it in. */
function bandFallback(theme: TerminalTheme): string {
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
