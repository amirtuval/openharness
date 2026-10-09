import { type CredentialTarget, credentialDisplayName } from '@openharness/client'
import { ArrowUpRight } from 'lucide-react'
import {
  isReservedCredentialName,
  isValidCredentialName,
  type ProviderCredential,
  type ProviderCredentialType,
  type PutProviderCredentialRequest,
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
 * The credential form for one target (epic #201, X5/X6; named credentials: #245 A3a).
 *
 * It is the *only* form a reader ever types a secret into: the first-run screen, the
 * Add-provider dialog and Settings → Providers all render this component, so "paste and
 * validate a secret" means exactly the same thing everywhere, and a fix to it is a fix to all
 * three.
 *
 * **The fields come from the credential type** (X6). {@link CREDENTIAL_FORMS} is a table from
 * the protocol's `ProviderCredentialType` to the fields that type collects and the request body
 * they build; the `Record` is what makes a new member a compile error here until it has a form.
 * Nothing else in the app knows how many fields a credential has.
 *
 * **A named target may also ask for a name.** The eleven providers are one each (`name` is
 * their id); a named type — Azure OpenAI — keeps as many credentials as the reader wants, each
 * under a name that becomes the `provider` half of its model ids. The name field appears only
 * when a credential of that type is already stored (the first one takes the type's default), and
 * the name it saves under is what the reader typed.
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
  /** The body `PUT /v1/provider-credentials/{name}` takes. */
  readonly build: (values: Readonly<Record<string, string>>) => PutProviderCredentialRequest
}

/** The values key the credential-name input uses; not a field of any payload. */
const NAME_FIELD = 'credential_name'

/** Split the deployment list a reader typed: commas or newlines, blanks dropped. */
function splitDeployments(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((name) => name.trim())
    .filter((name) => name !== '')
}

/**
 * The form table, keyed by the protocol's credential type.
 *
 * `api_key` is one secret, and it is the only place a single key is read in this app.
 * `azure_openai` (#245, A3a) collects the resource endpoint, the key and the deployment names —
 * Azure offers no endpoint that lists deployments, so the reader types them and each becomes a
 * model.
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
  azure_openai: {
    fields: [
      {
        name: 'endpoint',
        label: 'Endpoint',
        placeholder: 'https://my-resource.openai.azure.com',
        help: 'The Azure OpenAI resource endpoint from the portal, over https.',
      },
      {
        name: 'api_key',
        label: 'API key',
        placeholder: '…',
        help: 'Sent once, stored encrypted on the server, never shown again. Saving replaces the key stored under this name.',
      },
      {
        name: 'deployments',
        label: 'Deployments',
        placeholder: 'gpt-4o, gpt-4o-mini',
        help: 'The deployment names your resource serves, separated by commas. Each becomes a model you can pick.',
      },
    ],
    build: (values) => ({
      type: 'azure_openai',
      endpoint: (values.endpoint ?? '').trim(),
      api_key: values.api_key ?? '',
      deployments: splitDeployments(values.deployments ?? ''),
    }),
  },
}

/** The empty value for every field of a form: what a successful save resets to. */
function emptyValues(form: CredentialForm): Record<string, string> {
  return Object.fromEntries(form.fields.map((field) => [field.name, '']))
}

/** What the form takes. */
export interface ProviderKeyFormProps {
  /** What is being connected: the tile the reader picked, or the row they asked to replace. */
  readonly target: CredentialTarget
  /** Every credential name the account already has: what decides the name field and "Replace". */
  readonly storedNames: readonly string[]
  /**
   * The name to save under, for a row's Replace: a second Azure credential's row reopens its
   * own form, prefilled with the name it is stored under.
   */
  readonly initialName?: string | undefined
  /** The write itself; the caller owns the client and the list around it. */
  readonly save: (
    name: string,
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
  target,
  storedNames,
  initialName,
  save,
  onSaved,
  returnHash,
  onCancel,
  cancelLabel = 'Cancel',
  autoFocus = false,
}: ProviderKeyFormProps) {
  const form = CREDENTIAL_FORMS[target.credential]
  // The first credential of a named type takes the type's default name; a second one has to be
  // told apart from it, so it asks. A replace always shows the name it replaces.
  const asksForName =
    target.named && (storedNames.includes(target.name) || initialName !== undefined)

  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...emptyValues(form),
    ...(asksForName ? { [NAME_FIELD]: initialName ?? '' } : {}),
  }))
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<{
    kind: 'invalid' | 'session' | 'error'
    message: string
  } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // A form for another target — the dialog swaps it under the form — starts empty, so one
  // credential's secret can never be sent for another.
  useEffect(() => {
    setValues({
      ...emptyValues(form),
      ...(asksForName ? { [NAME_FIELD]: initialName ?? '' } : {}),
    })
    setFailure(null)
    // The reset is keyed by the target and the name decision, not by the values it derives
    // from: re-running it on every keystroke would wipe the input the reader is typing into.
  }, [target.name, target.credential, asksForName, initialName])

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus()
    }
  }, [autoFocus, target.name])

  const typedName = (values[NAME_FIELD] ?? '').trim()
  const name = asksForName ? typedName : target.name
  const nameError = !asksForName ? null : nameErrorMessage(typedName, storedNames, target)
  const filled =
    form.fields.every((field) => (values[field.name] ?? '').trim() !== '') && nameError === null
  const replacing = name !== '' && storedNames.includes(name)

  const submit = async (): Promise<void> => {
    if (!filled || submitting) {
      return
    }
    setSubmitting(true)
    setFailure(null)
    const result = await save(name, form.build(values))
    setSubmitting(false)
    if (!result.ok) {
      setFailure(result)
      return
    }
    // Cleared on success, and it was never rendered anywhere: the field the reader typed into
    // is the only place the secret ever lived in this app.
    setValues({
      ...emptyValues(form),
      ...(asksForName ? { [NAME_FIELD]: result.credential.name } : {}),
    })
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
          // Warm, but still the truth: the provider refused the credential, and the server's own
          // sentence is the body verbatim (U12, #227). A failure is never softened into vagueness.
          title={
            failure.kind === 'invalid'
              ? `Hmm, ${target.displayName} didn't accept that`
              : 'The request failed'
          }
          message={failure.message}
          onDismiss={() => setFailure(null)}
        />
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{target.displayName}</p>
        <a
          className="inline-flex items-center gap-0.5 text-xs underline underline-offset-2"
          href={target.keyUrl}
          target="_blank"
          rel="noreferrer"
        >
          Get a key
          {/* The mark that this leaves the app, as an icon rather than a `↗` character:
              a literal arrow is a font's to draw, and the headless stack draws it as a box. */}
          <ArrowUpRight aria-hidden="true" className="size-3" />
        </a>
      </div>
      {target.freeTier === undefined ? null : <FreeTierChip hint={target.freeTier} />}

      {asksForName ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`provider-${NAME_FIELD}`}>Name</Label>
          <Input
            id={`provider-${NAME_FIELD}`}
            aria-label="Name"
            ref={inputRef}
            value={values[NAME_FIELD] ?? ''}
            autoComplete="off"
            spellCheck={false}
            placeholder={target.name}
            onChange={(event) => {
              setValues((current) => ({ ...current, [NAME_FIELD]: event.target.value }))
            }}
          />
          <p className="text-xs text-muted-foreground">
            {nameError ??
              `What this credential is called. Its models are named after it — ${name}/<deployment>.`}
          </p>
        </div>
      ) : null}

      {form.fields.map((field, index) => (
        <div key={field.name} className="flex flex-col gap-1.5">
          <Label htmlFor={`provider-${field.name}`}>{field.label}</Label>
          <Input
            id={`provider-${field.name}`}
            ref={index === 0 && !asksForName ? inputRef : undefined}
            type={field.name === 'endpoint' || field.name === 'deployments' ? 'text' : 'password'}
            value={values[field.name] ?? ''}
            autoComplete="off"
            spellCheck={false}
            placeholder={
              field.name === 'api_key' ? (target.keyHint ?? field.placeholder) : field.placeholder
            }
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

/**
 * Why a typed credential name cannot be saved, or `null` when it can.
 *
 * The server enforces exactly these two rules (the format, and that no fixed provider id is
 * taken), so this is the form saying what the route would say — before a round trip, and next
 * to the field rather than in a banner. A name already in use is refused here too: replacing a
 * credential is a row's Replace, and a name the reader typed by accident should not silently
 * overwrite another credential.
 */
function nameErrorMessage(
  name: string,
  storedNames: readonly string[],
  target: CredentialTarget,
): string | null {
  if (name === '') {
    return null
  }
  if (!isValidCredentialName(name)) {
    return 'A name is short and lowercase: letters, digits and dashes, e.g. `azure-eu`.'
  }
  if (isReservedCredentialName(name)) {
    return 'That name belongs to one of the built-in providers. Pick another.'
  }
  if (storedNames.includes(name)) {
    return `You already have a ${credentialDisplayName({ name, type: target.credential })} credential called that. Pick another name.`
  }
  return null
}
