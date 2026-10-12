import type { ModeToolOverride, Skill, UserId } from '@openharness/protocol'
import type { SkillStore } from '@openharness/session'

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
  return skills.filter((skill) => override?.skills?.[skill.id] ?? skill.enabled)
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
