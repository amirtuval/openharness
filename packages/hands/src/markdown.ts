/**
 * HTML → Markdown: a fetched page as the text a model reads (epic #303, #305).
 *
 * `web_fetch` gets bytes, and bytes are not what a model should be shown: a page is a majority
 * of navigation, script, style and boilerplate around the article a reader came for. So the
 * conversion has two halves, and both are libraries rather than hand-written rules:
 *
 * - **Main content** is [Mozilla's `Readability`](https://github.com/mozilla/readability), the
 *   reader-mode extraction Firefox ships — the same algorithm a browser's reading view uses,
 *   maintained by Mozilla, and a few tens of kilobytes. It is given a DOM built by
 *   [`linkedom`](https://github.com/WebReflection/linkedom), a much smaller DOM implementation
 *   than `jsdom` (no full browser machinery, no dependency tree of its own) — enough for
 *   `Readability` and nothing more.
 * - **Markdown** is [`turndown`](https://github.com/mixmark-io/turndown), the HTML→Markdown
 *   converter that is the de-facto one in the Node ecosystem, with one small runtime dependency
 *   of its own. Its options are set to the shapes a model reads best: ATX headings, fenced code,
 *   inlined links.
 *
 * Both are **data in, data out**: nothing here executes a page, resolves a script or follows a
 * link. What comes back is a string that goes into a tool result, which is where the threat
 * model's rule applies — it is data the model is shown, never an instruction it follows.
 *
 * Two things are done here rather than by a library, because they are about *this* use:
 *
 * - **Script, style and the other non-prose elements are dropped before anything reads the
 *   page.** `turndown` would otherwise emit their text (`<style>`'s rules, a `<script>`'s
 *   source) into the markdown, and `Readability` scores them into its content estimate.
 * - **Relative links are made absolute** against the URL the page was actually fetched from, so
 *   a link a model is shown is one it can fetch — `Readability` resolves against a document URI
 *   this DOM does not have.
 */

import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'

/**
 * Elements whose content is code, styling or chrome rather than prose, removed before anything
 * reads the page.
 *
 * `script` and `style` are the two the issue names; `noscript` and `template` are their
 * equivalents (one holds markup for a browser that runs no script, the other markup no browser
 * renders), and `iframe` and `svg` are not text at all — `turndown` would emit an iframe's
 * fallback or an inline SVG's paths as paragraphs.
 */
const DROPPED_ELEMENTS = ['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas']

/** The link-shaped attributes whose values are resolved against the page's own URL. */
const URL_ATTRIBUTES: readonly (readonly [string, string])[] = [
  ['a', 'href'],
  ['img', 'src'],
  ['source', 'src'],
  ['video', 'src'],
  ['audio', 'src'],
]

/**
 * The converter, built once: `TurndownService` construction installs its rule set, and a page
 * is converted with the same options every time.
 */
const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
})

/** Convert one HTML document to Markdown, with `url` as the address relative links resolve against. */
export function htmlToMarkdown(html: string, url: string): string {
  const { document } = parseHTML(html)
  // `linkedom`'s document is structurally the one `Readability` reads — `querySelectorAll`,
  // `remove`, `getAttribute`, `documentElement` — which is the whole of the interface used here.
  const dom: Document = document
  dropChrome(dom)
  absolutizeUrls(dom, url)
  const article = readMainContent(dom)
  // `Readability` answers `null` for a page it cannot find content in — a bare list, a page
  // that is one table, a document with no text. The stripped document is still the honest
  // answer then: it is the page minus its script and style, which is exactly what asked for
  // markdown means.
  const source = article?.content ?? dom.documentElement?.outerHTML ?? html
  const markdown = turndown.turndown(source).trim()
  const title = article?.title ?? null
  if (title === null || title.length === 0) {
    return markdown
  }
  // The title is the page's own, and `Readability` reads it from `document.title`; it is put
  // back as a heading because the article body does not carry it.
  return `# ${title}\n\n${markdown}`
}

/**
 * The page's main content, or `null` when there is none to find.
 *
 * `Readability` mutates the document it is handed and throws on shapes it cannot score (a
 * malformed tree, a document with no body), so a failure here is a page that could not be
 * extracted rather than a conversion that failed: the caller falls back to the whole document.
 */
function readMainContent(
  dom: Document,
): { content: string | null | undefined; title: string | null | undefined } | null {
  try {
    const article = new Readability(dom).parse()
    if (article === null) {
      return null
    }
    return { content: article.content, title: article.title }
  } catch {
    return null
  }
}

/** Remove every element in {@link DROPPED_ELEMENTS}. */
function dropChrome(dom: Document): void {
  for (const selector of DROPPED_ELEMENTS) {
    for (const element of [...dom.querySelectorAll(selector)]) {
      element.remove()
    }
  }
}

/**
 * Resolve every link-shaped URL against the page's own address, so a relative link in the
 * markdown is one a model can fetch.
 *
 * A value that does not resolve (a `mailto:`, a `javascript:` notice, one already absolute
 * against another scheme) is left exactly as the page wrote it: rewriting what a page said is
 * not this module's business, and a value `URL` refuses is a value a reader can still see.
 */
function absolutizeUrls(dom: Document, url: string): void {
  for (const [selector, attribute] of URL_ATTRIBUTES) {
    for (const element of dom.querySelectorAll(`${selector}[${attribute}]`)) {
      const value = element.getAttribute(attribute)
      if (value === null || value.trim().length === 0) {
        continue
      }
      try {
        element.setAttribute(attribute, new URL(value, url).href)
      } catch {
        // Not a URL this page's address can resolve (a scheme `URL` will not fold, a malformed
        // value); the page's own spelling is kept.
      }
    }
  }
}
