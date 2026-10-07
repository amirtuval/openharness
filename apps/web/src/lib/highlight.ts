import { createHighlighterCore, type HighlighterCore, type LanguageInput } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

/**
 * Syntax highlighting for the chat's code blocks (epic #201, #204).
 *
 * Four things make this module what it is:
 *
 * - **It is loaded lazily.** `code-block.tsx` imports it with a dynamic `import()`, and every
 *   grammar, every theme and the wasm engine below are chunks of their own — so none of it is
 *   in the app's main bundle, and the first paint never waits for it. A chat with no code in
 *   it never fetches it at all.
 * - **One highlighter, made once.** {@link highlighter} memoizes `createHighlighterCore`, so
 *   every code block on the page shares one instance instead of one grammar registry each.
 * - **Grammars arrive on demand, one at a time.** {@link LANGUAGES} is the whole set the chat
 *   highlights; a fence asks for one of them and only that grammar is fetched, once, through
 *   `loadLanguage`. Anything else — an unshipped language, a label we do not know, a fence
 *   that is still being written — is `null`, and the block renders as plain text: still
 *   readable, still copyable, and no worse off than before this module existed.
 * - **Nothing is inline.** `defaultColor: false` makes Shiki write all three palettes as CSS
 *   variables (`--shiki-light`, `--shiki-dim`, `--shiki-dark` and the `-bg` pair) rather than
 *   painting the first theme into the element's `style`. `index.css` then picks the one the
 *   page is in with `[data-theme]` rules — no `!important`, and a theme switch repaints code
 *   without re-highlighting it.
 */

/** The Shiki theme per app theme (#203). Dim borrows Shiki's own soft dark palette. */
const THEMES = {
  light: 'github-light',
  dim: 'github-dark-dimmed',
  dark: 'github-dark',
} as const

/**
 * The languages a fence is highlighted in, keyed by the id Shiki knows them by, each its own
 * lazy chunk.
 *
 * Deliberately short: a chat highlights what people paste and what models write, and every
 * entry costs a grammar in the build. A language that is not here is not a failure — the block
 * falls back to plain text.
 */
const LANGUAGES: Record<string, LanguageInput> = {
  bash: () => import('shiki/langs/bash.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
}

/**
 * The fence labels that name one of {@link LANGUAGES}.
 *
 * Models write `ts`, `js`, `py`, `sh` as often as the full names, and a fence nobody wrote a
 * language for is common enough that there is no entry for it — the block simply goes
 * unhighlighted.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  css: 'css',
  diff: 'diff',
  patch: 'diff',
  go: 'go',
  golang: 'go',
  html: 'html',
  javascript: 'javascript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  json: 'json',
  jsx: 'jsx',
  markdown: 'markdown',
  md: 'markdown',
  python: 'python',
  py: 'python',
  sql: 'sql',
  tsx: 'tsx',
  typescript: 'typescript',
  ts: 'typescript',
  yaml: 'yaml',
  yml: 'yaml',
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
 * Load one grammar, once.
 *
 * The map is what makes a language safe to ask for twice: two code blocks that arrive together
 * with the same fence share the one `loadLanguage` call rather than racing each other into it.
 */
function loadLanguage(shiki: HighlighterCore, id: string): Promise<void> {
  const load = LANGUAGES[id]
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
 * `null` is the answer for a language the chat does not ship and for a grammar that refuses
 * the text, and it is never an error the caller has to handle: a block that cannot be
 * highlighted is drawn as plain text. Highlighting is a decoration, and a reply must render
 * whether or not it can be applied — including the reply that is still arriving, whose fence
 * may not have closed yet.
 */
export async function highlight(code: string, language: string): Promise<HighlightedCode | null> {
  const id = LANGUAGE_ALIASES[language.trim().toLowerCase()]
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
