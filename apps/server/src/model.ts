import type { ModelCredential, ModelFactory } from '@openharness/brain'
import { providerModelFactory } from '@openharness/brain'

import { ENV_VARS, type ServerConfig } from './config'
import type { ResolveSessionCredential } from './credentials'
import { MOCK_MODEL_ENV_VALUE, createMockModelFactory } from './mock-model'

/**
 * Which model the server streams from.
 *
 * Two factories, and the environment picks: the provider factory, which turns the protocol's
 * `provider/model` ids into real models, or the deterministic test model. The choice is made
 * exactly once, here, so there is one place to read to answer "can this process be talking to
 * the mock?" — and {@link resolveModelFactory} never returns the mock unless the variable
 * asks for it by name.
 *
 * The credential each request is made with is **not** resolved here: it is per session, so
 * `main.ts` builds the resolver ({@link import('./credentials').createSessionCredentialResolver})
 * against the store and the vault, and the mock case gets {@link resolveMockCredential}. With
 * the provider factory, a session whose owner has no stored key for the provider ends its turn
 * with the brain's `missing_provider_credential` — never with a key from the environment (A5).
 */

/** The model factory a process runs with, and which kind it is. */
export interface ResolvedModel {
  /** The factory a scheduler hands to every turn. */
  readonly factory: ModelFactory
  /** `mock` when the deterministic test model is in use, `provider` otherwise. */
  readonly kind: 'mock' | 'provider'
}

/** The placeholder credential the deterministic test model is handed. It ignores it. */
export const MOCK_CREDENTIAL: ModelCredential = { type: 'api_key', apiKey: 'openharness-test-model' }

/**
 * The credential resolver the mock model runs with.
 *
 * The mock needs no credential and ignores whatever it is handed, but the brain asks for one
 * before every request — without an answer, a mock turn would end with
 * `missing_provider_credential` like any other credential-less turn. This resolver answers
 * for every session, because the answer is discarded.
 */
export const resolveMockCredential: ResolveSessionCredential = () =>
  Promise.resolve(MOCK_CREDENTIAL)

/**
 * Resolve the model factory from a configuration.
 *
 * Nothing here reads a provider credential: the factory is handed one per request by the
 * session-bound resolver, so a missing key is a turn that fails with a `session.error`, not a
 * boot that fails — and no deployment can fall back to `OPENAI_API_KEY`, which is not read at
 * all any more (A5).
 *
 * @throws Error when `OPENHARNESS_TEST_MODEL` is set to anything but `mock`: a typo must not
 *   quietly fall back to the provider factory, nor quietly to the mock
 */
export function resolveModelFactory(config: ServerConfig): ResolvedModel {
  if (config.testModel === undefined) {
    return { factory: providerModelFactory, kind: 'provider' }
  }
  if (config.testModel !== MOCK_MODEL_ENV_VALUE) {
    throw new Error(
      `${ENV_VARS.testModel} must be ${JSON.stringify(MOCK_MODEL_ENV_VALUE)} when it is set, ` +
        `got ${JSON.stringify(config.testModel)}`,
    )
  }
  return { factory: createMockModelFactory(), kind: 'mock' }
}
