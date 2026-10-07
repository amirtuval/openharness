import type { ProviderCredentialType, PutProviderCredentialRequest } from '@openharness/protocol'

/**
 * The key form, built from the **credential type** (epic #201, X6) — the CLI's half of the
 * table the web app keeps in `apps/web/src/components/providers/provider-key-form.tsx`.
 *
 * `api_key` is the only member of the protocol's `ProviderCredentialType` today, and it is the
 * only place in this package a secret is read. The `Record` is the point: Bedrock (`aws`),
 * Vertex (`gcp_service_account`) and Azure (`azure`) arrive as new members of the protocol's
 * union, and each one is a compile error here until it has fields — so a form cannot silently
 * collect the wrong shape for a credential it does not understand.
 *
 * The two frontends keep their own copies rather than sharing one: the web form is React DOM
 * with Tailwind classes, this one is Ink, and the only thing they have in common — the field
 * names and the request body — is the protocol's, which is where the truth lives. The
 * `e2e` suite is what holds the two to the same *behaviour* (a key saved here is one the
 * server validates for the web app too).
 */

/** One input a credential type collects. */
export interface CredentialField {
  /** The key in the values record, and the request field it becomes. */
  readonly name: string
  /** What the prompt calls it. */
  readonly label: string
}

/** One credential type's form: the fields, and how they become a request body. */
export interface CredentialForm {
  readonly fields: readonly CredentialField[]
  /** The body `PUT /v1/provider-credentials/{provider}` takes. */
  readonly build: (values: Readonly<Record<string, string>>) => PutProviderCredentialRequest
}

/**
 * The form table, keyed by the protocol's credential type.
 *
 * A type this table does not carry cannot be rendered: the lookup is typed, so the compiler
 * refuses a type it has never heard of rather than the flow asking for the wrong fields.
 */
export const CREDENTIAL_FORMS: Record<ProviderCredentialType, CredentialForm> = {
  api_key: {
    fields: [{ name: 'api_key', label: 'API key' }],
    build: (values) => ({ type: 'api_key', api_key: values['api_key'] ?? '' }),
  },
}

/**
 * The form for a provider, from the metadata the two frontends share.
 *
 * A provider the metadata list has never heard of is an `api_key` form, which is what every
 * provider the server can validate takes — the credentials API accepts any router id, so a
 * reader who names one this list does not carry still gets the one form that could work.
 */
export function formForCredential(credential: ProviderCredentialType | undefined): CredentialForm {
  return CREDENTIAL_FORMS[credential ?? 'api_key']
}
