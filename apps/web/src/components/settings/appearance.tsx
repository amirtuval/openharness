import { Check } from 'lucide-react'

import { useTheme } from '../../hooks/use-theme'
import { THEME_OPTIONS } from '../../lib/theme'
import { cn } from '../../lib/utils'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'

/**
 * Settings → Appearance (epic #201, X3).
 *
 * The four themes the app paints with. A choice is applied to `<html>` the moment it is
 * clicked — the stylesheet is one block of CSS variables per `data-theme`, so nothing
 * re-renders the chat to repaint it — and saved to the account's preferences by
 * `components/theme-preference.tsx`, which is mounted once in the shell. This card is
 * therefore only a picker: it holds no local state and no copy of the choice, so the sidebar's
 * quick switch and this are never out of step.
 *
 * Native radios rather than buttons: a theme is a single choice in a set, which is exactly
 * what a radio group is, and the arrow keys, the screen-reader announcement and the label
 * click all come with it. The input itself is `sr-only` and the label carries the look.
 */
export function AppearanceCard() {
  const { theme, choose } = useTheme()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Appearance</CardTitle>
        <CardDescription>
          System follows your operating system and switches when it does. The choice is kept with
          your account, so every browser you sign in from starts in the same theme.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {THEME_OPTIONS.map(({ value, label }) => (
            <label
              key={value}
              className={cn(
                'flex cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                'has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-[3px]',
                theme === value
                  ? 'border-ring bg-accent text-accent-foreground'
                  : 'hover:bg-accent/60',
              )}
            >
              <input
                type="radio"
                name="theme"
                value={value}
                checked={theme === value}
                onChange={() => {
                  choose(value)
                }}
                className="sr-only"
              />
              {label}
              <Check
                aria-hidden="true"
                className={cn('size-4 shrink-0', theme === value ? 'opacity-100' : 'opacity-0')}
              />
            </label>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
