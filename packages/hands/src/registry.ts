import type { ToolDefinition, ToolExecutionContext, ToolResult } from './tool'
import { DEFAULT_TOOL_TIMEOUT_MS, errorResult } from './tool'

/**
 * The tools a turn can call, and the one way to call one.
 *
 * A registry is a host's list — it holds nothing itself, reads nothing and remembers nothing
 * between calls — so building a brain's tools is building one of these and handing it over.
 * Everything a call needs that is not the tool's own is passed per call
 * ({@link ToolRunContext}), which is what lets the same registry run for two users without
 * ever holding one of their values.
 */

/** What a caller tells the registry about the turn a call runs in. */
export interface ToolRunContext {
  /**
   * Aborting this ends the call early — an interrupt of the turn, or a shutdown. The call is
   * answered with an `is_error` result rather than an exception: an interrupt is something the
   * model is told about, not something that takes the log down with it.
   */
  readonly signal?: AbortSignal
  /**
   * The per-user values the host resolved for this turn, keyed by name. The registry hands
   * them to the tool untouched; it never looks one up itself.
   */
  readonly secrets?: Readonly<Record<string, string>>
  /**
   * The most a call may take this turn, when the host has a ceiling of its own. The effective
   * limit is the smaller of this and the tool's own `timeoutMs`, so a host can shorten a call
   * but never lengthen what a tool declared.
   */
  readonly timeoutMs?: number
}

/** A set of tools, and `execute`: how one call of one is run. */
export interface ToolRegistry {
  /** The tools registered, in registration order — the order a request offers them in. */
  readonly tools: readonly ToolDefinition[]
  /** The tool of that name, or `undefined`. */
  get(name: string): ToolDefinition | undefined
  /**
   * Run one call.
   *
   * Never throws and never returns anything but a {@link ToolResult}: a name no tool has, an
   * input the tool's schema refuses, a call that throws, one that runs past its timeout and
   * one cut short by an interrupt all come back as `isError` results the model reads. The
   * caller stores what comes back; there is no second outcome to handle.
   *
   * @param name the tool to run
   * @param input the arguments the model produced, as the call carried them
   * @param context the turn's signal, ceilings and resolved per-user values
   */
  execute(name: string, input: unknown, context?: ToolRunContext): Promise<ToolResult>
}

/**
 * Build a registry over a list of tools.
 *
 * @param tools the tools it holds; a name two of them share is refused here rather than
 *   silently shadowing one of them at call time
 */
export function createToolRegistry(tools: readonly ToolDefinition[]): ToolRegistry {
  const byName = new Map<string, ToolDefinition>()
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`two tools are registered under the name ${JSON.stringify(tool.name)}`)
    }
    byName.set(tool.name, tool)
  }
  return {
    tools: [...tools],
    get: (name) => byName.get(name),
    async execute(name, input, context = {}) {
      const tool = byName.get(name)
      if (tool === undefined) {
        return errorResult(`No tool named ${JSON.stringify(name)} is registered.`)
      }
      const parsed = tool.inputSchema.safeParse(input)
      if (!parsed.success) {
        return errorResult(`Invalid input for ${tool.name}: ${issuesOf(parsed.error.issues)}`)
      }
      return await run(tool, parsed.data, context)
    },
  }
}

/**
 * Run one parsed call under the turn's limits, turning every outcome into a result.
 *
 * A call ends when the tool answers, when the turn aborts it, or when it runs past its
 * deadline — whichever happens first. The limit is a **race**, not a hint: a tool that ignores
 * the signal it was handed (a library that does not take one, a hand-written loop) would
 * otherwise hold the turn open for as long as it liked, and one hung call would be the end of
 * the turn's ability to do anything. The call is left running against an aborted signal and
 * its answer is discarded; what the model is told is that the call did not finish.
 *
 * The two endings the caller caused are reported as themselves rather than as whatever the
 * tool happened to do about them (or failed to): an aborted call is `Interrupted by the
 * user.` and one past its deadline is a timeout, whether the tool threw, returned its own
 * "stopped" result or is still going. `deadline` is tested before `signal`, because a timeout
 * aborts the combined signal too and would otherwise read as an interrupt.
 */
