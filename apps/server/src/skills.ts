import type { SkillProvider } from '@openharness/brain'
import type { EventInput, ModeId, ModeToolOverride, Skill, UserId } from '@openharness/protocol'
import {
  EVENT_TYPES,
  skillsInForce as applySkillsInForce,
  skillSettingsOf,
} from '@openharness/protocol'
import type { SessionStore, SkillStore } from '@openharness/session'

import { invalidRequest } from './http/errors'

/**
 * Which of a user's skills are on for one request (epic #349, K8).
 *
 * A skill is on or off **per skill**: `Skill.enabled` is the user's own choice — the switch the
 * settings screen writes, on when a skill is imported — and a **mode** may override it, exactly
 * as a mode overrides which built-in tools are on (#307) and which remote MCP servers are in
 * play (#311). The two levels are the same rule in all three places: the per-user setting is
 * the default, a mode patches it, and a chat that follows a mode follows it live — the next
 * request resolves the mode as it is now.
 *
 * The resolution, in one line: **a mode that names a skill wins; a skill it does not name
 * follows the user's `enabled`.**
 *
 * Two properties are deliberate, and they are the MCP half's (`mcp/in-force.ts`) over a
 * different resource:
 *
 * - **A mode naming a skill the user no longer has is ignored**, not an error: the mode routes
 *   store the map by id without checking it, so deleting a skill leaves the modes that named it
 *   untroubled — they simply stop matching anything. The same is true of an id that never named
 *   a skill at all.
 * - **On and off, never anything else.** A mode decides *which* skills a request has; the
 *   snapshot's content, the files and the description are the skill's own, and a mode cannot
 *   rewrite them.
 *
 * This module is the **settings answer the brain will read** (the listing, the `skill` tool and
 * the `/` menu: #352, #353, #354), and it sits beside `tool-settings.ts` because it is the same
 * kind of thing: a resolver the host builds once and hands to a turn, answered per request. It
 * is deliberately not part of `SkillStore` — applying a mode's override over the user's choices
 * is the caller's, and never the store's.
 */

/**
 * The skills in force, given the user's own list and the mode's override.
 *
 * Pure, so the rule can be read and tested without a store: the order is the input's (the store
 * lists a user's skills oldest first), and a skill the mode names is on or off exactly as the
 * mode says. An import order that does not move is what lets a client show a stable list.
 */
export function skillsInForce(
  skills: readonly Skill[],
  override: ModeToolOverride | null,
): Skill[] {
  // The rule itself is the protocol's, and the `/` menu on both frontends applies the same
  // function: a menu row the server refuses, or a missing one it would accept, cannot happen
  // because there is only one rule to read (K8).
  return applySkillsInForce(skills, override)
}

/**
 * What the resolution needs: the skills a user has.
 *
 * A one-method seam rather than the whole store, so a caller — and a test — supplies exactly
 * what the read uses, the way `ToolSettingsDeps` narrows the session store to three methods.
 */
export interface SkillSettingsDeps {
  /** The user's own skills, oldest first. */
  readonly skills: Pick<SkillStore, 'list'>
}

/**
 * The skills in force for a request: the owner's own list with the mode's override applied
 * (epic #349, K8).
 *
 * `override` is the tool override of the mode the request resolved to — `Mode.tools`, which is
 * also what carries the built-in and MCP halves — or `null` for a chat that follows no mode, or
 * one whose mode says nothing. It is an argument rather than something this module looks up,
 * because the mode a chat follows is resolved by the host once per request (`modes.ts`) and all
 * three halves have to come from that one answer rather than from three lookups that could
 * disagree.
 *
 * The read is one `list` per request — the price the tool-settings resolver and
 * `listMcpServersInForce` also pay — which is what makes a skill switched off, or a mode
 * edited, apply from the next request on. Nothing here reads a file's content: a listing needs
 * names, descriptions and ids, and `SkillStore.list` never hands anything else out.
 */
export async function listSkillsInForce(
  deps: SkillSettingsDeps,
  ownerId: UserId,
  override: ModeToolOverride | null,
): Promise<Skill[]> {
  return skillsInForce(await deps.skills.list({ ownerId }), override)
}

/**
 * The resolver the server hands a turn: the session owner's skills with the mode's override
 * applied, asked once per request.
 *
 * The same seam as the tool-settings resolver (`createToolSettingsResolver`) and the mode
 * resolver (`ModeResolver`), and the same signature shape — owner and the resolved mode's tool
 * override — so the pieces of a request's setup that come from the owner can all be resolved in
 * one place, per request, from one reading of the mode.
 */
export type SkillSettingsResolver = (
  ownerId: UserId,
  override: ModeToolOverride | null,
) => Promise<Skill[]>

/** The {@link SkillSettingsResolver} a deployment with skills hands its turns. */
export function createSkillSettingsResolver(deps: SkillSettingsDeps): SkillSettingsResolver {
  return (ownerId, override) => listSkillsInForce(deps, ownerId, override)
}

/**
 * What the brain's skill tools need (epic #349, K6; #352): the listing a user's skills are read
 * from, and one file of a snapshot.
 *
 * A superset of {@link SkillSettingsDeps} on purpose — the same read, plus the file read the two
 * tools answer from — so a caller that already holds the store passes it to both.
 */
