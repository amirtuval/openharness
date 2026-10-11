import type { ToolRegistry, ToolResult, ToolRunContext } from '@openharness/hands'
import { createToolRegistry, errorResult } from '@openharness/hands'
import type {
  JsonValue,
  ModeToolOverride,
  ProviderCredentialType,
  StoredEvent,
  ToolCallEvent,
  ToolInput,
  ToolPermission,
  ToolReference,
  UserId,
} from '@openharness/protocol'
import {
  ASK_USER_TOOL_NAME,
  isToolCallEvent,
  isToolResultEvent,
  toolCallOfferedName,
  toolResultCallId,
} from '@openharness/protocol'
import type { AppendableEvent } from '@openharness/session'
import type { ToolSet } from 'ai'
import { jsonSchema, zodSchema } from 'ai'

import { agentMcpToolUse, agentToolUse, toolResultForCall } from './events'
import type { McpToolRef } from './mcp'
import type { ModelToolCall } from './model'
import {
  awaitingUser,
  confirmationsByCall,
  executionLost,
  malformedQuestion,
  waitsForUser,
} from './pausing'

/**
 * The loop's half of tools: what a request offers, what the settings in force say about a call,
 * and how one step's calls are run and stored (epic #303, X2/X4; the per-user settings and the
 * mode's override: #307).
 *
 * `@openharness/hands` owns *how* a tool runs; this module owns *when* — one request's offered
 * set resolved, one step's calls stored, run concurrently and answered in call order, all
 * through the turn's own append so every write stays fenced and validated like any other.
 * Nothing here holds state between steps: the log is what says which call is owed an answer.
 */

/**
 * The most model requests one turn may make (epic #303, X2).
 *
 * A turn is one call of the model per step, so this is the number of steps a loop of
 * tool-calls-whose-results-prompt-more-calls may run before the turn is cut short. Fifty is
 * far past any real task and well short of a runaway: the turn ends with a visible
 * `session.error` and the session goes idle rather than retrying.
 */
export const DEFAULT_MAX_TOOL_STEPS = 50

/**
 * What the settings in force say about one tool (epic #303, X4; issue #307).
 *
 * `enabled` decides whether the tool is **offered at all**: a tool that is off is not in a
 * request's offer — the model cannot see it and cannot call it — which is what the per-user
 * "on or off" and a mode's override decide between them. `permission` is the permission a call
 * to it is **evaluated under** when it is offered: `allow` runs the call, `deny` refuses it
 * without running it, and `ask` pauses the turn until the user answers (epic #303, #309).
 *
 * The two are separate for a reason: a tool with `deny` is still offered (the model may call
 * it and be told no, which it can act on), and a `remember: session` approval is remembered per
 * tool, which is why a permission is a per-tool value and not a single switch.
 */
export interface ToolDecision {
  /** Whether the tool is offered to the model at all. */
  readonly enabled: boolean
  /** The permission a call to it is evaluated under. */
  readonly permission: ToolPermission
}

/**
 * The effective tool settings for one request, keyed by tool name (epic #303, X4; #307).
 *
 * A name the record does not carry is offered under **the tool's own declared permission** —
 * what a host with no settings, and a tool a user has never configured, get — so a resolver
 * answers only the names it has something to say about if it likes.
 */
export type ToolSettings = Readonly<Record<string, ToolDecision>>

/**
 * Where a request's tool settings come from (epic #303, X4; #307): the user's stored settings,
 * with the request's mode's override applied over them, asked once per request.
 *
 * A resolver rather than a value, for the reason the credential resolver is one: the settings
 * belong to the session's owner and live in the host's store, and nothing in this package reads
 * a database or an environment variable. It is asked **once per request** — not once per call
 * as the earlier per-call policy was — because the whole offered set has to be known before the
 * request is built: a disabled tool is left out of the offer entirely, and the span has to
 * record what this request really offered. Asking per request is also what makes a settings
 * change, or a mode edit, apply from the next request on, exactly as a model switch does.
 *
 * The **mode's override** travels with the question (`modeOverride`) rather than being applied
 * here, because the mode a chat follows is the host's to resolve: the host has the mode row and
 * the user's settings in one place and answers the two merged, and this package never has to
 * know how a mode overrides a user. `null` is a request whose chat follows no mode, or a mode
 * that says nothing about tools.
 *
 * A host that injects none gets each tool's own declared permission, which for every built-in
 * tool is `allow` (#305) — the epic's "allow every registered tool" — while a tool that
 * declares otherwise (an MCP tool's `ask`, #312) is honoured rather than silently allowed.
 */
