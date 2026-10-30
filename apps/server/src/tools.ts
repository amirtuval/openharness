import { appendFile } from 'node:fs/promises'

import type {
  McpToolProvider,
  SubagentRuntime,
  SubagentTypeResolver,
  ToolSecretResolver,
  ToolSettingsResolver,
  ToolSupportFor,
} from '@openharness/brain'
import {
  HARNESS_TOOL_HANDLERS,
  createSubagentTools,
  createToolRegistry,
  createWebFetchTool,
  textResult,
  todoWriteTool,
} from '@openharness/hands'
import type { McpFetch, ToolDefinition, ToolRegistry } from '@openharness/hands'
import type { SessionId } from '@openharness/protocol'
import type { SessionStore } from '@openharness/session'
import { z } from 'zod'

import type { ModelRegistry } from './catalog/registry'
import { createToolSupportResolver } from './catalog/tool-support'
import { createMcpToolProvider } from './mcp/tools'
import type { McpServerService } from './mcp/service'
import type { ResolvedModel } from './model'
import { askUserTool } from './pausing'
import { testTaskTool } from './test-tasks'
import { createToolSettingsResolver } from './tool-settings'
import type { Logger } from './types'

/**
 * The tools a turn may offer (epic #303, X4; the built-ins are #305; the per-user settings are
 * #307), and how this server registers and wires them.
 *
 * Every deployment gets the built-in tools of
 * [#305](https://github.com/amirtuval/openharness/issues/305): `web_fetch` and `todo_write` —
 * the one reaches a URL the model chose through `safeFetch`, the other keeps the model's own
 * list. **`web_search` is not one of them any more** (#335): it is offered by attaching the
 * chat model's own provider's native search tool to the request, so there is nothing here to
 * register, no key to inject and no allowance to count — `@openharness/brain`'s
 * `./native-search` decides per request whether the model has one. The test model additionally
 * gets the `echo` tool, which is what lets the e2e suite drive a whole tool turn through the
 * real server. The slow test tool (#378, P4) is the one exception: it is registered **only**
 * when `OPENHARNESS_TEST_TOOL_EXECUTION_LOG` is set, because the suite that needs it is the
 * only one that may see it in the offer.
 *
 * **`ask_user` is registered by every deployment, whatever the model** (epic #303, #309): a
 * model that needs a decision asks the user for one, the turn ends `requires_action`, and the
 * user's answer is the call's result. It is the one tool the server itself provides, and it is
 * process-independent — nothing about it is a test hook.
 *
 * The per-user settings (#307) sit on top of the same registry: {@link createTurnTools} hands
 * the brain a resolver over the very registry {@link createTurnRegistry} built, so a tool a
 * settings screen calls unavailable is one a request is not offered. `web_search` is not in
 * that registry and is still listed there: it is offered per request, and its availability is
 * the chat model's (`./tool-settings`).
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

/** The name of the mock model's slow test tool (#378, P4). */
export const TEST_SLOW_TOOL_NAME = 'echo_slow'

/** What the model reads about {@link createTestSlowTool}. */
export const TEST_SLOW_TOOL_DESCRIPTION =
  'Test only: echo the text after a delay, so a test can kill the process while the call runs.'

/** How long the slow tool waits when its call names no delay. */
export const TEST_SLOW_TOOL_DEFAULT_DELAY_MS = 60_000

/**
 * A test-only tool that takes its time (#378, P4).
 *
 * The e2e crash suite needs a tool call that is really in flight when its owner is killed: the
 * recovering brain must answer the inherited call `execution lost` and **not** run it. A
 * delay is the seam; the input carries it, so a test chooses the window. The tool appends one
 * line to `OPENHARNESS_TEST_TOOL_EXECUTION_LOG` per execution — the count a test reads
 * afterwards to prove there was only one.
 *
 * That variable is also what registers the tool: a mock server that does not set it offers the
 * ordinary test tools alone, so a test asserting an exact offer — every e2e suite but the crash
 * one — is not handed a tool its fixture never calls. A deployment never registers it, and one
 * that sets the variable by mistake still gets nothing: `kind` has to be `mock` too.
 */
