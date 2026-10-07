import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

import type { Line, Span } from './text'
import { syntaxColor, type TerminalTheme } from './theme'

/**
 * Syntax highlighting for a fenced code block, as spans.
 *
 * **Why `highlight.js`.** The three candidates were Shiki (ANSI output), `cli-highlight`, and
 * this. Shiki's own ANSI output is the nicest, and Shiki is by far the largest: its grammars
 * and Oniguruma engine run to tens of megabytes, and this package is published as a single
 * self-contained `dist/index.js` **with no runtime dependencies** — every byte a grammar takes
 * is a byte every `npm i -g @openh/cli` downloads, for a chat client. `cli-highlight` is the
 * small one, but it hands back a string full of escape sequences, and a message is laid out
 * here as spans (see `text.ts`): the wrapper, the table renderer and the code frame all
 * measure and cut text, and measuring text that already contains colour means parsing it back
 * apart. `highlight.js` is the middle path — small, tokenises to class names, and the escape
 * sequences are ours to place.
 *
 * **Only some languages ship.** The full `highlight.js` bundle carries ~190 of them; each one
 * is registered here only if a chat reply plausibly contains it. An unknown language — or a
 * fence with no language at all — is shown as plain code, which is the honest answer: guessing
 * from the content (`highlightAuto`) mis-colours more than it gets right on short snippets.
 */
const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  python,
  ruby,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
}

for (const [name, language] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, language)
}

/** The languages a fence can name and still be coloured, for the docs and the tests. */
export const HIGHLIGHTED_LANGUAGES: readonly string[] = Object.keys(LANGUAGES)

/**
 * The opening tag of a coloured run, matched at the current position (`y`, not `g`).
 *
 * A scope can be two classes — `hljs-title class_`, `hljs-title function_` — where the second
 * is the CSS hook that keeps `title` reusable, so only the first word is the scope.
 */
const OPEN_SPAN = /<span class="hljs-([^\s"]+)[^"]*">/y

/** The tag that closes one. */
const CLOSE_SPAN = '</span>'

/** The entities `highlight.js` writes into its output. */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function unescapeHtml(text: string): string {
  return text.replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/gu,
    (whole, hex, decimal, name) => {
      if (typeof hex === 'string') return String.fromCodePoint(Number.parseInt(hex, 16))
      if (typeof decimal === 'string') return String.fromCodePoint(Number.parseInt(decimal, 10))
      return ENTITIES[String(name)] ?? whole
    },
  )
}

/**
 * The language a fence asked for, as `highlight.js` knows it, or nothing.
 *
 * A fence's info string is more than a name — `ts title="x.ts"`, `python {1,3}` — so only its
 * first word counts, and `highlight.js` answers for a language's aliases (`ts`, `py`, `sh`)
 * because registering a language registers them too.
 */
function resolveLanguage(language: string | undefined): string | undefined {
  const name = language
    ?.trim()
    .split(/[\s,{]/u)[0]
    ?.toLowerCase()
  if (name === undefined || name === '') return undefined
  return hljs.getLanguage(name) === undefined ? undefined : name
}

/** A code block nobody is colouring: the lines, as they were written. */
function plainLines(code: string): Line[] {
  return code.split('\n').map((line) => (line === '' ? [] : [{ text: line }]))
}

/** Cut styled spans into lines, keeping each span's style on both sides of a newline. */
function toLines(spans: readonly Span[]): Line[] {
  const lines: Span[][] = [[]]
  for (const span of spans) {
    span.text.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([])
      if (part !== '') lines[lines.length - 1]?.push({ ...span, text: part })
    })
  }
  return lines
}

/**
 * `code` as one line of spans per source line, coloured for `theme`.
 *
 * The lines come back unwrapped — a long line is still a long line — because only the code
 * block's frame knows how much room it has and how far in it starts.
 *
 * A snippet that is still arriving is highlighted like any other, which is what makes a
 * streaming fence readable while it streams: `ignoreIllegals` keeps half a keyword, or an
 * unterminated string, from being an error, and a language that throws anyway (a grammar
 * choking on something pathological) falls back to the plain text rather than failing the
 * turn — a colouring problem must never be a chat that stops.
 */
export function highlightCode(
  code: string,
  language: string | undefined,
  theme: TerminalTheme,
): Line[] {
  const name = resolveLanguage(language)
  if (name === undefined) return plainLines(code)

  let html: string
  try {
    html = hljs.highlight(code, { language: name, ignoreIllegals: true }).value
  } catch {
    return plainLines(code)
  }

  return toLines(spansFromHtml(html, theme))
}

/**
 * `highlight.js`'s output — `<span class="hljs-keyword">const</span> x` — as spans.
 *
 * It is a scan with a stack rather than a regular expression, because the spans **nest**:
 * a function's parameter list is one `hljs-params` run with a `hljs-title class_` span inside
 * it for the type, and the type is the colour a reader wants. Matching each span pairwise
 * takes the inner `</span>` for the outer one's end and the rest of the block falls out as
 * literal markup — which is exactly the bug this replaced.
 */
function spansFromHtml(html: string, theme: TerminalTheme): Span[] {
  const spans: Span[] = []
  const open: string[] = []
  let offset = 0

  const push = (text: string): void => {
    if (text === '') return
    const scope = open[open.length - 1]
    const color = scope === undefined ? undefined : syntaxColor(theme, scope)
    spans.push(color === undefined ? { text } : { text, color })
  }

  while (offset < html.length) {
    if (html.startsWith(CLOSE_SPAN, offset)) {
      open.pop()
      offset += CLOSE_SPAN.length
      continue
    }

    OPEN_SPAN.lastIndex = offset
    const opened = OPEN_SPAN.exec(html)
    if (opened !== null) {
      offset = OPEN_SPAN.lastIndex
      // The innermost scope is the colour; the one around it is what the run sits in.
      if (opened[1] !== undefined) open.push(opened[1])
      continue
    }

    if (html[offset] === '<') {
      // A `<` that opens no tag: text, one character of it. `highlight.js` escapes every one
      // that came from the code, so this is a shape it did not write — shown, not dropped.
      push('<')
      offset += 1
      continue
    }

    // Everything up to the next `<` is text, in the colour of the scope it is inside.
    const end = html.indexOf('<', offset)
    push(unescapeHtml(html.slice(offset, end === -1 ? html.length : end)))
    offset = end === -1 ? html.length : end
  }

  return spans
}
