import type {
  SubagentParent,
  SubagentTypeResolution,
  SubagentTypeResolver,
  SubagentTypeSummary,
} from '@openharness/brain'
import { GENERAL_PURPOSE_DESCRIPTION, GENERAL_PURPOSE_TYPE } from '@openharness/brain'
import type { Mode, UserId } from '@openharness/protocol'
import type { CredentialStore, SessionStore } from '@openharness/session'

import { usableModeModel } from './modes'

/**
 * Subagent types, server-side (epic #340, decision S2; issue #342): the types a parent model
 * may start, and what one of them resolves to.
 *
 * A **type is a mode with a description**. The parent model picks a kind of helper, so the
 * kinds are the user's own modes that carry a `subagent_description` — each of which already
 * says how a chat on it runs — plus one built-in every deployment offers:
 * `general-purpose`, which is the parent's own model, effort and tools in a fresh context.
 * The epic puts the vocabulary and the child's system prompt in `@openharness/brain`
 * (`subagent.ts`, this module's `SubagentTypeResolver`); everything that needs a database, a
 * credential or a tool registry is here.
 *
 * **Resolution is the same one a chat gets, on purpose.** A mode type resolves through
 * {@link usableModeModel} — `requireUsableMode`'s rule, so a mode whose model cannot be used is
 * refused here exactly as a chat on it would be refused — and its tools and MCP servers come
 * from `effectiveTools` and `listMcpServersInForce`, the two functions the tool loop itself
 * reads. Nothing is re-derived: retuning a mode changes what its type starts, from the next
 * call on, and "the tools this type's child has" and "the tools this request offers" cannot
 * drift apart because they are one computation.
 *
 * **Every refusal is an answer, never a throw** ({@link SubagentTypeResolution}): the reader is
 * a model, and a name it got wrong or a mode its owner has not finished configuring is
 * something it can act on — by picking another type or doing the work itself.
 */

/** What resolving a subagent type needs, beyond the mode itself. */
export interface SubagentTypeDeps {
  /** The caller's modes — the types — and the preferences the availability check reads. */
  readonly store: Pick<SessionStore, 'listModes' | 'getPreferences'>
  /** The caller's own provider credentials: what decides whether a mode's model can be used. */
  readonly credentials: Pick<CredentialStore, 'list'>
}

/**
 * The types on offer, built from the owner's modes: the built-in first, then every mode that
 * carries a description, oldest first — the store's own order.
 *
 * A mode without a description is a preset, not a type, and is left out; another user's modes
 * are not read at all ({@link SubagentTypeResolver.list} is owner-scoped). Nothing here checks
 * whether a type's model can be used: the list is what a model chooses from, and the choice is
 * where usability decides.
 *
 * A mode **named after the built-in** is left out too (#362): mode names are free text, so a
 * user can describe a mode called `general-purpose`, and the name would then be offered twice —
 * twice in the list a model chooses from, and unreachable as a type, because {@link
 * SubagentTypeResolver.resolve} answers the built-in first. One name, one type: the user's mode
 * keeps working as a **preset** and is simply not a type (`resolve` answers the built-in for
 * that name, exactly as `list` says).
 */
function summariesOf(modes: readonly Mode[]): SubagentTypeSummary[] {
  return [
    { name: GENERAL_PURPOSE_TYPE, description: GENERAL_PURPOSE_DESCRIPTION },
    ...modes.flatMap((mode) =>
      mode.subagent_description === null || mode.name === GENERAL_PURPOSE_TYPE
        ? []
        : [{ name: mode.name, description: mode.subagent_description }],
    ),
  ]
}

/**
 * What a name that is not a type is answered with: the name, and what there is to choose from
 * instead.
 *
 * The list is the whole point of the sentence — a model told only that its choice was wrong
 * has to guess again, and guessing is what a list stops. An empty list is spelled out rather
 * than left blank, because "no type is available" is itself an answer the model has to be able
 * to read (it can still do the work in its own chat).
 */
