import type {
  McpToolProvider,
  ToolSecretResolver,
  ToolSettingsResolver,
  ToolSupportFor,
} from '@openharness/brain'
import {
  WEB_SEARCH_API_KEY,
  createBraveSearchProvider,
  createToolRegistry,
  createWebFetchTool,
  createWebSearchTool,
  textResult,
  todoWriteTool,
} from '@openharness/hands'
import type { McpFetch, SearchTransport, ToolDefinition, ToolRegistry } from '@openharness/hands'
import type { SessionStore } from '@openharness/session'
import { z } from 'zod'

import type { ModelRegistry } from './catalog/registry'
import { createToolSupportResolver } from './catalog/tool-support'
import type { SearchConfig } from './config'
import { createMcpToolProvider } from './mcp/tools'
import type { McpServerService } from './mcp/service'
import type { ResolvedModel } from './model'
import { askUserTool } from './pausing'
import type { SearchAllowance } from './searches'
import { createToolSettingsResolver } from './tool-settings'
import type { Logger } from './types'

/**
 * The tools a turn may offer (epic #303, X4; the built-ins are #305; the per-user settings are
 * #307), and how this server registers and wires them.
 *
 * Every deployment gets the built-in tools of
 * [#305](https://github.com/amirtuval/openharness/issues/305): `web_fetch` and `todo_write`
 * always — the one reaches a URL the model chose through `safeFetch`, the other keeps the
 * model's own list — and `web_search` **only where the operator configured a search API**,
 * because there is nothing to offer a model without one. A deployment that sets no
 * `OPENHARNESS_SEARCH_API_KEY` therefore offers two tools and no search, which is a smaller
 * offer rather than a broken one. The test model additionally gets the `echo` tool, which is
 * what lets the e2e suite drive a whole tool turn through the real server.
 *
 * **`ask_user` is registered by every deployment, whatever the model** (epic #303, #309): a
 * model that needs a decision asks the user for one, the turn ends `requires_action`, and the
 * user's answer is the call's result. It is the one tool the server itself provides, and it is
 * process-independent — nothing about it is a test hook.
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
 *
 * The per-user settings (#307) sit on top of the same registry: {@link createTurnTools} hands
 * the brain a resolver over the very registry {@link createTurnRegistry} built, so a tool a
 * settings screen calls unavailable is one a request is not offered.
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

/** The registry the test hook runs with: {@link testEchoTool} beside the real {@link askUserTool}. */
export function createTestToolRegistry(): ToolRegistry {
  return createToolRegistry([askUserTool, testEchoTool])
}

/**
 * What {@link createTurnRegistry} needs to build a deployment's registry.
 *
 * It is a subset of {@link TurnToolsOptions}, so `main.ts` and the harness can pass the same
 * object to both builders rather than restating the environment twice.
 */
export interface TurnRegistryOptions {
  /** The parsed environment: the search API `web_search` is served by, or `null` for none. */
  readonly config: {
    /** The search API `web_search` is served by, or `null` when the deployment offers none. */
    readonly search: SearchConfig | null
  }
  /** Which factory the process runs — `mock` adds the test tool to the built-ins. */
  readonly kind: ResolvedModel['kind']
  /** The client a search request goes through: the server's egress, like every other call. */
  readonly searchTransport: SearchTransport
}

/**
 * The tools this process registers (epic #303; the built-ins are #305; `ask_user` is #309).
 *
 * `web_fetch` and `todo_write` are registered for every process, whatever model it runs, and
 * `web_search` is added only where the operator configured a search API — with no provider to
 * call there is nothing to offer, and a deployment that configured none gets a smaller offer
 * rather than a broken one. `ask_user` is registered by every process too, ahead of them: the
 * model can ask the user a question and the turn pauses until they answer, whichever model the
 * process runs. The test model (`kind === 'mock'`) gets the `echo` tool after `ask_user`,
 * ahead of the tools that reach the world, since those would be exercised by a script that
 * cannot use them.
 *
 * One function, called once, because two readers need the same answer: the turn's options
 * ({@link createTurnTools}) and the `/v1/me/tools` routes both build from this registry, and a
 * tool listed as available must be one a chat can really call.
 */
export function createTurnRegistry(options: TurnRegistryOptions): ToolRegistry {
  const { config, kind, searchTransport } = options
  const tools: ToolDefinition[] = [askUserTool]
  if (kind === 'mock') {
    tools.push(testEchoTool)
  }
  tools.push(createWebFetchTool(), todoWriteTool)
  const search = config.search
  if (search !== null) {
    tools.push(
      createWebSearchTool({
        provider: createBraveSearchProvider({ transport: searchTransport }),
        dailyLimit: search.dailyLimit,
      }),
    )
  }
  return createToolRegistry(tools)
}

