import type {
  McpServerId,
  ModeId,
  ModeToolOverride,
  ReasoningEffort,
  UserId,
} from '@openharness/protocol'

/**
 * Subagents, brain-side (epic #340): the **system prompt** a child runs with, and the
 * vocabulary of **subagent types**.
 *
 * The epic's decision S2 says a subagent type is a **mode with a description**: the types a
 * parent model may start are the user's own modes that carry a `subagent_description`
 * (`@openharness/protocol`), plus one built-in every deployment has. What a type resolves to
 * is what a chat would run — a model, an effort, a prompt addition and a tool set — so this
 * module is the two halves of that the brain owns:
 *
 * - {@link SUBAGENT_SYSTEM_PROMPT}, the addition every child's system prompt carries, which is
 *   what tells a model that it is one and what its final message is for; and
 * - {@link SubagentTypeResolver}, the seam a host implements — the same "the host resolves,
 *   the caller applies" shape as the mode resolver (`./turn`) — so that the `agent` tool
 *   (#344) can ask one place what types exist and what one starts.
 *
 * **What is deliberately not here.** A child session's tools, its model and its effort are the
 * host's answer, not this package's: modes live in the host's database and the user's
 * credentials decide availability (`apps/server`'s `subagent-types.ts`). Nothing in the loop
 * reads a resolver yet — the parent's tools are #344's — so this module carries the vocabulary
 * and the prompt, and no `RunTurnOptions` field wires it into a turn. A host that implements
 * {@link SubagentTypeResolver} is handed it by whoever builds the `agent` tool, which is where
 * the turn's own resolvers are handed to `runTurn` too.
 */

/**
 * The version of the child system prompt below (#342, the summary prompt's rule: K7, #277).
 *
 * A constant rather than a hash of the text — the point is that a change to what a subagent is
 * told is **visible**, and a reader comparing two runs wants a name for the difference rather
 * than a fingerprint. Bumped by hand when {@link SUBAGENT_SYSTEM_PROMPT} changes meaningfully,
 * exactly as the summary prompt's is (`SUMMARY_PROMPT_VERSION`, `./summarize`).
 *
 * `subagent-v1` is the first spelling: who the child is working for, that it cannot ask the
 * user, what its final message has to carry, and the one way it may speak to the parent while
 * it works.
 */
export const SUBAGENT_SYSTEM_PROMPT_VERSION = 'subagent-v1'

/**
 * What every child's system prompt says (#340, S2; #342).
 *
 * Four facts, and each is one a subagent has no way to learn from its own conversation:
 *
 * - **it is a subagent**, working for a chat that started it — so it knows its reader is a
 *   model acting for a user, not the user;
 * - **it cannot ask the user anything**, so it must not wait for an answer that cannot come:
 *   what it could not do belongs in its final message, rather than in a question;
 * - **its final message is the whole of what the parent receives** — the parent does not see
 *   the steps, so the message has to stand on its own; and
 * - **it can send interim notes** with `message_parent` while it works, which is the one thing
 *   a chat whose turn is still running could not otherwise do.
 *
 * Written once, here, because every child runs with it and a second copy would be a second
 * thing to keep true — the same reason the summary prompt is one constant (`./summarize`). A
 * host that writes a child session reads it with {@link withSubagentPrompt}. It is **appended**
 * to whatever prompt the child already has (its own, and a mode's addition when the type is a
 * mode), never in place of it: what the child is doing is a type's business, and that it is
 * someone's helper is not.
 */
export const SUBAGENT_SYSTEM_PROMPT =
  'You are a subagent: a chat another chat started, to do one job for it. The chat that ' +
  'started you is your parent.\n\n' +
  'You cannot ask the user anything — no question of yours reaches them, and nothing waits ' +
  'for an answer — so never stop to ask. What you were missing belongs in your final message, ' +
  'not in a question.\n\n' +
  'Your final message is the whole of what the parent receives: it does not see your steps, ' +
  'your tool calls or your interim notes. Say what you did, what you found and what you could ' +
  'not do, so that the message stands on its own.\n\n' +
  'While you work you may send the parent a short interim note with the `message_parent` ' +
  'tool. Use it for progress, not for questions.'

/**
 * The system prompt a child runs with: `system`, with {@link SUBAGENT_SYSTEM_PROMPT} appended
 * after it (#342).
 *
 * **Appended, never substituted**, and joined by a blank line exactly as a mode's addition is
 * (`withModePrompt` in `./turn`): a child that follows a mode gets both additions, in the
 * order the caller composes them, and a child with no prompt of its own gets the subagent
 * addition alone rather than an empty string. A `null` or empty `system` is "nothing of its
 * own", the same reading the session's own prompt gets.
 */
export function withSubagentPrompt(system: string | null): string | null {
  const base = system !== null && system.length > 0 ? system : null
  return base === null ? SUBAGENT_SYSTEM_PROMPT : `${base}\n\n${SUBAGENT_SYSTEM_PROMPT}`
}

