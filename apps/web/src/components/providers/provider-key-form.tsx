import { type CredentialTarget, credentialDisplayName } from '@openharness/client'
import { ArrowUpRight } from 'lucide-react'
import {
  BEDROCK_REGIONS,
  DEFAULT_BEDROCK_REGION,
  VERTEX_LOCATIONS,
  isBedrockRegion,
  isReservedCredentialName,
  isServiceAccountKey,
  isValidCredentialName,
  parseServiceAccountKey,
  type ProviderCredential,
  type ProviderCredentialType,
  type PutProviderCredentialRequest,
  type VertexLocation,
} from '@openharness/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'

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
  /**
   * What the field is drawn as. `password` is the default — a credential field is usually a
   * secret and is masked — and `select` is a value from a fixed list, which is what a region is:
   * a free-text one would go into an AWS hostname.
   */
  readonly kind?: 'password' | 'text' | 'select'
  /** The choices a `select` offers, in order. */
  readonly options?: readonly string[]
  /** The value a field starts at, for a field that is never empty. A `select` needs one. */
  readonly defaultValue?: string
  /**
   * Whether the field may be left blank. An absent optional field is omitted from the request
   * body rather than sent as an empty string, which is what the protocol's optional fields
   * (Bedrock's session token) accept and an empty one does not.
   */
  readonly optional?: boolean
  /** A field a reader pastes or uploads a whole document into: several lines, not one. */
  readonly multiline?: boolean
  /** Offer a file picker that reads a file into this field — a key document to upload. */
  readonly upload?: boolean
  /** Why what is typed cannot be used, or `null` — shown under the field, and it holds Save. */
  readonly validate?: (value: string) => string | null
  /**
   * A field a whole service-account **key document** goes into (Vertex, #251).
   *
   * It is the one field this form draws unmasked on purpose — a reader has to be able to check
   * what they pasted — so once what is in it parses as a service-account key the field is
   * **replaced by a summary** of the document's public facts (the client email, the project id
   * and the key id) and a Replace action that clears it. Nothing of the document, the private
   * key above all, is ever drawn after it parses: a screen share or a screenshot of a filled
   * form must not be able to carry key material.
   */
  readonly keyDocument?: boolean
}

/** One credential type's form: the fields, and how they become a request body. */
interface CredentialForm {
  readonly fields: readonly CredentialField[]
  /** The body `PUT /v1/provider-credentials/{name}` takes. */
  readonly build: (values: Readonly<Record<string, string>>) => PutProviderCredentialRequest
  /**
   * The fields a change to `changed` fills in, for a form where one field defaults another.
   *
   * A Vertex credential's project defaults from the key document the reader pasted, and this is
   * where the form says so. It answers **only the fields it fills** — anything already typed is
   * the reader's and is never overwritten — and it is applied when the named field changes, not
   * on every keystroke, so clearing a field to retype it does not put the default back.
   */
  readonly derive?: (
    changed: string,
    values: Readonly<Record<string, string>>,
  ) => Readonly<Record<string, string>>
}

/** The values key the credential-name input uses; not a field of any payload. */
const NAME_FIELD = 'credential_name'

/**
 * What a `select` is drawn as: the input's own box, with room on the right for the arrow the
 * platform draws. Tokens rather than colours, so it follows the theme like every other control.
 */
