import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  getSettings,
  resetSettings,
  saveSettings,
  subscribeSettings,
} from './settings'

describe('settings', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to the same origin and no key', () => {
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps the snapshot identity stable until something is saved', () => {
    expect(getSettings()).toBe(getSettings())

    const saved = saveSettings({ serverUrl: 'http://localhost:3000' })
    expect(getSettings()).toBe(saved)
    expect(saved).toEqual({ serverUrl: 'http://localhost:3000', apiKey: '' })
  })

  it('reads what a previous visit stored', () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ serverUrl: 'https://api.example.com', apiKey: 'oh_1' }),
    )

    expect(getSettings()).toEqual({ serverUrl: 'https://api.example.com', apiKey: 'oh_1' })
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
    expect(saveSettings({ apiKey: 'oh_2' })).toEqual({ serverUrl: '', apiKey: 'oh_2' })
    expect(getSettings().apiKey).toBe('oh_2')
  })

  it('notifies subscribers on a save, and stops when they unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeSettings(listener)

    saveSettings({ apiKey: 'oh_3' })
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    saveSettings({ apiKey: 'oh_4' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('goes back to the defaults when reset', () => {
    saveSettings({ serverUrl: 'http://localhost:3000', apiKey: 'oh_5' })
    expect(resetSettings()).toEqual(DEFAULT_SETTINGS)
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)
  })
})
