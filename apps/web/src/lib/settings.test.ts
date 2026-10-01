import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  getSettings,
  resetSettings,
  saveSettings,
  subscribeSettings,
} from './settings'

/** The app's one setting, and what it does with the one an older version stored. */
describe('settings', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to the same origin', () => {
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps the snapshot identity stable until something is saved', () => {
    expect(getSettings()).toBe(getSettings())

    const saved = saveSettings({ serverUrl: 'http://localhost:3000' })
    expect(getSettings()).toBe(saved)
    expect(saved).toEqual({ serverUrl: 'http://localhost:3000' })
  })

  it('reads what a previous visit stored', () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ serverUrl: 'https://api.example.com' }),
    )

    expect(getSettings()).toEqual({ serverUrl: 'https://api.example.com' })
  })

  it('drops the removed API key a previous version stored (epic #65, A8)', () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ serverUrl: 'https://api.example.com', apiKey: 'oh_secret' }),
    )

    expect(getSettings()).toEqual({ serverUrl: 'https://api.example.com' })
    // And it is gone from the browser too, not just from what this app reads.
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(
      JSON.stringify({ serverUrl: 'https://api.example.com' }),
    )
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).not.toContain('oh_secret')
  })

  it('never writes a key again', () => {
    saveSettings({ serverUrl: 'http://localhost:3000' })
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).not.toContain('apiKey')
  })

  it('falls back to the defaults for anything unreadable', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, '{not json')
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)

    localStorage.setItem(SETTINGS_STORAGE_KEY, '"a string"')
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)

    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ serverUrl: 42 }))
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('survives a storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(saveSettings({ serverUrl: 'http://localhost:8787' })).toEqual({
      serverUrl: 'http://localhost:8787',
    })
    expect(getSettings().serverUrl).toBe('http://localhost:8787')
  })

  it('notifies subscribers on a save, and stops when they unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeSettings(listener)

    saveSettings({ serverUrl: 'http://localhost:3000' })
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    saveSettings({ serverUrl: 'http://localhost:8787' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('goes back to the defaults when reset', () => {
    saveSettings({ serverUrl: 'http://localhost:3000' })
    expect(resetSettings()).toEqual(DEFAULT_SETTINGS)
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)
  })
})