export function createTestSlowTool(options: {
  readonly executionLog: string
}): ToolDefinition<{ text: string; delay_ms?: number }> {
  return {
    name: TEST_SLOW_TOOL_NAME,
    description: TEST_SLOW_TOOL_DESCRIPTION,
    inputSchema: z.object({
      text: z.string(),
      delay_ms: z.number().int().min(0).max(TEST_SLOW_TOOL_DEFAULT_DELAY_MS).optional(),
    }),
    permission: 'allow',
    // Above the delay the call is allowed to ask for, so the test's own kill is what ends it.
    timeoutMs: TEST_SLOW_TOOL_DEFAULT_DELAY_MS + 5_000,
    run: async (input, context) => {
      await appendFile(options.executionLog, `${TEST_SLOW_TOOL_NAME}\n`, 'utf8')
      await waitUnlessAborted(input.delay_ms ?? TEST_SLOW_TOOL_DEFAULT_DELAY_MS, context.signal)
      return textResult(input.text)
    },
  }
}

/** Wait `ms`, or until the call is aborted — the registry reports the abort either way. */
function waitUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The registry the test hooks run with: {@link testEchoTool} beside the real {@link askUserTool}.
 *
 * The task **wait** is deliberately not here: `agent_wait` is a real tool every deployment
 * registers since #344 (`{@link createTurnRegistry}`), so it is registered by the turn's own
 * registry rather than by a test hook — [`testTaskWaitTool`](./test-tasks.ts) remains for a
 * test that wants the wait tool on its own.
 */
export function createTestToolRegistry(): ToolRegistry {
  return createToolRegistry([askUserTool, testEchoTool, testTaskTool])
}

/**
 * What {@link createTurnRegistry} needs to build a deployment's registry.
 *
 * It is a subset of {@link TurnToolsOptions}, so `main.ts` and the harness can pass the same
 * object to both builders rather than restating the environment twice.
 */
export interface TurnRegistryOptions {
  /** Which factory the process runs — `mock` adds the test tools to the built-ins. */
  readonly kind: ResolvedModel['kind']
  /**
   * The file the mock model's slow tool appends an execution line to (#378, P4); test only.
   *
   * Setting it is what **registers** the tool: a mock server without it offers the ordinary
   * test tools alone, which keeps a fixture-specific tool out of every other suite's exact
   * offer. Ignored unless `kind` is `mock`.
   */
  readonly executionLog?: string | undefined
}

/**
 * The tools this process registers (epic #303; the built-ins are #305; `ask_user` is #309).
 *
 * `web_fetch` and `todo_write` are registered for every process, whatever model it runs, and
 * `ask_user` ahead of them: the
 * model can ask the user a question and the turn pauses until they answer, whichever model the
 * process runs. The test model (`kind === 'mock'`) gets the `echo` tool after `ask_user`,
 * ahead of the tools that reach the world, since those would be exercised by a script that
 * cannot use them — and the slow test tool beside it **only when `executionLog` is set**, so
 * the crash suite's fixture is in the crash suite's offer alone (#378, P4).
 *
 * One function, called once, because two readers need the same answer: the turn's options
 * ({@link createTurnTools}) and the `/v1/me/tools` routes both build from this registry, and a
 * tool listed as available must be one a chat can really call.
 */
export function createTurnRegistry(options: TurnRegistryOptions): ToolRegistry {
  const tools: ToolDefinition[] = [askUserTool]
  if (options.kind === 'mock') {
    // The test hooks: the `echo` tool, and the background task the mock model can start
    // (epic #340, S4/S5; #343). The **wait** a model ends a turn on is no longer a hook: since
    // #344 every deployment registers the real `agent_wait` below, and two tools under one name
    // is what a registry refuses.
    tools.push(testEchoTool, testTaskTool)
    // The slow tool is the crash suite's fixture, and only that suite opts in by naming its
    // execution log: every other mock server would otherwise offer a tool no test calls, and
    // the e2e suites assert the offer exactly.
    if (options.executionLog !== undefined) {
      tools.push(createTestSlowTool({ executionLog: options.executionLog }))
    }
  }
  // The subagent tools (epic #340, S5; #344) are registered here and **replaced** per turn: the
  // definitions this holds are what a settings screen lists (so a user can turn one off, and a
  // mode can override it), and the loop puts the session-bound ones in their place — the names,
  // the schemas and the `allow` default are the same either way. Their `run` answers the
  // sentence every harness-answered tool answers (`HARNESS_TOOL_HANDLERS`): nothing in a real
  // turn reaches it, because a turn that has a runtime swaps the definition before the offer.
  tools.push(
    ...createSubagentTools({ types: [], handlers: HARNESS_TOOL_HANDLERS }),
    createWebFetchTool(),
    todoWriteTool,
  )
  return createToolRegistry(tools)
}

