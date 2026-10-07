import {
  ApiError,
  AuthenticationError,
  PROVIDERS,
  providerInfo,
  providerName,
} from '@openharness/client'
import type { Client } from '@openharness/client'
import { Box, Text, useInput } from 'ink'
import { useCallback, useRef, useState } from 'react'

import { describeError, type ErrorContext } from '../errors'
import { formForCredential } from '../providers/credential-form'
import { SecretInput } from './secret-input'

/**
 * Connecting a model provider from the terminal (#210, epic #201 X7/X8) — the CLI's mirror of
 * the web app's first-run flow and its Add-provider dialog.
 *
 * Two steps, one component: pick a provider from the list built from `PROVIDERS`, then paste
 * its key into a hidden input. On success the caller is told which provider was saved; on a
 * key the provider refuses, the reason is shown and the same box asks again, because the usual
 * mistake is a key copied with a space in it. The flow settles exactly once — the caller's
 * business is what happens next, and there are three callers: the app's no-credentials screen,
 * the `/providers` slash command (`chat/commands.ts`) through the inline prompt slot, and
 * `oh providers add`.
 *
 * Three things about it are load-bearing, and all three are about the key:
 *
 * - the key is typed into {@link SecretInput}, which echoes nothing and masks what it holds —
 *   so no frame, log or test snapshot can contain it;
 * - it goes straight to `client.providerCredentials.put`, which is the *same* write the web app
 *   makes (X7): the server validates it once against the provider and seals it. Nothing is
 *   written to this machine — there is no config-directory file a key could land in;
 * - a failure is reported by the server's own message, which never carries the key back.
 *
 * The "get a key" URL is always printed, so a terminal that cannot open a browser (SSH, CI,
 * no display) still has what it needs; `o` opens it where a browser exists. Free-tier hints
 * come from the same metadata the web app's tiles show (X8).
 */

export interface ProviderSetupProps {
  /** The client the key is saved through — `providerCredentials.put`. */
  readonly client: Client
  /** What the error messages should mention. */
  readonly context?: ErrorContext | undefined
  /** Start on this provider's key form, skipping the list; without one the flow starts on it. */
  readonly initialProvider?: string | undefined
  /** Open a URL in the browser; returns whether one was launched. Injectable for tests. */
  readonly openUrl: (url: string) => boolean
  /** The credential was stored. `provider` is the router id that was saved. */
  readonly onSaved: (provider: string) => void
  /** The user gave up: Esc at the list, or Ctrl+C anywhere. */
  readonly onCancel: () => void
  /**
   * The save was refused with a 401 — the session is stale, and adding a credential needs a
   * fresh one. The caller offers to sign in again; the flow does not retry by itself, because
   * a re-login is the run's business, not a screen's.
   */
  readonly onStaleSession: () => void
}

