/**
 * HTML → Markdown: a fetched page as the text a model reads (epic #303, #305).
 *
 * `web_fetch` gets bytes, and bytes are not what a model should be shown: a page is a majority
 * of navigation, script, style and boilerplate around the content a reader came for. So the
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
 * Five things are done here rather than by a library, because they are about *this* use:
 *
 * - **Chrome is dropped before anything reads the page.** `script`, `style`, `noscript`,
 *   `template`, `iframe`, `svg` and `canvas` are removed because `turndown` would otherwise emit
 *   their text (`<style>`'s rules, a `<script>`'s source, an inline SVG's paths) and
 *   `Readability` would score them into its content estimate. The page's **structural chrome** is
 *   removed for the same reason: `nav`, `header`, `footer`, `aside`, `dialog` and `form`, and the
 *   ARIA landmark roles that name the same regions (`banner`, `navigation`, `contentinfo`,
 *   `complementary`, `search`), plus modal overlays (`role=dialog`, `aria-modal`). A consent or
 *   cookie banner is a container the page names as one — a class or id whose words are
 *   `cookie`/`consent`/`gdpr`, matched whole so a page *about* cookies is not mistaken for one —
 *   and nothing here depends on a single site's markup.
 * - **A page with no article still gets its content.** `Readability` is tuned for one article: a
 *   news homepage whose "content" is a list of headlines can make it answer `null`, or answer a
 *   small wrong node (a byline list, a teaser). When the article it found is missing, or is under
 *   a quarter of the document's own text, {@link selectContent} runs a second, honest pass that
 *   keeps the headline/teaser shape — headings, the links inside or around them, teasers, lists
 *   and captioned images, in document order — rather than handing back the whole stripped
 *   document. Menus and link bars are left out, and the masthead above the first real content is
 *   skipped, so what leads is a headline and not a nav bar or a logo.
 * - **Relative links are made absolute** against the URL the page was actually fetched from, so
 *   a link a model is shown is one it can fetch — `Readability` resolves against a document URI
 *   this DOM does not have.
 * - **The shapes that would convert to stray punctuation are normalized** before anything reads
 *   the tree: an anchor wrapping a block (a news card is one `<a>` around a whole headline and
 *   teaser) has its link pushed down into each block, so the output reads `# [Headline](href)`
 *   instead of an orphan `[` with its `](href)` far below, and an anchor with nothing readable in
 *   it (an icon button, an image with no `src`) is dropped, so no `[]()` is emitted.
 * - **The page's own `<title>` is put back as a heading** when `Readability` read one, because
 *   the article body does not carry it.
 */

import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'

/**
 * Elements whose content is code, styling or chrome rather than prose, removed before anything
 * reads the page.
 *
 * `script` and `style` are the two the issue names (and a `<script type="application/ld+json">`
 * is a `<script>`, so its inline JSON goes with them); `noscript` and `template` are their
 * equivalents (one holds markup for a browser that runs no script, the other markup no browser
 * renders), and `iframe`, `svg` and `canvas` are not text at all — `turndown` would emit an
 * iframe's fallback, an inline SVG's paths or a canvas's fallback as paragraphs.
 */
const DROPPED_ELEMENTS = ['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas']

/**
 * The page's structural chrome, by tag and by the ARIA landmark role that names the same region.
 *
 * A page marks its navigation with `<nav>` or `role="navigation"`, its banner with `<header>` or
 * `role="banner"`, its footer with `<footer>` or `role="contentinfo"`, a sidebar with `<aside>`
 * or `role="complementary"`, a search box with `role="search"`. A modal overlay — a cookie
 * banner, a sign-up prompt, a lightbox — is a `<dialog>`, `role="dialog"` or `aria-modal`. These
 * are the page's *own* claims about which parts are not the content, which is the principled
 * rule this uses: no class-name guessing for menus and footers.
 */
const CHROME_SELECTORS = [
  'nav',
  'header',
  'footer',
  'aside',
  'dialog',
  'form',
  '[role=banner]',
  '[role=navigation]',
  '[role=contentinfo]',
  '[role=complementary]',
  '[role=search]',
  '[role=dialog]',
  '[aria-modal=true]',
]

/**
 * The consent/cookie-banner containers a page names as one, looked up cheaply by substring and
 * then filtered by {@link isConsentChrome} so the substring alone never decides.
 *
 * `[class*=cookie i]` matches a class like `mycookierecipe` too, which is why the substring only
 * narrows the search and the whole word decides.
 */