export type ToolSettingsResolver = (
  ownerId: UserId,
  modeOverride: ModeToolOverride | null,
) => Promise<ToolSettings> | ToolSettings

/**
 * Whether a model can call tools at all, asked once per request (epic #303, X2).
 *
 * The same injected-resolver seam as `reasoningSupportFor`: the server answers from its
 * models.dev snapshot (`tool_call`), and `undefined` — a model the registry does not know —
 * means "offer them": hiding tools from an unfamiliar model would be guessing, and a custom
 * endpoint whose server supports them is exactly the case that would lose.
 */
export type ToolSupportFor = (
  modelId: string,
  credentialType: ProviderCredentialType,
) => boolean | undefined

/**
 * Where a turn's per-user tool values come from (epic #303, X4).
 *
 * A resolver rather than a value, for the reason the credential resolver is one: the values
 * belong to the session's owner, and the host is what knows how to find them. Nothing in this
 * package reads an environment variable or a store.
 */
export type ToolSecretResolver = (ownerId: UserId) => Promise<Readonly<Record<string, string>>>

/**
 * The registry this request may call from, or `undefined` when it offers no tools.
 *
 * A deployment with no registry has nothing to offer, a model the registry marks as tool-less
 * gets none, and a request in which **every** registered tool is disabled offers none either:
 * in each case the request is built exactly as it was before tools existed, which is what makes
 * a model that cannot call tools work rather than fail on a rejected parameter — and what makes
 * "the user turned every tool off" the same request as "this deployment has no tools".
 */
export function toolsFor(
  registry: ToolRegistry | undefined,
  supportFor: ToolSupportFor | undefined,
  settings: ToolSettings | undefined,
  modelId: string,
  credentialType: ProviderCredentialType,
): ToolRegistry | undefined {
  if (registry === undefined) {
    return undefined
  }
  if (supportFor?.(modelId, credentialType) === false) {
    return undefined
  }
  return enabledTools(registry, settings)
}

/**
 * The registry with the tools a user has turned off left out, or `undefined` when that leaves
 * none (epic #303, X4; #307).
 *
 * The same registry instance comes back whenever nothing is disabled, which is the case every
 * host without settings is in, so "no settings" and "settings that disable nothing" build
 * identical requests.
 */
function enabledTools(
  registry: ToolRegistry,
  settings: ToolSettings | undefined,
): ToolRegistry | undefined {
  if (settings === undefined) {
    return registry
  }
  const tools = registry.tools.filter((tool) => isEnabled(settings[tool.name]))
  if (tools.length === registry.tools.length) {
    return registry
  }
  return tools.length === 0 ? undefined : createToolRegistry(tools)
}

/** Whether the settings offer a tool: a name they do not carry is offered, on its declaration. */
function isEnabled(decision: ToolDecision | undefined): boolean {
  return decision?.enabled ?? true
}

/**
 * The tools a request offers, as its `span.model_request_start` records them (epic #303, X1; #312).
 *
 * @param registry the tools the request offered — the deployment's and the remote ones together
 * @param mcp which server each remote tool came from, by offered name, or `undefined` for a
 *   request that offered none. A tool the map does not name is this build's own.
 */
export function offeredTools(
  registry: ToolRegistry,
  mcp?: ReadonlyMap<string, McpToolRef>,
): ToolReference[] {
  return registry.tools.map((tool) => {
    const remote = mcp?.get(tool.name)
    return remote === undefined
      ? { name: tool.name, source: 'builtin' }
      : { name: tool.name, source: 'mcp', server: remote.serverName }
  })
}

/**
 * The tools a request offers the model, in the registry's order.
 *
 * **No tool carries `execute`.** A tool the AI SDK can run is a tool it runs itself, looping
 * and making the next model request underneath the loop that owns the log — the second loop
 * epic #303, X2 forbids. Without one the SDK stops after the step and reports the calls, which
 * is what the brain stores and runs.
 */
export function toolSet(registry: ToolRegistry): ToolSet {
  return Object.fromEntries(
    registry.tools.map((tool) => [
      tool.name,
      {
        description: tool.description,
        // A tool whose schema came from elsewhere (a remote MCP tool's, #312) is offered the
        // JSON Schema it was given — the model has to see the parameters the server really
        // takes — while a tool this build defines is offered its zod schema.
        inputSchema:
          tool.inputJson === undefined
            ? zodSchema(tool.inputSchema)
            : jsonSchema(tool.inputJson as unknown as Parameters<typeof jsonSchema>[0]),
      },
    ]),
  )
}

