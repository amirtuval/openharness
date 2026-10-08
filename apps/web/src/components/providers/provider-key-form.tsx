import { providerInfo } from '@openharness/client'
import { ArrowUpRight } from 'lucide-react'
import type {
  ProviderCredential,
  ProviderCredentialType,
  PutProviderCredentialRequest,
} from '@openharness/protocol'
import { useEffect, useRef, useState } from 'react'

import type { CredentialWriteResult } from '../../hooks/use-provider-credentials'
import { signInHash } from '../../lib/router'
import { ErrorBanner } from '../chat/error-banner'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { FreeTierChip } from './free-tier-chip'

/**
 * The key form for one provider (epic #201, X5/X6).
 *
 * It is the *only* form a reader ever types a key into: the first-run screen, the Add-provider
 * dialog and Settings → Providers all render this component, so "paste and validate a key"
 * means exactly the same thing everywhere, and a fix to it is a fix to all three.
 *
 * **The fields come from the credential type** (X6). {@link CREDENTIAL_FORMS} is a table from
 * the protocol's `ProviderCredentialType` to the fields that type collects and the request body
 * they build; `api_key` is the only member today, and the `Record` is what makes a new member —
 * Bedrock, Vertex, Azure — a compile error here until it has a form. Nothing else in the app
 * knows how many fields a credential has.
 */

/** One input a credential type collects. */
interface CredentialField {
  /** The key in the values record, and the request field it becomes. */
  readonly name: string
  readonly label: string
  /** Shown in the input when it is empty; the provider's key format where one was given. */
  readonly placeholder: string
  /** The line under the input. Says what happens to what was typed. */
  readonly help: string
}

/** One credential type's form: the fields, and how they become a request body. */
interface CredentialForm {
  readonly fields: readonly CredentialField[]
  /** The body `PUT /v1/provider-credentials/{provider}` takes. */
  readonly build: (values: Readonly<Record<string, string>>) => PutProviderCredentialRequest
}

/**
 * The form table, keyed by the protocol's credential type.
 *
 * `api_key` is the only member of `ProviderCredentialType` today (epic #65, A5), and it is the
 * only place a secret is read in this app. Bedrock (`aws`), Vertex (`gcp_service_account`) and
 * Azure (`azure`) arrive here as new members in phase 4, each adding its own fields — a region,
 * a role ARN, a JSON blob — and nothing outside this table and the protocol's union changes.
 */
const CREDENTIAL_FORMS: Record<ProviderCredentialType, CredentialForm> = {
  api_key: {
    fields: [
      {
        name: 'api_key',
        label: 'API key',
        placeholder: 'sk-…',
        help: 'Sent once, stored encrypted on the server, never shown again. Saving replaces the key stored for this provider.',
      },
    ],
    build: (values) => ({ type: 'api_key', api_key: values.api_key ?? '' }),
  },
}

/** The empty value for every field of a form: what a successful save resets to. */
function emptyValues(form: CredentialForm): Record<string, string> {
  return Object.fromEntries(form.fields.map((field) => [field.name, '']))
}

/** What the form takes. */
export interface ProviderKeyFormProps {
  /** The Mastra router id the key is for. */
  readonly provider: string
  /** A key for this provider is already stored, so saving replaces it. */
  readonly replacing: boolean
  /** The write itself; the caller owns the client and the list around it. */
  readonly save: (
    provider: string,
    body: PutProviderCredentialRequest,
  ) => Promise<CredentialWriteResult>
  /** The credential was stored. */
  readonly onSaved: (credential: ProviderCredential) => void
  /** Where a fresh sign-in should return to, for the one failure that needs it. */
  readonly returnHash: string
  /**
   * Rendered as a second button when given, which is "Back to the list" in the dialog (a
   * provider was picked from the tiles) and "Cancel" in the first-run flow (the screen is the
   * whole flow, so going back is leaving the form, not leaving a list).
   */
  readonly onCancel?: (() => void) | undefined
  /** What that button says. */
  readonly cancelLabel?: string | undefined
  /** Put the cursor in the first field (the first-run screen and the dialog do). */
  readonly autoFocus?: boolean | undefined
}

