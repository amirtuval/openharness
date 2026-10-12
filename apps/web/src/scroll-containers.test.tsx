import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { makeFake, renderApp } from './test-support/render-app'

/**
 * The app shell is the viewport, and the document never scrolls (#316).
 *
 * The bug this file pins is a layout one, and jsdom has no layout — nothing here is a
 * measurement. What *is* testable is the contract that broke, because it is all classes: a
 * scroll pane clips its own content, and an absolutely positioned element inside it (every
 * `sr-only` span: the chat's streaming caret, the settings screen's theme radios, its usage
 * table's caption) is clipped by that pane **only when the pane is its containing block**. With
 * no positioned ancestor between those elements and the shell, they were positioned against the
 * initial containing block instead, escaped the pane's clip, and stretched the *document* — the
 * settings page by ~2 400px, a streaming reply by ~17 000px — so the app grew a second, useless
 * scrollbar over empty space that the whole page could be scrolled into.
 *
 * The visual half of the verification is Playwright, where the assertion is
 * `document.scrollingElement.scrollHeight === clientHeight` with the transcript scrolled to the
 * bottom (see `apps/web/AGENTS.md`); these are its class-level siblings.
 */

/** `apps/web`: the package folder. */
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The stylesheet, as text. */
function stylesheet(): string {
  return readFileSync(path.join(packageDir, 'src/index.css'), 'utf8')
}

/** The classes of the one element a selector names, as one string. */
function classesOf(selector: string): string {
  const element = document.querySelector(selector)
  expect(element, `no element matches ${selector}`).not.toBeNull()
  return (element as HTMLElement).className
}

describe('the app shell and its scroll panes (#316)', () => {
  it('makes the shell the viewport: dynamic height, clipped, and positioned', async () => {
    renderApp(makeFake())
    await screen.findByRole('navigation', { name: 'Chats' })

    const classes = classesOf('[data-slot="app-shell"]')
    // Exactly the visible viewport. `h-dvh` and not `100vh`: on a phone `100vh` is the *tall*
    // viewport, and a shell taller than the screen is a page scrollbar nobody can remove.
    expect(classes).toContain('h-dvh')
    // Clipped, so nothing a screen lays out can reach the document. `clip` rather than
    // `hidden`: a `hidden` box can still be scrolled by the browser to reveal a focused
    // descendant, which would shift the whole app.
    expect(classes).toContain('overflow-clip')
    // The positioned ancestor every absolute element inside the app resolves against.
    expect(classes).toContain('relative')
  })

  it('keeps the transcript a scroll pane that clips its own absolute content', async () => {
    renderApp(makeFake())

    const transcript = await screen.findByRole('log')
    expect(transcript.className).toContain('overflow-y-auto')
    expect(transcript.className).toContain('relative')
  })

  it('keeps the settings pane a scroll pane that clips its own absolute content', async () => {
    renderApp(makeFake(), { hash: '#/settings' })

    const heading = await screen.findByRole('heading', { name: 'Settings' })
    const pane = heading.closest('[data-slot="settings-column"]')
    expect(pane).not.toBeNull()
    expect((pane as HTMLElement).className).toContain('overflow-y-auto')
    expect((pane as HTMLElement).className).toContain('relative')
  })

  it('keeps the chat list a scroll pane that clips its own absolute content', async () => {
    renderApp(makeFake())

    const nav = await screen.findByRole('navigation', { name: 'Chats' })
    expect(nav.className).toContain('overflow-y-auto')
    expect(nav.className).toContain('relative')
  })

  it('clips the root, so a shell taller than it cannot become a page scrollbar', () => {
    // The one part of the rule that is not a class: `#root` is the shell's only parent on the
    // page, and a mobile browser may resolve its `100%` a shade shorter than the dynamic
    // viewport height the shell is laid out at. The rule lives in the base layer of the
    // stylesheet, so it is read from there — jsdom applies no stylesheet to the render above.
    const css = stylesheet()
    expect(css).toMatch(/#root\s*\{[^}]*overflow:\s*hidden/)
  })
})
