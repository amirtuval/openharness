import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { LOGO_MARK_DOT, LOGO_MARK_RING, LOGO_MARK_VIEW_BOX } from './components/logo-mark'

/**
 * The shipped icons (#240).
 *
 * The mark is drawn twice — inline by the component and as `public/favicon.svg` — because a
 * page cannot put a component in a `<link rel="icon">`, and neither copy can be generated from
 * the other at build time. They are held together here instead: this reads the SVG and fails
 * if its ring or its dot has moved.
 *
 * `public/` and `index.html` are read from disk rather than imported: Vite serves the first as
 * static files and the second is the entry document, so neither is in the module graph — which
 * is why this test reaches for `node:fs`. The paths are built with `path`, not `new URL(…,
 * import.meta.url)`, because Vite rewrites that pattern into an asset URL.
 */

/** `apps/web`: the package folder, which is where the two files live. */
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A file in the package, read as text. */
function read(relative: string): string {
  return readFileSync(path.join(packageDir, relative), 'utf8')
}

/** The favicon, parsed. */
function faviconDocument(): Document {
  const doc = new DOMParser().parseFromString(read('public/favicon.svg'), 'image/svg+xml')
  // A malformed SVG — a `--` inside a comment is enough — parses to a document holding a
  // `<parsererror>` rather than the mark, and a browser would draw nothing. So the parse is
  // part of what is checked, in both tests that read the file.
  expect(doc.querySelector('parsererror')).toBeNull()
  return doc
}

/** The mark's two circles, in draw order: the ring, then the dot. */
function circles(doc: Document): [Element, Element] {
  const [ring, dot] = [...doc.querySelectorAll('circle')]
  if (ring === undefined || dot === undefined) {
    throw new Error('the favicon did not draw its two circles')
  }
  return [ring, dot]
}

describe('the favicon', () => {
  it('draws the same mark the component does', () => {
    const doc = faviconDocument()
    const [ring, dot] = circles(doc)

    expect(doc.documentElement.getAttribute('viewBox')).toBe(LOGO_MARK_VIEW_BOX)
    expect(ring.getAttribute('cx')).toBe(String(LOGO_MARK_RING.cx))
    expect(ring.getAttribute('cy')).toBe(String(LOGO_MARK_RING.cy))
    expect(ring.getAttribute('r')).toBe(String(LOGO_MARK_RING.r))
    expect(ring.getAttribute('stroke-width')).toBe(String(LOGO_MARK_RING.strokeWidth))
    expect(ring.getAttribute('stroke-dasharray')).toBe(LOGO_MARK_RING.dashArray)
    expect(ring.getAttribute('transform')).toBe(
      `rotate(${LOGO_MARK_RING.rotation} ${LOGO_MARK_RING.cx} ${LOGO_MARK_RING.cy})`,
    )
    expect(dot.getAttribute('cx')).toBe(String(LOGO_MARK_DOT.cx))
    expect(dot.getAttribute('cy')).toBe(String(LOGO_MARK_DOT.cy))
    expect(dot.getAttribute('r')).toBe(String(LOGO_MARK_DOT.r))
  })

  it('carries the palette, and the dark violet behind the media query', () => {
    const doc = faviconDocument()
    const [ring, dot] = circles(doc)

    // The exact sRGB of the tokens in `src/index.css`: the primary violet converts to #7C3AED,
    // the dark link violet to #A78BFA and the coral to #FB7185. A favicon cannot read a custom
    // property, so the file writes them out — which is what this pins.
    expect(ring.getAttribute('stroke')?.toUpperCase()).toBe('#7C3AED')
    expect(dot.getAttribute('fill')?.toUpperCase()).toBe('#FB7185')

    const rules = doc.querySelector('style')?.textContent
    expect(rules).toContain('prefers-color-scheme: dark')
    expect(rules?.toUpperCase()).toContain('#A78BFA')
  })
})

describe('index.html', () => {
  it('links only icons that exist in public/', () => {
    const links = [...read('index.html').matchAll(/<link\b[^>]*>/gu)].map((match) => match[0])
    const icons = links.filter((tag) => /\brel="(?:icon|apple-touch-icon)"/u.test(tag))

    // The SVG, the ICO fallback and the apple-touch icon (#240) — the whole set, so a link
    // that was dropped, or a fourth that was never added, both show up here.
    expect(icons).toHaveLength(3)
    for (const tag of icons) {
      const href = /href="([^"]+)"/u.exec(tag)?.[1]
      // Root-relative: Vite's `base` is unset, so `public/` is served at the site root.
      expect(href, `${tag} has no root-relative href`).toMatch(/^\//u)
      expect(
        existsSync(path.join(packageDir, 'public', href ?? '')),
        `${href ?? 'the href'} is not in public/`,
      ).toBe(true)
    }
  })
})