/**
 * The tools a turn is handed, and the loop's decisions about them (epic #303, X4; #307).
 *
 * The field names are `RunTurnOptions`' own, so `SessionRunner` spreads this object straight
 * into a turn's options and there is nothing to keep in step by hand. The settings resolver is
 * the one #307 adds: the session owner's stored choices, with the mode's override applied, read
 * per request. What was #305's — the per-step secrets resolver the operator's search key
 * travelled through — is gone with the key (#335); a tool that still wants a per-user value can
 * be handed one the same way, and nothing needs one today.
 */
export interface TurnToolOptions {
  /** The tools a request may offer — its offer, before the settings take any of them out. */
  readonly tools: ToolRegistry
  /** The settings in force per request; each tool's own declaration when absent (#307). */
  readonly toolSettings?: ToolSettingsResolver
  /** Whether a model can call tools; the registry's `tool_call` when absent. */
  readonly toolSupportFor?: ToolSupportFor
  /** Where a step's per-user values come from, for a tool that wants any (epic #303, X4). */
  readonly resolveToolSecrets?: ToolSecretResolver
  /** The most model requests one turn may make; the brain's default when absent. */
  readonly maxToolSteps?: number
  /**
   * What this deployment knows about subagents (epic #340, S5/S6; #344): the type resolver, and
   * S6's two limits. Absent, the loop offers nobody the five tools — which is what a host that
   * wired no resolver wants.
   */
  readonly subagents?: SubagentRuntime
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
  /** The parsed environment: how many requests one turn may make, and the subagent limits. */
  readonly config: {
    /** The most model requests one turn may make. */
    readonly maxToolSteps: number
    /** How deep a tree of helpers may get (epic #340, S6; #344). */
    readonly maxAgentDepth: number
    /** How many of one root chat's descendants may be live at once (S6; #344). */
    readonly maxLiveTasks: number
  }
  /** Which factory the process runs — `mock` adds the test tool to the built-ins. */
  readonly kind: ResolvedModel['kind']
  /** The store the settings resolver reads a user's choices from. */
  readonly store: Pick<SessionStore, 'getToolSettings' | 'getMode' | 'getPreferences'>
  /** The model registry, which answers which models can call tools at all. */
  readonly registry: ModelRegistry
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
  /**
   * The subagent types this deployment offers, and how the host is signalled (epic #340, S5/S6;
   * #344) — everything the five tools need that is not the store or the session.
   *
   * `main.ts` builds it from the mode resolver's own deps and the two limits of {@link
   * TurnToolsOptions.config}; a test wires its own. Absent, the loop adds nothing and takes
   * nothing away: no chat is offered a helper the deployment cannot start.
   */
  readonly subagents?: SubagentTypeResolver
  /**
   * How the host is told to look at a session now (S5's `agent_stop`, S6's starts; #344).
   *
   * A signal is a hint like every other one — the event is what is durable — so a host that
   * wires none loses latency and nothing else. `main.ts` passes the scheduler's own `signal`.
   */
  readonly signal?: (sessionId: SessionId, kind: 'work' | 'interrupt') => void
}

/**
 * Resolve the tools a turn runs with: the registry, the settings over it (#307), the support
 * gate and the step budget.
 *
 * Every deployment registers `ask_user` (#309), so a chat always offers at least it: a chat
 * whose owner has turned every tool off offers nothing — an empty offer, not a missing one —
 * and a host that would rather run without tools passes the turn no options at all.
 *
 * The registry is built **once per process** and holds no per-user state, so one registry
 * serves every session. The one tool a request carries besides it — a provider's native search
 * (#335) — is not resolved here: the brain attaches it per request, and knows the model.
 */
export function createTurnTools(options: TurnToolsOptions): TurnToolOptions {
  const { config, registry } = options
  const tools = options.tools ?? createTurnRegistry(options)
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
    maxToolSteps: config.maxToolSteps,
    // The subagent half of the loop (epic #340, S5/S6; #344): the types the resolver answers,
    // and the two limits the environment names. Absent a resolver, this stays out of the turn's
    // options entirely, and the loop offers the five tools to nobody.
    ...(options.subagents === undefined
      ? {}
      : {
          subagents: {
            types: options.subagents,
            maxDepth: config.maxAgentDepth,
            maxLiveTasks: config.maxLiveTasks,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        }),
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
