import type { UserTheme } from '@openharness/protocol'
import { Monitor, Moon, MoonStar, Sun } from 'lucide-react'

import { useTheme } from '../hooks/use-theme'
import { THEME_OPTIONS } from '../lib/theme'
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from './ui/dropdown-menu'

/** The mark for each choice. */
const THEME_ICONS: Record<UserTheme, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dim: Moon,
  dark: MoonStar,
}

/**
 * The theme, switched from anywhere there is a menu (epic #201, X3 and U10).
 *
 * The quick switch next to the settings screen's Appearance card: the same store, the same
 * instant application, the same saved write (`components/theme-preference.tsx`) — a reader who
 * wants a different theme while reading a chat should not have to leave it.
 *
 * Since U10 this is the **items**, not a menu: the four choices live in the account menu at the
 * foot of the sidebar, so there is one menu there instead of a theme button, a sign-out button
 * and an email that all wanted the same corner. It is a radio group rather than four plain
 * items because that is what it is — one choice out of four, with the current one marked — and
 * Radix then gives it the arrow keys and the `aria-checked` that go with it.
 */
export function ThemeMenuItems() {
  const { theme, choose } = useTheme()

  return (
    <DropdownMenuRadioGroup
      value={theme}
      onValueChange={(value) => {
        choose(value as UserTheme)
      }}
    >
      {THEME_OPTIONS.map(({ value, label }) => {
        const Icon = THEME_ICONS[value]
        return (
          <DropdownMenuRadioItem key={value} value={value}>
            <Icon aria-hidden="true" className="text-muted-foreground" />
            {label}
          </DropdownMenuRadioItem>
        )
      })}
    </DropdownMenuRadioGroup>
  )
}
