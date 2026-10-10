import type { TextBlock, ToolPermission } from '@openharness/protocol'
import type { z } from 'zod'

/**
 * What a tool is, and what it is handed when it runs.
 *
 * A tool is a name the model calls, a description it reads, an input schema the registry
 * checks the call against, the policy the host applies by default, and the time it may take.
 * Everything else — which tools exist, which user's values they get, how long they may run —
 * is the host's, which is why nothing here reads the environment, a file or a database.
 */

/**
 * How long a tool call may run before it is cut short, when its definition names no timeout.
 *
 * Half a minute is a chat-shaped default: long enough for a page fetch or a search, short
 * enough that a hung call does not hold a turn open. A tool with a different shape (a big
 * download, a slow internal service) says so in its own definition, and a host may lower the
 * ceiling per turn.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000

/**
 * What one tool call produced.
 *
 * `content` is the same text blocks a message carries, because that is the shape the result
 * gets stored in (the log's `agent.tool_result`), and `isError` is what tells the model to
 * read it as a failed call. A tool need not say `isError` itself: the registry turns a thrown
 * error, an abort and a timeout into one, so a tool that ignores all three still fails the way
 * a call fails rather than taking the turn down with it.
 */
export interface ToolResult {
  /** The blocks the model is shown; text today. */
  readonly content: readonly TextBlock[]
  /** Whether the call failed. Absent means it succeeded. */
  readonly isError?: boolean
}

/** A successful result: one text block. */
export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

/** A failed result: one text block, `isError: true`. */
export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/**
 * What a tool is told about the turn it runs in.
 *
 * Nothing here is read from anywhere but the caller: the host resolves a turn's values and
 * bounds and hands them over, so a tool has no way to reach a secret, a setting or a session
 * that this context does not carry (epic #303, X4).
 */
export interface ToolExecutionContext {
  /**
   * Aborting this ends the call early — an interrupt, a shutdown, or the timeout below
   * elapsing. The registry answers an aborted call with an `is_error` result rather than an
   * exception, so a tool that honors the signal needs no handling of its own; a tool that
   * ignores it is still cut short at the registry's boundary, and its work is left running
   * against a signal that says to stop.
   */
  readonly signal?: AbortSignal
  /**
   * The most time this call may take, in milliseconds: the tool's own `timeoutMs`, or
   * {@link DEFAULT_TOOL_TIMEOUT_MS} when it names none — lowered by the host when the turn's
   * own limit is smaller. It is the number `signal` is aborted after, so a tool that wants to
   * report "this took too long" rather than be cut off can watch the same clock.
   */
  readonly timeoutMs: number
  /**
   * The per-user values the host resolved for this turn, keyed by name (epic #303, X4): a
   * service's key, an MCP server's token. `@openharness/hands` never reads the environment or
   * a database — whatever a tool needs, the server puts here — and a tool must never put one
   * of these into its result: results are stored in the session log.
   */
  readonly secrets: Readonly<Record<string, string>>
}

/**
 * One tool, as the registry holds it.
 *
 * `inputSchema` is the contract with the model: it becomes the tool definition a request
 * offers (the AI SDK turns it into the JSON Schema the provider sends), and it is what the
 * registry parses a call's arguments with before running anything. A call that does not match
 * it is answered with an `is_error` result — the model is told its arguments were wrong, and
 * the tool never runs.
 *
 * `permission` is the tool's **default**, not the decision: the loop asks the host's policy
 * resolver per call and records what it answered (`evaluated_permission`). `run` is a method
 * rather than a property so that a list of tools with different input types is one array —
 * the registry hands each tool the input its own schema parsed.
 */
export interface ToolDefinition<Input = unknown> {
  /** The name the model calls it by. Unique within a registry. */
  readonly name: string
  /** What the model is told it does. Written for a model, not for a user. */
  readonly description: string
  /** The shape of a call's arguments; see the note above. */
  readonly inputSchema: z.ZodType<Input>
  /** The policy this tool gets when the host's resolver has none of its own. */
  readonly permission: ToolPermission
  /** The most a call may take; {@link DEFAULT_TOOL_TIMEOUT_MS} when omitted. */
  readonly timeoutMs?: number
  /** Run one call, with the arguments the definition's own schema parsed. */
  run(input: Input, context: ToolExecutionContext): Promise<ToolResult> | ToolResult
}
