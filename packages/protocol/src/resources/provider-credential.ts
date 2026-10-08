import { z } from 'zod'

import { TimestampSchema } from '../common'
import { ProviderCredentialIdSchema } from '../ids'

/**
 * Provider credentials — the per-user model-provider keys (epic #65, A5) — and the endpoints
 * that manage them:
 *
 * - `PUT    /v1/provider-credentials/{provider}` (add or replace)
 * - `GET    /v1/provider-credentials`
 * - `DELETE /v1/provider-credentials/{provider}`
 *
 * // extension: Anthropic's Managed Agents API has no notion of a user's own credentials;
 * Anthropic holds the model-provider keys. openharness does not: every user brings their own,
 * they are stored encrypted (the `@openharness/vault` package), and the API is **write-only**
 * — a secret goes up and only metadata ever comes back down. Nothing in this module carries a
 * secret in a response, and the plaintext must never reach a log, an event or an error.
 */

/**
 * The credential forms a provider credential can take.
 *
 * Only `api_key` exists today: one secret, for the providers the model factory
 * authenticates that way (OpenAI, Anthropic, Google AI Studio, OpenRouter, Groq, …). The
 * record is designed so that `aws`, `gcp_service_account` and `azure` later become new types
 * in this union rather than a new design — each a `type` string plus its own payload fields.
 */
export const ProviderCredentialTypeSchema = z.literal('api_key')

export type ProviderCredentialType = z.infer<typeof ProviderCredentialTypeSchema>

/**
 * A stored provider credential, as the API returns it: **metadata only**.
 *
 * The secret itself never appears here or anywhere else in a response — `last4` is what a UI
 * shows so a user can tell one key from another. A credential is keyed by its owner and
 * `provider`, so there is at most one per provider per user: `PUT` replaces it.
 */
export const ProviderCredentialSchema = z.object({
  id: ProviderCredentialIdSchema,
  type: ProviderCredentialTypeSchema,
  /** The provider id the key authenticates, e.g. `anthropic`, `openai`. */
  provider: z.string().min(1),
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

export type ProviderCredential = z.infer<typeof ProviderCredentialSchema>

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

/**
 * Body of `PUT /v1/provider-credentials/{provider}`. Response: {@link ProviderCredentialSchema}.
 *
 * A discriminated union on `type` with exactly one member today — `api_key` — so that
 * `aws`, `gcp_service_account` and `azure` slot in later as new members with their own
 * payload fields. The path's `provider` names the provider id (`anthropic`, `openai`, …);
 * the body carries the secret.
 *
 * A fresh session is required to add, replace or delete a credential (epic #65, A2): the
 * server refuses a stale one. A credential that fails validation on save answers 422
 * `invalid_provider_credential`.
 */
export const PutProviderCredentialRequestSchema = z.discriminatedUnion('type', [
  ApiKeyProviderCredentialSchema,
])

export type PutProviderCredentialRequest = z.infer<typeof PutProviderCredentialRequestSchema>

/**
 * Response of `GET /v1/provider-credentials`: every credential the caller owns, metadata
 * only.
 *
 * No pagination envelope: a user has one credential per provider at most, so the list is
 * short by construction. The array is empty, never absent, when nothing is stored — which is
 * also the state a fresh account starts in.
 */
export const ListProviderCredentialsResponseSchema = z.object({
  data: z.array(ProviderCredentialSchema),
})

export type ListProviderCredentialsResponse = z.infer<typeof ListProviderCredentialsResponseSchema>
