import { z } from 'zod'

import { BEDROCK_REGIONS } from '../bedrock'
import { TimestampSchema } from '../common'
import { ProviderCredentialIdSchema } from '../ids'

/**
 * Provider credentials — the per-user model-provider keys (epic #65, A5) — and the endpoints
 * that manage them:
 *
 * - `PUT    /v1/provider-credentials/{name}` (add or replace)
 * - `GET    /v1/provider-credentials`
 * - `DELETE /v1/provider-credentials/{name}`
 *
 * // extension: Anthropic's Managed Agents API has no notion of a user's own credentials;
 * Anthropic holds the model-provider keys. openharness does not: every user brings their own,
 * they are stored encrypted (the `@openharness/vault` package), and the API is **write-only**
 * — a secret goes up and only metadata ever comes back down. Nothing in this module carries a
 * secret in a response, and the plaintext must never reach a log, an event or an error.
 *
 * A credential is keyed by its **name**, which is the `provider` half of the model ids it
 * serves: `PUT /v1/provider-credentials/anthropic` stores the Anthropic key, and
 * `PUT /v1/provider-credentials/azure-eu` stores a named Azure OpenAI credential that answers
 * `azure-eu/<deployment>`. For the eleven fixed providers the name is simply the provider id —
 * there is one of each — and the named types (see `credential-types.ts`, epic #245 A3a) let a
 * user keep more than one of a type under names they choose.
 */

/**
 * The credential forms a provider credential can take.
 *
 * `api_key` is one secret, for the providers the model factory authenticates that way (OpenAI,
 * Anthropic, Google AI Studio, OpenRouter, Groq, …) — the eleven fixed provider ids. The record
 * is a discriminated union on `type`, so `gcp_service_account` later becomes a new type with its
 * own payload fields rather than a new design; `azure_openai` (epic #245, A3a),
 * `openai_compatible` (epic #245, A3b), `bedrock` (epic #245, A3c) and `vertex` (epic #245,
 * A3d) are the four such types.
 */
export const ProviderCredentialTypeSchema = z.enum([
  'api_key',
  'azure_openai',
  'openai_compatible',
  'bedrock',
  'vertex',
])

export type ProviderCredentialType = z.infer<typeof ProviderCredentialTypeSchema>

/** Every credential type, in schema order. */
export const PROVIDER_CREDENTIAL_TYPES: readonly ProviderCredentialType[] =
  ProviderCredentialTypeSchema.options

/**
 * The public, non-secret facts a custom OpenAI-compatible credential publishes (epic #245, A3b).
 *
 * A credential's wire form is the same fields whatever its type, and a type that has a fact a
 * settings screen should show publishes it as **its own** `details` object rather than as a new
 * top-level field — {@link ProviderCredentialSchema} is where each type says what it publishes,
 * so Bedrock's `{ region }`, Vertex's `{ email, project, location }` and this type's host arrive
 * as their own variants rather than as keys one map grows. It is **not** the credential's
 * payload — the payload is sealed and comes back open only on the model-call path — and nothing
 * secret may ever be put in it. The whole point of a dedicated object is that the values are
 * chosen for display: a base URL's *host*, never the URL (whose path is the user's and may name
 * a resource), and never any part of a key.
 */
export const OpenAICompatibleCredentialDetailsSchema = z.object({
  /**
   * The host of a custom credential's base URL, e.g. `api.example.com` or `127.0.0.1:11434` (a
   * port is part of the host). The scheme and the path are dropped: the host is what tells one
   * custom endpoint from another in a list.
   */
  base_url_host: z.string().min(1),
})

export type OpenAICompatibleCredentialDetails = z.infer<
  typeof OpenAICompatibleCredentialDetailsSchema
>

/**
 * The public facts an Amazon Bedrock credential publishes (epic #245, A3c): its **region**.
 *
 * A Bedrock request is addressed by region, and one account's keys in one region is one
 * credential — so `last4` alone leaves two Bedrock rows indistinguishable. The region is not a
 * secret and is what a list shows (`BEDROCK_REGIONS` is the vocabulary the request validates
 * against; a `details` read back is a string, the stored value).
 */
export const BedrockCredentialDetailsSchema = z.object({
  region: z.string().min(1),
})

