import { useSyncExternalStore } from 'react'

import type { UserTheme } from '@openharness/protocol'
import { chooseTheme, getTheme, subscribeTheme } from '../lib/theme'

/** The theme, and the way to change it. */
export interface ThemeView {
  /** The choice in effect: `system`, `light`, `dim` or `dark`. */
  readonly theme: UserTheme
  /**
   * Choose a theme: applied at once, cached, and written to the account's preferences by
   * `components/theme-preference.tsx`.
   */
  readonly choose: (theme: UserTheme) => void
}

/**
 * The theme store, bound to React the way `use-settings.ts` binds the settings store.
 *
 * There is no server call here on purpose: this is what the sidebar and the settings screen
 * share, and neither should have to be inside a client to render a colour scheme. The one
 * write is the shell's (`theme-preference.tsx`), so a click is instant everywhere and saved
 * once.
 */
export function useTheme(): ThemeView {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme)
  return { theme, choose: chooseTheme }
}
