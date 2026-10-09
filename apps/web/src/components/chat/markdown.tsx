import { Children, isValidElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { cn } from '../../lib/utils'
import { CodeBlock } from './code-block'

/**
 * The elements an agent message is rendered from.
 *
 * Written out rather than pulled from a typography plugin: the app needs a dozen of them, and
 * the classes here are the whole design. No `rehype-raw`, so raw HTML in a message stays text.
 *
 * It is a module-level constant on purpose. `react-markdown` re-renders the whole document on
 * every streaming delta, and a `components` object rebuilt per render would be a new
 * `pre`/`code`/`p` function every time — i.e. a new element type, so React would unmount and
 * remount the message's whole subtree instead of patching it. Standing still is what lets
 * `CodeBlock`'s `memo` (and the reader's scroll position, and the Copy button's "Copied")
 * survive the next delta.
 *
 * **Streaming is handled by rendering, not by pre-processing the text.** A half-written fence
 * is a code block that ends where the message does — CommonMark closes an unterminated fence
 * at the end of the input — so the reader sees the block forming rather than a stray ``` and
 * a wall of markup that turns into code only once it closes. A half-written `**bold` is the
 * characters that have arrived, which is the same rule: nothing is hidden, nothing is mangled,
 * and the next delta completes it. (A half-written link is the one case where GFM has an
 * opinion of its own: `[the docs](https://ex` leaves the marker text as text and autolinks the
 * address it can see, because that is what the text that arrived says.)
 *
 * A code block is drawn by {@link CodeElement} + the `pre` below, which between them are what
 * turns a fenced block into `code-block.tsx`. See `docs/chat-ui.md` for the streaming and
 * highlighting rules behind it.
 */
const components: Components = {
  p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-link underline underline-offset-2"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => <h3 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  code: CodeElement,
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }) => (
    // A table is a grid: give it a scroll container of its own rather than let a wide one
    // squash the message (and every column in it) narrower than its content — and let the
    // table be **as wide as its content wants** (`min-w-full`, not `w-full`, #212). `w-full`
    // asks for exactly the column's width, which an auto-layout table can only honour by
    // narrowing every column until the cells wrap one word per line, and then overflowing
    // anyway when a cell cannot shrink that far: squashed *and* clipped. `min-w-full` fills
    // the column when the table is narrow and scrolls inside the wrapper above when it is not,
    // which is what the wrapper is for.
    <div className="my-3 overflow-x-auto">
      <table className="w-max min-w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => (
    <td className="border-b border-border/60 px-2 py-1 align-top">{children}</td>
  ),
  pre: ({ children }) => {
    const code = codeElement(children)
    if (code !== null) {
      return <CodeBlock code={code.text} language={code.language} />
    }
    // A `pre` react-markdown did not put a `code` element in. Nothing in markdown produces
    // one — every fenced *and* indented block is a `code` inside a `pre` — so this is the
    // plain wrapper rather than a crash if that ever stops being true.
    return <pre className="my-2 overflow-x-auto rounded-md border bg-muted/50 p-3">{children}</pre>
  },
}

/**
 * The `code` element: a block's code is left for `pre` to draw, everything else is the inline
 * pill.
 *
 * Named rather than written inline because {@link codeElement} recognises it by identity —
 * `react-markdown` hands a `pre` its children as elements whose `type` is the component it
 * will call, which is the only way a `pre` can tell a code block from a `<code>` in a sentence.
 */
function CodeElement({ className, children }: { className?: string; children?: ReactNode }) {
  // `language-…` is remark's name for a fence's info string, and it is what the `pre` reads
  // the language off — so a block's `code` is passed through untouched here, class and all.
  // Inline code, which no `pre` wraps, gets the pill.
  return /^language-/.test(className ?? '') ? (
    <code className={className}>{children}</code>
  ) : (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  )
}

/**
 * The code block behind a `pre`, or `null` when this `pre` does not hold one.
 *
 * To `react-markdown` a fence and an indented block are the same two elements; the only thing
 * that tells them apart is the `language-…` class remark writes from the fence's info string.
 * Both become a {@link CodeBlock}, so an indented block gets the header and the Copy button
 * too and is simply labelled `text` — it is a code block, and it is readable either way.
 *
 * The info string can hold more than the language (````ts title="x"`); the first word is the
 * language, as GitHub reads it.
 */
function codeElement(children: ReactNode): { text: string; language: string | null } | null {
  const elements = Children.toArray(children)
  if (elements.length !== 1) {
    return null
  }
  const element = elements[0]
  if (!isValidElement<{ className?: string; children?: ReactNode }>(element)) {
    return null
  }
  if (element.type !== CodeElement) {
    return null
  }
  const language = /^language-(\S+)/.exec(element.props.className ?? '')?.[1]?.toLowerCase()
  return { text: textOf(element.props.children), language: language ?? null }
}

/** The text a `<code>` element holds, with anything that is not text left out. */
function textOf(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
    .join('')
}

/**
 * Render message text as GitHub-flavored Markdown.
 *
 * **The wrapper wraps.** `break-words` is on the root rather than on each element because
 * `overflow-wrap` is inherited: one rule reaches every paragraph, list item, heading, table
 * cell and inline `<code>` in the message, and none of them can be forgotten. What it fixes is
 * the reply that carries a long unbreakable run — a URL, a hash, a pasted token, a long
 * identifier, all of which a coding assistant emits constantly: without it the run sets the
 * line's width, the line leaves the bubble, and the transcript's scroll container — which is
 * `overflow: auto` on both axes, because a scroll container cannot be `visible` on one and not
 * the other — **clips it at the right edge** (#212). That is the whole of the narrow-screen
 * report: at 400px the same run is a much larger share of the width, so it is where it was
 * noticed, not where it starts.
 *
 * It is `break-word` and not `anywhere`: a word is only broken when it would not fit on a line
 * of its own, and — the part that matters — the *intrinsic* width of the text is unchanged, so
 * a short message's bubble is still as small as its words. Code blocks opt out explicitly
 * (`break-normal` on the `pre`) and keep scrolling inside themselves.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div
      data-slot="markdown"
      className={cn('min-w-0 text-sm break-words text-foreground', className)}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