/**
 * The one type every deployment offers (epic #340, S2): the parent's own configuration, with a
 * fresh context.
 *
 * It is not a mode and has no row anywhere, because it has nothing for a user to configure: a
 * helper that runs on the model, the effort and the tools the parent is running right now is
 * what "just do this for me in a clean context" means, and a chat that wants a *different*
 * kind of helper is what a mode with a description is for. It is always offered, so the
 * `agent` tool always has at least one type to name.
 */
export const GENERAL_PURPOSE_TYPE = 'general-purpose'

/**
 * What {@link GENERAL_PURPOSE_TYPE} is for, as the parent model reads it (#344 builds the tool
 * description this goes into).
 *
 * Phrased for the choice the parent is making — *should this be a helper at all?* — rather
 * than as a description of an agent: the alternative to starting a `general-purpose` child is
 * doing the work in this chat.
 */
export const GENERAL_PURPOSE_DESCRIPTION =
  'A general-purpose helper that runs on this chat’s own model, effort and tools, in a fresh ' +
  'context. Use it for a self-contained piece of work you do not want in this conversation.'

/**
 * One subagent type as the parent model is offered it (epic #340, S2; #342): the name the
 * `agent` tool is called with, and what the type is good for.
 *
 * The description is here rather than in the tool's own text because it is the user's — a
 * mode's `subagent_description` — and the tool's description is the list of these (#344).
 */
export interface SubagentTypeSummary {
  /** The type's name: a mode's name, or {@link GENERAL_PURPOSE_TYPE}. */
  readonly name: string
  /** What the type is good for, in the words the parent model chooses by. */
  readonly description: string
}

/**
 * The parent chat a type is resolved **for**, as the loop knows it at a request boundary
 * (#342).
 *
 * {@link GENERAL_PURPOSE_TYPE} is nothing but the parent's own configuration, so the answers
 * have to come from the parent rather than from a second lookup that could disagree:
 *
 * - `model` is the `provider/model` this request runs — for a parent that follows a mode, the
 *   mode's resolved model, not the session's stored one;
 * - `reasoningEffort` is the effort in force for this request, which is the newest one a
 *   `user.message` asked for and otherwise the parent mode's own (#252; #245, M6);
 * - `toolOverride` is the tool override the parent's own mode imposes — the on/off patch over
 *   the user's settings, and the MCP servers by id — or `null` for a chat that follows no
 *   mode. It is the parent's **effective** tool set in the one spelling a mode has for one:
 *   applying it to the owner's settings is what "the tools this chat has" means everywhere
 *   else (#307).
 *
 * Every field is the loop's own answer for the request the tool is running in, which is the
 * point: a `general-purpose` child is the parent continued on a clean context, so it must be
 * the parent's configuration *now* rather than the one the session was created with.
 */
export interface SubagentParent {
  /** The `provider/model` the parent's current request runs. */
  readonly model: string
  /** The reasoning effort in force for the parent, or `null` for the provider's default. */
  readonly reasoningEffort: ReasoningEffort | null
  /** The tool override the parent's own mode imposes, or `null` when it follows none. */
  readonly toolOverride: ModeToolOverride | null
  /**
   * The mode the parent follows, or `null` for a chat on a plain model (#344).
   *
   * The third answer a caller that creates the child **on a mode** needs: a `general-purpose`
   * child of a chat that follows one follows the same mode (S2, "the parent, continued"), and
   * the mode is what carries the tool and MCP-server override — the session record holds an id
   * and nothing else, and `toolOverride` alone could not be stored on a child.
   */
  readonly modeId: ModeId | null
}

/**
 * A subagent type resolved into the configuration a child starts with (epic #340, S2; #342).
 *
 * It is deliberately the same answer a **chat** resolves to — the model, the effort, the
 * prompt addition and the tool set — because that is the epic's decision: a type is a mode, so
 * what a child runs is what a chat on that mode would run, and a parent that wants its helper
 * to change is a user who edits the mode they already have.
 *
 * Two spellings of the tool half, and neither is spare:
 *
 * - `toolOverride` is the **patch** the type imposes (`Mode.tools`, or the parent's own mode's
 *   for {@link GENERAL_PURPOSE_TYPE}) — what a caller that creates the child **on the mode**
 *   passes on, so the child follows it live exactly as a chat does; and
 * - `tools` and `mcpServers` are that patch **applied to the owner's settings**, which is the
 *   set a child really has: the loop's own answer (`apps/server`'s `effectiveTools` and
 *   `listMcpServersInForce`), for a caller that builds the child's turn options itself. A
 *   caller must not compute this a second way: "the tools this child has" and "the tools this
 *   request offers" are one answer, and the server is where it is computed.
 *
 * `tools` is a list of **names** and `mcpServers` a list of server ids: policies stay the
 * user's (E6), so a type says which tools a child has and never what a call to one may do.
 */