/** What the loop tells {@link runToolStep} about the step it is running. */
export interface ToolStepOptions {
  /** The calls the step produced, in the order the model made them. */
  readonly calls: readonly ModelToolCall[]
  /** The tools a call may name — the request's own offer, disabled tools already left out. */
  readonly registry: ToolRegistry
  /** What the settings in force say; each tool's own permission when absent (#307). */
  readonly settings?: ToolSettings
  /**
   * The remote tools this request offered, by their offered name (epic #303, X10; #312).
   *
   * A call to one of these is stored as an `agent.mcp_tool_use` — with the server it belongs to
   * and the tool's own name on it — and answered with an `agent.mcp_tool_result`. Absent (or a
   * name it does not carry) means a built-in call, which is the pair `agent.tool_use` /
   * `agent.tool_result` records.
   */
  readonly mcp?: ReadonlyMap<string, McpToolRef>
  /**
   * The tools this chat has already been told to allow — a `remember: session` approval
   * (epic #303, #309). Read off the log by the turn (`sessionApprovedTools`), because the
   * confirmation event is the record; a name here is offered and run without asking again.
   */
  readonly approved?: ReadonlySet<string>
  /** The per-user values the host resolved for this turn (X4). */
  readonly secrets?: Readonly<Record<string, string>>
  /** The turn's signal: an aborted call is answered as interrupted. */
  readonly signal?: AbortSignal
  /** The turn's one write path: validated, fenced, and atomic per append. */
  readonly append: (events: AppendableEvent[]) => Promise<StoredEvent[]>
}

/**
 * Handle one step's tool calls: decide, store, run, answer (epic #303, X2).
 *
 * The order is the contract, and each part of it is deliberate:
 *
 * 1. **The permission is read before the call is stored**, so `agent.tool_use` records the
 *    permission the call was actually evaluated under — not what a setting says now.
 * 2. **The calls are stored first, in one append.** Everything the model asked for is in the
 *    log before anything runs, so a turn that dies mid-execution leaves "these calls were
 *    made" behind for its successor to find.
 * 3. **The calls run concurrently**, so three fetches take one fetch's time.
 * 4. **The results are stored in call order**, in one append: the log reads as the model asked
 *    its questions, not as they happened to finish.
 *
 * A call the settings refuse is never run: it is answered as an `is_error` result that says why
 * (`Permission to use <name> has been denied.`), so the model learns what happened rather than
 * being left to guess. A call the user has to answer is **not** answered here at all: it is
 * stored, nothing runs it, and the turn ends `requires_action` — the results arrive in the turn
 * the `user.tool_confirmation` starts (`./pausing`). The one exception is a question no client
 * could render (`ask_user` called with a shape its schema refuses): the model is told what was
 * wrong with it and asks again, rather than the turn pausing on something nobody can answer.
 *
 * A call naming a tool nothing carries is the exception to the refusals — there is no permission
 * question to answer, so the registry answers it (`No tool named <name> is registered.`). A call
 * naming a tool this request did not offer cannot arrive from the offer the request was built
 * from; if one does anyway, the registry answers it the same way, because the tool is not in the
 * registry this step was handed. An interrupt during the step is not special here — every call
 * gets an answer, those cut short with `Interrupted by the user.`, and a call waiting on the user
 * is left waiting for the turn's ending to resolve (see `runTurn`) — and the loop ends the turn
 * on it afterwards.
 */