export function ProviderSetup({
  client,
  context,
  initialProvider,
  openUrl,
  onSaved,
  onCancel,
  onStaleSession,
}: ProviderSetupProps) {
  const [provider, setProvider] = useState<string | null>(initialProvider ?? null)
  const [index, setIndex] = useState(() => providerIndex(initialProvider))
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // The cursor and the pending values the handlers read, for the reason the model picker keeps
  // refs too: Ink hands `useInput` the latest *committed* render, so two keystrokes inside one
  // render would both read the position — and the provider — from before them.
  const indexRef = useRef(index)
  const providerRef = useRef(provider)
  const savingRef = useRef(false)

  const info = provider === null ? undefined : providerInfo(provider)

  const moveTo = (next: number): void => {
    const clamped = Math.min(Math.max(next, 0), PROVIDERS.length - 1)
    indexRef.current = clamped
    setIndex(clamped)
  }

  const choose = (id: string): void => {
    providerRef.current = id
    setProvider(id)
    setError(null)
    setNote(null)
  }

  const backToPick = useCallback((): void => {
    if (initialProvider !== undefined) {
      // There is no list to go back to when the provider was named: the flow's own cancel is
      // the way out, exactly as the web dialog's is.
      onCancel()
      return
    }
    providerRef.current = null
    setProvider(null)
    setError(null)
    setNote(null)
  }, [initialProvider, onCancel])

  /** Open the provider's key page, saying what came of it. */
  const openKeyPage = useCallback((): void => {
    const url = providerInfo(providerRef.current ?? '')?.keyUrl
    if (url === undefined) return
    setNote(
      openUrl(url)
        ? `Opening ${url} in your browser.`
        : `No browser here (no display, CI or SSH) — open ${url} yourself.`,
    )
  }, [openUrl])

  const save = useCallback(
    (apiKey: string): void => {
      const target = providerRef.current
      if (target === null || savingRef.current) return
      savingRef.current = true
      setSaving(true)
      setError(null)
      setNote(null)
      void (async () => {
        try {
          const form = formForCredential(providerInfo(target)?.credential)
          await client.providerCredentials.put(target, form.build({ api_key: apiKey }))
          onSaved(target)
        } catch (failure) {
          if (failure instanceof AuthenticationError) {
            onStaleSession()
            return
          }
          setError(describeSaveFailure(failure, context))
          savingRef.current = false
          setSaving(false)
        }
      })()
    },
    [client, context, onSaved, onStaleSession],
  )

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onCancel()
      return
    }

    // The key step's own keys belong to the SecretInput; only the shared cancel is read here.
    if (providerRef.current !== null) return

    if (key.escape) {
      onCancel()
      return
    }
    if (key.upArrow) {
      moveTo(indexRef.current - 1)
      return
    }
    if (key.downArrow) {
      moveTo(indexRef.current + 1)
      return
    }
    if (key.return) {
      const picked = PROVIDERS[indexRef.current]
      if (picked !== undefined) choose(picked.id)
      return
    }
    // `o` on the list opens the highlighted provider's key page — the same key the form binds.
    if (input === 'o') openKeyPage()
  })

  if (provider === null) {
    return (
      <Box flexDirection="column">
        <Text>
          No provider key yet — a chat runs on a model from a provider you have a key for.
        </Text>
        <Text dimColor>
          Pick one; the key is validated once against the provider and stored encrypted on the
          server, never on this machine.
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {PROVIDERS.map((entry, position) => (
            <Text key={entry.id} color={position === index ? 'cyan' : undefined}>
              {`${position === index ? '❯' : ' '} ${entry.name}${
                entry.freeTier === undefined ? '' : ` · ${entry.freeTier}`
              }`}
            </Text>
          ))}
        </Box>
        {note !== null && <Text dimColor>{note}</Text>}
        <Text dimColor>↑/↓ to choose, Enter to connect, o for its key page, Esc to skip.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>{`Connect ${providerName(provider)}`}</Text>
      {info !== undefined && (
        <Text>
          {`Get a key: ${info.keyUrl}`}
          <Text dimColor> — press o to open it</Text>
        </Text>
      )}
      {info?.freeTier !== undefined && <Text dimColor>{info.freeTier}</Text>}
      {error !== null && <Text color="red">{error}</Text>}
      {note !== null && <Text dimColor>{note}</Text>}
      <Box marginTop={1}>
        <SecretInput
          placeholder={info?.keyHint ?? 'paste the key'}
          busy={saving}
          onChar={(character) => {
            if (character !== 'o') return false
            openKeyPage()
            return true
          }}
          onSubmit={save}
          onCancel={backToPick}
        />
      </Box>
      {saving ? (
        <Text dimColor>saving…</Text>
      ) : (
        <Text dimColor>
          {`Enter to save, Esc to go back${info?.keyUrl === undefined ? '' : ', o (before typing) for the key page'}.`}
        </Text>
      )}
    </Box>
  )
}

/**
 * Which row the list starts on: the named provider where the caller named one, the first row
 * otherwise. A provider the metadata list has never heard of starts on the first row, because
 * there is no row to sit on — the key form is reached directly either way.
 */
function providerIndex(initialProvider: string | undefined): number {
  if (initialProvider === undefined) return 0
  const found = PROVIDERS.findIndex((entry) => entry.id === initialProvider)
  return found === -1 ? 0 : found
}

/**
 * The one line a failed save gets.
 *
 * A rejected key is the case worth a sentence of its own: the provider said no, and the fix is
 * almost always to paste again. Everything else is the server's message as it stands. Neither
 * can carry the key — the API is write-only, and no response, error or debug line echoes it
 * (epic #65, A5) — which is the property the security tests assert.
 */
function describeSaveFailure(failure: unknown, context: ErrorContext | undefined): string {
  if (failure instanceof ApiError && failure.type === 'invalid_provider_credential') {
    return `The key was rejected: ${failure.message} Try again, or Esc to go back.`
  }
  const report = describeError(failure, context)
  return report.hints.length === 0 ? report.message : `${report.message} ${report.hints.join(' ')}`
}
