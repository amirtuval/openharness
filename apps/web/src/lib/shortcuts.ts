/**
 * The app's keyboard shortcuts, as a rule (#212).
 *
 * Framework-free like `router.ts` and `settings.ts`: {@link shortcutFor} is a pure function
 * over the four things a keystroke is (the key, and whether Ctrl, ⌘, Shift and Alt were held),
 * so the whole of "which shortcut is this" is testable without a document — and
 * `hooks/use-shortcuts.ts` is the React binding that listens.
 *
 * Two rules run through all of them, and they are the ones that make a keyboard shortcut a
 * help rather than an ambush:
 *
 * - **A single key never fires while the reader is typing.** `/` in the message box is a
 *   slash, not a command; `?` in the search field of the model picker is a question mark.
 *   {@link isTypingTarget} is the test — an input, a textarea, a select, anything
 *   contenteditable — and a shortcut with a modifier is exempt from it, because Ctrl+Shift+O
 *   is not a character anyone types.
 * - **Nothing is bound that the browser already means.** Bold is Ctrl+B in a text field and
 *   the sidebar here, which the typing rule keeps apart; Ctrl+/ and Ctrl+Shift+O are free in
 *   every browser worth the name.
 *
 * The Stop key is the sixth shortcut and is deliberately **not** in here: it is `Escape` in
 * the composer, which is a rule about that box rather than about the app — see `composer.tsx`.
 * It is in {@link SHORTCUTS} all the same, because the sheet should list what a reader can
 * actually press.
 */

/** One thing a reader can press. */
export type ShortcutId = 'new-chat' | 'focus-composer' | 'toggle-sidebar' | 'shortcuts-sheet'

/**
 * The keys of a keystroke, and nothing else.
 *
 * Structural rather than `KeyboardEvent` so a test can hand it four fields: the matcher has no
 * business knowing about `target`, `preventDefault` or which element the event was fired on.
 */
export interface KeyChord {
  /** `KeyboardEvent.key`: a character, or a name like `Escape` or `Dead`. */
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
}

/**
 * Which shortcut a keystroke is, if any.
 *
 * @param event the keystroke
 * @param typing whether the reader is typing in a field ({@link isTypingTarget} of its target)
 * @returns the shortcut, or `null` for a keystroke that is not one — including a modified key
 *   this app does not use, which is left to the browser rather than swallowed.
 */
export function shortcutFor(event: KeyChord, typing: boolean): ShortcutId | null {
  // `key` is case-sensitive and Shift changes it (`b` → `B`, `/` → `?`), so the letter is
  // folded: what the matcher cares about is which key was pressed, not how it was written.
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  const mod = event.ctrlKey || event.metaKey

  // Alt is never part of a shortcut here, and on some layouts it is how a character is typed:
  // Alt+/ is a key combination somewhere, and it is not this app's.
  if (event.altKey) {
    return null
  }

  if (mod) {
    if (event.shiftKey) {
      return key === 'o' ? 'new-chat' : null
    }
    if (key === 'b') {
      return 'toggle-sidebar'
    }
    return key === '/' ? 'shortcuts-sheet' : null
  }

  // Bare keys, and only outside a field.
  if (typing) {
    return null
  }
  if (key === '/') {
    return 'focus-composer'
  }
  // `?` arrives with Shift held on most layouts, which is why this branch does not care about
  // the modifier the way the ones above do: it is one key to the reader either way.
  return key === '?' ? 'shortcuts-sheet' : null
}

/**
 * Whether a key event's target is somewhere the reader is **typing**.
 *
 * `select` and contenteditable are in here with `input` and `textarea`: the rule the app
 * promises is "single keys do not fire while you are typing in a field", and a page that
 * swallowed `/` inside a rich-text box would be breaking it on a technicality.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') {
    return false
  }
  const element = target as Partial<HTMLElement>
  if (element.isContentEditable === true) {
    return true
  }
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** One line of the shortcuts sheet. */
export interface ShortcutHelp {
  /** The keys as they are shown, one `<kbd>` each. */
  readonly keys: readonly string[]
  /** What it does, in the imperative. */
  readonly description: string
}

/**
 * Every shortcut, in the order the sheet lists them: what a reader does most, first.
 *
 * `Ctrl/⌘` is one label rather than a choice made at runtime: which of the two a machine has
 * is obvious to whoever is looking at their own keyboard, and a sheet that named the wrong one
 * because `navigator.platform` lied would be worse than one that names both. The matcher takes
 * either, on every platform, so both labels are true everywhere.
 */
export const SHORTCUTS: readonly ShortcutHelp[] = [
  { keys: ['Ctrl/⌘', 'Shift', 'O'], description: 'Start a new chat' },
  { keys: ['/'], description: 'Put the cursor in the message box' },
  { keys: ['Esc'], description: 'Stop the reply that is running (from the message box)' },
  { keys: ['Ctrl/⌘', 'B'], description: 'Show or hide the sidebar' },
  { keys: ['?'], description: 'Show this list' },
  { keys: ['Ctrl/⌘', '/'], description: 'Show this list' },
]
