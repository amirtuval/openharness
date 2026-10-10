import type { ToolSecretResolver, ToolSettingsResolver, ToolSupportFor } from '@openharness/brain'
import { createToolRegistry, textResult } from '@openharness/hands'
import type { ToolDefinition, ToolRegistry } from '@openharness/hands'
import type { SessionStore } from '@openharness/session'
import { z } from 'zod'

import type { ModelRegistry } from './catalog/registry'
import { createToolSupportResolver } from './catalog/tool-support'
import type { ResolvedModel } from './model'
import { askUserTool } from './pausing'
import { createToolSettingsResolver } from './tool-settings'

/**
 * The tools a turn may offer (epic #303, X4), and the ones this build registers.
 *
 * **`ask_user` is registered by every deployment** (epic #303, #309): a model that needs a
 * decision asks the user for one, and the turn pauses until they answer. It is the one tool the
 * server itself provides, and it is process-independent — nothing about it is a test hook.
 *
 * The rest of the built-ins ship with
 * [#305](https://github.com/amirtuval/openharness/issues/305), so the only other registry this
 * server builds is the test one: an `echo` tool registered behind
 * `OPENHARNESS_TEST_MODEL=mock`, which is what lets the e2e suite drive a whole tool turn
 * through the real server, scheduler, brain and log.
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

/** The registry the test hook runs with: {@link testEchoTool} beside the real {@link askUserTool}. */
export function createTestToolRegistry(): ToolRegistry {
  return createToolRegistry([askUserTool, testEchoTool])
}

/**
 * The tools this process registers.
 *
 * Every deployment gets `ask_user` (#309) — the model can ask the user a question, and the turn
 * pauses until they answer. The test model additionally gets the `echo` tool, so a whole tool
 * turn — the call stored, run, answered, the second request — can be driven through the real
 * server in an e2e test.
 *
 * One function, called once, because two readers need the same answer: the turn's options and
 * the `/v1/me/tools` routes both build from this registry, and a tool listed as available must
 * be one a chat can really call.
 *
 * @param kind which factory the process runs — `mock` adds the test tool
 */
export function createTurnRegistry(kind: ResolvedModel['kind']): ToolRegistry {
  return kind === 'mock' ? createTestToolRegistry() : createToolRegistry([askUserTool])
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
  /** The tools this process registers (always at least `ask_user`). */
  readonly tools: ToolRegistry
  /** The store the settings resolver reads a user's choices from. */
  readonly store: Pick<SessionStore, 'getToolSettings' | 'getMode' | 'getPreferences'>
  /** The model registry, which answers which models can call tools at all. */
  readonly registry: ModelRegistry
}

/**
 * Resolve the tools a turn runs with.
 *
 * Every deployment registers `ask_user` (#309), so this always answers: a chat whose owner has
 * turned everything off offers nothing — an empty offer, not a missing one — and a host that
 * would rather run without tools passes the turn no options at all.
 */
export function createTurnTools(deps: TurnToolDeps): TurnToolOptions {
  const { tools } = deps
  return {
    tools,
    toolSettings: createToolSettingsResolver({ store: deps.store, tools }),
    toolSupportFor: createToolSupportResolver(deps.registry),
    maxToolSteps: deps.config.maxToolSteps,
  }
}