const CONSENT_CANDIDATES = [
  '[class*=cookie i]',
  '[class*=consent i]',
  '[class*=gdpr i]',
  '[id*=cookie i]',
  '[id*=consent i]',
  '[id*=gdpr i]',
].join(',')

/** The whole words a consent banner's class or id is built from, plus the tools that name one. */
const CONSENT_WORDS = new Set(['cookie', 'cookies', 'consent', 'gdpr', 'onetrust'])

/**
 * A consent banner written as one word (`cookieconsent`, `cookiebanner`, `gdprnotice`), which
 * splitting on separators leaves whole.
 */
const CONSENT_JOINED =
  /^(cookie|consent|gdpr)(banner|notice|message|popup|modal|dialog|bar|box|overlay|wrapper|container|policy|alert)?$/

/** Elements that carry content a reader came for: headings, paragraphs, links, captioned images. */
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

/**
 * The shortest anchor text that counts as a headline rather than a menu word.
 *
 * A headline link — a story title, a teaser — is a phrase; a nav link is a word or two (`Home`,
 * `Log in`, `More`). Eight characters keeps `comments` out and a real headline in.
 */
const MIN_LINK_TEXT = 8

/**
 * How small `Readability`'s answer may be, as a fraction of the document's own text, before
 * {@link selectContent} takes over.
 *
 * A quarter: a real article is normally the bulk of the visible text once script, style and
 * chrome are gone, while a wrong node on a headline homepage is a few percent — the failure this
 * exists for is a news homepage where `Readability` picks a byline list about 16% of the page's
 * text instead of the content. A page whose article is genuinely smaller than a quarter of what a
 * reader sees (a huge comment thread around a short post) falls back too, which is the right
 * answer: the fallback keeps its paragraphs anyway. The measure is relative, not an absolute
 * floor, so a small page and a large one are judged the same way and a short real article keeps
 * `Readability`'s own clean extraction and its title.
 */
const ARTICLE_TEXT_RATIO = 0.25

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
  dropConsentChrome(dom)
  absolutizeUrls(dom, url)
  normalizeMarkup(dom)

  const documentText = textLength(dom.documentElement?.textContent)
  const article = readMainContent(dom)
  // `Readability`'s answer is trusted when it is a real share of the page's text — or when the
  // page had no text to compare against and the answer is not empty.
  const articleIsMain =
    article !== null &&
    (documentText === 0
      ? article.content.length > 0
      : article.text >= ARTICLE_TEXT_RATIO * documentText)
  if (article !== null && articleIsMain) {
    return render(article.content, article.title)
  }

  // `Readability` answered nothing usable for this page. The heuristic pass is the answer: the
  // page's own doc-shaped content — headlines and the links that carry them, teasers, images —
  // in document order, without the menus and chrome a whole-document fallback would keep.
  const fallback = selectContent(dom)
  if (fallback.length === 0 && article !== null && article.content.length > 0) {
    // The fallback found nothing either (a page of bare divs and images); `Readability`'s own
    // node, however small, is the honest answer then.
    return render(article.content, article.title)
  }
  return render(fallback, null)
}

/** What {@link readMainContent} read: the article's HTML, its title, and the text length of its body. */
interface MainContent {
  readonly content: string
  readonly title: string | null
  readonly text: number
}

/**
 * The page's main content, or `null` when there is none to find.
 *
 * `Readability` mutates the document it is handed and throws on shapes it cannot score (a
 * malformed tree, a document with no body), so it is handed a **clone**: the caller still needs
 * the whole cleaned document for {@link selectContent}, and a failure here is a page that could
 * not be extracted rather than a conversion that failed.
 */
function readMainContent(dom: Document): MainContent | null {
  try {
    const article = new Readability(dom.cloneNode(true) as Document).parse()
    if (article === null) {
      return null
    }
    return {
      content: article.content ?? '',
      title: article.title ?? null,
      text: textLength(article.textContent),
    }
  } catch {
    return null
  }
}

/**
 * The content a page without a readable article still has: its headings, the links that carry
 * its headlines, its short paragraphs and its captioned images, in document order.
 *
 * It walks the cleaned body and keeps the first element at or above each content node, so a
 * headline inside a link is kept once (the link, with the headline in it) and never twice, and
 * a menu — a list of short links with no prose — is skipped whole. What comes out is a small
 * document the converter turns into Markdown. When the page has no such content the answer is
 * the empty string, which the caller reads as "nothing here".
 */
