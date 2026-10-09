import {
  ApiError,
  AuthenticationError,
  CREDENTIAL_TARGETS,
  credentialDisplayName,
  type Client,
  type CredentialTarget,
} from '@openharness/client'
import { Box, Text, useInput } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import { describeError, type ErrorContext } from '../errors'
import {
  CREDENTIAL_NAME_FIELD,
  type CredentialField,
  formForCredential,
  nameErrorMessage,
} from '../providers/credential-form'
import { SecretInput } from './secret-input'

/**
 * Connecting a model provider from the terminal (#210, epic #201 X7/X8; named credentials:
 * #245 A3a) — the CLI's mirror of the web app's first-run flow and its Add-provider dialog.
 *
 * Two steps, one component: pick a target from `CREDENTIAL_TARGETS` (the eleven providers, then
 * the named credential types), then answer its fields — one prompt each, masked where the value
 * is a secret. On success the caller is told which credential was saved; on a secret the
 * provider refuses, the reason is shown and the same box asks again, because the usual mistake
 * is a key copied with a space in it. The flow settles exactly once — the caller's business is
 * what happens next, and there are three callers: the app's no-credentials screen, the
 * `/providers` slash command (`chat/commands.ts`) through the inline prompt slot, and
 * `oh providers add`.
 *
 * Three things about it are load-bearing, and all three are about the secret:
 *
 * - a secret field is typed into {@link SecretInput}, which echoes nothing and masks what it
 *   holds — so no frame, log or test snapshot can contain it;
 * - it goes straight to `client.providerCredentials.put`, which is the *same* write the web app
 *   makes (X7): the server validates it once against the provider and seals it. Nothing is
 *   written to this machine — there is no config-directory file a secret could land in;
 * - a failure is reported by the server's own message, which never carries the secret back.
 *
 * A **named** target also asks for a name, and only when one of its type is already stored: the
 * first Azure credential takes the type's default (`azure`), and a second has to be told apart
 * from it. That is why the flow reads the credential list once — the same read the web dialog
 * makes through its hook.
 *
 * The "get a key" URL is always printed, so a terminal that cannot open a browser (SSH, CI,
 * no display) still has what it needs; `o` opens it where a browser exists. Free-tier hints
 * come from the same metadata the web app's tiles show (X8).
 */

export interface ProviderSetupProps {
  /** The client the credential is saved through — `providerCredentials.put`. */
  readonly client: Client
  /** What the error messages should mention. */
  readonly context?: ErrorContext | undefined
  /** Start on this target's form, skipping the list; without one the flow starts on it. */
  readonly initialProvider?: string | undefined
  /** Open a URL in the browser; returns whether one was launched. Injectable for tests. */
  readonly openUrl: (url: string) => boolean
  /** The credential was stored. `name` is the name it is stored under. */
  readonly onSaved: (name: string) => void
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
  const [target, setTarget] = useState<CredentialTarget | null>(() =>
    targetForName(initialProvider),
  )
  const [index, setIndex] = useState(() => targetIndex(initialProvider))
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** The names already stored, or `null` until the one read lands. */
  const [storedNames, setStoredNames] = useState<readonly string[] | null>(null)
  /** Which prompt of the form is on screen. */
  const [step, setStep] = useState(0)

  // The cursor, the pending values and the position the handlers read, for the reason the model
  // picker keeps refs too: Ink hands `useInput` the latest *committed* render, so two keystrokes
  // inside one render would both read the state from before them.
  const indexRef = useRef(index)
  const targetRef = useRef(target)
  const savingRef = useRef(false)
  const valuesRef = useRef<Record<string, string>>({})
  const stepRef = useRef(0)

  // One read, for the one thing it decides: whether a named target has to ask for a name.
  useEffect(() => {
    let live = true
    void client.providerCredentials
      .list()
      .then((response) => {
        if (live) setStoredNames(response.data.map((credential) => credential.name))
      })
      .catch(() => {
        // A list that cannot be read must not block adding a credential. No names known means
        // a named target does not ask — and the server still refuses a name that is taken.
        if (live) setStoredNames([])
      })
    return () => {
      live = false
    }
  }, [client])