export function ProviderKeyForm({
  provider,
  replacing,
  save,
  onSaved,
  returnHash,
  onCancel,
  cancelLabel = 'Cancel',
  autoFocus = false,
}: ProviderKeyFormProps) {
  const info = providerInfo(provider)
  // A provider this app has never heard of — the credentials API takes any router id — is an
  // `api_key` form, because that is what every provider the server can validate takes.
  const form = CREDENTIAL_FORMS[info?.credential ?? 'api_key']

  const [values, setValues] = useState<Record<string, string>>(() => emptyValues(form))
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<{
    kind: 'invalid' | 'session' | 'error'
    message: string
  } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // A form for another provider — the dialog swaps the provider under it — starts empty, so one
  // provider's key can never be sent for another.
  useEffect(() => {
    setValues(emptyValues(form))
    setFailure(null)
  }, [provider, form])

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus()
    }
  }, [autoFocus, provider])

  const filled = form.fields.every((field) => (values[field.name] ?? '').trim() !== '')

  const submit = async (): Promise<void> => {
    if (!filled || submitting) {
      return
    }
    setSubmitting(true)
    setFailure(null)
    const result = await save(provider, form.build(values))
    setSubmitting(false)
    if (!result.ok) {
      setFailure(result)
      return
    }
    // Cleared on success, and it was never rendered anywhere: the field the reader typed into
    // is the only place the key ever lived in this app.
    setValues(emptyValues(form))
    onSaved(result.credential)
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {failure !== null && failure.kind === 'session' ? (
        <ErrorBanner
          title="Sign in again"
          message={failure.message}
          action={
            <a className="underline underline-offset-2" href={signInHash(returnHash)}>
              Sign in again
            </a>
          }
        />
      ) : failure !== null ? (
        <ErrorBanner
          // Warm, but still the truth: the provider refused the key, and the server's own
          // sentence — `The OpenAI credential was rejected by the provider.` — is the body
          // verbatim (U12, #227). A failure is never softened into vagueness.
          title={
            failure.kind === 'invalid'
              ? `Hmm, ${info?.name ?? provider} didn't accept that key`
              : 'The request failed'
          }
          message={failure.message}
          onDismiss={() => setFailure(null)}
        />
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{info?.name ?? provider}</p>
        {info === undefined ? null : (
          <a
            className="inline-flex items-center gap-0.5 text-xs underline underline-offset-2"
            href={info.keyUrl}
            target="_blank"
            rel="noreferrer"
          >
            Get a key
            {/* The mark that this leaves the app, as an icon rather than a `↗` character:
                a literal arrow is a font's to draw, and the headless stack draws it as a box. */}
            <ArrowUpRight aria-hidden="true" className="size-3" />
          </a>
        )}
      </div>
      {info?.freeTier === undefined ? null : <FreeTierChip hint={info.freeTier} />}

      {form.fields.map((field, index) => (
        <div key={field.name} className="flex flex-col gap-1.5">
          <Label htmlFor={`provider-${field.name}`}>{field.label}</Label>
          <Input
            id={`provider-${field.name}`}
            ref={index === 0 ? inputRef : undefined}
            type="password"
            value={values[field.name] ?? ''}
            autoComplete="off"
            spellCheck={false}
            placeholder={info?.keyHint ?? field.placeholder}
            onChange={(event) => {
              setValues((current) => ({ ...current, [field.name]: event.target.value }))
            }}
          />
          <p className="text-xs text-muted-foreground">{field.help}</p>
        </div>
      ))}

      <div className="flex items-center gap-2">
        <Button type="submit" className="self-start" disabled={submitting || !filled}>
          {submitting ? 'Saving…' : replacing ? 'Replace key' : 'Save key'}
        </Button>
        {onCancel === undefined ? null : (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
            {cancelLabel}
          </Button>
        )}
      </div>
    </form>
  )
}