async function run(
  tool: ToolDefinition,
  input: unknown,
  context: ToolRunContext,
): Promise<ToolResult> {
  const timeoutMs = effectiveTimeout(tool, context)
  const deadline = AbortSignal.timeout(timeoutMs)
  const signal =
    context.signal === undefined ? deadline : AbortSignal.any([context.signal, deadline])
  const secrets = context.secrets ?? {}
  const values = secretValues(secrets)
  const cutShort = (): ToolResult | null => {
    if (deadline.aborted) {
      return errorResult(`Tool ${tool.name} timed out after ${timeoutMs} ms.`)
    }
    if (signal.aborted) {
      return errorResult('Interrupted by the user.')
    }
    return null
  }
  if (context.signal?.aborted === true) {
    // Nothing new starts for a turn already interrupted. The deadline cannot have fired yet.
    return errorResult('Interrupted by the user.')
  }
  const execution: ToolExecutionContext = { signal, timeoutMs, secrets }
  // The listener is the call's, not the turn's: a signal lives as long as the turn does, and
  // one left behind per call would accumulate for as long as it ran.
  const listener: { remove: (() => void) | null } = { remove: null }
  const stopped = new Promise<null>((resolve) => {
    const fire = (): void => resolve(null)
    if (signal.aborted) {
      fire()
      return
    }
    signal.addEventListener('abort', fire, { once: true })
    listener.remove = () => signal.removeEventListener('abort', fire)
  })
  try {
    const raced = await Promise.race([
      // The async wrapper is what makes a tool that throws *synchronously* a rejection this
      // race can see, rather than an exception on the way to the race being built.
      (async () => tool.run(input, execution))().then(
        (result) => ({ done: true as const, result }),
        (error: unknown) => ({ done: false as const, error }),
      ),
      stopped,
    ])
    if (raced === null) {
      return cutShort() ?? errorResult('Interrupted by the user.')
    }
    if (!raced.done) {
      return (
        cutShort() ??
        errorResult(`Tool ${tool.name} failed: ${scrubText(messageOf(raced.error), values)}`)
      )
    }
    return cutShort() ?? scrub(raced.result, values)
  } finally {
    listener.remove?.()
  }
}

/**
 * The result with the turn's resolved secrets replaced by `[REDACTED]`.
 *
 * Every outcome of every call passes through here, which is what makes "a secret never reaches
 * the log" a property of the registry rather than a rule each tool has to remember: a tool
 * handed a key that echoes it back — in its answer, or in the error it throws — stores
 * `[REDACTED]` where the key was (epic #303, X11). The values are matched whole, so this
 * cannot mangle a result that merely mentions a similar string.
 */
function scrub(result: ToolResult, values: readonly string[]): ToolResult {
  if (values.length === 0) {
    return result
  }
  return {
    content: result.content.map((block) => ({ ...block, text: scrubText(block.text, values) })),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  }
}

/** The non-empty secret values to look for, longest first so a prefix cannot shadow one. */
function secretValues(secrets: Readonly<Record<string, string>>): string[] {
  return Object.values(secrets)
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length)
}

/**
 * `text` with each of `values` replaced by {@link REDACTED_PLACEHOLDER}.
 *
 * An empty value is skipped rather than honoured: it occurs at every position, so replacing it
 * would shred the text instead of redacting anything.
 */
export function scrubText(text: string, values: readonly string[]): string {
  let scrubbed = text
  for (const value of values) {
    if (value.length === 0) {
      continue
    }
    scrubbed = scrubbed.split(value).join(REDACTED_PLACEHOLDER)
  }
  return scrubbed
}

/** What a scrubbed secret is replaced with. */
export const REDACTED_PLACEHOLDER = '[REDACTED]'

/** The smaller of the host's ceiling and the tool's own timeout. */
function effectiveTimeout(tool: ToolDefinition, context: ToolRunContext): number {
  const own = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
  return context.timeoutMs === undefined ? own : Math.min(own, context.timeoutMs)
}

/** What a schema refusal said, as the field paths a model can act on. */
function issuesOf(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.join('.') || '(input)'}: ${issue.message}`).join('; ')
}

/**
 * An error's message, and never its stack: a tool's failure is stored in the session log, and
 * a stack carries absolute paths and whatever a library put in the error.
 *
 * Something with nothing to say — an `Error` with an empty message, or a value that is not an
 * error at all — becomes one plain sentence rather than `String(error)`, which would store
 * `Error` or `[object Object]` in the log.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }
  if (typeof error === 'string' && error.length > 0) {
    return error
  }
  return 'an unknown error'
}
