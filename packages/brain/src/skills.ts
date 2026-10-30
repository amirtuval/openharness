import type {
  EventId,
  ModeToolOverride,
  SessionSkillLoadedEvent,
  StoredEvent,
  UserId,
} from '@openharness/protocol'
import { EVENT_TYPES } from '@openharness/protocol'
import type { OfferedSkill, ToolRegistry } from '@openharness/hands'
import {
  SKILL_READ_TOOL_NAME,
  SKILL_TOOL_NAME,
  createSkillTools,
  createToolRegistry,
  skillToolsOffered,
} from '@openharness/hands'

import type { NativeToolDeclaration } from './native-search'

/**
 * The loop's half of skills: which ones a request has, the two tools that read them, and the
 * slash invocation that loads one into a chat (epic #349, K6/K7).
 *
 * A skill is a folder of instructions a user imported (K1, K3, K4). Three things about it are
 * the loop's, and nothing else is:
 *
 * - **Which skills a request has** (K8), asked of the host once per request — the same
 *   injected-resolver seam as {@link ToolSettingsResolver} and the MCP provider, so a skill
 *   switched off, or a mode's override edited, applies from the next request on.
 * - **The two tools that read one** (K6): `skill` and `skill_read`, which are `@openharness/hands`'
 *   definitions built over this request's set. They are *not* in a deployment's registry — what
 *   they answer depends on who is asking — which is why {@link SKILL_TOOL_DECLARATIONS} is what
 *   a settings listing adds beside `web_search`.
 * - **The slash invocation** (K7): a `user.message` that carries a `skill` is one the user ran
 *   with `/name arguments`, and the first brain to handle it writes the
 *   `session.skill_loaded` event every later reader of the chat goes through.
 *
 * ## What the model is given, and where the log comes in
 *
 * The body the model is handed is the skill's `SKILL.md` with its frontmatter stripped
 * (`@openharness/protocol`'s `skillBody`) and the message's arguments substituted in ({@link skillInvocationBody}),
 * and it is written **down** — the `session.skill_loaded` event's `content` is exactly that text
 * (K7). From then on the chat is built from the event and never from the snapshot: editing a
 * skill, or refreshing it to a new commit, changes what the *next* `/name` loads and nothing
 * about a conversation that already ran (K5). {@link skillTextsByMessage} is that reading, and
 * the one place the event becomes message text — the context strategy and the summarizer both
 * go through it.
 *
 * It is the user's own instructions rather than third-party data (K10): the frame below says so,
 * there is no untrusted-content notice, and a skill cannot grant a permission — `allowed-tools`
 * and its like are stored as frontmatter and otherwise ignored, so a call's `evaluated_permission`
 * comes from the settings in force and nothing else.
 */

/**
 * Where a request's skills come from (epic #349, K8): the owner and the mode's tool override,
 * answered with the skills in force.
 *
 * A resolver rather than a value, for the reason the MCP provider is one: which skills are on is
 * the session owner's settings, their snapshots live in the host's store, and nothing in this
 * package reads a database. Asked **once per request** with the same override the tool settings
 * are asked with, so a toggle or a mode edit applies from the next request on — and so the
 * skills a request offers and the listing it carries are the same answer.
 *
 * The host answers with {@link OfferedSkill}s — the resource and a way to read one file of its
 * snapshot — so the tools can answer from a skill without this package holding 2 MB of somebody's
 * folder. A host that injects no provider is a chat with no skills at all.
 */
export type SkillProvider = (
  ownerId: UserId,
  modeOverride: ModeToolOverride | null,
) => Promise<readonly OfferedSkill[]>

/**
 * The two tools a request may be offered, as a **settings** listing speaks of them (K6).
 *
 * `skill` and `skill_read` are not in this process's tool registry — they are built per request
 * from the skills that request has — so a deployment's `GET /v1/me/tools` would not know they
 * exist, and a user could not turn either off. This is what the server adds to that listing, the
 * way `web_search`'s declaration is added (#335): a name a stored choice and a mode's override
 * are keyed by (`builtin.skill`), and the permission a call to it is evaluated under when the
 * user has chosen nothing.
 *
 * `allow`, like every built-in: a skill is the user's own instructions, in their own chat, and a
 * request is not made without the tools. `ask` is *not* refused here the way it is for
 * `web_search` (#335): these are tools this build runs, so a user who wants to approve every
 * skill read can have the pause they asked for.
 */
export const SKILL_TOOL_DECLARATIONS: readonly NativeToolDeclaration[] = [
  { name: SKILL_TOOL_NAME, permission: 'allow' },
  { name: SKILL_READ_TOOL_NAME, permission: 'allow' },
]