export async function runToolStep(options: ToolStepOptions): Promise<void> {
  const { calls, registry, settings, append } = options
  if (calls.length === 0) {
    return
  }
  const approved = options.approved ?? new Set<string>()
  // The decision per call, resolved from the settings, the tool's own declaration and the
  // approvals this chat already has, before anything is stored — so each call's event records
  // the decision it was actually made under.
  const decisions = calls.map((call) => decisionFor(registry, settings, call.name, approved))
  const inputs = calls.map((call) => asToolInput(call.input))
  const stored = await append(
    calls.map((call, index) => {
      const permission = decisions[index]?.permission ?? 'deny'
      const input = inputs[index] ?? {}
      const remote = options.mcp?.get(call.name)
      // The pair the call belongs to is the event type: a remote tool's call records the server
      // and the tool's own name on it, and is answered by an `agent.mcp_tool_result` (#312).
      return remote === undefined
        ? agentToolUse(call.name, input, permission)
        : agentMcpToolUse(remote.serverName, remote.toolName, input, permission)
    }),
  )
  const context: ToolRunContext = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
  }
  const results = await Promise.all(
    calls.map(async (call, index): Promise<ToolResult | null> => {
      const decision = decisions[index] ?? { permission: 'deny' as const, waiting: false }
      const input = inputs[index] ?? {}
      if (decision.waiting) {
        // The call is the user's to answer (#309): nothing runs, and no result is written — the
        // turn ends `requires_action` and the next turn answers it from the confirmation. The
        // one exception is a question nothing could answer: the model is told what was wrong
        // with it and asks again, rather than the turn pausing on a call no client can render.
        const problem = malformedQuestion({ name: call.name, input })
        return problem === null ? null : errorResult(problem)
      }
      if (runs(registry, call.name, decision.permission)) {
        return await registry.execute(call.name, input, context)
      }
      return errorResult(refusal(call.name))
    }),
  )
  await append(
    stored.flatMap((event, index) => {
      const result = results[index]
      if (result === null || result === undefined || !isToolCallEvent(event)) {
        return []
      }
      // The answer is written in the call's own pair, `agent.mcp_tool_result` for a remote one.
      return [toolResultForCall(event, result.content, result.isError === true)]
    }),
  )
}

/**
 * Answer the calls a turn inherited without an answer (epic #303, X3).
 *
 * A `agent.tool_use` with no `agent.tool_result` is a call whose execution this brain did not
 * see: the process that had it died, or the turn was cut off between the two appends. It is
 * **never run again** — the tool may have had an effect nobody recorded, and repeating it
 * would duplicate a write, a purchase or a message — so the call is answered with
 * `execution lost` and the model decides what to do about it: try again, try something else,
 * or tell the user.
 *
 * The one call this must *not* answer is one still waiting on the user — an approval or an
 * `ask_user` question with nothing answering it yet (#309) — because there is nothing to be
 * lost: the question is still open, and a resumed brain keeps waiting (see
 * {@link lostExecutions}). A call the user *did* answer, and which then went unanswered, **is**
 * one of these: whatever the approval allowed may already have run.
 *
 * @param events the session's log, as the turn's replay read handed it over
 * @param append the turn's append
 */
export async function repairLostExecutions(
  events: readonly StoredEvent[],
  append: (events: AppendableEvent[]) => Promise<StoredEvent[]>,
): Promise<void> {
  const lost = lostExecutions(events)
  if (lost.length === 0) {
    return
  }
  await append(
    lost.map((call) =>
      toolResultForCall(
        call,
        // The name the model called the tool by: for a remote tool the offered name (#312),
        // which is what the model called and what a cap or a settings entry is keyed by.
        [{ type: 'text', text: executionLost(toolCallOfferedName(call)) }],
        true,
      ),
    ),
  )
}

/**
 * The calls the log holds with no answer that a brain inherited rather than made (X3).
 *
 * Every unanswered call except the ones still waiting on the user: a call nobody has been asked
 * about is open, and answering it would end a question the user may still answer. A call with a
 * confirmation is not waiting any more — the user answered, and whether the loop had got as far
 * as running it is exactly what a crash makes unknowable — so it is one of these.
 *
 * Built-in and remote alike (#312): a remote tool may have had an effect nobody recorded just as
 * a built-in one may, so it is answered `execution lost` and never run again either.
 *
 * @param events the session's log, as the turn's replay read handed it over
 */
export function lostExecutions(events: readonly StoredEvent[]): ToolCallEvent[] {
  const confirmations = confirmationsByCall(events)
  const waiting = new Set(
    awaitingUser(events)
      .filter((call) => !confirmations.has(call.id))
      .map((call) => call.id),
  )
  return pendingToolUse(events).filter((call) => !waiting.has(call.id))
}

/**
 * The calls the log holds with no result, in the order they were made (epic #303, X3).
 *
 * The pairing is by id and nothing else — `agent.tool_result.tool_use_id` names the
 * `agent.tool_use` it answers — so a call whose answer is missing is exactly a call no event
 * points at. A `session.rewind` that took a call back removes it from the replay read the
 * caller passes here, so a branch nobody is on contributes nothing.
 */
