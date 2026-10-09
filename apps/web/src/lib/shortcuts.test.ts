import { describe, expect, it } from 'vitest'

import { isTypingTarget, SHORTCUTS, shortcutFor, type KeyChord } from './shortcuts'

/**
 * The keyboard rule (issue #212).
 *
 * All of it is {@link shortcutFor}: "which shortcut is this keystroke, if any" is a function of
 * four booleans and a key, so the whole of the binding is testable with no document, no
 * listener and no rendering. What the shell *does* with each answer is `App.test.tsx`'s.
 */

/** One keystroke. Everything unheld unless the test says otherwise. */
function chord(key: string, held: Partial<KeyChord> = {}): KeyChord {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...held }
}

describe('shortcutFor', () => {
  it('is Ctrl/⌘+Shift+O for a new chat', () => {
    expect(shortcutFor(chord('O', { ctrlKey: true, shiftKey: true }), false)).toBe('new-chat')
    expect(shortcutFor(chord('O', { metaKey: true, shiftKey: true }), false)).toBe('new-chat')
    // The modifier is the point: Ctrl+O alone is the browser's own "open file".
    expect(shortcutFor(chord('o', { ctrlKey: true }), false)).toBeNull()
  })

  it('is Ctrl/⌘+B for the sidebar, and Ctrl/⌘+/ for the sheet', () => {
    expect(shortcutFor(chord('b', { ctrlKey: true }), false)).toBe('toggle-sidebar')
    expect(shortcutFor(chord('B', { metaKey: true }), false)).toBe('toggle-sidebar')
    expect(shortcutFor(chord('/', { ctrlKey: true }), false)).toBe('shortcuts-sheet')
  })

  it('is `/` and `?` on their own, and only outside a field', () => {
    expect(shortcutFor(chord('/'), false)).toBe('focus-composer')
    // `?` needs Shift on most layouts, which is why it is matched by the character rather
    // than by the key with no modifier.
    expect(shortcutFor(chord('?', { shiftKey: true }), false)).toBe('shortcuts-sheet')
    expect(shortcutFor(chord('?'), false)).toBe('shortcuts-sheet')
  })

  it('never fires a bare key while the reader is typing', () => {
    // The whole promise of the rule: a slash typed into the message box is a slash.
    expect(shortcutFor(chord('/'), true)).toBeNull()
    expect(shortcutFor(chord('?', { shiftKey: true }), true)).toBeNull()
    // A modified key is not a character anyone types, so it is not suppressed.
    expect(shortcutFor(chord('b', { ctrlKey: true }), true)).toBe('toggle-sidebar')
    expect(shortcutFor(chord('O', { ctrlKey: true, shiftKey: true }), true)).toBe('new-chat')
    expect(shortcutFor(chord('/', { ctrlKey: true }), true)).toBe('shortcuts-sheet')
  })

  it('leaves everything else to the browser', () => {
    expect(shortcutFor(chord('Escape'), false)).toBeNull()
    expect(shortcutFor(chord('k', { ctrlKey: true }), false)).toBeNull()
    expect(shortcutFor(chord('r', { metaKey: true }), false)).toBeNull()
    // Alt is never part of one here — on some layouts it is how a character is typed.
    expect(shortcutFor(chord('/', { ctrlKey: true, altKey: true }), false)).toBeNull()
    expect(shortcutFor(chord('/', { altKey: true }), false)).toBeNull()
    // Shift on a modified key that the app does not use is a different key, not this one.
    expect(shortcutFor(chord('b', { ctrlKey: true, shiftKey: true }), false)).toBeNull()
    expect(shortcutFor(chord('/', { ctrlKey: true, shiftKey: true }), false)).toBeNull()
  })
})

describe('isTypingTarget', () => {
  it('is true for the things a reader types into', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isTypingTarget(document.createElement(tag))).toBe(true)
    }
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    // jsdom does not implement `isContentEditable`, so the property the rule reads is set
    // here the way a browser would compute it.
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(isTypingTarget(editable)).toBe(true)
  })

  it('is false for anything else', () => {
    expect(isTypingTarget(document.createElement('div'))).toBe(false)
    expect(isTypingTarget(document.body)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    // A key event with no target at all (the document itself, in practice).
    expect(isTypingTarget(document)).toBe(false)
  })
})

describe('SHORTCUTS', () => {
  it('lists every shortcut a reader can press, key and all', () => {
    // The sheet is built from this list, so what is asserted is that the list is the sheet:
    // six rows, each spelled out, and the two that share a description really are two keys.
    expect(SHORTCUTS).toHaveLength(6)
    for (const shortcut of SHORTCUTS) {
      expect(shortcut.keys.length).toBeGreaterThan(0)
      expect(shortcut.description).not.toBe('')
    }
    expect(SHORTCUTS.filter((shortcut) => shortcut.description === 'Show this list')).toHaveLength(
      2,
    )
    // Stop is in the sheet although it is not a `ShortcutId`: it is the composer's own key.
    expect(SHORTCUTS.some((shortcut) => shortcut.keys.includes('Esc'))).toBe(true)
  })
})
