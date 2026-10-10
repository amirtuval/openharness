import type { ToolSecretResolver, ToolSettingsResolver, ToolSupportFor } from '@openharness/brain'
import { createToolRegistry, textResult } from '@openharness/hands'
import type { ToolDefinition, ToolRegistry } from '@openharness/hands'
import type { SessionStore } from '@openharness/session'
import { z } from 'zod'

import type { ModelRegistry } from './catalog/registry'
import { createToolSupportResolver } from './catalog/tool-support'
import type { ResolvedModel } from './model'
import { createToolSettingsResolver } from './tool-settings'

/**
 * The tools a turn may offer (epic #303, X4), and the one this build registers.
 *
 * **A real tool ships with [#305](https://github.com/amirtuval/openharness/issues/305)**, so the
 * only registry this server builds is the test one: an `echo` tool registered behind
 * `OPENHARNESS_TEST_MODEL=mock`, which is what lets the e2e suite drive a whole tool turn through
 * the real server, scheduler, brain and log. A process on a provider model has no tools at all —
 * `createTurnTools` answers `undefined` — which is exactly the behaviour of every server before
 * #304.
 */

/** The name of the test tool; the mock model calls it by this name. */
export const TEST_TOOL_NAME = 'echo'

/** What the test tool says it does — written for a model, since a model is who reads it. */
export const TEST_TOOL_DESCRIPTION =
  'Echo the text you were given back, unchanged. Use it to check that tools work.'

/**
 * `echo`: the test tool.
 *
 * It takes one string and returns it, so a turn that calls it has a result that is exactly
 * predictable from the log and nothing else — the property an end-to-end assertion needs. It
 * reads nothing from its context and uses no secret, which is also what makes it safe to
 * register behind a flag whose only other effect is to swap the model for a fake one.
 */
export const testEchoTool: ToolDefinition<{ text: string }> = {
  name: TEST_TOOL_NAME,
  description: TEST_TOOL_DESCRIPTION,
  inputSchema: z.object({ text: z.string() }),
  permission: 'allow',
  run: (input) => textResult(input.text),
}

/** The registry the test hook runs with: just {@link testEchoTool}. */
export function createTestToolRegistry(): ToolRegistry {
  return createToolRegistry([testEchoTool])
}

/**
 * The tools this process registers, or `undefined` for a deployment that registers none.
 *
 * `undefined` is every deployment on a real provider model, and is not a degraded mode: it is a
 * chat with no tools, which is what this server was before #304 and what it will keep being
 * until #305's built-ins land. The test model gets {@link createTestToolRegistry} because it is
 * the model the tests speak to, so a tool turn — and a tool **setting** — can be driven through
 * the real server.
 *
 * One function, called once, because two readers need the same answer: the turn's options and
 * the `/v1/me/tools` routes both build from this registry, and a tool listed as available must
 * be one a chat can really call.
 *
 * @param kind which factory the process runs — `mock` is what turns the test registry on
 */
export function createTurnRegistry(kind: ResolvedModel['kind']): ToolRegistry | undefined {
  return kind === 'mock' ? createTestToolRegistry() : undefined
}

/**
 * The tools a turn is handed, and the loop's decisions about them (epic #303, X4; #307).
 *
 * The field names are `RunTurnOptions`' own, so `SessionRunner` spreads this object straight
 * into a turn's options and there is nothing to keep in step by hand. The settings resolver is
 * the one #307 adds: the session owner's stored choices, with the mode's override applied, read
 * per request.
 */
export interface TurnToolOptions {
  /** The tools a request may offer — its offer, before the settings take any of them out. */
  readonly tools: ToolRegistry
  /** The settings in force per request; each tool's own declaration when absent (#307). */
  readonly toolSettings?: ToolSettingsResolver
  /** Whether a model can call tools; the registry's `tool_call` when absent. */
  readonly toolSupportFor?: ToolSupportFor
  /** Where a step's per-user values come from (#311). */
  readonly resolveToolSecrets?: ToolSecretResolver
  /** The most model requests one turn may make; the brain's default when absent. */
  readonly maxToolSteps?: number
}

/** What {@link createTurnTools} builds its answer from. */
export interface TurnToolDeps {
  /** The parsed environment: how many requests a turn may make. */
  readonly config: { readonly maxToolSteps: number }
  /** The tools this process registers ({@link createTurnRegistry}), or `undefined` for none. */
  readonly tools: ToolRegistry | undefined
  /** The store the settings resolver reads a user's choices from. */
  readonly store: Pick<SessionStore, 'getToolSettings' | 'getMode' | 'getPreferences'>
  /** The model registry, which answers which models can call tools at all. */
  readonly registry: ModelRegistry
}

/**
 * Resolve the tools a turn runs with, or `undefined` when this process registers none.
 *
 * A deployment with no registry has nothing to offer and is never asked for a user's settings:
 * there is nothing a setting could turn on.
 */
export function createTurnTools(deps: TurnToolDeps): TurnToolOptions | undefined {
  const { tools } = deps
  if (tools === undefined) {
    return undefined
  }
  return {
    tools,
    toolSettings: createToolSettingsResolver({ store: deps.store, tools }),
    toolSupportFor: createToolSupportResolver(deps.registry),
    maxToolSteps: deps.config.maxToolSteps,
  }
}
