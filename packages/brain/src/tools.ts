import type { ToolRegistry, ToolRunContext } from '@openharness/hands'
import { errorResult } from '@openharness/hands'
import type {
  AgentToolUseEvent,
  JsonValue,
  ProviderCredentialType,
  StoredEvent,
  ToolInput,
  ToolPermission,
  ToolReference,
  UserId,
} from '@openharness/protocol'
import { EVENT_TYPES } from '@openharness/protocol'
import type { AppendableEvent } from '@openharness/session'
import type { ToolSet } from 'ai'
import { zodSchema } from 'ai'

import { agentToolResult, agentToolUse } from './events'
import type { ModelToolCall } from './model'

/**
 * The loop's half of tools: what a request offers, what the policy in force says about a call,
 * and how one step's calls are run and stored (epic #303, X2/X4).
 *
 * `@openharness/hands` owns *how* a tool runs; this module owns *when* — one step's calls
 * resolved, stored, run concurrently and answered in call order, all through the turn's own
 * append so every write stays fenced and validated like any other. Nothing here holds state
 * between steps: the log is what says which call is owed an answer.
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
 * What the policy in force says about one call (epic #303, X3/X4).
 *
 * The host injects it — the per-user settings of #307 will live behind it — and the loop asks
 * it once per call, so a change applies from the next call on. `deny` refuses the call without
 * running it, `allow` runs it, and `ask` is the pause #309 adds: nothing produces it yet, and
 * until pausing exists the loop treats it as a refusal rather than running something the user
 * has not agreed to.
 *
 * A host that injects none gets each tool's own declared permission, which for every built-in
 * tool is `allow` (#305) — so the default is the epic's "allow every registered tool" — while
 * a tool that declares otherwise (an MCP tool's `ask`, #312) is honoured rather than silently
 * allowed.
 */
export type ToolPolicyResolver = (
  toolName: string,
  ownerId: UserId,
) => ToolPermission | Promise<ToolPermission>

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
 * A deployment with no registry has nothing to offer, and a model the registry marks as
 * tool-less gets none: its request is built exactly as it was before tools existed, which is
 * what makes a model that cannot call tools work rather than fail on a rejected parameter.
 */
export function toolsFor(
  registry: ToolRegistry | undefined,
  supportFor: ToolSupportFor | undefined,
  modelId: string,
  credentialType: ProviderCredentialType,
): ToolRegistry | undefined {
  if (registry === undefined) {
    return undefined
  }
  return supportFor?.(modelId, credentialType) === false ? undefined : registry
}

/** The tools a request offers, as its `span.model_request_start` records them. */
export function offeredTools(registry: ToolRegistry): ToolReference[] {
  return registry.tools.map((tool) => ({ name: tool.name, source: 'builtin' }))
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
      { description: tool.description, inputSchema: zodSchema(tool.inputSchema) },
    ]),
  )
}

