import { useSyncExternalStore } from 'react'

import { currentRoute, subscribeRoute, type Route } from '../lib/router'

/** The current route, re-rendering the caller when the hash changes. */
export function useRoute(): Route {
  return useSyncExternalStore(subscribeRoute, currentRoute, currentRoute)
}
