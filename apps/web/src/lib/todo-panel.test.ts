import { describe, expect, it, vi } from 'vitest'

import {
  TODO_PANEL_COLLAPSED_ITEM_LIMIT,
  TODO_PANEL_STORAGE_PREFIX,
  readTodoPanelCollapsed,
  todoPanelStartsCollapsed,
  todoPanelStorageKey,
  writeTodoPanelCollapsed,
} from './todo-panel'

/**
 * The task list's fold, remembered per chat (#314).
 *
 * `localStorage` is cleared for every test by `vitest.setup.ts`'s global `afterEach`, so each
 * case starts from a reader who has said nothing.
 */
describe('the task list fold', () => {
  it('remembers a fold per chat, and reads it back', () => {
    writeTodoPanelCollapsed('sesn_one', true)
    writeTodoPanelCollapsed('sesn_two', false)

    expect(readTodoPanelCollapsed('sesn_one')).toBe(true)
    expect(readTodoPanelCollapsed('sesn_two')).toBe(false)
    // Another chat is another memory, and a key nothing wrote is "no choice".
    expect(readTodoPanelCollapsed('sesn_three')).toBeNull()
    expect(localStorage.getItem(todoPanelStorageKey('sesn_one'))).toBe('collapsed')
    expect(todoPanelStorageKey('sesn_one')).toBe(`${TODO_PANEL_STORAGE_PREFIX}sesn_one`)
  })

  it('reads a value it did not write as no choice at all', () => {
    localStorage.setItem(todoPanelStorageKey('sesn_one'), 'maybe')
    expect(readTodoPanelCollapsed('sesn_one')).toBeNull()
  })

  it('loses nothing when the browser refuses storage', () => {
    // Safari's private mode throws on `setItem`; a policy can throw on both.
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is not available')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage is not available')
    })

    expect(readTodoPanelCollapsed('sesn_one')).toBeNull()
    expect(() => {
      writeTodoPanelCollapsed('sesn_one', true)
    }).not.toThrow()

    get.mockRestore()
    set.mockRestore()
  })

  it('starts a long list folded and a short one open', () => {
    // The rule is a limit and not a taste: one more than the panel may draw unbidden.
    expect(todoPanelStartsCollapsed(TODO_PANEL_COLLAPSED_ITEM_LIMIT)).toBe(false)
    expect(todoPanelStartsCollapsed(TODO_PANEL_COLLAPSED_ITEM_LIMIT + 1)).toBe(true)
    expect(todoPanelStartsCollapsed(0)).toBe(false)
    expect(todoPanelStartsCollapsed(40)).toBe(true)
  })
})