  const form = target === null ? null : formForCredential(target.credential)
  const asksForName =
    target !== null && target.named && storedNames !== null && storedNames.includes(target.name)
  const nameField: CredentialField = {
    name: CREDENTIAL_NAME_FIELD,
    // The second half of the model id depends on the type: an Azure credential's ids are
    // `<name>/<deployment>`, a custom endpoint's are `<name>/<model>` (#249).
    label: `Name (its models will be ${target?.name ?? ''}/${
      target?.credential === 'azure_openai' ? '<deployment>' : '<model>'
    })`,
    secret: false,
  }
  const steps: readonly CredentialField[] =
    form === null ? [] : [...(asksForName ? [nameField] : []), ...form.fields]
  const current = steps[step]

  const moveTo = (next: number): void => {
    const clamped = Math.min(Math.max(next, 0), CREDENTIAL_TARGETS.length - 1)
    indexRef.current = clamped
    setIndex(clamped)
  }

  const choose = (picked: CredentialTarget): void => {
    targetRef.current = picked
    setTarget(picked)
    valuesRef.current = {}
    stepRef.current = 0
    setStep(0)
    setError(null)
    setNote(null)
  }

  const backToPick = useCallback((): void => {
    if (initialProvider !== undefined) {
      // There is no list to go back to when the target was named: the flow's own cancel is the
      // way out, exactly as the web dialog's is.
      onCancel()
      return
    }
    targetRef.current = null
    setTarget(null)
    valuesRef.current = {}
    stepRef.current = 0
    setStep(0)
    setError(null)
    setNote(null)
  }, [initialProvider, onCancel])

  /** Open the target's page, saying what came of it. */
  const openKeyPage = useCallback((): void => {
    const url = targetRef.current?.keyUrl
    if (url === undefined) return
    setNote(
      openUrl(url)
        ? `Opening ${url} in your browser.`
        : `No browser here (no display, CI or SSH) — open ${url} yourself.`,
    )
  }, [openUrl])