function selectContent(dom: Document): string {
  // A page normally has a `<body>` and it is the content; a bare fragment parsed on its own puts
  // its content directly under `documentElement` with an empty `<body>` beside it, so an empty
  // `<body>` is not the answer.
  const root = dom.body !== null && dom.body.children.length > 0 ? dom.body : dom.documentElement
  if (root === null) {
    return ''
  }
  const container = dom.createElement('div')
  collectContent(root, container, { started: false })
  return container.innerHTML
}

/**
 * Walk `root`'s element children, appending each content node to `out` and descending elsewhere.
 *
 * `state.started` tracks whether any real content has been kept yet: until it has, a content
 * node that is only furniture — a logo image, a one-word utility link — is skipped rather than
 * kept, so a page's masthead does not lead the answer. Once the first real content is found,
 * everything after it is kept as it comes.
 */
function collectContent(root: Element, out: Element, state: { started: boolean }): void {
  for (const child of Array.from(root.children)) {
    if (isMenuList(child) || isLinkBar(child)) {
      continue
    }
    if (isContentElement(child)) {
      if (!state.started && !isLeadContent(child)) {
        continue
      }
      state.started = true
      out.appendChild(child)
      continue
    }
    collectContent(child, out, state)
  }
}

/**
 * The shortest anchor text that starts the content when it is the first thing on the page.
 *
 * A headline is a phrase and a utility link is a word or two, so a link this long is treated as
 * the page's first real content and everything before it as masthead. A link with a heading in
 * it qualifies however short it is — that is a headline by its own markup.
 */
const LEAD_LINK_MIN = 25

/**
 * Whether a content node is substantial enough to be the page's first kept content rather than
 * part of the masthead above it: a heading, a paragraph, a quote/figure/pre, or a link that
 * carries a heading or is headline-length.
 */
function isLeadContent(element: Element): boolean {
  const tag = element.tagName.toLowerCase()
  if (HEADING_TAGS.has(tag) || tag === 'p' || tag === 'blockquote' || tag === 'pre') {
    return true
  }
  if (tag === 'figure') {
    return textLength(element.textContent) > 0
  }
  if (tag === 'a') {
    return (
      element.querySelector('h1, h2, h3, h4, h5, h6, p') !== null ||
      textLength(element.textContent) >= LEAD_LINK_MIN
    )
  }
  return false
}

/**
 * Whether an element is content a reader came for rather than structure around it.
 *
 * A heading with text, a paragraph with text (short ones included — a teaser is a paragraph), a
 * blockquote/pre/figure, an image the page gave an `alt` (a tracking pixel has none), or a link
 * whose text is a phrase rather than a menu word — or a link that wraps a captioned image, which
 * is how a headline card is often built.
 */
function isContentElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase()
  if (HEADING_TAGS.has(tag)) {
    return textLength(element.textContent) > 0
  }
  if (tag === 'p') {
    return textLength(element.textContent) > 0
  }
  if (tag === 'blockquote' || tag === 'pre' || tag === 'figure') {
    return textLength(element.textContent) > 0 || element.querySelector('img') !== null
  }
  if (tag === 'ul' || tag === 'ol') {
    // A list that reached here is not a menu ({@link isMenuList} is checked first); it is a list
    // of content — steps, points, a block of headlines — and is kept whole.
    return textLength(element.textContent) > 0
  }
  if (tag === 'img') {
    return (element.getAttribute('alt') ?? '').trim().length > 0
  }
  if (tag === 'a') {
    if (textLength(element.textContent) >= MIN_LINK_TEXT) {
      return true
    }
    const image = element.querySelector('img[alt]')
    return image !== null && (image.getAttribute('alt') ?? '').trim().length > 0
  }
  return false
}

/**
 * Whether a list is a menu: several items that are each a short link, and no prose.
 *
 * A headline list — the content of a news homepage — carries long link text or a heading, so it
 * is not one; a navigation list is items like "Home", "News", "Sport".
 */
function isMenuList(element: Element): boolean {
  const tag = element.tagName.toLowerCase()
  if (tag !== 'ul' && tag !== 'ol') {
    return false
  }
  const items = Array.from(element.children).filter((child) => child.tagName.toLowerCase() === 'li')
  if (items.length < 2) {
    return false
  }
  if (element.querySelector('h1, h2, h3, h4, h5, h6, p') !== null) {
    return false
  }
  const shortLinks = items.filter(
    (item) => textLength(item.textContent) < 40 && item.querySelector('a') !== null,
  ).length
  return shortLinks >= Math.ceil(items.length * 0.6)
}