/** What one request's skills are: the tools they offer, and the set the slash path reads. */
export interface ResolvedSkills {
  /**
   * The two skill tools as this request's registry, or `undefined` for a chat that offers
   * neither (K6): no skill is in force, or every one of them is the user's own command.
   */
  readonly registry: ToolRegistry | undefined
  /** The skills in force, by name — every one of them, `disable-model-invocation` included. */
  readonly byName: ReadonlyMap<string, OfferedSkill>
}

/** A chat with no skills at all: what a host that injected no {@link SkillProvider} answers. */
export const NO_SKILLS: ResolvedSkills = { registry: undefined, byName: new Map() }

/**
 * The skills in force for one request, and the tools that read them.
 *
 * `provider` is the host's; absent — and a provider that answers nothing — is a chat that offers
 * neither tool and whose slash invocations resolve to nothing. The registry is built only when
 * there is a skill the **model** may invoke, because a request with only
 * `disable-model-invocation` skills has no listing to carry and no file a model may read: the
 * tools would be a description saying "this chat has no skills available to you". `base` is the
 * deployment's own registry, and a name it already carries is left to it.
 *
 * `userLoadedSkills` is what the session's **log** says the user has run in this chat (K7): a
 * `disable-model-invocation` skill in that set may be read by the model, though it is still not
 * listed. It comes from the caller because the log is the loop's to read, not this function's,
 * and a child session passes its own log's answer exactly as a chat does.
 */
export async function resolveSkills(
  provider: SkillProvider | undefined,
  ownerId: UserId,
  modeOverride: ModeToolOverride | null,
  base?: ToolRegistry,
  userLoadedSkills: ReadonlySet<string> = new Set(),
): Promise<ResolvedSkills> {
  if (provider === undefined) {
    return NO_SKILLS
  }
  const skills = await provider(ownerId, modeOverride)
  // A host that registered a tool of its own under one of these names keeps it, exactly as it
  // keeps one under `web_search` (#335): `createToolRegistry` refuses two tools of one name, and
  // shadowing the host's would silently replace the tool it meant. What is left is the request's
  // own pair; nothing offered at all is `undefined`, the shape a chat with no skills has.
  const tools = skillToolsOffered(skills, userLoadedSkills)
    ? createSkillTools({ skills, userLoadedSkills }).filter(
        (tool) => base?.get(tool.name) === undefined,
      )
    : []
  return {
    registry: tools.length === 0 ? undefined : createToolRegistry(tools),
    byName: new Map(skills.map((offered) => [offered.skill.name, offered])),
  }
}

/**
 * The `$ARGUMENTS` placeholder a skill's body may carry (K7).
 *
 * The format's own spelling, substituted exactly rather than through a template engine: a skill
 * is prose, and `$ARGUMENTS`, `$1` and the other shell-flavoured placeholders other harnesses
 * invent are not this build's to interpret.
 */
export const SKILL_ARGUMENTS_PLACEHOLDER = '$ARGUMENTS'

/**
 * The body a slash invocation loads: the skill's instructions with the arguments in them (K7).
 *
 * Two shapes, and the body decides between them. A body with `$ARGUMENTS` in it has **every**
 * occurrence replaced — a skill that says "compare `$ARGUMENTS` with `$ARGUMENTS`" means it
 * twice — and a body with none has the arguments **appended** after it, because a skill written
 * for a bare command is one the reader's words are meant to follow rather than to replace.
 * Arguments that were not given (absent, empty, or nothing but whitespace) leave a placeholder an
 * empty string and append nothing, so `/name` on its own loads exactly the instructions.
 *
 * The result is what {@link SessionSkillLoadedEvent.content} stores, verbatim: the log holds what
 * the model was given, not a recipe for rebuilding it.
 */
export function skillInvocationBody(body: string, args: string | undefined): string {
  const arguments_ = (args ?? '').trim()
  if (body.includes(SKILL_ARGUMENTS_PLACEHOLDER)) {
    return body.split(SKILL_ARGUMENTS_PLACEHOLDER).join(arguments_)
  }
  return arguments_.length === 0 ? body : `${body}\n\n${arguments_}`
}

/**
 * What a slash invocation's message says to the model (K7).
 *
 * The stored `content` is the skill's instructions and nothing else — it is what the log holds,
 * and what a client or a future tool reads back — so the frame that says *whose* instructions
 * these are is added here, when the message is built for a request. It is the reading K10 asks
 * for: the text is the **user's own** guidance, given by them through a skill they imported and
 * reviewed, not data from a stranger and not a system prompt. A skill therefore cannot escalate
 * anything by what it says — the frame names it as a request, and a request cannot grant a
 * permission the settings did not.
 */