export interface ResolvedSubagentType {
  /** The type's name, as it was asked for. */
  readonly name: string
  /** What the type is good for, as the parent model was offered it. */
  readonly description: string
  /** The `provider/model` the child runs. */
  readonly model: string
  /** The effort the child runs at, or `null` for the provider's default. */
  readonly reasoningEffort: ReasoningEffort | null
  /** Appended to the child's system prompt, or `null` for no addition of its own. */
  readonly systemPromptAddition: string | null
  /**
   * The mode the child is created **on**, so it follows it live, or `null` for a child on a
   * plain model (#344).
   *
   * A type that came from a mode answers its own id; {@link GENERAL_PURPOSE_TYPE} answers the
   * parent's ({@link SubagentParent.modeId}), because it is the parent continued. It is what
   * makes {@link ResolvedSubagentType.toolOverride} real rather than advisory: the caller passes
   * this id to `createSession` (with the resolved `model` as the header's fallback), and the
   * loop then resolves the mode for the child's every request exactly as it does for a chat's —
   * model, effort, prompt addition and the tool/MCP-server override included (#245, M6).
   */
  readonly modeId: ModeId | null
  /**
   * The tool/MCP-server patch the type imposes, or `null`.
   *
   * For a mode type this is the mode's own `tools`; for {@link GENERAL_PURPOSE_TYPE} it is the
   * parent's `SubagentParent.toolOverride`, which is how the built-in type says "the tools
   * this chat has" in the one vocabulary a tool override has.
   */
  readonly toolOverride: ModeToolOverride | null
  /** The built-in tools the child has, by name — the patch applied to the owner's settings. */
  readonly tools: readonly string[]
  /** The ids of the remote MCP servers in force for the child. */
  readonly mcpServers: readonly McpServerId[]
}

/**
 * What resolving a type answered: the type, or **why it cannot be started** (epic #340, S2;
 * #342).
 *
 * A result rather than a throw, on purpose. The two ways a type can fail — a name that is not
 * a type, and a mode whose model cannot be used (`requireUsableMode`'s rule) — are answers the
 * **model** acts on: it is told what happened and chooses another type or does the work
 * itself. An exception would have to be caught and turned into the same sentence anyway, one
 * frame up, with the tool's own error handling between the two; and a failure that escapes as
 * a rejected promise would end a turn over a choice the model can simply make differently.
 *
 * `message` is therefore a sentence **for the model**, naming what it can do next rather than
 * the state of a database.
 */
export type SubagentTypeResolution =
  | { readonly ok: true; readonly type: ResolvedSubagentType }
  | { readonly ok: false; readonly message: string }

/**
 * Where a parent's subagent types come from (epic #340, S2; #342): a host's answer to the two
 * questions the `agent` tool asks — which types exist, and what one of them starts.
 *
 * The same "the host resolves, the caller applies" seam as the mode resolver (`./turn`): types are
 * modes, modes live in the host's database, and whether one's model can be used is a question
 * about the owner's stored credentials — none of which this package reads. An object rather
 * than one function because the two questions are answered from one place and a caller needs
 * both: the list is the `agent` tool's own description (#344), and the resolution is what
 * starting the type stores as the child's configuration.
 *
 * Both are asked **per call, never cached**, so a mode edited between two starts applies to the
 * second — the live-follow a mode is for (#245, M6) — and a credential added meanwhile makes a
 * type usable that was not.
 */
export interface SubagentTypeResolver {
  /**
   * The types to offer the parent model: {@link GENERAL_PURPOSE_TYPE} **first**, then every
   * one of the owner's modes that carries a `subagent_description`, oldest first.
   *
   * Only the owner's own modes: another user's are not types this parent can start (A4). A
   * mode with no description is left out — it is a preset, not a type — and a type whose model
   * cannot be used is still listed, because the list is what the model chooses from and
   * {@link SubagentTypeResolver.resolve} is where a choice is refused.
   */
  list(ownerId: UserId): Promise<readonly SubagentTypeSummary[]>

  /**
   * One type by name, as the configuration a child starts with — or the sentence saying why it
   * cannot be started. Never throws ({@link SubagentTypeResolution}).
   *
   * A name that is neither {@link GENERAL_PURPOSE_TYPE} nor one of the owner's modes with a
   * description is refused; a mode whose model cannot be used — "my default model" with no
   * default set, or a provider the owner has no credential for — is refused by
   * `requireUsableMode`'s rule.
   *
   * `parent` is the chat asking, which {@link GENERAL_PURPOSE_TYPE} resolves to and the other
   * types ignore: their configuration is the mode's, not the parent's.
   */
  resolve(ownerId: UserId, name: string, parent: SubagentParent): Promise<SubagentTypeResolution>
}