/**
 * Whether an element is a bar of links — a toolbar, a utility strip, a category strip — rather
 * than content.
 *
 * It is the menu-list rule widened from a list to any container: several links, essentially all
 * of the element's (short) text inside them, and no prose at all (no heading, paragraph,
 * quote, figure or pre). A page's top bar is like this; a block of headlines is not, because a
 * headline block carries a heading or a teaser paragraph, and its text is not just link text.
 * Like {@link isMenuList} this is the page's *shape*, not its class names.
 */
function isLinkBar(element: Element): boolean {
  const links = Array.from(element.querySelectorAll('a'))
  if (links.length < 3) {
    return false
  }
  if (element.querySelector('h1, h2, h3, h4, h5, h6, p, blockquote, figure, pre') !== null) {
    return false
  }
  const text = textLength(element.textContent)
  if (text === 0 || text > MAX_LINK_BAR_TEXT) {
    return false
  }
  const inLinks = links.reduce((sum, link) => sum + textLength(link.textContent), 0)
  return inLinks >= text * LINK_BAR_RATIO
}

/** The most text a link bar may hold; more than this is a block of headlines rather than a strip. */
const MAX_LINK_BAR_TEXT = 300

/** The share of a link bar's text that must be inside its links for it to count as one. */
const LINK_BAR_RATIO = 0.8

/** The Markdown of one source, with the page's title as a leading heading when there is one. */
function render(source: string, title: string | null | undefined): string {
  const markdown = turndown.turndown(source).trim()
  if (title === null || title === undefined || title.length === 0) {
    return markdown
  }
  // The title is the page's own, and `Readability` reads it from `document.title`; it is put
  // back as a heading because the article body does not carry it.
  return `# ${title}\n\n${markdown}`
}

/** Remove every element in {@link DROPPED_ELEMENTS} and every {@link CHROME_SELECTORS} match. */
function dropChrome(dom: Document): void {
  for (const selector of [...DROPPED_ELEMENTS, ...CHROME_SELECTORS]) {
    for (const element of [...dom.querySelectorAll(selector)]) {
      element.remove()
    }
  }
}

/**
 * Remove every consent/cookie banner, by the whole words the page named it with.
 *
 * The candidates come from a substring lookup ({@link CONSENT_CANDIDATES}) so the walk is small;
 * {@link isConsentChrome} then keeps only containers whose class or id is genuinely built from a
 * consent word — `cookie-banner`, `cookie_consent`, `gdpr-notice`, `onetrust` — and leaves a page
 * that merely mentions cookies (a class like `mycookierecipe`) alone.
 */
function dropConsentChrome(dom: Document): void {
  for (const element of [...dom.querySelectorAll(CONSENT_CANDIDATES)]) {
    if (isConsentChrome(element)) {
      element.remove()
    }
  }
}

/** Whether an element's class or id names it a consent/cookie banner. */
function isConsentChrome(element: Element): boolean {
  const raw = `${element.getAttribute('class') ?? ''} ${element.getAttribute('id') ?? ''}`
  if (raw.trim().length === 0) {
    return false
  }
  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => word.length > 0 && (CONSENT_WORDS.has(word) || CONSENT_JOINED.test(word)))
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

/**
 * The tags that make an element a block: content that the converter writes on its own line(s).
 *
 * Used by {@link reflowBlockLinks} to find the leaf blocks a link that wraps a whole block has to
 * be pushed down into. `li` is here so a link over a list pushes into each item; `hr` is not,
 * because it carries no content to carry a link.
 */
const BLOCK_SELECTOR =
  'address,article,aside,blockquote,dd,details,div,dl,dt,fieldset,figcaption,figure,' +
  'h1,h2,h3,h4,h5,h6,header,li,main,nav,ol,p,pre,section,summary,table,ul'