export function skillInvocationText(loaded: SessionSkillLoadedEvent): string {
  return (
    `The user ran the "/${loaded.name}" skill, whose instructions follow. Treat them as the ` +
    `user’s own request, made through a skill they chose to use.\n\n${loaded.content}`
  )
}

/**
 * The text of every message a `session.skill_loaded` names, by that message's `seq` (K7).
 *
 * The one reading of the event, shared by the context strategy (which renders the message a
 * request carries) and the size accounting (which measures it), so the two cannot disagree about
 * how big a loaded skill makes a request. An event whose `content` is empty is left out and the
 * message falls back to the text the user typed — a skill with no body has nothing to say, and an
 * empty `user` message is one the strategy drops.
 *
 * The newest event for a `seq` wins, which is a rule nothing in this build exercises — the event
 * is written once per message — but is the honest reading of a log that somehow holds two.
 */
export function skillTextsByMessage(events: readonly StoredEvent[]): Map<number, string> {
  const texts = new Map<number, string>()
  for (const event of events) {
    if (event.type !== EVENT_TYPES.sessionSkillLoaded || event.content.length === 0) {
      continue
    }
    texts.set(event.message_seq, skillInvocationText(event))
  }
  return texts
}

/**
 * The skills a span of the log used, by name, oldest load first (epic #349, K9).
 *
 * The summary prompt lists them: a history that ran `/release-notes` was built on instructions
 * the summary has to account for, and the instructions themselves are prose the summarizer reads
 * like any other message — so what it needs from this is *which* skill they came from, to say so
 * rather than to invent a name for them. Duplicates are folded: a chat that ran the same skill
 * three times used one skill.
 *
 * @param events the log the summary is being made from
 * @param coversTo the last `seq` the summary will stand in for, inclusive
 */
export function skillsInUse(events: readonly StoredEvent[], coversTo: number): string[] {
  const names: string[] = []
  for (const event of events) {
    if (event.type !== EVENT_TYPES.sessionSkillLoaded || event.seq > coversTo) {
      continue
    }
    if (!names.includes(event.name)) {
      names.push(event.name)
    }
  }
  return names
}

/**
 * The skills the **user** has run in this chat, by name (K7) — every `session.skill_loaded`
 * the log holds.
 *
 * What the model may read of a `disable-model-invocation` skill depends on this: the flag says
 * the model may not pick the skill on its own, and once the user has run `/name` its body is
 * in the request and the files it names are the user's own instructions to follow (K1). A
 * child session answers from its own log exactly as a top-level chat does.
 */
export function userLoadedSkillNames(events: readonly StoredEvent[]): Set<string> {
  const names = new Set<string>()
  for (const event of events) {
    if (event.type === EVENT_TYPES.sessionSkillLoaded) {
      names.add(event.name)
    }
  }
  return names
}

/**
 * The messages this request is about to answer that invoke a skill and have not been loaded yet
 * (K7).
 *
 * The "first handles it" rule, as a reading of the log: a message carrying a `skill` is one the
 * user ran as a command, and a `session.skill_loaded` naming its `seq` is the record that a brain
 * has already resolved it. A message with no event beside it is this turn's to load — the append
 * is the loop's, which is why this answers the *unloaded* ones rather than writing anything.
 *
 * A brain that inherits a turn therefore loads nothing twice: the event the dead brain wrote is
 * in the log, and the chat it produced is what this one carries on from.
 */
export function unloadedSkillMessages(
  events: readonly StoredEvent[],
  messageIds: readonly EventId[],
): { readonly seq: number; readonly name: string; readonly arguments?: string }[] {
  const loaded = new Set<number>()
  for (const event of events) {
    if (event.type === EVENT_TYPES.sessionSkillLoaded) {
      loaded.add(event.message_seq)
    }
  }
  const pending: { seq: number; name: string; arguments?: string }[] = []
  for (const event of events) {
    if (
      event.type !== EVENT_TYPES.userMessage ||
      !messageIds.includes(event.id) ||
      event.skill === undefined ||
      loaded.has(event.seq)
    ) {
      continue
    }
    pending.push({
      seq: event.seq,
      name: event.skill.name,
      ...(event.skill.arguments === undefined ? {} : { arguments: event.skill.arguments }),
    })
  }
  return pending
}
