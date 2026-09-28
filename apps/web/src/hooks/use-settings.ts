import { useSyncExternalStore } from 'react'

import { getSettings, subscribeSettings, type Settings } from '../lib/settings'

/** The saved settings, re-rendering the caller when they change. */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, getSettings, getSettings)
}
