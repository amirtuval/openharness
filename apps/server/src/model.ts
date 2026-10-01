import type { ModelCredential, ModelFactory, ResolveCredential } from '@openharness/brain'
import { routerModelFactory } from '@openharness/brain'

import { ENV_VARS, type ServerConfig } from './config'
import { MOCK_MODEL_ENV_VALUE, createMockModelFactory } from './mock-model'

/**
 * Which model the server streams from, and the credential each request is made with.
 *
 * Two factories, and the environment picks: Mastra's router, which turns the protocol's
 * `provider/model` ids into real models, or the deterministic test model. The choice is made
 * exactly once, here, so there is one place to read to answer "can this process be talking to
 * the mock?" — and {@link resolveModelFactory} never returns the mock unless the variable
 * asks for it by name.
 */

/** The model factory a process runs with, which kind it is, and its credential resolver. */
export interface ResolvedModel {
  /** The factory a scheduler hands to every turn. */
  readonly factory: ModelFactory
  /** `mock` when the deterministic test model is in use, `router` otherwise. */
  readonly kind: 'mock' | 'router'
  /**
   * Where a model request's provider credential comes from (epic #65, A5).
   *
   * The server holds no provider keys of its own, so with the router this is the session
   * owner's stored credential — the vault lookup #61 wires in. Until it lands, {@link
   * noStoredCredential} answers "none" and a router turn ends with the brain's
   * `missing_provider_credential` `session.error`, which is the correct v2 behaviour: the
   * environment is never a fallback. The mock needs no credential and gets a placeholder.
   */
  readonly resolveCredential: ResolveCredential
}

/**
 * No credential for any provider — what the server can answer until #61 looks one up in the
 * vault. A turn that reaches this ends with `missing_provider_credential`, never with a key
 * from the environment.
 */
export const noStoredCredential: ResolveCredential = () => Promise.resolve(null)

/** The placeholder credential the deterministic test model is handed. It ignores it. */
export const MOCK_CREDENTIAL: ModelCredential = { apiKey: 'openharness-test-model' }

/**
 * Resolve the model factory, and the credential resolver that goes with it, from a
 * configuration.
 *
 * Nothing here reads a provider credential: the router is handed one per request by the
 * resolver, so a missing key is a turn that fails with a `session.error`, not a boot that
 * fails — and with the router no key is looked up at all until #61 lands, which is what makes
 * a deployment without per-user credentials fail closed rather than fall back to
 * `OPENAI_API_KEY`. What this does guard is the variable itself.
 *
 * @throws Error when `OPENHARNESS_TEST_MODEL` is set to anything but `mock`: a typo must not
 *   quietly fall back to the router, nor quietly to the mock
 */
export function resolveModelFactory(config: ServerConfig): ResolvedModel {
  if (config.testModel === undefined) {
    return { factory: routerModelFactory, kind: 'router', resolveCredential: noStoredCredential }
  }
  if (config.testModel !== MOCK_MODEL_ENV_VALUE) {
    throw new Error(
      `${ENV_VARS.testModel} must be ${JSON.stringify(MOCK_MODEL_ENV_VALUE)} when it is set, ` +
        `got ${JSON.stringify(config.testModel)}`,
    )
  }
  return {
    factory: createMockModelFactory(),
    kind: 'mock',
    resolveCredential: () => Promise.resolve(MOCK_CREDENTIAL),
  }
}
