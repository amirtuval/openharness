import type { UserTheme } from '@openharness/protocol'
import { useEffect, useRef } from 'react'

import { useTheme } from '../hooks/use-theme'
import { noteAuthenticationError } from '../lib/auth-store'
import { showNotice } from '../lib/notice'
import { adoptTheme, chooseTheme, getTheme } from '../lib/theme'
import { useClient } from './client-provider'

/**
 * The theme, stored on the server (epic #201, X3): reads it once, writes every choice back.
 *
 * The store in `lib/theme.ts` is what paints — instantly, from the click and from the
 * `localStorage` cache that got the first frame right — and this is the one piece that knows
 * both about it and about the client. It renders nothing; it is the shell's, mounted once
 * beside the sidebar, so the settings picker and the sidebar's quick switch (which only call
 * `chooseTheme`) are saved the same way and by the same code.
 *
 * The order of the two effects is the whole subtlety. The read adopts the account's theme only
 * if the choice has not moved since the request left — the stored value wins once it answers,
 * but not over a click made after it. The write fires for a choice the server has not been
 * told about yet, and puts the previous choice back if the server refuses it, so a picker
 * never shows a theme that is not stored.
 */
export function ThemePreference(): null {
  const client = useClient()
  const { theme } = useTheme()
  // What the server is known to hold. Seeded from the choice in effect at mount — the cached
  // one — so a first render does not write a theme the account already has.
  const synced = useRef<UserTheme>(theme)

  useEffect(() => {
    const controller = new AbortController()
    // The choice when this request left. A click after that is the reader's last word, and its
    // own write is already on its way; `lib/theme.ts` cannot tell the two apart — a request is
    // not a value — so the caller that made the request is the one that asks.
    const startedAt = getTheme()
    void client.preferences.get({ signal: controller.signal }).then(
      (preferences) => {
        if (controller.signal.aborted) {
          return
        }
        if (getTheme() !== startedAt) {
          return
        }
        synced.current = preferences.theme
        adoptTheme(preferences.theme)
      },
      (caught: unknown) => {
        // A failed read leaves the cache in charge: no theme is worth an error banner, but a
        // 401 still signs the app out, which is the shell's business.
        if (!controller.signal.aborted) {
          noteAuthenticationError(client, caught)
        }
      },
    )
    return () => {
      controller.abort()
    }
  }, [client])

  useEffect(() => {
    const previous = synced.current
    if (previous === theme) {
      return
    }
    synced.current = theme
    void client.preferences.put({ theme }).catch((caught: unknown) => {
      noteAuthenticationError(client, caught)
      // Only if nothing newer was chosen while this was in flight: a second click is the
      // reader's last word, and its own write is on its way.
      if (synced.current === theme) {
        synced.current = previous
        chooseTheme(previous)
        showNotice('Could not save your theme — it will be back to the stored one next time.')
      }
    })
  }, [client, theme])

  return null
}
