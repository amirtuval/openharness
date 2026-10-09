import type { Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

/**
 * The Markdown parser, and the one thing it is asked: `text` in, a tree out.
 *
 * It is the same family the web app renders with (`react-markdown` is `remark` + `rehype`)
 * and the same CommonMark it follows, so a reply reads the same on both clients — with
 * GitHub's extensions (tables, strikethrough, task lists, autolinks) on both sides too, which
 * is why the plugin is `remark-gfm` here as well. It parses to mdast and stops there: the
 * rendering is the terminal's problem, and `rehype` (HTML) has no part in it.
 *
 * Built once, at module load. A processor is a pipeline, and this one has no state to keep
 * between documents: building it per message would recompile micromark's extensions for every
 * streamed delta.
 */
const processor = unified().use(remarkParse).use(remarkGfm)

/**
 * A reply, as a document.
 *
 * **Nothing throws, and nothing is escaped.** A reply is Markdown even when it is half a
 * Markdown document — a fence that has not been closed yet, a `|` table with no rows — and the
 * parser is built for exactly that: an unterminated fence is a code block that ends at the end
 * of the text, which is what makes a streaming reply render as it arrives (X2). The text is
 * never quoted or escaped first: a message that begins with `#` **is** a heading, which is the
 * point of rendering Markdown at all.
 */
export function parseMarkdown(text: string): Root {
  return processor.parse(text)
}
