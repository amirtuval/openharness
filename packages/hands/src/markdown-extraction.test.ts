import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { htmlToMarkdown } from './markdown'

/**
 * HTML → Markdown against **saved pages** (epic #303, #305; #314).
 *
 * `markdown.test.ts` is the conversion on hand-written documents, where every element is there
 * on purpose. This file is the other half: the conversion on pages that were fetched from the
 * real web and saved, because the failures that matter — a headline a reader-mode extractor
 * misses, a page of headlines it answers `null` for, a charset a server does not name — only
 * show up on a real page's markup.
 *
 * The fixtures under `src/fixtures/` are those pages, **trimmed** to a size a repository can
 * carry (each is under 120 KB): the JS payload is collapsed to a single `<script>` stub carrying
 * the marker `TRIM_MARKER_SCRIPT` and `window.`, so "no script text survives" is asserted
 * against a string that is definitely in the input, and the largest non-essential subtrees are
 * removed until the file fits — the main content of each page is kept whole. They are read
 * relative to this file with `new URL(..., import.meta.url)`, so they are found however the
 * tests are run.
 */

/** A saved page fixture, read relative to this test file (all but one are UTF-8). */
function fixture(name: string, encoding = 'utf-8'): string {
  const bytes = readFileSync(new URL(`./fixtures/${name}`, import.meta.url))
  return new TextDecoder(encoding).decode(bytes)
}

/** The main headline of the ynet homepage, as the page writes it. */
const YNET_HEADLINE = 'ראש העיר כפר סבא, אשתו ומנכ"ל בעירייה נעצרו. החשד: קיבלו שוחד להטיית מכרזים'

/** The pages from the web, each converted at a URL of its own so relative links resolve. */
const REAL_PAGES = [
  { page: 'ynet', file: 'ynet.html', url: 'https://www.ynet.co.il/' },
  { page: 'hacker news', file: 'hacker-news.html', url: 'https://news.ycombinator.com/' },
  { page: 'wikipedia', file: 'wikipedia.html', url: 'https://en.wikipedia.org/wiki/Israel' },
] as const

/**
 * Every saved page, each with its own `charset` and the address its relative links resolve
 * against — the whole fixture set, for the properties that must hold on all of them.
 */
const FIXTURES = [
  { page: 'ynet', file: 'ynet.html', encoding: 'utf-8', url: 'https://www.ynet.co.il/' },
  {
    page: 'hacker news',
    file: 'hacker-news.html',
    encoding: 'utf-8',
    url: 'https://news.ycombinator.com/',
  },
  {
    page: 'wikipedia',
    file: 'wikipedia.html',
    encoding: 'utf-8',
    url: 'https://en.wikipedia.org/wiki/Israel',
  },
  { page: 'consent', file: 'consent.html', encoding: 'utf-8', url: 'https://recipes.example/cake' },
  {
    page: 'windows-1255',
    file: 'windows-1255.html',
    encoding: 'windows-1255',
    url: 'https://example.test/he',
  },
] as const

describe.each(FIXTURES)(
  'htmlToMarkdown: no stray punctuation on the $page page',
  ({ file, encoding, url }) => {
    const markdown = htmlToMarkdown(fixture(file, encoding), url)

    it('does not begin with an unmatched bracket', () => {
      // An anchor wrapping a block once converted to `[` + the block + `](href)`, so the very
      // first character the model read was the `[` of a link whose `](href)` was far below.
      expect(markdown).not.toMatch(/^[[\]]/)
    })

    it('carries no empty link or image', () => {
      // An icon link (an empty `<a>`) and an undescribed image both once converted to `[](...)`.
      expect(markdown).not.toContain('[](')
      expect(markdown).not.toContain('[ ](')
    })
  },
)

describe.each(REAL_PAGES)('htmlToMarkdown: the $page page', ({ file, url }) => {
  it('keeps no script text, no `window.` JS and no style', () => {
    const markdown = htmlToMarkdown(fixture(file), url)
    expect(markdown).not.toContain('window.')
    expect(markdown).not.toContain('TRIM_MARKER_SCRIPT')
    expect(markdown).not.toContain('<script')
    expect(markdown).not.toContain('<style')
    expect(markdown.length).toBeGreaterThan(0)
  })
})

describe('htmlToMarkdown: the ynet homepage', () => {
  const markdown = htmlToMarkdown(fixture('ynet.html'), 'https://www.ynet.co.il/')

  it('keeps the main headline, and leads with it', () => {
    expect(markdown).toContain(YNET_HEADLINE)
    // The headline is the page's content: it is at the very top, not after a masthead.
    expect(markdown.indexOf(YNET_HEADLINE)).toBeLessThan(50)
  })

  it('drops the top bar, the navigation and the news ticker before the content', () => {
    // The UI labels of the header and the main navigation's own first item; none is content.
    for (const chrome of ['נגישות', 'דווחו לנו', 'עוד מבזקים', 'מבזקים', 'ראשי']) {
      expect(markdown).not.toContain(chrome)
    }
  })

  it('keeps the story links, and leaves an already-absolute link as the page wrote it', () => {
    expect(markdown).toContain('https://www.ynet.co.il/news/article/b18yjcyjgl')
  })
})

describe('htmlToMarkdown: the Hacker News front page', () => {
  const markdown = htmlToMarkdown(fixture('hacker-news.html'), 'https://news.ycombinator.com/')

  it('yields the front-page story titles as links', () => {
    expect(markdown).toContain('# Hacker News')
    expect(markdown).toMatch(
      /\[Yandex bot traffic down 99% after data center attack\]\(https:\/\/radar\.cloudflare\.com\//,
    )
    // A relative link on the page is resolved against the address the page was fetched from.
    expect(markdown).toContain('https://news.ycombinator.com/item?id=')
  })
})

describe('htmlToMarkdown: the Wikipedia article', () => {
  const markdown = htmlToMarkdown(fixture('wikipedia.html'), 'https://en.wikipedia.org/wiki/Israel')

  it('keeps the first paragraph of the article', () => {
    expect(markdown).toContain('# Israel - Wikipedia')
    expect(markdown).toContain('This article is about the country')
  })
})

describe('htmlToMarkdown: a consent banner', () => {
  const markdown = htmlToMarkdown(fixture('consent.html'), 'https://recipes.example/cake')

  it('drops cookie and GDPR chrome, and keeps a page that only mentions cookies', () => {
    expect(markdown).toContain('Chocolate cake')
    expect(markdown).toContain('ganache')
    // The banner's own words are gone, whatever it called itself.
    expect(markdown).not.toContain('Accept all cookies')
    expect(markdown).not.toContain('GDPR')
    expect(markdown).not.toMatch(/cookie[s]? to improve/i)
  })
})
