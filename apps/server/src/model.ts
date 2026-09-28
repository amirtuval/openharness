import { type ModelFactory, routerModelFactory } from '@openharness/brain'

import { ENV_VARS, type ServerConfig } from './config'
import { MOCK_MODEL_ENV_VALUE, createMockModelFactory } from './mock-model'

/**
 * Which model the server streams from.
 *
 * Two factories, and the environment picks: Mastra's router, which turns the protocol's
 * `provider/model` ids into real models, or the deterministic test model. The choice is made
 * exactly once, here, so there is one place to read to answer "can this process be talking to
 * the mock?" — and {@link resolveModelFactory} never returns the mock unless the variable
 * asks for it by name.
 */

/** The model factory a process runs with, and which kind it is. */
export interface ResolvedModel {
  /** The factory a scheduler hands to every turn. */
  readonly factory: ModelFactory
  /** `mock` when the deterministic test model is in use, `router` otherwise. */
  readonly kind: 'mock' | 'router'
}

/**
 * Resolve the model factory from a configuration.
 *
 * Nothing here checks for provider credentials: the router resolves them when it makes a
 * request, so a missing key is a turn that fails with a `session.error`, not a boot that
 * fails. What this does guard is the variable itself.
 *
 * @throws Error when `OPENHARNESS_TEST_MODEL` is set to anything but `mock`: a typo must not
 *   quietly fall back to the router, nor quietly to the mock
 */
export function resolveModelFactory(config: ServerConfig): ResolvedModel {
  if (config.testModel === undefined) {
    return { factory: routerModelFactory, kind: 'router' }
  }
  if (config.testModel !== MOCK_MODEL_ENV_VALUE) {
    throw new Error(
      `${ENV_VARS.testModel} must be ${JSON.stringify(MOCK_MODEL_ENV_VALUE)} when it is set, ` +
        `got ${JSON.stringify(config.testModel)}`,
    )
  }
  return { factory: createMockModelFactory(), kind: 'mock' }
}