export type BedrockCredentialDetails = z.infer<typeof BedrockCredentialDetailsSchema>

/**
 * The public facts a Google Vertex credential publishes (epic #245, A3d): the service-account
 * **email**, the **project** and the **location**.
 *
 * None of the three is a secret, and each is what tells two Vertex credentials apart — one
 * service account may serve several projects, and one project several regions. `last4` is the
 * private key **id**'s last four characters, an identifier Google prints beside the account, and
 * never any part of the private key: the key itself stays inside the sealed payload.
 */
export const VertexCredentialDetailsSchema = z.object({
  /** The service account's address, e.g. `vertex@my-project.iam.gserviceaccount.com`. */
  email: z.string().min(1),
  /** The Google Cloud project the models run in. */
  project: z.string().min(1),
  /** The Vertex AI location, one of {@link VERTEX_LOCATIONS}. */
  location: z.string().min(1),
})

export type VertexCredentialDetails = z.infer<typeof VertexCredentialDetailsSchema>

/**
 * Every type's published details, as one union: what a credential store persists and hands back
 * (`UpsertCredentialInput.details`), where which type a value belongs to is the credential's own
 * `type` beside it. The wire — {@link ProviderCredentialSchema} — is where the union is keyed
 * per type; this is the storage-level spelling of the same values. A new type adds its details
 * object to this union when it adds its variant there.
 */
export type ProviderCredentialDetails =
  | OpenAICompatibleCredentialDetails
  | BedrockCredentialDetails
  | VertexCredentialDetails

/** The fields every credential's metadata carries, whatever its type. */
const ProviderCredentialMetadataBaseSchema = z.object({
  id: ProviderCredentialIdSchema,
  /**
   * The credential's name: the `provider` half of every model id it serves, e.g. `anthropic`
   * or `azure-eu`. Unique per user; for the eleven fixed providers it is the provider id.
   */
  name: z.string().min(1),
  /** The last four characters of the stored secret, for recognition only. */
  last4: z.string(),
  created_at: TimestampSchema,
  /** When the credential was last added or replaced. */
  updated_at: TimestampSchema,
  /**
   * When the credential last passed validation against the provider. Absent until a save has
   * validated it — a credential is validated on save, so a stored one normally carries this.
   */
  validated_at: TimestampSchema.optional(),
})

/**
 * The `api_key` metadata: the fixed providers. It publishes no type-specific facts, so it has no
 * `details` — its metadata is byte-for-byte what it was before the field existed.
 */
export const ApiKeyProviderCredentialMetadataSchema = ProviderCredentialMetadataBaseSchema.extend({
  type: z.literal('api_key'),
})

/**
 * The `azure_openai` metadata: it publishes none either. The resource endpoint is part of the
 * sealed payload, and one whose path may name a resource is not a list's to show.
 */
export const AzureOpenAIProviderCredentialMetadataSchema =
  ProviderCredentialMetadataBaseSchema.extend({
    type: z.literal('azure_openai'),
  })

/** The `openai_compatible` metadata, with the base URL's host a list may show (#245, A3b). */
export const OpenAICompatibleProviderCredentialMetadataSchema =
  ProviderCredentialMetadataBaseSchema.extend({
    type: z.literal('openai_compatible'),
    details: OpenAICompatibleCredentialDetailsSchema.optional(),
  })

/** The `bedrock` metadata, with the region a list may show (#245, A3c). */
export const BedrockProviderCredentialMetadataSchema = ProviderCredentialMetadataBaseSchema.extend({
  type: z.literal('bedrock'),
  details: BedrockCredentialDetailsSchema.optional(),
})

/** The `vertex` metadata, with the email, project and location a list may show (#245, A3d). */
export const VertexProviderCredentialMetadataSchema = ProviderCredentialMetadataBaseSchema.extend({
  type: z.literal('vertex'),
  details: VertexCredentialDetailsSchema.optional(),
})

/**
 * A stored provider credential, as the API returns it: **metadata only**.
 *
 * The secret itself never appears here or anywhere else in a response — `last4` is what a UI
 * shows so a user can tell one key from another. A credential is keyed by its owner and its
 * `name`, so there is at most one per name per user: `PUT` replaces it.
 *
 * A **discriminated union on `type`**: each type carries exactly the public facts it publishes,
 * so `details` is typed for the type that has it — a base-URL host on a custom credential, a
 * region on a Bedrock one, the email, project and location on a Vertex one — and a type with
 * none carries no `details` key at all. That is what keeps the JSON of the types that existed
 * before this field byte-for-byte unchanged.
 */