const SELECT_CLASS =
  'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30'

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
 * model. `openai_compatible` (#249, A3b) collects a base URL and an **optional** key: the
 * endpoint's own `/models` list is what becomes the models, so there is nothing else to type.
 * `bedrock` (#245, A3c) collects the region (a dropdown, because the region is spliced
 * into an AWS hostname and free text could only name a host that does not exist) and the two
 * IAM keys, plus the session token temporary credentials carry when there is one. `vertex`
 * (#245, A3d) collects the service-account key document — pasted or uploaded — with the project
 * and the location it runs in; the document collapses to a summary once it parses, so no part of
 * a private key stays on screen.
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
  openai_compatible: {
    fields: [
      {
        name: 'base_url',
        label: 'Base URL',
        placeholder: 'http://localhost:11434/v1',
        help: 'The OpenAI-compatible API root — the address its /models endpoint lives under. It is checked on save, and only http and https are accepted.',
        kind: 'text',
      },
      {
        name: 'api_key',
        label: 'API key (optional)',
        placeholder: '…',
        help: 'Sent once, stored encrypted on the server, never shown again. Leave it empty for an endpoint that takes no key, such as a local server.',
        optional: true,
      },
    ],
    // The key is omitted entirely when it is empty: the schema accepts a missing key but not an
    // empty string, and an endpoint that takes none must send no `Authorization` header.
    build: (values) => {
      const apiKey = (values.api_key ?? '').trim()
      return {
        type: 'openai_compatible',
        base_url: (values.base_url ?? '').trim(),
        ...(apiKey === '' ? {} : { api_key: apiKey }),
      }
    },
  },
  bedrock: {
    fields: [
      {
        name: 'region',
        label: 'Region',
        kind: 'select',
        options: BEDROCK_REGIONS,
        defaultValue: DEFAULT_BEDROCK_REGION,
        placeholder: DEFAULT_BEDROCK_REGION,
        help: 'The AWS region the models run in. Your credential lists and calls this region only.',
      },
      {
        name: 'access_key_id',
        label: 'Access key ID',
        kind: 'text',
        placeholder: 'AKIA…',
        help: 'The IAM access key ID. Sent once, stored encrypted on the server, never shown again — only its last four characters are.',
      },
      {
        name: 'secret_access_key',
        label: 'Secret access key',
        placeholder: '…',
        help: 'The IAM secret access key. Sent once, stored encrypted, never returned by any response or written to a log.',
      },
      {
        name: 'session_token',
        label: 'Session token',
        optional: true,
        placeholder: 'Optional',
        help: 'Only for temporary credentials (SSO, an assumed role). Leave it empty for a long-lived IAM user key.',
      },
    ],
    build: (values) => {
      const region = values.region ?? ''
      const sessionToken = (values.session_token ?? '').trim()
      return {
        type: 'bedrock',
        // The field is a `select` over the protocol's list, so the fallback is unreachable; it
        // is what makes the value a region to the compiler without a cast.
        region: isBedrockRegion(region) ? region : DEFAULT_BEDROCK_REGION,
        access_key_id: (values.access_key_id ?? '').trim(),
        // Both halves are trimmed, because both are copied out of a console or a downloaded
        // `.csv` — where a trailing newline is the normal case, and a signature computed over
        // one is a signature AWS rejects while the reader looks at two correct-looking keys.
        secret_access_key: (values.secret_access_key ?? '').trim(),
        ...(sessionToken === '' ? {} : { session_token: sessionToken }),
      }
    },
  },
  vertex: {
    fields: [
      {
        name: 'service_account',
        label: 'Service account key',
        placeholder: '{ "type": "service_account", … }',
        help: 'The JSON key file Google Cloud issued for a service account, pasted or uploaded whole. It is sent once, stored encrypted on the server, and never shown again.',
        multiline: true,
        upload: true,
        keyDocument: true,
        validate: (value) =>
          value.trim() === '' || isServiceAccountKey(value)
            ? null
            : 'That is not a service-account key file. Download one from the service account’s Keys page.',
      },
      {
        name: 'project',
        label: 'Project ID',
        placeholder: 'my-project-123456',
        // The document carries a project already, and `derive` fills this in from it — a
        // service account with access to several projects may name another.
        help: 'The Google Cloud project the models run in. Defaults to the project the key belongs to.',
      },
      {
        name: 'location',
        label: 'Location',
        kind: 'select',
        options: VERTEX_LOCATIONS,
        placeholder: 'us-central1',
        help: 'The Vertex AI region the models run in — the location is the host every request goes to. The key’s project page lists the regions it serves.',
      },
    ],
    build: (values): PutProviderCredentialRequest => ({
      type: 'vertex',
      service_account: values.service_account ?? '',
      project: (values.project ?? '').trim(),
      // The select offers the protocol's locations and nothing else, so this is the only value
      // it can hold; an empty one is refused before the request is made.
      location: (values.location ?? '') as VertexLocation,
    }),
    derive: (changed, values): Record<string, string> => {
      if (changed !== 'service_account' || (values.project ?? '').trim() !== '') {
        return {}
      }
      const key = parseServiceAccountKey(values.service_account ?? '')
      return key === null ? {} : { project: key.project_id }
    },
  },
}

/**
 * The value every field of a form starts at: empty, or the field's own default.
 *
 * A `select` is never empty — there is no "no region" a Bedrock credential could be saved
 * with — so it starts at its default and a successful save resets to the same place.
 */
function emptyValues(form: CredentialForm): Record<string, string> {
  return Object.fromEntries(form.fields.map((field) => [field.name, field.defaultValue ?? '']))
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

  const modelIdHint = target.modelIdHint
  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...emptyValues(form),
    ...(asksForName ? { [NAME_FIELD]: initialName ?? '' } : {}),
  }))
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<{
    kind: 'invalid' | 'session' | 'error'
    message: string
  } | null>(null)
  /**
   * The first field of the form, whichever element it is — an `<Input>` for most types, the
   * region's `<select>` for Bedrock — so the caret lands in it when the form opens.
   *
   * A callback ref rather than a `RefObject`: a shared `useRef` would have to be typed as the
   * union, and neither `<input>` nor `<select>` accepts a ref of the union. The callback takes
   * the union as its *parameter*, which both elements satisfy.
   */
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null)
  const firstFieldRef = useCallback((element: HTMLInputElement | HTMLSelectElement | null) => {
    inputRef.current = element
  }, [])
  // A field that is a document (Vertex's key) is a textarea rather than an input, so the two
  // elements keep a ref each rather than one union-typed one.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  /**
   * Apply one field's new value, and then whatever the change defaults.
   *
   * `derive` is how a form says one field fills another in — Vertex's project, from the key
   * document just pasted — and it runs here rather than on every render, so a field the reader
   * clears stays cleared.
   */
  const change = (field: string, value: string): void => {
    setValues((current) => {
      const next = { ...current, [field]: value }
      return { ...next, ...(form.derive?.(field, next) ?? {}) }
    })
  }

  /** Read an uploaded file into a field: the same value pasting its contents would give. */
  const readFile = async (file: File, field: string): Promise<void> => {
    change(field, await file.text())
  }

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
      ;(inputRef.current ?? textareaRef.current)?.focus()
    }
  }, [autoFocus, target.name])

  const typedName = (values[NAME_FIELD] ?? '').trim()
  const name = asksForName ? typedName : target.name
  const nameError = !asksForName
    ? null
    : nameErrorMessage(typedName, storedNames, target, initialName)
  // An optional field — Bedrock's session token — may be blank; everything else has to be
  // filled before a save is offered, so the reader is not sent a request the provider will
  // refuse over a field the form could have shown as missing. A name the form asks for counts
  // as filled only when it has been answered, and it is not one of `form.fields`.
  const fieldErrorOf = (field: CredentialField): string | null =>
    field.validate?.(values[field.name] ?? '') ?? null
  const filled =
    (!asksForName || typedName !== '') &&
    form.fields.every(
      (field) => field.optional === true || (values[field.name] ?? '').trim() !== '',
    ) &&
    form.fields.every((field) => fieldErrorOf(field) === null) &&
    nameError === null
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
        {target.keyUrl === undefined ? null : (
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
        )}
      </div>
      {target.freeTier === undefined ? null : <FreeTierChip hint={target.freeTier} />}

      {asksForName ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`provider-${NAME_FIELD}`}>Name</Label>
          <Input
            id={`provider-${NAME_FIELD}`}
            aria-label="Name"
            ref={firstFieldRef}
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
              `What this credential is called. Its models are named after it — ${
                typedName === '' ? target.name : typedName
              }/${modelIdHint}.`}
          </p>
        </div>
      ) : null}

      {form.fields.map((field, index) => {
        const fieldError = fieldErrorOf(field)
        // A service-account document is replaced by its summary the moment it parses (#251):
        // the field is the one thing drawn unmasked here, and a private key must not stay on a
        // screen someone may be sharing. Only `keyDocument` fields do this, and they are the
        // only ones whose value is a whole document.
        const key =
          field.keyDocument === true ? parseServiceAccountKey(values[field.name] ?? '') : null
        return (
          <div key={field.name} className="flex flex-col gap-1.5">
            <Label htmlFor={`provider-${field.name}`}>{field.label}</Label>
            {key !== null ? (
              // The summary carries the document's **public** facts and nothing else. The
              // private key, and the rest of the document, are not rendered, logged or kept
              // by this component after the parse.
              <div
                data-slot="key-document-summary"
                className="flex flex-col gap-1 rounded-md border bg-muted/40 px-3 py-2"
              >
                <p className="font-mono text-xs break-all">{key.client_email}</p>
                <p className="text-xs text-muted-foreground">
                  project {key.project_id} · key {key.private_key_id}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() => {
                    change(field.name, '')
                  }}
                >
                  Replace
                </Button>
              </div>
            ) : field.kind === 'select' ? (
              // A native `<select>`: the list is short and fixed, and `index.css` sets
              // `color-scheme` per theme, so its popup follows Light/Dim/Dark like the rest of
              // the page. (The model picker cannot be one — its list is long, searchable and
              // live — which is why that one is the app's own listbox.)
              <select
                id={`provider-${field.name}`}
                aria-label={field.label}
                ref={index === 0 && !asksForName ? firstFieldRef : undefined}
                className={SELECT_CLASS}
                value={values[field.name] ?? ''}
                onChange={(event) => {
                  change(field.name, event.target.value)
                }}
              >
                {/* A field that may start empty — Vertex's location, unlike Bedrock's region,
                    which is never empty — offers an unselected row so the reader must choose
                    rather than silently saving the first option. */}
                {field.defaultValue === undefined ? (
                  <option value="">
                    {field.placeholder === '' ? 'Choose…' : `Choose ${field.placeholder}…`}
                  </option>
                ) : null}
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : field.multiline === true ? (
              <Textarea
                id={`provider-${field.name}`}
                ref={index === 0 && !asksForName ? textareaRef : undefined}
                aria-label={field.label}
                // `field-sizing-fixed`, against the primitive's `field-sizing-content`: a pasted
                // key document is one very long line (its PEM's newlines are escapes), and a box
                // that grows to fit it would push the dialog wider than the screen. The box keeps
                // its rows and scrolls instead.
                className="field-sizing-fixed max-h-48 min-h-32 overflow-auto font-mono text-xs"
                rows={6}
                value={values[field.name] ?? ''}
                autoComplete="off"
                spellCheck={false}
                placeholder={field.placeholder}
                onChange={(event) => {
                  change(field.name, event.target.value)
                }}
              />
            ) : (
              <Input
                id={`provider-${field.name}`}
                ref={index === 0 && !asksForName ? firstFieldRef : undefined}
                type={
                  field.kind === 'text' || field.name === 'endpoint' || field.name === 'deployments'
                    ? 'text'
                    : 'password'
                }
                value={values[field.name] ?? ''}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  field.name === 'api_key'
                    ? (target.keyHint ?? field.placeholder)
                    : field.placeholder
                }
                onChange={(event) => {
                  change(field.name, event.target.value)
                }}
              />
            )}
            {field.upload === true && key === null ? (
              <Input
                type="file"
                aria-label={`Upload ${field.label}`}
                accept=".json,application/json"
                className="text-xs"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file !== undefined) {
                    void readFile(file, field.name)
                  }
                }}
              />
            ) : null}
            <p className="text-xs text-muted-foreground">{fieldError ?? field.help}</p>
          </div>
        )
      })}

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
 * to the field rather than in a banner. A name already in use is refused here too: adding a
 * credential is not how one replaces another, and a name the reader typed by accident should
 * not silently overwrite one.
 *
 * `replacingName` is the name of the credential a row's Replace is editing, and it is exempt
 * from that last rule: the form opens prefilled with **its own** name, so refusing that name
 * would leave the Save button disabled for every named credential — a row that could never be
 * replaced.
 */
function nameErrorMessage(
  name: string,
  storedNames: readonly string[],
  target: CredentialTarget,
  replacingName?: string,
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
  if (name !== replacingName && storedNames.includes(name)) {
    return `You already have a ${credentialDisplayName({ name, type: target.credential })} credential called that. Pick another name.`
  }
  return null
}