/** What the loop tells {@link runToolStep} about the step it is running. */
export interface ToolStepOptions {
  /** The calls the step produced, in the order the model made them. */
  readonly calls: readonly ModelToolCall[]
  /** The tools a call may name. */
  readonly registry: ToolRegistry
  /** The session's owner, which the policy resolver is asked about. */
  readonly ownerId: UserId
  /** What the policy in force says; each tool's own permission when absent. */
  readonly policy?: ToolPolicyResolver
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
 * 1. **The policy is resolved before the call is stored**, so `agent.tool_use` records the
 *    permission the call was actually evaluated under — not what a setting says now.
 * 2. **The calls are stored first, in one append.** Everything the model asked for is in the
 *    log before anything runs, so a turn that dies mid-execution leaves "these calls were
 *    made" behind for its successor to find.
 * 3. **The calls run concurrently**, so three fetches take one fetch's time.
 * 4. **The results are stored in call order**, in one append: the log reads as the model asked
 *    its questions, not as they happened to finish.
 *
 * A call the policy refuses is never run: it is answered with `Permission to use <name> has
 * been denied.` as an `is_error` result, so the model learns why rather than being left to
 * guess. A call naming a tool nothing carries is the exception — there is no policy question to
 * answer, so the registry answers it (`No tool named <name> is registered.`). An interrupt during the step is not special here — every call gets an answer, those
 * cut short with `Interrupted by the user.` — and the loop ends the turn on it afterwards.
 */
export async function runToolStep(options: ToolStepOptions): Promise<void> {
  const { calls, registry, ownerId, policy, append } = options
  if (calls.length === 0) {
    return
  }
  // Policy first, concurrently and in call order: a resolver is the host's (it may read the
  // user's settings), and the answer has to exist before the call that carries it is stored.
  const permissions = await Promise.all(
    calls.map(
      async (call) =>
        (await policy?.(call.name, ownerId)) ?? defaultPermission(registry, call.name),
    ),
  )
  const inputs = calls.map((call) => asToolInput(call.input))
  const stored = await append(
    calls.map((call, index) =>
      agentToolUse(call.name, inputs[index] ?? {}, permissions[index] ?? 'deny'),
    ),
  )
  const context: ToolRunContext = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
  }
  const results = await Promise.all(
    calls.map((call, index) =>
      runs(registry, call.name, permissions[index] ?? 'deny')
        ? registry.execute(call.name, inputs[index] ?? {}, context)
        : Promise.resolve(errorResult(`Permission to use ${call.name} has been denied.`)),
    ),
  )
  await append(
    stored.map((event, index) =>
      agentToolResult(event.id, results[index]?.content ?? [], results[index]?.isError === true),
    ),
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
 * The one call this must *not* answer is one waiting on the user — an approval or an
 * `ask_user` question (#309) — because there is nothing to be lost: the question is still
 * open, and writing a result over it would answer a question nobody asked. Nothing pauses a
 * turn yet, so every inherited call is repaired; that check is the seam #309 fills.
 *
 * @param events the session's log, as the turn's replay read handed it over
 * @param append the turn's append
 */
export async function repairLostExecutions(
  events: readonly StoredEvent[],
  append: (events: AppendableEvent[]) => Promise<StoredEvent[]>,
): Promise<void> {
  const lost = pendingToolUse(events)
  if (lost.length === 0) {
    return
  }
  await append(
    lost.map((call) =>
      agentToolResult(
        call.id,
        [
          {
            type: 'text',
            text:
              `Tool ${call.name}: execution lost. The turn that started this call did not finish, ` +
              'so it was not run again.',
          },
        ],
        true,
      ),
    ),
  )
}

/**
 * The calls the log holds with no result, in the order they were made (epic #303, X3).
 *
 * The pairing is by id and nothing else — `agent.tool_result.tool_use_id` names the
 * `agent.tool_use` it answers — so a call whose answer is missing is exactly a call no event
 * points at. A `session.rewind` that took a call back removes it from the replay read the
 * caller passes here, so a branch nobody is on contributes nothing.
 */
export function pendingToolUse(events: readonly StoredEvent[]): AgentToolUseEvent[] {
  const answered = new Set<string>()
  for (const event of events) {
    if (event.type === EVENT_TYPES.agentToolResult) {
      answered.add(event.tool_use_id)
    }
  }
  return events.filter(
    (event): event is AgentToolUseEvent =>
      event.type === EVENT_TYPES.agentToolUse && !answered.has(event.id),
  )
}

/** What the policy says by default: the tool's own permission, or a refusal for a name none has. */
function defaultPermission(registry: ToolRegistry, name: string): ToolPermission {
  return registry.get(name)?.permission ?? 'deny'
}

/**
 * Whether a call is handed to the registry — which is what runs it, or answers that nothing of
 * that name exists.
 *
 * A policy refuses a call only where there is a tool to refuse: a name no tool carries is not a
 * policy question, and the registry's own answer (`No tool named … is registered.`) is the one
 * a model can act on. It is still recorded as `deny`, because a call nothing may run is
 * precisely what `deny` says — the reason travels in the result, where a reader looks for it.
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
