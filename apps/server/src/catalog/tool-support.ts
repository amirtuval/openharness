import type { ToolSupportFor } from '@openharness/brain'

import { findModel, registryKeyFor } from './model-lookup'
import type { ModelRegistry } from './registry'

/**
 * Whether a model can call tools (epic #303, X2).
 *
 * The brain offers a request's tools only to a model that can use them, and which models those
 * are is data now rather than a hand-written pattern per provider: models.dev carries a
 * `tool_call` flag for every model it knows, the snapshot keeps the `false` ones
 * (`catalog/registry.ts`), and this is the resolver the server hands the brain as
 * `RunTurnOptions.toolSupportFor` — the same injected-resolver seam as the reasoning effort
 * (#252's follow-up) and the context budget (#246), over the same registry.
 *
 * **Absence is `true`.** A model the registry does not know — an unknown provider, a model the
 * snapshot predates, a deployment under a named credential models.dev files nothing for — is
 * offered tools rather than quietly denied them: the flag exists to catch the models that
 * really cannot call them (models.dev marks 147 of the snapshot's 972), and guessing "no" for
 * an unfamiliar id would be the same mistake the catalogue's chat filter refuses to make. It is
 * also why `undefined` and `false` are kept apart here: the brain reads both as "no tools",
 * while `GET /v1/models` reports the first as `tool_call: true` (the entry is built from the
 * same rule, `catalog.ts`).
 *
 * The lookup itself — which snapshot key a `provider/model` id's first half reads, and the
 * Bedrock inference-profile fallback — is {@link findModel}'s, shared with the reasoning gate.
 *
 * @param registry where the metadata comes from — the bundled models.dev snapshot in production
 */
export function createToolSupportResolver(registry: ModelRegistry): ToolSupportFor {
  return (modelId, credentialType) => {
    const separator = modelId.indexOf('/')
    if (separator <= 0 || separator === modelId.length - 1) {
      return undefined
    }
    const key = registryKeyFor(modelId.slice(0, separator), credentialType)
    if (key === undefined) {
      return undefined
    }
    const model = findModel(registry, key, modelId.slice(separator + 1), credentialType)
    // `toolCall` is written only when it is `false`, so a model that is there and callable and
    // one that is not there at all both answer `undefined` — "not known to be unable".
    return model?.toolCall === false ? false : undefined
  }
}
