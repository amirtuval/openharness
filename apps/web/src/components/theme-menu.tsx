import type { UserTheme } from '@openharness/protocol'
import { Check, Monitor, Moon, MoonStar, Sun } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useTheme } from '../hooks/use-theme'
import { THEME_OPTIONS } from '../lib/theme'
import { cn } from '../lib/utils'
import { Button } from './ui/button'

/** The mark for each choice: what the trigger shows, and what each row is led by. */
const THEME_ICONS: Record<UserTheme, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dim: Moon,
  dark: MoonStar,
}

/**
 * The theme, switched from the sidebar (epic #201, X3).
 *
 * The quick switch next to the settings screen's Appearance card: the same store, the same
 * instant application, the same saved write (`components/theme-preference.tsx`) — a reader who
 * wants a different theme while reading a chat should not have to leave it. It reads the theme
 * from the store rather than from props, which is also why the sidebar tests can render the
 * list on its own.
 *
 * An icon button opening a menu, like the session rows' kebab: the trigger shows the choice in
 * effect, and the menu is the four. Escape and a pointer outside close it, as every overlay in
 * this app does.
 */
export function ThemeMenu() {
  const { theme, choose } = useTheme()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const TriggerIcon = THEME_ICONS[theme]
  const label = THEME_OPTIONS.find((option) => option.value === theme)?.label ?? 'System'

  useEffect(() => {
    if (!open) {
      return
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={menuRef} className="relative shrink-0">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Theme: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="text-muted-foreground"
        onClick={() => {
          setOpen((current) => !current)
        }}
      >
        <TriggerIcon aria-hidden="true" />
      </Button>
      {open ? (
        <div
          role="menu"
          aria-label="Theme"
          className="absolute right-0 bottom-full z-20 mb-1 w-44 rounded-md border bg-popover p-1 shadow-md"
        >
          {THEME_OPTIONS.map(({ value, label: optionLabel }) => {
            const Icon = THEME_ICONS[value]
            const active = value === theme
            return (
              <Button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                variant="ghost"
                size="sm"
                className={cn('w-full justify-start gap-2', active && 'bg-accent')}
                onClick={() => {
                  choose(value)
                  setOpen(false)
                }}
              >
                <Icon aria-hidden="true" />
                {optionLabel}
                <Check
                  aria-hidden="true"
                  className={cn('ml-auto', active ? 'opacity-100' : 'opacity-0')}
                />
              </Button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