export interface SkillProviderDeps {
  /** The user's own skills, and the files of each snapshot. */
  readonly skills: Pick<SkillStore, 'list' | 'getFile'>
}

/**
 * The {@link SkillProvider} a deployment hands its turns: the skills in force for a request, each
 * with a way to read one file of its snapshot (epic #349, K6; #352).
 *
 * The same read {@link createSkillSettingsResolver} makes — one `list` per request, with the
 * mode's override applied — because the listing a request carries and the skills its tools can
 * answer from have to be one answer. `readFile` is a closure rather than the files themselves: a
 * request listings a user's skills must not read every snapshot, and a file is read only when a
 * model asks for it. It answers the store's own contract — `null` for a path the snapshot does
 * not hold, and for another owner's skill alike — and the tools turn that into an `is_error`
 * listing the files that are there.
 */
export function createSkillProvider(deps: SkillProviderDeps): SkillProvider {
  return async (ownerId, override) => {
    const inForce = await listSkillsInForce({ skills: deps.skills }, ownerId, override)
    return inForce.map((skill) => ({
      skill,
      // The whole file, encoding included: the tools report a binary file by its size and
      // encoding rather than handing a model base64 text (K2, K4).
      readFile: async (path: string) => deps.skills.getFile(skill.id, { ownerId }, path),
    }))
  }
}

/**
 * What the slash-invocation check needs (epic #349, K7): the skills, and the modes an override
 * comes from.
 *
 * The modes are here because which skills are in force depends on the mode the chat follows (K8),
 * and the check has to answer for the state the batch **leaves the session in** — the same state
 * the next request's resolver will see.
 */
export interface SkillInvocationDeps extends SkillSettingsDeps {
  /** The mode store, for the override the batch's chat will run under. */
  readonly modes: Pick<SessionStore, 'getMode'>
}

/**
 * The tool override of the mode a batch leaves a session on (epic #349, K8), or `null`.
 *
 * Read through the owner scope like every other resource: a mode the caller does not own is not
 * theirs to follow, and a mode that says nothing about skills answers `null`. A mode that has been
 * deleted since answers `null` too, exactly as the brain's own resolver treats it — the session
 * lands on the model it last ran, and nothing overrides the user's own switches.
 */
export async function modeToolOverride(
  deps: SkillInvocationDeps,
  ownerId: UserId,
  modeId: ModeId | null,
): Promise<ModeToolOverride | null> {
  if (modeId === null) {
    return null
  }
  return (await deps.modes.getMode(modeId, { ownerId }))?.tools ?? null
}

/**
 * Refuse a slash invocation this chat cannot run, before anything is stored (epic #349, K7).
 *
 * `/name arguments` is a `user.message` naming one of the user's skills, and the server is what
 * decides whether it may land. Two refusals, both the protocol's 400 `invalid_request_error` and
 * neither storing anything:
 *
 * - **Unknown or off.** The name is not among the skills in force for this chat, which is the
 *   user's `enabled` with the mode's override applied — the same answer the next request's
 *   resolver will give. A skill turned off, deleted, or one a mode stopped naming reads exactly
 *   as a name that never existed, which is what stops a client from using the route to probe for
 *   one.
 * - **Not user-invocable.** The skill is on, but its frontmatter says `user-invocable: false`:
 *   it is a skill only the **model** uses, and `/name` is not a way to run it.
 *
 * `disable-model-invocation: true` is deliberately **accepted** here — that is the field's whole
 * point: a skill the model may not invoke is one the user runs by hand.
 *
 * The check is on the batch rather than on one event because a batch is one append: a message
 * that named a skill the chat does not have refuses the whole thing, so the log never holds a
 * message whose invocation the brain would then have to skip.
 *
 * @param modeId the mode the batch leaves the session on, or `null` for a chat following none —
 *   resolved here, and only when there is an invocation to check
 * @throws HttpError 400 `invalid_request_error` naming the skill and what is wrong with it
 */
export async function assertInvocableSkills(
  deps: SkillInvocationDeps,
  ownerId: UserId,
  modeId: ModeId | null,
  events: readonly EventInput[],
): Promise<void> {
  const invocations = events.flatMap((event) =>
    event.type === EVENT_TYPES.userMessage && event.skill !== undefined ? [event.skill] : [],
  )
  if (invocations.length === 0) {
    // The common case, and the reason the mode is read here rather than by the caller: a batch
    // that invokes nothing costs one pass over its events and no store read at all.
    return
  }
  const override = await modeToolOverride(deps, ownerId, modeId)
  const inForce = await listSkillsInForce({ skills: deps.skills }, ownerId, override)
  for (const invocation of invocations) {
    const skill = inForce.find((candidate) => candidate.name === invocation.name)
    if (skill === undefined) {
      throw invalidRequest(
        `no skill named "${invocation.name}" is available to this chat: it is not one of your ` +
          'skills, or it is turned off here',
      )
    }
    if (!skillSettingsOf(skill).userInvocable) {
      throw invalidRequest(
        `the "${invocation.name}" skill is not user-invocable: its frontmatter says the model ` +
          'uses it and only the model does',
      )
    }
  }
}
