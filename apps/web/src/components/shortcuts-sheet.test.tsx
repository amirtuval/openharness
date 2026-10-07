import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { SHORTCUTS } from '../lib/shortcuts'
import { ShortcutsSheet } from './shortcuts-sheet'

/**
 * The sheet itself (issue #212): every shortcut, spelled out, and a close that reports back.
 *
 * That `?` opens it is `App.test.tsx`'s; this is the list a reader sees once it is open. It is
 * built from {@link SHORTCUTS}, so what matters here is that the list is on screen whole —
 * a shortcut the sheet does not mention is one nobody will ever find.
 */
describe('ShortcutsSheet', () => {
  it('lists every shortcut, keys and all', () => {
    render(<ShortcutsSheet open onClose={vi.fn()} />)

    const sheet = document.querySelector('[data-slot="shortcuts-sheet"]') as HTMLElement
    expect(sheet).not.toBeNull()
    // One row per shortcut: the description on the left, its keys on the right.
    expect(within(sheet).getAllByRole('term')).toHaveLength(SHORTCUTS.length)
    // `getAllBy`: two rows share the description "Show this list" without being one row —
    // they are two keys that do the same thing, which is what the sheet is for.
    for (const shortcut of SHORTCUTS) {
      expect(within(sheet).getAllByText(shortcut.description).length).toBeGreaterThan(0)
      for (const key of shortcut.keys) {
        expect(within(sheet).getAllByText(key).length).toBeGreaterThan(0)
      }
    }
    // Both doors to the sheet, and the key that stops a reply, are on it.
    expect(within(sheet).getAllByText('Ctrl/⌘').length).toBeGreaterThan(0)
    expect(within(sheet).getAllByText('?').length).toBeGreaterThan(0)
    expect(within(sheet).getAllByText('Esc').length).toBeGreaterThan(0)
  })

  it('says nothing at all while it is closed', () => {
    render(<ShortcutsSheet open={false} onClose={vi.fn()} />)
    expect(screen.queryByText('Keyboard shortcuts')).toBeNull()
  })

  it('hears Escape, and hands the close back to the shell', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ShortcutsSheet open onClose={onClose} />)

    // Escape is Radix's — the dialog is the thing that knows it is a dialog — so what the
    // shell has to get out of it is one call, not a key handler of its own.
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