export const ProviderCredentialSchema = z.discriminatedUnion('type', [
  ApiKeyProviderCredentialMetadataSchema,
  AzureOpenAIProviderCredentialMetadataSchema,
  OpenAICompatibleProviderCredentialMetadataSchema,
  BedrockProviderCredentialMetadataSchema,
  VertexProviderCredentialMetadataSchema,
])

export type ProviderCredential = z.infer<typeof ProviderCredentialSchema>

/**
 * A credential's metadata with its `type` and `details` left wide: every field a variant has,
 * before a credential's type narrows which of them apply. It is the shape a store builds from a
 * row or an argument and what {@link ProviderCredential} is narrowed from.
 */
export type ProviderCredentialMetadata = z.infer<typeof ProviderCredentialMetadataBaseSchema> & {
  readonly type: ProviderCredentialType
  readonly details?: ProviderCredentialDetails
}

/**
 * The `api_key` form of {@link PutProviderCredentialRequestSchema}: a single secret.
 *
 * `api_key` is **write-only**. It is accepted on this request and never echoed back: no
 * response, event, log line or error message may carry it (epic #65, A5).
 */
export const ApiKeyProviderCredentialSchema = z.object({
  type: z.literal('api_key'),
  /** The secret itself. Sent once, stored encrypted, never returned. */
  api_key: z.string().min(1),
})

export type ApiKeyProviderCredential = z.infer<typeof ApiKeyProviderCredentialSchema>

/** The most deployments one Azure OpenAI credential may carry. */
export const MAX_AZURE_DEPLOYMENTS = 64

