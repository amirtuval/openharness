import {
  credentialTypeInfo,
  PROVIDER_IDS,
  type ProviderCredentialType,
} from '@openharness/protocol'

import { bedrockUnderlyingModelId } from './bedrock-profiles'
import type { ModelRegistry, RegistryModel } from './registry'

/**
 * Reading one `provider/model` id out of the registry.
 *
 * Two resolvers the server hands the brain read a model id the same way — the reasoning effort
 * (#252) and whether the model can call tools (epic #303, X2) — and the two questions differ
 * only in what they ask *about* the model. The lookup itself is here, once, because its two
 * subtle parts are the kind that drift when they are written twice: which snapshot key a name
 * reads, and the Bedrock inference-profile fallback.
 */

/**
 * The registry's entry for a model id, with one fallback: a **Bedrock cross-region inference
 * profile** is looked up by the foundation model it wraps when its own id is not filed.
 *
 * A profile's model id (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) is geography-scoped —
 * and an application profile's is account-scoped — so models.dev may not have that exact id
 * even though it files the model underneath it. The profile's reasoning knob is the wrapped
 * model's, and `bedrockUnderlyingModelId` is the one place that turns the first into the
 * second. The fallback is guarded to the `bedrock` credential type for that reason: stripping a
 * geography prefix off some other provider's id would be turning one model into another.
 */
export function findModel(
  registry: ModelRegistry,
  key: string,
  id: string,
  credentialType: ProviderCredentialType,
): RegistryModel | undefined {
  const models = registry.models(key)
  const exact = models.find((entry) => entry.id === id)
  if (exact !== undefined || credentialType !== 'bedrock') {
    return exact
  }
  const underlying = bedrockUnderlyingModelId(id)
  return underlying === undefined ? undefined : models.find((entry) => entry.id === underlying)
}

/**
 * The snapshot key a `provider/model` id reads its model under.
 *
 * A fixed provider id is its own key — the snapshot is keyed by **our** ids. Anything else is a
 * **named credential**, and its first half is the name the reader chose (`azure-eu`), which the
 * snapshot has never heard of: its models are filed under the credential *type*'s models.dev key
 * (`azure`, `amazon-bedrock`), which is the same mapping the catalogue borrows a deployment's
 * window and price with (`credentialTypeInfo`, epic #245 A3a). A type with no models.dev key —
 * the OpenAI-compatible custom URL, which is a host the reader typed — has no entry to read and
 * answers nothing, as does an `api_key` credential under a name no provider carries.
 *
 * @param provider the id's first half: a provider id, or a named credential's name
 * @param credentialType what the request is made with — the fact that says which key a name reads
 */
export function registryKeyFor(
  provider: string,
  credentialType: ProviderCredentialType,
): string | undefined {
  if ((PROVIDER_IDS as readonly string[]).includes(provider)) {
    return provider
  }
  return credentialTypeInfo(credentialType)?.modelsDevKey
}
