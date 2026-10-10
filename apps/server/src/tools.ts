import type { ToolPolicyResolver, ToolSecretResolver, ToolSupportFor } from '@openharness/brain'
import {
  WEB_SEARCH_API_KEY,
  createBraveSearchProvider,
  createToolRegistry,
  createWebFetchTool,
  createWebSearchTool,
  textResult,
  todoWriteTool,
} from '@openharness/hands'
import type { SearchTransport, ToolDefinition, ToolRegistry } from '@openharness/hands'
import { z } from 'zod'

import type { ModelRegistry } from './catalog/registry'
import { createToolSupportResolver } from './catalog/tool-support'
import type { SearchConfig } from './config'
import type { ResolvedModel } from './model'
import type { SearchAllowance } from './searches'

/**
 * The tools a turn may offer (epic #303, X4), and how this server wires them.
 *
 * Every deployment gets the built-in tools of
 * [#305](https://github.com/amirtuval/openharness/issues/305): `web_fetch` and `todo_write`
 * always — the one reaches a URL the model chose through `safeFetch`, the other keeps the
 * model's own list — and `web_search` **only where the operator configured a search API**,
 * because there is nothing to offer a model without one. A deployment that sets no
 * `OPENHARNESS_SEARCH_API_KEY` therefore offers two tools and no search, which is a smaller
 * offer rather than a broken one.
 *
 * Two things here are the server's alone, and they are why the tools live in `@openharness/hands`
 * and the wiring does not:
 *
 * - **The operator's search key**, which is a deployment secret: the tool is handed it per step
 *   through the turn's per-user values (`resolveToolSecrets`), which is also the channel the
 *   registry scrubs anything a tool returns with. `@openharness/hands` never reads an
 *   environment variable, so nothing else could hand it the key.
 * - **The daily allowance**, which is a fact about the log: the server counts the user's
 *   searches ({@link SearchAllowance}) and withholds the key once they are gone, so the tool
 *   answers with the limit notice. That is the one reason a registered search tool is ever
 *   handed no key.
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
 * reads nothing from its context and uses no secret, which is why it is registered only behind
 * `OPENHARNESS_TEST_MODEL=mock`, where the model is a fake and the tools that reach the world
 * would otherwise be exercised by a script that cannot use them.
 */
export const testEchoTool: ToolDefinition<{ text: string }> = {
  name: TEST_TOOL_NAME,
  description: TEST_TOOL_DESCRIPTION,
  inputSchema: z.object({ text: z.string() }),
  permission: 'allow',
  run: (input) => textResult(input.text),
}

/**
 * The tools a turn is handed, and the loop's decisions about them.
 *
 * The field names are `RunTurnOptions`' own, so `SessionRunner` spreads this object straight
 * into a turn's options and there is nothing to keep in step by hand.
 */
export interface TurnToolOptions {
  /** The tools a request may offer. */
  readonly tools: ToolRegistry
  /** What the policy in force says per call; each tool's own permission when absent (#307). */
  readonly toolPolicy?: ToolPolicyResolver
  /** Whether a model can call tools; the registry's `tool_call` when absent. */
  readonly toolSupportFor?: ToolSupportFor
  /** Where a step's per-user values come from — here, the operator's search key. */
  readonly resolveToolSecrets?: ToolSecretResolver
  /** The most model requests one turn may make; the brain's default when absent. */
  readonly maxToolSteps?: number
}

/** What {@link createTurnTools} needs to build a deployment's registry. */
export interface TurnToolsOptions {
  /** The parsed environment: how many requests a turn may make, and the search settings. */
  readonly config: {
    readonly maxToolSteps: number
    /** The search API `web_search` is served by, or `null` when the deployment offers none. */
    readonly search: SearchConfig | null
  }
  /** Which factory the process runs — `mock` adds the test tool to the built-ins. */
  readonly kind: ResolvedModel['kind']
  /** The model registry, which answers which models can call tools at all. */
  readonly registry: ModelRegistry
  /** The client a search request goes through: the server's egress, like every other call. */
  readonly searchTransport: SearchTransport
  /** The per-user daily allowance, counted from the log; needed only when search is on. */
  readonly allowance: SearchAllowance | undefined
}

/**
 * Resolve the tools this process runs with.
 *
 * The registry is built **once per process** and holds no per-user state: which user is
 * searching is resolved per step (`resolveToolSecrets` is asked with the session's owner), so
 * one registry serves every session without ever holding a key itself.
 */
export function createTurnTools(options: TurnToolsOptions): TurnToolOptions {
  const { config, kind, registry, searchTransport, allowance } = options
  const tools: ToolDefinition[] = [createWebFetchTool(), todoWriteTool]
  if (kind === 'mock') {
    tools.unshift(testEchoTool)
  }
  const search = config.search
  if (search !== null) {
    tools.push(
      createWebSearchTool({
        provider: createBraveSearchProvider({ transport: searchTransport }),
        dailyLimit: search.dailyLimit,
      }),
    )
  }
  return {
    tools: createToolRegistry(tools),
    // Which models may be offered tools is models.dev's `tool_call`, the same gate the context
    // budget and the reasoning effort come from (#304, X2).
    toolSupportFor: createToolSupportResolver(registry),
    // The operator's key, per step, and only while the user has searches left. Withholding it
    // is how the allowance is enforced: the tool answers with the limit notice, which says
    // what happened rather than leaving the model to guess why its call failed.
    ...(search === null || allowance === undefined
      ? {}
      : { resolveToolSecrets: searchSecretResolver(search, allowance) }),
    maxToolSteps: config.maxToolSteps,
  }
}

/** The resolver that hands a step the operator's key while the user's allowance lasts. */
function searchSecretResolver(
  search: SearchConfig,
  allowance: SearchAllowance,
): ToolSecretResolver {
  return async (ownerId): Promise<Readonly<Record<string, string>>> => {
    const remaining = await allowance.remaining(ownerId)
    return remaining > 0 ? { [WEB_SEARCH_API_KEY]: search.apiKey } : {}
  }
}