/**
 * Normalize the shapes `turndown` renders as stray Markdown punctuation, before anything reads
 * the tree.
 *
 * Two page patterns produce those artifacts, and neither is the string's fault — so they are
 * fixed on the DOM rather than by trimming the output:
 *
 * - **An anchor that wraps block content.** A news card is often one `<a>` around a whole
 *   story: `<a href="…"><h1>Headline</h1><p>Teaser</p></a>`. The inlined-link rule renders that
 *   as `[` + the converted block (`# Headline`) + `](href)` — an orphan `[` at the very start
 *   and its `](url)` far below. {@link reflowBlockLinks} moves the link inside each block
 *   instead, so it becomes `# [Headline](href)`, which is what the page meant.
 * - **An anchor with nothing readable in it.** An icon button — Hacker News's upvote arrow, a
 *   site-search magnifier — is an `<a>` wrapping an empty `<span>`; the link rule renders the
 *   empty anchor as `[](href)`. {@link dropEmptyElements} drops such an anchor (and an image
 *   with no `src`), so nothing empty reaches the converter.
 */
function normalizeMarkup(dom: Document): void {
  dropEmptyElements(dom)
  reflowBlockLinks(dom)
}

/**
 * Remove the elements that would convert to nothing but punctuation: a link with no readable
 * content, and an image that says nothing.
 *
 * An anchor is readable when it has text or wraps an image with a `src`; anything else (an empty
 * `<a>`, one holding only a decorative `<span>`) is an icon rather than a link and is dropped, so
 * no `[]()` is emitted. An `<img>` is readable when it has a source *and* an `alt`: with no
 * `src`, or with no `alt`, it converts to `![]()`/`![](src)` — a URL fragment that shows a reader
 * nothing — so a tracker pixel (Hacker News's spacer `s.gif`) and an undescribed decoration both
 * go. An image with `alt` text is kept, which is the same rule the fallback's
 * {@link isContentElement} uses.
 */
function dropEmptyElements(dom: Document): void {
  for (const anchor of [...dom.querySelectorAll('a')]) {
    if (!hasReadableContent(anchor)) {
      anchor.remove()
    }
  }
  for (const image of [...dom.querySelectorAll('img')]) {
    const src = (image.getAttribute('src') ?? '').trim()
    const alt = (image.getAttribute('alt') ?? '').trim()
    if (src.length === 0 || alt.length === 0) {
      image.remove()
    }
  }
}

/** Whether a link holds something a reader can read: text, or an image with a source. */
function hasReadableContent(element: Element): boolean {
  return textLength(element.textContent) > 0 || element.querySelector('img[src]') !== null
}

/**
 * Push the link down into the blocks it wraps, so no anchor holds block-level content.
 *
 * For each anchor with a block-level descendant, every leaf block inside it has its children
 * moved into a fresh `<a>` with the same `href` (and `title`), and the outer anchor is unwrapped:
 * `<a href><h1>X</h1><p>Y</p></a>` becomes `<h1><a href>X</a></h1><p><a href>Y</a></p>`. The
 * converter then renders `# [X](href)` and `[Y](href)`, which is exactly the link the page drew,
 * with no orphan bracket. A link with no `href` (a placeholder) is unwrapped without a link, so
 * its content survives rather than being dropped with the anchor.
 */
function reflowBlockLinks(dom: Document): void {
  for (const anchor of [...dom.querySelectorAll('a')]) {
    if (anchor.querySelector(BLOCK_SELECTOR) === null) {
      continue
    }
    const href = anchor.getAttribute('href')
    const title = anchor.getAttribute('title')
    const blocks = Array.from(anchor.querySelectorAll(BLOCK_SELECTOR)).filter(
      (block) => block.querySelector(BLOCK_SELECTOR) === null,
    )
    if (href !== null) {
      for (const block of blocks) {
        // A void/empty leaf block (`<hr>`, an empty `<div>`) has nothing to carry the link, so
        // wrapping it would only produce the `[](href)` this pass exists to prevent.
        if (block.firstChild === null) {
          continue
        }
        const link = dom.createElement('a')
        link.setAttribute('href', href)
        if (title !== null) {
          link.setAttribute('title', title)
        }
        while (block.firstChild !== null) {
          link.appendChild(block.firstChild)
        }
        block.appendChild(link)
      }
    }
    // Unwrap the outer anchor: its block children (now carrying the link) become its siblings.
    const parent = anchor.parentNode
    if (parent !== null) {
      while (anchor.firstChild !== null) {
        parent.insertBefore(anchor.firstChild, anchor)
      }
    }
    anchor.remove()
  }
}

/** The length of some element's text with its whitespace collapsed, which is how size is judged. */
function textLength(text: string | null | undefined): number {
  return (text ?? '').replace(/\s+/g, ' ').trim().length
}
