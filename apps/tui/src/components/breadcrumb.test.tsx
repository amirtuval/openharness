import type { Session } from '@openharness/protocol'
import { makeChildSession, makeSession } from '@openharness/protocol/fixtures'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { breadcrumbSpans, BreadcrumbLine } from './breadcrumb'
import { ThemeProvider } from './theme'

const DARK = { background: 'dark', color: true, level: 3 } as const

/** A chat with a title of its own. */
function named(title: string, overrides: Partial<Session> = {}): Session {
  return { ...makeSession(), title, ...overrides }
}

/** What the line reads, as text. */
function textOf(chain: readonly Session[]): string {
  return breadcrumbSpans(chain, DARK)
    .map((span) => span.text)
    .join('')
}

afterEach(cleanup)

describe('the breadcrumb of a task’s own chat (#347)', () => {
  it('reads root first, with this chat last', () => {
    const root = named('root chat')
    const child = { ...makeChildSession(root), title: 'researcher' }
    expect(textOf([root, child])).toBe('root chat › researcher')
  })

  it('dims every step but the chat the reader is in', () => {
    const root = named('root chat')
    const child = { ...makeChildSession(root), title: 'researcher' }
    const spans = breadcrumbSpans([root, child], DARK)

    const rootSpan = spans.find((span) => span.text === 'root chat')
    const childSpan = spans.find((span) => span.text === 'researcher')
    expect(rootSpan?.dim).toBe(true)
    expect(childSpan?.dim).toBeUndefined()
    // The separators are chrome, like every other structural mark in the transcript.
    expect(spans.find((span) => span.text === ' › ')?.color).toBe('gray')
  })

  it('falls back to a session handle for a chat the server has not named', () => {
    // A helper's title is null: the server names a session from its first *message*, and a
    // child's is the prompt its parent wrote.
    const root = named('root chat')
    const child = { ...makeChildSession(root), title: null }
    expect(textOf([root, child])).toBe(`root chat › ${shorten(child)}`)
  })

  it('draws nothing an uncoloured terminal cannot read', () => {
    const root = named('root chat')
    const child = { ...makeChildSession(root), title: 'researcher' }
    expect(textOf([root, child])).toBe('root chat › researcher')
  })

  it('draws the chain, and truncates rather than overflowing', () => {
    const root = named('root chat')
    const child = { ...makeChildSession(root), title: 'researcher' }
    const frame = (
      render(
        <ThemeProvider theme={DARK}>
          <BreadcrumbLine chain={[root, child]} width={12} />
        </ThemeProvider>,
      ).lastFrame() ?? ''
    ).trimEnd()
    expect(frame.length).toBeLessThanOrEqual(12)
  })
})

/** How the client shortens a handle: `sesn_…<last 6>`. */
function shorten(session: Session): string {
  return `sesn_…${session.id.slice(-6)}`
}