  const save = useCallback((): void => {
    const picked = targetRef.current
    if (picked === null || savingRef.current || form === null) return
    const name = asksForName ? (valuesRef.current[CREDENTIAL_NAME_FIELD] ?? '') : picked.name
    const nameError = asksForName ? nameErrorMessage(name, storedNames ?? []) : null
    if (nameError !== null) {
      setError(nameError)
      return
    }
    savingRef.current = true
    setSaving(true)
    setError(null)
    setNote(null)
    void (async () => {
      try {
        await client.providerCredentials.put(name, form.build(valuesRef.current))
        onSaved(name)
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
  }, [asksForName, client, context, form, onSaved, onStaleSession, storedNames])

  /** One prompt answered: remember it, and move on — or save on the last one. */
  const submitStep = useCallback(
    (value: string): void => {
      const field = steps[stepRef.current]
      if (field === undefined) return
      valuesRef.current = { ...valuesRef.current, [field.name]: value }
      if (field.name === CREDENTIAL_NAME_FIELD) {
        const nameError = nameErrorMessage(value, storedNames ?? [])
        if (nameError !== null) {
          setError(nameError)
          return
        }
        setError(null)
      }
      if (stepRef.current >= steps.length - 1) {
        save()
        return
      }
      stepRef.current += 1
      setStep(stepRef.current)
    },
    [save, steps, storedNames],
  )

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onCancel()
      return
    }

    // The form's own keys belong to the SecretInput; only the shared cancel is read here.
    if (targetRef.current !== null) return

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
      const picked = CREDENTIAL_TARGETS[indexRef.current]
      if (picked !== undefined) choose(picked)
      return
    }
    // `o` on the list opens the highlighted target's page — the same key the form binds.
    if (input === 'o') openKeyPage()
  })

  if (target === null) {
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
          {CREDENTIAL_TARGETS.map((entry, position) => (
            <Text key={entry.name} color={position === index ? 'cyan' : undefined}>
              {`${position === index ? '❯' : ' '} ${entry.displayName}${
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

  // A named target waits for the one list read: without it the flow cannot know whether to ask
  // for a name, and asking after the fields were answered would be a second form.
  if (target.named && storedNames === null) {
    return (
      <Box flexDirection="column">
        <Text>{`Connect ${target.displayName}`}</Text>
        <Text dimColor>checking what you already have…</Text>
      </Box>
    )
  }

  if (current === undefined) {
    return (
      <Box flexDirection="column">
        <Text>{`Connect ${target.displayName}`}</Text>
        <Text dimColor>this credential type has no fields yet</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>{`Connect ${target.displayName}`}</Text>
      {target.keyUrl === undefined ? null : (
        <Text>
          {`Get a key: ${target.keyUrl}`}
          <Text dimColor> — press o to open it</Text>
        </Text>
      )}
      {target.freeTier !== undefined && <Text dimColor>{target.freeTier}</Text>}
      {error !== null && <Text color="red">{error}</Text>}
      {note !== null && <Text dimColor>{note}</Text>}
      <Box flexDirection="column" marginTop={1}>
        <Text>{current.label}</Text>
        <SecretInput
          // A new prompt is a new input: the key keeps Ink from reusing the previous field's
          // value, which would silently carry a secret into the next answer.
          key={`${target.name}:${current.name}:${step}`}
          placeholder={current.secret ? (target.keyHint ?? 'paste the key') : 'type it'}
          mask={current.secret}
          optional={current.optional === true}
          busy={saving}
          onChar={(character) => {
            // Only claim `o` when there is a page to open: a custom endpoint has none, and
            // claiming the letter would silently drop it from the URL being typed (#249).
            if (character !== 'o' || target.keyUrl === undefined) return false
            openKeyPage()
            return true
          }}
          onSubmit={submitStep}
          onCancel={backToPick}
        />
      </Box>
      {saving ? (
        <Text dimColor>saving…</Text>
      ) : (
        <Text dimColor>
          {`Enter to continue, Esc to go back${target.keyUrl === undefined ? '' : ', o (before typing) for the key page'}.`}
        </Text>
      )}
    </Box>
  )
}

/**
 * The target a name picked: the tile whose name it is.
 *
 * A caller that named a credential the list does not carry — a router id nobody configured —
 * gets `null` and the list, which is where they can pick one that exists.
 */
function targetForName(name: string | undefined): CredentialTarget | null {
  if (name === undefined) return null
  return CREDENTIAL_TARGETS.find((target) => target.name === name) ?? null
}

/** Which row the list starts on: the named target where the caller named one, the first otherwise. */
function targetIndex(name: string | undefined): number {
  if (name === undefined) return 0
  const found = CREDENTIAL_TARGETS.findIndex((target) => target.name === name)
  return found === -1 ? 0 : found
}

/**
 * The one line a failed save gets.
 *
 * A rejected credential is the case worth a sentence of its own: the provider said no, and the
 * fix is almost always to paste again. Everything else is the server's message as it stands.
 * Neither can carry the secret — the API is write-only, and no response, error or debug line
 * echoes it (epic #65, A5) — which is the property the security tests assert.
 */
function describeSaveFailure(failure: unknown, context: ErrorContext | undefined): string {
  if (failure instanceof ApiError && failure.type === 'invalid_provider_credential') {
    return `It was rejected: ${failure.message} Try again, or Esc to go back.`
  }
  const report = describeError(failure, context)
  return report.hints.length === 0 ? report.message : `${report.message} ${report.hints.join(' ')}`
}

/** The display name of a stored credential, re-exported for the callers that print one. */
export { credentialDisplayName }