function unknownTypeMessage(name: string, modes: readonly Mode[]): string {
  const offered = summariesOf(modes)
    .map((type) => type.name)
    .join(', ')
  return `There is no subagent type named "${name}". The types available to this chat are: ${offered}.`
}

/**
 * What an unavailable mode type is answered with (epic #340, S2; the rule:
 * {@link usableModeModel}).
 *
 * Worded for the **model**, not for the user: a chat on an unavailable mode is refused with
 * `modeUnavailableMessage`, which tells a reader to edit the mode — advice the parent model can
 * neither take nor pass on. This sentence says what happened and what the model can do about it
 * instead, which is another type or its own work.
 */
function unavailableTypeMessage(mode: Mode): string {
  return (
    `The "${mode.name}" subagent type cannot be started: the mode's model is not available ` +
    'to this account. Start a different type, or do the work in this chat instead.'
  )
}

/**
 * The {@link SubagentTypeResolver} the server hands whoever builds the parent's `agent` tool
 * (epic #340, S2; #342; the tool itself: #344).
 *
 * Both calls read the store, so a mode edited between two starts applies to the second — the
 * live follow a mode is for (#245, M6) — and a credential added meanwhile makes a type usable
 * that was not. That is the point of the seam rather than a list computed once: a type is a
 * mode, and a mode is resolved as it is now.
 */
export function createSubagentTypeResolver(deps: SubagentTypeDeps): SubagentTypeResolver {
  const usability = { store: deps.store, credentials: deps.credentials }

  return {
    async list(ownerId: UserId): Promise<readonly SubagentTypeSummary[]> {
      return summariesOf(await deps.store.listModes({ ownerId }))
    },

    async resolve(
      ownerId: UserId,
      name: string,
      parent: SubagentParent,
    ): Promise<SubagentTypeResolution> {
      if (name === GENERAL_PURPOSE_TYPE) {
        // The built-in type is the parent continued: the model and effort this request runs,
        // and the tool override its own mode imposes (which is the parent's effective set in
        // the one spelling an override has). It has no prompt addition of its own — the
        // child's system prompt is its own plus the subagent one every child carries.
        return {
          ok: true,
          type: {
            name: GENERAL_PURPOSE_TYPE,
            description: GENERAL_PURPOSE_DESCRIPTION,
            model: parent.model,
            reasoningEffort: parent.reasoningEffort,
            systemPromptAddition: null,
            toolOverride: parent.toolOverride,
            // The parent's own mode, so a child of a chat that follows one follows it too: the
            // mode is what carries the tool and MCP-server override, and a child created on it
            // resolves exactly as its parent's next request does (#344). `null` means the child
            // is a plain session on the parent's model.
            modeId: parent.modeId,
          },
        }
      }
      // A mode is looked up by **name**, which is what the parent model has: modes have no
      // separate "type id", and a name is unique among its owner's modes (`0024`'s constraint),
      // so the lookup cannot be ambiguous. A mode with no description is not a type, so it is
      // answered exactly as an unknown name is — it is not in the list the model was offered.
      // The read happens here rather than above, so resolving the built-in type costs no mode
      // read at all.
      const modes = await deps.store.listModes({ ownerId })
      const mode = modes.find((candidate) => candidate.name === name)
      if (mode === undefined || mode.subagent_description === null) {
        return { ok: false, message: unknownTypeMessage(name, modes) }
      }
      const model = await usableModeModel(usability, ownerId, mode)
      if (model === null) {
        return { ok: false, message: unavailableTypeMessage(mode) }
      }
      return {
        ok: true,
        type: {
          name: mode.name,
          description: mode.subagent_description,
          model,
          reasoningEffort: mode.reasoning_effort,
          systemPromptAddition: mode.system_prompt_addition,
          toolOverride: mode.tools,
          // The child is created **on** this mode (#344): it follows it live, so retuning the
          // mode retunes the helper, and the override above is applied by the mode resolver
          // rather than restated on a session that could go stale.
          modeId: mode.id,
        },
      }
    },
  }
}
