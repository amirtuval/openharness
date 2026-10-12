import { describe, expect, it } from 'vitest'

import { htmlToMarkdown } from './markdown'

/**
 * HTML → Markdown (epic #303, #305).
 *
 * What is asserted here is the *shape* a model reads: the main content, without the page's
 * script, style and navigation, with its links fetchable and its headings and code intact.
 */

describe('htmlToMarkdown', () => {
  it('keeps the main content and drops script, style and chrome', () => {
    const html = `<!doctype html><html><head><title>T</title>
      <style>body { color: red }</style><script>fetch('/steal')</script></head>
      <body><nav>Home | About</nav>
      <article><h2>Weather</h2><p>It rained all week, which nobody had forecast, and the river
      came up over the road by Thursday morning. The council closed it that afternoon.</p></article>
      <footer>© 2026</footer></body></html>`
    const markdown = htmlToMarkdown(html, 'https://example.com/weather')
    expect(markdown).toContain('## Weather')
    expect(markdown).toContain('It rained all week')
    expect(markdown).toContain('# T')
    expect(markdown).not.toContain('color: red')
    expect(markdown).not.toContain("fetch('/steal')")
  })

  it('resolves relative links and images against the page’s address', () => {
    const html = `<html><body><article><p>See <a href="/next">the next page</a> and
      <a href="https://other.example/x">another site</a>, or the
      <img src="pic.png" alt="picture">.</p></article></body></html>`
    const markdown = htmlToMarkdown(html, 'https://example.com/a/b/')
    expect(markdown).toContain('https://example.com/next')
    expect(markdown).toContain('https://other.example/x')
    expect(markdown).toContain('https://example.com/a/b/pic.png')
  })

  it('keeps a link a page wrote in another scheme, and drops a script one', () => {
    const html = `<html><body><article><p>Write to <a href="mailto:a@b.example">us</a>, and
      see <a href="javascript:void(0)">this</a>, and <a href="#">the top</a>.</p></article></body></html>`
    const markdown = htmlToMarkdown(html, 'https://example.com/')
    // A `mailto:` is a link a model can act on and is kept as written; a `javascript:` URL is
    // dropped by the extractor, which is the right answer — it is a script, not an address.
    expect(markdown).toContain('mailto:a@b.example')
    expect(markdown).not.toContain('javascript:')
    expect(markdown).toContain('this')
  })

  it('falls back to the whole document when there is no article to find', () => {
    // `Readability` answers `null` for a page with no content it can score; the stripped
    // document is still the honest answer, and it is what a document-shaped page gets.
    const html = '<html><head><script>bad()</script></head><body><p>short</p></body></html>'
    const markdown = htmlToMarkdown(html, 'https://example.com/')
    expect(markdown).toContain('short')
    expect(markdown).not.toContain('bad()')
  })

  it('converts headings, fenced code, lists and emphasis the way a model reads them', () => {
    const html = `<html><body><article><h1>Code</h1>
      <pre><code>const x = 1</code></pre>
      <ul><li>one</li><li>two</li></ul>
      <p><strong>bold</strong> and <em>italic</em>.</p></article></body></html>`
    const markdown = htmlToMarkdown(html, 'https://example.com/')
    expect(markdown).toContain('```')
    expect(markdown).toContain('const x = 1')
    // `turndown` pads a list marker to three spaces; it is the library's own rendering and is
    // not worth a hand-written rule to change.
    expect(markdown).toMatch(/-\s+one/)
    expect(markdown).toContain('**bold**')
    expect(markdown).toContain('*italic*')
  })

  it('answers an empty string for a document with nothing in it', () => {
    expect(htmlToMarkdown('<html><body></body></html>', 'https://example.com/')).toBe('')
  })
})
