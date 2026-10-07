import { Check, Copy } from 'lucide-react'
import { Fragment, memo, useEffect, useRef, useState } from 'react'

import type { HighlightedCode } from '../../lib/highlight'
import { Button } from '../ui/button'

/**
 * A fenced code block: its language, a Copy button, and the code itself, highlighted (epic
 * #201, #204).
 *
 * The highlighting is behind `src/lib/highlight.ts`, which is imported **dynamically** — so
 * Shiki, its themes, the wasm engine and the grammars are not in the app's main bundle and a
 * chat with no code never fetches them. Everything between the dynamic import and the tokens
 * is {@link useHighlighted}: plain text while the first load is in flight, plain text forever
 * for a language the chat does not ship, and tokens once they match the text on screen.
 *
 * {@link CodeBlock} is `memo`'d on `(code, language)` for the streaming case. A delta
 * re-renders the whole message, which re-renders this component's element — but a block that
 * has already finished gets the same two strings back, so it is not re-rendered and its code
 * is not re-tokenized. Only the block the reply is still writing pays for anything.
 */

/** How long the Copy button says "Copied". */
const COPIED_MS = 1500

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
}: {
  /** The block's text, exactly as the fence held it. */
  code: string
  /** The fence's language label, lowercased — `ts`, `bash`, `python` — or `null` for a fence with none. */
  language: string | null
}) {
  const highlighted = useHighlighted(code, language)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(copiedTimer.current), [])

  async function copy() {
    if (!(await writeToClipboard(code))) {
      return
    }
    setCopied(true)
    window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => {
      setCopied(false)
    }, COPIED_MS)
  }

  return (
    <div
      data-slot="code-block"
      data-language={language ?? 'text'}
      className="my-3 overflow-hidden rounded-md border border-border text-xs"
      // The three palettes Shiki wrote as variables, so `index.css` can paint the right one
      // for the theme without this component knowing which theme is on.
      style={highlighted.style}
    >
      <div
        data-slot="code-header"
        className="flex items-center justify-between gap-2 border-b border-border bg-black/5 py-0.5 pr-1 pl-3 dark:bg-white/10"
      >
        <span data-slot="code-language" className="font-mono text-[0.7rem] text-muted-foreground">
          {language ?? 'text'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-slot="code-copy"
          className="text-muted-foreground"
          onClick={() => {
            void copy()
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {/* `white-space: pre` is the `<pre>` default and the reason a long line scrolls here
          instead of wrapping into the message. */}
      <pre className="overflow-x-auto px-3 py-2.5 font-mono leading-relaxed">
        <code>
          {highlighted.lines.map((line, lineIndex) => (
            // A line is its index: the sixth line of a block is the sixth line of a block.
            <Fragment key={lineIndex}>
              {lineIndex === 0 ? null : '\n'}
              {line.map((token, tokenIndex) => (
                // Likewise a token: its place in the line is what it is. The style is the
                // `--shiki-*` variables for that token — empty when the grammar left it plain.
                <span key={tokenIndex} data-slot="code-token" style={token.style}>
                  {token.content}
                </span>
              ))}
            </Fragment>
          ))}
        </code>
      </pre>
    </div>
  )
})

/**
 * Highlight `code`, in the shape the block renders.
 *
 * The answer is always one of two things, and both are {@link HighlightedCode}, so the block
 * renders the same tree either way and React patches it rather than replacing it:
 *
 * - the tokens, once they are **of this exact text** — which is what keeps a streaming block
 *   from painting the previous delta's tokens under the current delta's text;
 * - {@link plainCode} otherwise: before the first highlight resolves, for a language the chat
 *   does not ship, for a grammar that refused the text, and for the deltas in between.
 */
function useHighlighted(code: string, language: string | null): HighlightedCode {
  const [highlighted, setHighlighted] = useState<{ code: string; tokens: HighlightedCode } | null>(
    null,
  )

  useEffect(() => {
    if (language === null) {
      return
    }
    let cancelled = false
    // The dynamic import is what keeps the highlighter out of the main bundle; the `??=`
    // makes every block after the first reuse the one module instance.
    highlightModule ??= import('../../lib/highlight')
    void highlightModule
      .then(({ highlight }) => highlight(code, language))
      .then((tokens) => {
        if (!cancelled && tokens !== null) {
          setHighlighted({ code, tokens })
        }
      })
      .catch(() => {
        // A chunk that will not load leaves the block in plain text, which is not an error
        // anyone reading the chat can do anything about.
      })
    return () => {
      cancelled = true
    }
  }, [code, language])

  return highlighted?.code === code ? highlighted.tokens : plainCode(code)
}

/** The highlighter module itself, once — the dynamic import every block shares. */
let highlightModule:
  | Promise<{
      highlight: (code: string, language: string) => Promise<HighlightedCode | null>
    }>
  | undefined

/** The block's text as the shape above, with no colours on it. */
function plainCode(code: string): HighlightedCode {
  return {
    lines: code.split('\n').map((line) => (line === '' ? [] : [{ content: line, style: {} }])),
    style: {},
  }
}

/**
 * Put `text` on the clipboard and answer whether it worked.
 *
 * The async clipboard API needs a secure context, and a browser that will not give it one (a
 * refused permission, a plain-http origin) is not something to explain in a chat message — the
 * button simply does not claim to have copied.
 */
async function writeToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
