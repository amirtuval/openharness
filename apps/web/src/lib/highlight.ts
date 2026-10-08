import { createHighlighterCore, type HighlighterCore, type LanguageInput } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import { bundledLanguages } from 'shiki/langs'

/**
 * Syntax highlighting for the chat's code blocks (epic #201, #204; U12, #227).
 *
 * Four things make this module what it is:
 *
 * - **It is loaded lazily.** `code-block.tsx` imports it with a dynamic `import()`, and every
 *   grammar, every theme and the wasm engine below are chunks of their own — so none of it is
 *   in the app's main bundle, and the first paint never waits for it. A chat with no code in
 *   it never fetches it at all.
 * - **One highlighter, made once.** {@link highlighter} memoizes `createHighlighterCore`, so
 *   every code block on the page shares one instance instead of one grammar registry each.
 * - **Grammars arrive on demand, one at a time.** {@link grammars} is Shiki's own bundled
 *   set — every language it ships, plus its aliases — and a fence asks for exactly one of
 *   them: the map is a table of `() => import('…')` thunks, so *reading* it costs nothing and
 *   only the grammar a block actually names is ever fetched. Anything else — a label no
 *   grammar claims, a fence still being written — is `null`, and the block renders as plain
 *   text: still readable, still copyable, and no worse off than before this module existed.
 * - **Nothing is inline.** `defaultColor: false` makes Shiki write all three palettes as CSS
 *   variables (`--shiki-light`, `--shiki-dim`, `--shiki-dark` and the `-bg` pair) rather than
 *   painting the first theme into the element's `style`. `index.css` then picks the one the
 *   page is in with `[data-theme]` rules — no `!important`, and a theme switch repaints code
 *   without re-highlighting it.
 *
 * #227 replaced a hand-kept list of fourteen grammars with the bundled set. The promise that
 * mattered — a chat fetches no grammar it does not draw — is kept exactly: `shiki/langs` is a
 * module of thunks (about 30 kB gzip) that lands in *this* chunk, which was already lazy, and
 * the 240-odd grammars behind it are still one chunk each, fetched on the fence that asks.
 * The main bundle does not move at all, which the PR's build output shows.
 */

/** The Shiki theme per app theme (#203). Dim borrows Shiki's own soft dark palette. */
const THEMES = {
  light: 'github-light',
  dim: 'github-dark-dimmed',
  dark: 'github-dark',
} as const

/**
 * Every grammar the chat can highlight, keyed by the id Shiki knows it by — and by the aliases
 * it ships for them.
 *
 * `bundledLanguages` is base ids *and* aliases (`sh` → `shellscript`, `py` → `python`,
 * `rs` → `rust`, `c++` → `cpp`, `tf` → `terraform`, `dockerfile` → `docker`, …), which is
 * exactly the table a fence needs: models write the short form as often as the long one. Each
 * value is a dynamic import, so this map costs a look-up and nothing else; the grammar itself
 * is fetched the first time a block asks for it.
 */
const grammars: Readonly<Record<string, LanguageInput>> = bundledLanguages

/**
 * The handful of fence labels Shiki does not ship an alias for.
 *
 * Short, and short on purpose — an entry here is a label Shiki has no answer for, not a
 * preference. `golang` and `patch` are the two the old hand-kept table carried that the
 * bundled one does not; a language nobody claims still falls back to plain text.
 */
const EXTRA_ALIASES: Readonly<Record<string, string>> = {
  golang: 'go',
  patch: 'diff',
}

/** A token of a highlighted line: its text, and the variables the three themes read. */
export interface HighlightedToken {
  readonly content: string
  /**
   * `--shiki-light`, `--shiki-dim` and `--shiki-dark` for this token. Empty for text a grammar
   * left uncoloured (whitespace), which is what makes the block's own ink apply to it.
   */
  readonly style: Readonly<Record<string, string>>
}

/** A code block, ready to render — highlighted or not. */
export interface HighlightedCode {
  /** The block's lines in order; a blank line is an empty array. */
  readonly lines: readonly (readonly HighlightedToken[])[]
  /**
   * The block's own declarations — the three backgrounds and the three inks — for the wrapper
   * element's `style`. Empty when the block is not highlighted.
   */
  readonly style: Readonly<Record<string, string>>
}

let highlighterPromise: Promise<HighlighterCore> | undefined
const languageLoads = new Map<string, Promise<void>>()

/**
 * The one highlighter, created on first use.
 *
 * No languages are loaded here on purpose: the engine, the themes and the grammars are
 * separate chunks, and the grammars wait for a block that asks for one.
 */
function highlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [
      import('shiki/themes/github-light.mjs'),
      import('shiki/themes/github-dark-dimmed.mjs'),
      import('shiki/themes/github-dark.mjs'),
    ],
    langs: [],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  })
  return highlighterPromise
}

/**
 * The grammar a fence label names, or `undefined` when nothing claims it.
 *
 * Two look-ups, and the order between them is the whole of it: the app's own few aliases first
 * (they exist because Shiki has no answer), then Shiki's bundled table, which already folds
 * every alias it ships onto its grammar.
 */
function grammarFor(label: string): string | undefined {
  const normalised = label.trim().toLowerCase()
  const id = EXTRA_ALIASES[normalised] ?? normalised
  return grammars[id] === undefined ? undefined : id
}

/**
 * Load one grammar, once.
 *
 * The map is what makes a language safe to ask for twice: two code blocks that arrive together
 * with the same fence share the one `loadLanguage` call rather than racing each other into it.
 */
function loadLanguage(shiki: HighlighterCore, id: string): Promise<void> {
  const load = grammars[id]
  if (load === undefined) {
    return Promise.resolve()
  }
  let pending = languageLoads.get(id)
  if (pending === undefined) {
    pending = shiki.loadLanguage(load)
    languageLoads.set(id, pending)
  }
  return pending
}

/**
 * Highlight `code` as `language`, or answer `null` when it cannot be.
 *
 * `null` is the answer for a label no grammar claims and for a grammar that refuses the text,
 * and it is never an error the caller has to handle: a block that cannot be highlighted is
 * drawn as plain text. Highlighting is a decoration, and a reply must render whether or not it
 * can be applied — including the reply that is still arriving, whose fence may not have closed
 * yet.
 */
export async function highlight(code: string, language: string): Promise<HighlightedCode | null> {
  const id = grammarFor(language)
  if (id === undefined) {
    return null
  }

  try {
    const shiki = await highlighter()
    await loadLanguage(shiki, id)

    const result = shiki.codeToTokens(code, {
      lang: id,
      themes: THEMES,
      // Every palette becomes a variable, so no colour is inline and a `[data-theme]` rule is
      // all that stands between a token and the theme the page is in.
      defaultColor: false,
    })

    return {
      lines: result.tokens.map((line) =>
        line.map((token) => ({ content: token.content, style: token.htmlStyle ?? {} })),
      ),
      style: { ...declarations(result.fg ?? ''), ...declarations(result.bg ?? '') },
    }
  } catch {
    // A grammar that will not take this text is not a reason to lose the text.
    return null
  }
}

/**
 * One `style` declaration string as the object React wants.
 *
 * Shiki writes `--shiki-light:#24292e;--shiki-dim:#adbac7;...`, and `defaultColor: false` is
 * what makes every part of it a `name:value` pair — including the first, which is a bare value
 * when that option is off, and which this then skips.
 */
function declarations(style: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon > 0) {
      result[declaration.slice(0, colon)] = declaration.slice(colon + 1)
    }
  }
  return result
}