/** Whether `value` is an absolute `https:` URL — the only scheme Azure endpoints may use. */
function isHttpsEndpoint(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The `azure_openai` form of {@link PutProviderCredentialRequestSchema} (epic #245, A3a).
 *
 * Azure OpenAI is addressed by deployment, not by a model id, and Microsoft offers no endpoint
 * that lists them: the user types the deployment names, and each becomes a model
 * (`<credential name>/<deployment>`). The fields are what a request needs besides the name the
 * credential is stored under:
 *
 * - `endpoint` — the resource endpoint, e.g. `https://my-resource.openai.azure.com`. It must be
 *   **`https`**; the server additionally refuses one that resolves to a private address
 *   (the SSRF guard), so a loopback or metadata endpoint cannot be stored.
 * - `api_key` — write-only, exactly like the `api_key` form's.
 * - `deployments` — the deployment names. At least one; the server checks the first on save and
 *   refuses a credential Azure rejects.
 */
export const AzureOpenAICredentialSchema = z.object({
  type: z.literal('azure_openai'),
  /** The Azure OpenAI resource endpoint; `https` only. */
  endpoint: z
    .string()
    .refine(isHttpsEndpoint, { message: 'the endpoint must be an absolute https URL' }),
  /** The secret itself. Sent once, stored encrypted, never returned. */
  api_key: z.string().min(1),
  /** The deployment names; each becomes a model id `<name>/<deployment>`. */
  deployments: z.array(z.string().min(1)).min(1).max(MAX_AZURE_DEPLOYMENTS),
})

export type AzureOpenAICredential = z.infer<typeof AzureOpenAICredentialSchema>

/**
 * Whether `value` is an absolute `http:` or `https:` URL — the schemes a custom base URL may
 * use. `http` is allowed on purpose (a self-hosted endpoint on a private network is the case
 * this type exists for); the SSRF guard, not the scheme, is what refuses an address a request
 * must not reach.
 */
function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The `openai_compatible` form of {@link PutProviderCredentialRequestSchema} (epic #245, A3b).
 *
 * Any server that speaks the OpenAI chat-completions API — a self-hosted Ollama or vLLM, a
 * gateway, a proxy — is addressed by a base URL the user supplies, and its model ids are
 * whatever its `/models` endpoint lists. The fields are what a request needs besides the name
 * the credential is stored under:
 *
 * - `base_url` — the OpenAI-compatible API root, e.g. `https://api.example.com/v1` or
 *   `http://127.0.0.1:11434/v1`. It must be an absolute `http`/`https` URL; the server
 *   additionally refuses one that resolves to a private address unless the self-host setting
 *   allows it (the SSRF guard), and it checks the endpoint on save with `GET {base_url}/models`.
 * - `api_key` — write-only when the endpoint wants one, and **optional**: a local server may
 *   take no key at all. Exactly like the `api_key` form's, it is accepted on this request and
 *   never returned.
 */
export const OpenAICompatibleCredentialSchema = z.object({
  type: z.literal('openai_compatible'),
  /** The OpenAI-compatible API root; an absolute `http`/`https` URL. */
  base_url: z
    .string()
    .refine(isHttpUrl, { message: 'the base URL must be an absolute http or https URL' }),
  /** The secret, when the endpoint wants one. Sent once, stored encrypted, never returned. */
  api_key: z.string().min(1).optional(),
})

export type OpenAICompatibleCredential = z.infer<typeof OpenAICompatibleCredentialSchema>

/**
 * The `bedrock` form of {@link PutProviderCredentialRequestSchema} (epic #245, A3c).
 *
 * Amazon Bedrock authenticates with an IAM principal's static access keys, and a request is
 * addressed by **region** — there is no endpoint to type, and no deployment to name: the
 * catalog is the region's own `ListFoundationModels`, and a model id's second half is a Bedrock
 * model id (`anthropic.claude-sonnet-4-20250514-v1:0`). The fields are therefore the three
 * credentials SigV4 signs with, plus the region:
 *
 * - `access_key_id` — the access key ID (`AKIA…`). Sent once, stored encrypted, never returned;
 *   only its last four characters come back, as `last4`.
 * - `secret_access_key` — the secret. Write-only, exactly like the `api_key` form's.
 * - `session_token` — the token temporary credentials (STS, SSO, an assumed role) carry, when
 *   there is one. Optional: long-lived IAM user keys have none.
 * - `region` — an AWS region from {@link BEDROCK_REGIONS}. Validated against that list, not
 *   accepted as free text: the region is spliced into an AWS hostname, and a string that is not
 *   a real region could not name one (`bedrock.ts` has the rule and the list).
 *
 * The whole payload is **sealed as one secret** — keys, token and region together. The region is
 * not itself secret, but a credential is stored as the single JSON value its type parsed to, so
 * there is one sealed blob per credential and no second place a field could live; the region
 * also rides on the metadata as `details.region`, which is what a list shows.
 *
 * // extension: assume-role and instance-profile credentials are out of v1 (epic #245, decision
 * M4). A role ARN is a different shape and a different signing path, and the save-time check
 * cannot complete an `sts:AssumeRole` on a user's behalf without a trust relationship that says
 * it may. Static keys are checked on save; a role would have to be checked by assuming it.
 */
export const BedrockCredentialSchema = z.object({
  type: z.literal('bedrock'),
  /** The IAM access key ID; `last4` is its last four characters. */
  access_key_id: z.string().min(1),
  /** The IAM secret access key. Sent once, stored encrypted, never returned. */
  secret_access_key: z.string().min(1),
  /** The session token temporary credentials carry; absent for long-lived IAM user keys. */
  session_token: z.string().min(1).optional(),
  /** The AWS region the credential runs in; one of {@link BEDROCK_REGIONS}. */
  region: z.enum(BEDROCK_REGIONS),
})

export type BedrockCredential = z.infer<typeof BedrockCredentialSchema>

/**
 * The service-account key a Google Vertex credential needs, as the JSON document Google hands
 * out (epic #245, A3d, decision M4): a user downloads it from the service account's Keys page
 * and pastes or uploads it whole. Workload identity federation is deliberately not supported.
 *
 * Only the five fields below are read — the ones that say what the document is and what a
 * request needs — and the document is otherwise carried through untouched, so a field Google
 * adds (or a user's own metadata) survives a save rather than being stripped by this schema.
 */
export interface ServiceAccountKey {
  /** Always `service_account`; the check that rejects a document that is not one. */
  readonly type: 'service_account'
  /** The project the key belongs to. The credential's `project` defaults from this. */
  readonly project_id: string
  /** The key's own id. Not a secret, and what `last4` is taken from. */
  readonly private_key_id: string
  /** The PEM private key. Never returned, logged or echoed anywhere. */
  readonly private_key: string
  /** The service account's address, e.g. `vertex@my-project.iam.gserviceaccount.com`. */
  readonly client_email: string
}

/** The fields {@link ServiceAccountKey} requires, in the order an error message lists them. */
const SERVICE_ACCOUNT_FIELDS = [
  'project_id',
  'private_key_id',
  'private_key',
  'client_email',
] as const

/**
 * The service-account key in `value` — the JSON text Google's console hands out — or `null`
 * when it is not one.
 *
 * The check is a real one rather than a look at the file name: the document must parse, must
 * say `type: service_account`, and must carry the fields a request needs. It is what the
 * protocol validates a `vertex` payload with, and the server parses the same document again
 * when it turns the payload into a credential; the one parser is what keeps the two from
 * disagreeing about what a service-account key is.
 */
export function parseServiceAccountKey(value: string): ServiceAccountKey | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const document = parsed as Record<string, unknown>
  if (document.type !== 'service_account') {
    return null
  }
  for (const field of SERVICE_ACCOUNT_FIELDS) {
    const value = document[field]
    if (typeof value !== 'string' || value.trim().length === 0) {
      return null
    }
  }
  return {
    type: 'service_account',
    project_id: document.project_id as string,
    private_key_id: document.private_key_id as string,
    private_key: document.private_key as string,
    client_email: document.client_email as string,
  }
}

/** Whether `value` is a service-account key — what a `vertex` payload's JSON is checked with. */
export function isServiceAccountKey(value: string): boolean {
  return parseServiceAccountKey(value) !== null
}

/**
 * The Google Cloud regions a Vertex credential may name.
 *
 * The location is not free text because it is not only a label: it is the **host** every
 * request goes to (`<location>-aiplatform.googleapis.com`), so a typo or an invented region
 * would be a credential that saves and then cannot make one request. The list is Google's
 * published set of Vertex AI locations, `global` included — the endpoint for models that are
 * served from a global host rather than a region.
 */
export const VERTEX_LOCATIONS = [
  'global',
  'us-central1',
  'us-east1',
  'us-east4',
  'us-east5',
  'us-south1',
  'us-west1',
  'us-west4',
  'northamerica-northeast1',
  'southamerica-east1',
  'europe-central2',
  'europe-north1',
  'europe-southwest1',
  'europe-west1',
  'europe-west2',
  'europe-west3',
  'europe-west4',
  'europe-west6',
  'europe-west8',
  'europe-west9',
  'asia-east1',
  'asia-east2',
  'asia-northeast1',
  'asia-northeast2',
  'asia-northeast3',
  'asia-south1',
  'asia-south2',
  'asia-southeast1',
  'asia-southeast2',
  'australia-southeast1',
  'australia-southeast2',
  'me-central1',
  'me-central2',
  'me-west1',
  'africa-south1',
] as const

/** A region {@link VERTEX_LOCATIONS} knows. */
export type VertexLocation = (typeof VERTEX_LOCATIONS)[number]

/**
 * A Google Cloud **project id**: lowercase, six to thirty characters with a letter at each end.
 *
 * Google's own rule, checked here so a typo is a 400 next to the field rather than a 403 from
 * Vertex on save. A project *number* is not accepted: the key's own `project_id` is an id, and
 * the document the reader pasted carries the one they mean.
 */
const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/

/**
 * The `vertex` form of {@link PutProviderCredentialRequestSchema} (epic #245, A3d).
 *
 * Vertex AI authenticates with a Google Cloud **service-account key**: the JSON document the
 * console hands out, which carries the private key that signs a short-lived OAuth token. The
 * fields are:
 *
 * - `service_account` — that document, **as text**, exactly as it was pasted or uploaded. It is
 *   sealed whole (the server never re-serialises it into a different shape) and handed whole to
 *   the client library, which is why this is a string and not a modelled object: the document
 *   is Google's, not this protocol's.
 * - `project` — the project the models are run in, and the one the save-time check lists
 *   publisher models from. It defaults, in the forms, to the document's own `project_id`; a
 *   service account with access to several projects may name another.
 * - `location` — one of {@link VERTEX_LOCATIONS}. Google has no endpoint that lists regions, so
 *   the list above is the check, and the host is derived from the value rather than typed.
 *
 * `gcp_service_account` is deliberately **not** a type of its own: this one is a Vertex
 * credential, and the key is the form its authentication takes. Workload identity federation,
 * an ADC-only setup and a bare project id are all refused — decision M4, and the reason is the
 * same one that makes this protocol carry the key rather than read it from the environment: the
 * server runs on GCP, so an ADC fallback would silently run a user's chat on openharness's own
 * service account.
 */
export const VertexCredentialSchema = z.object({
  type: z.literal('vertex'),
  /** The service-account key JSON, as text. Write-only: never returned, logged or echoed. */
  service_account: z.string().refine(isServiceAccountKey, {
    message:
      'the service account must be the JSON key file Google Cloud issued for a service ' +
      'account (its `type` is `service_account` and it carries the key); download one from ' +
      "the service account's Keys page",
  }),
  /** The Google Cloud project the models run in. */
  project: z.string().refine((value) => GCP_PROJECT_ID_PATTERN.test(value), {
    message: 'the project must be a Google Cloud project id, e.g. `my-project-123456`',
  }),
  /** The Vertex AI location; the host every request goes to is derived from it. */
  location: z.enum(VERTEX_LOCATIONS),
})

export type VertexCredential = z.infer<typeof VertexCredentialSchema>

/**
 * Body of `PUT /v1/provider-credentials/{name}`. Response: {@link ProviderCredentialSchema}.
 *
 * A discriminated union on `type`. The path's `name` is the credential's name — the provider
 * half of the model ids it serves; for the eleven fixed providers it is the provider id. The
 * body carries the secret.
 *
 * A fresh session is required to add, replace or delete a credential (epic #65, A2): the
 * server refuses a stale one. A credential that fails validation on save answers 422
 * `invalid_provider_credential`.
 */
export const PutProviderCredentialRequestSchema = z.discriminatedUnion('type', [
  ApiKeyProviderCredentialSchema,
  AzureOpenAICredentialSchema,
  OpenAICompatibleCredentialSchema,
  BedrockCredentialSchema,
  VertexCredentialSchema,
])

export type PutProviderCredentialRequest = z.infer<typeof PutProviderCredentialRequestSchema>

/**
 * The {@link ProviderCredentialDetails} a PUT body's type publishes, or `undefined` for a type
 * with none (epic #245, A3b).
 *
 * This is the whole mapping from "what a user saved" to "what the metadata may show", and it
 * lives here — beside the schemas — because two sides must agree on it: the server derives a
 * credential's stored `details` from the body it seals, and a client that fakes the server
 * (the web app's and the TUI's `@openharness/client/testing`) must produce the same answer.
 * Only facts safe to publish are read out — a custom base URL's **host**, never its path and
 * never any part of a key; a Bedrock credential's **region**; and a Vertex credential's
 * service-account **email**, **project** and **location**, read through
 * {@link parseServiceAccountKey} so the email comes from the document that was sealed and never
 * from a second parse. No part of a private key is ever returned, logged or echoed.
 */
export function credentialDetails(
  body: PutProviderCredentialRequest,
): ProviderCredentialDetails | undefined {
  if (body.type === 'openai_compatible') {
    return { base_url_host: new URL(body.base_url).host }
  }
  if (body.type === 'bedrock') {
    return { region: body.region }
  }
  if (body.type === 'vertex') {
    // The schema refined `service_account` with `isServiceAccountKey`, so this parse succeeds;
    // a body that somehow reached here without one contributes no facts rather than throwing.
    const key = parseServiceAccountKey(body.service_account)
    if (key === null) {
      return undefined
    }
    return { email: key.client_email, project: body.project, location: body.location }
  }
  return undefined
}

/**
 * Response of `GET /v1/provider-credentials`: every credential the caller owns, metadata
 * only.
 *
 * No pagination envelope: a user has one credential per name at most, so the list is short by
 * construction. The array is empty, never absent, when nothing is stored — which is also the
 * state a fresh account starts in.
 */
export const ListProviderCredentialsResponseSchema = z.object({
  data: z.array(ProviderCredentialSchema),
})

export type ListProviderCredentialsResponse = z.infer<typeof ListProviderCredentialsResponseSchema>
