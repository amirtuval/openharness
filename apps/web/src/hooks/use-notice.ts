import { useSyncExternalStore } from 'react'

import { currentNotice, subscribeNotice } from '../lib/notice'

/** The shell's current notice, re-rendering the caller when it changes. */
export function useNotice(): string | null {
  return useSyncExternalStore(subscribeNotice, currentNotice, currentNotice)
}