export function pendingToolUse(events: readonly StoredEvent[]): ToolCallEvent[] {
  const answered = new Set<string>()
  for (const event of events) {
    if (isToolResultEvent(event)) {
      answered.add(toolResultCallId(event))
    }
  }
  return events.filter(
    (event): event is ToolCallEvent => isToolCallEvent(event) && !answered.has(event.id),
  )
}

/**
 * What one call is decided to be (epic #303, X4; #307; #309).
 *
 * `permission` is what the call's `agent.tool_use` records — the decision it was made under —
 * and `waiting` says whether the turn has to stop for the user. They are two fields because a
 * pause is recorded as `ask` while what it means is "not yet": the call is stored, nothing runs,
 * and the turn ends `requires_action`.
 */
interface CallDecision {
  readonly permission: ToolPermission
  /** Whether the call is waiting on the user rather than running now. */
  readonly waiting: boolean
}

/**
 * Decide one call: what it is evaluated under, and whether it waits for the user.
 *
 * The settings in force first — they are what a user chose, with the request's mode override
 * already applied — and the tool's own declared permission otherwise, so a host with no
 * settings, and a tool a user has never configured, keep the behaviour #304 shipped. A name
 * that no tool carries has no declaration either, and reads as `deny`: a call nothing may run
 * is exactly what `deny` says.
 *
 * A `deny` refuses the call whatever else is true: it is the user's own decision about the tool,
 * and the one thing that outranks a pause. Otherwise a call the settings evaluate as `ask` — or
 * a call to `ask_user`, which always asks — waits, unless this chat has already been told to
 * allow that tool (`remember: session`, epic #303, #309). A remembered approval never waives
 * `ask_user`: a question is still a question, and only the user's answers can answer it.
 */
function decisionFor(
  registry: ToolRegistry,
  settings: ToolSettings | undefined,
  name: string,
  approved: ReadonlySet<string>,
): CallDecision {
  const tool = registry.get(name)
  const permission = settings?.[name]?.permission ?? tool?.permission ?? 'deny'
  if (permission === 'deny') {
    return { permission, waiting: false }
  }
  if (waitsForUser(permission, tool !== undefined, name)) {
    const remembered = name !== ASK_USER_TOOL_NAME && approved.has(name)
    return remembered
      ? { permission: 'allow', waiting: false }
      : { permission: 'ask', waiting: true }
  }
  return { permission, waiting: false }
}

/** What a refused call is answered with (epic #303, X4). */
function refusal(name: string): string {
  return `Permission to use ${name} has been denied.`
}

/**
 * Whether a call is handed to the registry — which is what runs it, or answers that nothing of
 * that name exists.
 *
 * A permission refuses a call only where there is a tool to refuse: a name no tool carries is
 * not a permission question, and the registry's own answer (`No tool named … is registered.`)
 * is the one a model can act on. It is still recorded as `deny`, because a call nothing may run
 * is precisely what `deny` says — the reason travels in the result, where a reader looks for it.
 */
function runs(registry: ToolRegistry, name: string, permission: ToolPermission): boolean {
  return permission === 'allow' || registry.get(name) === undefined
}

/** How deep {@link asToolInput} walks before it stops believing a value is JSON. */
const MAX_TOOL_INPUT_DEPTH = 32

/**
 * The arguments a call carried, as the JSON object the protocol stores.
 *
 * A provider hands back whatever its JSON carried, and the log demands JSON
 * ({@link ToolInput}): a value that cannot survive a round trip — a function, a `Date` a
 * parsed schema produced, a cycle, a number that is not finite — would be stored as something
 * no reader could read back. So the value is walked once and anything that is not JSON is
 * dropped, an array losing its holes and an object its non-JSON keys. Arguments that are not
 * an object at all become `{}`: no registered tool takes one, and the registry's own schema is
 * what tells the model so.
 */
export function asToolInput(value: unknown): ToolInput {
  const walked = jsonValueOf(value, 0)
  return isJsonObject(walked) ? walked : {}
}

/** One value as JSON, or `undefined` when it cannot be one. */
function jsonValueOf(value: unknown, depth: number): JsonValue | undefined {
  if (depth > MAX_TOOL_INPUT_DEPTH) {
    return undefined
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const item_ = jsonValueOf(item, depth + 1)
      return item_ === undefined ? [] : [item_]
    })
  }
  if (typeof value === 'object') {
    const object: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      const item_ = jsonValueOf(item, depth + 1)
      if (item_ !== undefined) {
        object[key] = item_
      }
    }
    return object
  }
  return undefined
}

/** Whether a walked value is a JSON object — what a tool's arguments have to be. */
function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
