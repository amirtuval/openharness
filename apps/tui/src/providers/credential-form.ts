import {
  isReservedCredentialName,
  isValidCredentialName,
  type ProviderCredentialType,
  type PutProviderCredentialRequest,
} from '@openharness/protocol'

/**
 * The credential form, built from the **credential type** (epic #201, X6; #245 A3a) — the CLI's
 * half of the table the web app keeps in `apps/web/src/components/providers/provider-key-form.tsx`.
 *
 * `api_key` is one secret and `azure_openai` is an endpoint, a key and a deployment list; the
 * `Record` is the point: a new member of the protocol's union is a compile error here until it
 * has fields, so a form cannot silently collect the wrong shape for a credential it does not
 * understand.
 *
 * The two frontends keep their own copies rather than sharing one: the web form is React DOM
 * with Tailwind classes, this one is Ink, and the only thing they have in common — the field
 * names and the request body — is the protocol's, which is where the truth lives. The `e2e`
 * suite is what holds the two to the same *behaviour*.
 */

/** One input a credential type collects. */
export interface CredentialField {
  /** The key in the values record, and the request field it becomes. */
  readonly name: string
  /** What the prompt calls it. */
  readonly label: string
  /**
   * Whether the input hides what is typed.
   *
   * A secret field is masked, so no frame can hold it; an endpoint or a deployment list is not
   * a secret and is shown, because the reader has to check what they pasted.
   */
  readonly secret: boolean
}

/** One credential type's form: the fields, and how they become a request body. */
export interface CredentialForm {
  readonly fields: readonly CredentialField[]
  /** The body `PUT /v1/provider-credentials/{name}` takes. */
  readonly build: (values: Readonly<Record<string, string>>) => PutProviderCredentialRequest
}

/** The values key the credential-name input uses; not a field of any payload. */
export const CREDENTIAL_NAME_FIELD = 'credential_name'

/** Split the deployment list a reader typed: commas or newlines, blanks dropped. */
export function splitDeployments(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((name) => name.trim())
    .filter((name) => name !== '')
}

/**
 * The form table, keyed by the protocol's credential type.
 *
 * A type this table does not carry cannot be rendered: the lookup is typed, so the compiler
 * refuses a type it has never heard of rather than the flow asking for the wrong fields.
 */
export const CREDENTIAL_FORMS: Record<ProviderCredentialType, CredentialForm> = {
  api_key: {
    fields: [{ name: 'api_key', label: 'API key', secret: true }],
    build: (values) => ({ type: 'api_key', api_key: values['api_key'] ?? '' }),
  },
  azure_openai: {
    fields: [
      { name: 'endpoint', label: 'Endpoint (https://…openai.azure.com)', secret: false },
      { name: 'api_key', label: 'API key', secret: true },
      { name: 'deployments', label: 'Deployments (comma-separated)', secret: false },
    ],
    build: (values) => ({
      type: 'azure_openai',
      endpoint: (values['endpoint'] ?? '').trim(),
      api_key: values['api_key'] ?? '',
      deployments: splitDeployments(values['deployments'] ?? ''),
    }),
  },
}

/**
 * The form for a credential type, from the metadata the two frontends share.
 *
 * A type the metadata list has never heard of is an `api_key` form, which is what every
 * provider the server can validate takes — the credentials API accepts any router id, so a
 * reader who names one this list does not carry still gets the one form that could work.
 */
export function formForCredential(credential: ProviderCredentialType | undefined): CredentialForm {
  return CREDENTIAL_FORMS[credential ?? 'api_key']
}

/**
 * Why a typed credential name cannot be saved, or `null` when it can.
 *
 * The server enforces exactly these three rules — the format, that no fixed provider id is
 * taken, and that the name is free — so this is the flow saying what the route would say,
 * before a round trip and before the rest of the fields are asked for. A name already in use is
 * refused here too: the flow asks for a name precisely to keep two credentials of a type apart,
 * and one that is already stored would be replaced instead.
 */
export function nameErrorMessage(name: string, storedNames: readonly string[]): string | null {
  if (name === '') {
    return null
  }
  if (!isValidCredentialName(name)) {
    return 'A name is short and lowercase: letters, digits and dashes, e.g. `azure-eu`.'
  }
  if (isReservedCredentialName(name)) {
    return `\`${name}\` is a built-in provider id. Pick another name.`
  }
  if (storedNames.includes(name)) {
    return `\`${name}\` is already taken. Pick another name.`
  }
  return null
}
