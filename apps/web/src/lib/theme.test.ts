import { describe, expect, it, vi } from 'vitest'

import {
  THEME_STORAGE_KEY,
  adoptTheme,
  chooseTheme,
  getTheme,
  resolveTheme,
  subscribeTheme,
} from './theme'

/**
 * The theme store (epic #201, X3): the four choices, the `data-theme` attribute they paint,
 * the operating system `system` follows, and the cache the first paint reads.
 *
 * The store is module-level, so every test starts by putting the page back at the default:
 * `localStorage.clear()` (the global `afterEach`) empties the cache, and `getTheme()` is what
 * notices and re-paints. Nothing here renders React — `appearance.test.tsx` and
 * `theme-menu.test.tsx` do that — so the assertions are about the DOM attribute and the cache,
 * which is what the two pickers are bound to.
 */

/** What the page is painted with. */
function painted(): string | undefined {
  return document.documentElement.dataset.theme
}

/**
 * A `matchMedia` that answers the system preference, and can be flipped.
 *
 * jsdom has no `matchMedia` at all, so every test about `system` installs one; `flip` is what
 * an operating system switching to dark looks like from here.
 */
function stubMatchMedia(initialDark: boolean): { flip: (dark: boolean) => void } {
  const listeners = new Set<() => void>()
  let dark = initialDark

  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' ? dark : false,
    media: query,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }))

  return {
    flip: (next: boolean) => {
      dark = next
      for (const listener of listeners) {
        listener()
      }
    },
  }
}

describe('resolveTheme', () => {
  it('resolves system against the operating system and passes the others through', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dim', false)).toBe('dim')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})

describe('the theme store', () => {
  it('paints a choice on <html> at once, and caches it', () => {
    getTheme()

    chooseTheme('dim')

    expect(painted()).toBe('dim')
    expect(getTheme()).toBe('dim')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dim')
  })

  it('starts from the cache, before anything is loaded from the server', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dim')

    // Reading is what the first render does, and it is enough: the inline script in
    // `index.html` already did the same thing for the very first paint.
    expect(getTheme()).toBe('dim')
    expect(painted()).toBe('dim')
  })

  it('falls back to system for a cache it cannot use', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'midnight')

    expect(getTheme()).toBe('system')
    expect(painted()).toBe('light')
  })

  it('follows the operating system while the choice is system, and stops once it is not', () => {
    const media = stubMatchMedia(false)
    subscribeTheme(() => undefined)

    chooseTheme('system')
    expect(painted()).toBe('light')

    media.flip(true)
    expect(painted()).toBe('dark')

    // A choice of one's own is not the operating system's to change.
    chooseTheme('light')
    media.flip(false)
    media.flip(true)
    expect(painted()).toBe('light')
    expect(getTheme()).toBe('light')
  })

  it('takes the stored value, and caches it for the next first paint', () => {
    getTheme()

    adoptTheme('dark')

    expect(getTheme()).toBe('dark')
    expect(painted()).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')

    // Which of "the reader's click" and "the account's answer" wins when they race is the
    // caller's question, not the store's: `appearance.test.tsx` is where that lives.
    adoptTheme('dim')
    expect(painted()).toBe('dim')
  })
})