/**
 * The tools a turn is handed, and the loop's decisions about them (epic #303, X4; #307).
 *
 * The field names are `RunTurnOptions`' own, so `SessionRunner` spreads this object straight
 * into a turn's options and there is nothing to keep in step by hand. The settings resolver is
 * the one #307 adds: the session owner's stored choices, with the mode's override applied, read
 * per request; the secrets resolver is #305's, which is where the operator's search key travels.
 */
export interface TurnToolOptions {
  /** The tools a request may offer — its offer, before the settings take any of them out. */
  readonly tools: ToolRegistry
  /** The settings in force per request; each tool's own declaration when absent (#307). */
  readonly toolSettings?: ToolSettingsResolver
  /** Whether a model can call tools; the registry's `tool_call` when absent. */
  readonly toolSupportFor?: ToolSupportFor
  /** Where a step's per-user values come from — here, the operator's search key. */
  readonly resolveToolSecrets?: ToolSecretResolver
  /** The most model requests one turn may make; the brain's default when absent. */
  readonly maxToolSteps?: number
  /**
   * Where a request's remote MCP tools come from (epic #303, X10; #312), or absent for a
   * deployment whose chats offer this build's tools alone. The loop asks it once per request
   * with the session's owner and the mode's tool override.
   */
  readonly mcpTools?: McpToolProvider
}

/**
 * What {@link createTurnTools} builds its answer from: the environment, the tools a process
 * registers, and the store the settings are read from.
 */
export interface TurnToolsOptions {
  /** The parsed environment: how many requests a turn may make, and the search settings. */
  readonly config: {
    /** The most model requests one turn may make. */
    readonly maxToolSteps: number
    /** The search API `web_search` is served by, or `null` when the deployment offers none. */
    readonly search: SearchConfig | null
  }
  /** Which factory the process runs — `mock` adds the test tool to the built-ins. */
  readonly kind: ResolvedModel['kind']
  /** The client a search request goes through: the server's egress, like every other call. */
  readonly searchTransport: SearchTransport
  /** The store the settings resolver reads a user's choices from. */
  readonly store: Pick<SessionStore, 'getToolSettings' | 'getMode' | 'getPreferences'>
  /** The model registry, which answers which models can call tools at all. */
  readonly registry: ModelRegistry
  /** The per-user daily allowance, counted from the log; needed only when search is on. */
  readonly allowance: SearchAllowance | undefined
  /**
   * The tools this process registers, when the caller already built them
   * ({@link createTurnRegistry}); omitted, the built-ins are built here.
   *
   * A test passes its own registry here (through the harness) so a settings screen has
   * something small and known to read; production passes nothing and gets the built-ins.
   */
  readonly tools?: ToolRegistry
  /**
   * The MCP server resource a request's remote tools are listed from (epic #303, X10; #312), or
   * `undefined` for a deployment that offers this build's tools alone.
   *
   * The service is what knows a user's servers, their sealed credentials and how to reach them;
   * the fetch is the guarded one every listing and every call goes through. A test passes its
   * own pair, which is how the remote half is exercised without a network.
   */
  readonly mcp?: {
    readonly service: Pick<McpServerService, 'list' | 'resolve' | 'disconnect'>
    readonly fetch: McpFetch
  }
  /** The clock the MCP listing cache runs on; injectable for tests. */
  readonly now?: () => Date
  /** Where a failed listing is logged. Silent by default. */
  readonly logger?: Logger
}

/**
 * Resolve the tools a turn runs with: the registry, the settings over it (#307), the support
 * gate, the operator's search key (#305) and the step budget.
 *
 * Every deployment registers `ask_user` (#309), so a chat always offers at least it: a chat
 * whose owner has turned every tool off offers nothing — an empty offer, not a missing one —
 * and a host that would rather run without tools passes the turn no options at all.
 *
 * The registry is built **once per process** and holds no per-user state: which user is
 * searching is resolved per step (`resolveToolSecrets` is asked with the session's owner), so
 * one registry serves every session without ever holding a key itself.
 */
export function createTurnTools(options: TurnToolsOptions): TurnToolOptions {
  const { config, registry, allowance } = options
  const tools = options.tools ?? createTurnRegistry(options)
  const search = config.search
  const mcp = options.mcp
  return {
    tools,
    // The per-user settings (#307): the session owner's stored choices, with a mode's override
    // applied, read per request over this very registry — so "available" and "offered" agree.
    // The remote half (#312) comes from the same read of the owner's servers and the same
    // override, so the tools this calls offered and the servers the loop lists agree too.
    toolSettings: createToolSettingsResolver({
      store: options.store,
      tools,
      ...(mcp === undefined ? {} : { mcpServers: mcp.service }),
    }),
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
    // The remote tools a request offers (epic #303, X10; #312): listed per request from the
    // chat's in-force servers, through the guarded fetch, and cached briefly.
    ...(mcp === undefined
      ? {}
      : {
          mcpTools: createMcpToolProvider({
            service: mcp.service,
            fetch: mcp.fetch,
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.logger === undefined ? {} : { logger: options.logger }),
          }),
        }),
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
