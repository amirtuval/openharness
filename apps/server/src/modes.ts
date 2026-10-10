import { MODE_DEFAULT_MODEL, type Mode, type ModeId, type UserId } from '@openharness/protocol'
import { providerOf, type ModeResolver, type ResolvedMode } from '@openharness/brain'
import type { CredentialStore, SessionStore } from '@openharness/session'

import { modeUnavailableError, notFoundError } from './http/errors'

/**
 * Modes, server-side (epic #245, M6): resolving the mode a chat follows to the model, effort and
 * system-prompt addition a request runs with, and deciding whether that model can be used at all.
 *
 * A mode lives in the database (`SessionStore`'s mode methods) and its "my default model" is the
 * user's stored preference, so both halves are here rather than in the brain: the brain asks a
 * `ModeResolver` for the resolved mode, the routes ask {@link requireUsableMode} whether a chat
 * may start or continue on one.
 */

/** What resolving a mode needs: the modes, the user's default model, and their credentials. */
export interface ModeDeps {
  /** The mode store and the per-user preferences, both on the session store. */
  readonly store: Pick<SessionStore, 'getMode' | 'getPreferences'>
  /** The caller's own provider credentials: what decides whether a model can be used. */
  readonly credentials: Pick<CredentialStore, 'list'>
}

/** The message every refusal carries: what is wrong, and what the user can do about it. */
export function modeUnavailableMessage(mode: Mode): string {
  return (
    `the "${mode.name}" mode's model isn't available; ` + 'edit the mode or pick a model instead'
  )
}

/**
 * Whether `userId` has a credential for `provider` — the provider half of a model id.
 *
 * **The one function the mode availability check goes through.** A credential is keyed by its
 * `name` (epic #245, A3a), and a name *is* the provider half of the model ids it serves — the
 * provider id for the eleven fixed ones, the reader's own short name for a named type such as
 * `azure-eu` — so the check is a lookup by name and nothing here needs to know which kind it
 * found. Everywhere above this — a mode's resolution, the refusal, the pickers — speaks of a
 * model id and a provider, never of how a credential is stored.
 */
export async function hasCredentialForProvider(
  credentials: Pick<CredentialStore, 'list'>,
  userId: UserId,
  provider: string,
): Promise<boolean> {
  const stored = await credentials.list({ userId })
  return stored.some((credential) => credential.name === provider)
}

/**
 * The model a mode runs: its own `provider/model` id, or the owner's default model when the mode
 * is on "my default model" — `null` when there is no default to follow.
 */
export function modeModelId(mode: Mode, defaultModel: string | null): string | null {
  return mode.model === MODE_DEFAULT_MODEL ? defaultModel : mode.model
}

/**
 * The mode a request runs under, as the brain wants it (#245, M6), or `null` when there is
 * nothing to apply: the mode is gone, or it is "my default model" with no default set.
 *
 * It does not check credentials: the brain resolves the credential for whatever model it is
 * handed, and a mode whose provider has no key fails there the way any other model without a key
 * does (`missing_provider_credential`). The *refusal* — the clear message a user gets for an
 * unusable mode — is the routes', checked where a chat starts or continues.
 *
 * Since #307 it also carries the mode's **tool override**: which built-in tools a chat on this
 * mode has on or off. The loop hands it to the tool-settings resolver with the owner, where it
 * is applied over the user's own choices — a mode decides the tool set, never a permission — so
 * the override travels with the mode rather than being resolved into the answer here.
 */
export async function resolveMode(
  deps: ModeDeps,
  ownerId: UserId,
  modeId: ModeId,
): Promise<ResolvedMode | null> {
  const mode = await deps.store.getMode(modeId, { ownerId })
  if (mode === null) {
    return null
  }
  const { default_model } = await deps.store.getPreferences(ownerId)
  const model = modeModelId(mode, default_model)
  if (model === null) {
    return null
  }
  return {
    id: mode.id,
    name: mode.name,
    model,
    reasoningEffort: mode.reasoning_effort,
    systemPromptAddition: mode.system_prompt_addition,
    toolOverride: mode.tools,
  }
}

/**
 * The {@link ModeResolver} the server hands the brain: the session-bound resolver the scheduler
 * passes through, closed over this deployment's store and credential store.
 */
export function createModeResolver(deps: ModeDeps): ModeResolver {
  return (ownerId, modeId) => resolveMode(deps, ownerId, modeId)
}

/**
 * Read a mode the caller owns, refusing an unknown or another user's one as the 404 it is.
 *
 * The same "missing, never 403" answer as every other resource (A4).
 */
export async function requireOwnedMode(
  deps: Pick<ModeDeps, 'store'>,
  ownerId: UserId,
  modeId: ModeId,
): Promise<Mode> {
  const mode = await deps.store.getMode(modeId, { ownerId })
  if (mode === null) {
    throw notFoundError(`no mode with id ${modeId}`)
  }
  return mode
}

/**
 * Read the mode a chat is starting or continuing on, or refuse it: 404 for one the caller does
 * not own, 422 `mode_unavailable_error` for one whose model cannot be used.
 *
 * This is the enforcement of M6's "never fall back silently": a chat on an unavailable mode is
 * refused before anything is stored, with a message naming the mode and what to do about it.
 * It is checked on `POST /v1/sessions` and on `POST …/events`, which is where a chat starts and
 * continues — the brain applies whatever a resolver answers.
 *
 * It answers the mode and the model it resolves to, which is what a session created on one
 * stores as its header model — the model the chat last ran, and the fallback a delete leaves.
 */
export async function requireUsableMode(
  deps: ModeDeps,
  ownerId: UserId,
  modeId: ModeId,
): Promise<{ readonly mode: Mode; readonly model: string }> {
  const mode = await requireOwnedMode(deps, ownerId, modeId)
  const { default_model } = await deps.store.getPreferences(ownerId)
  const model = modeModelId(mode, default_model)
  if (
    model === null ||
    !(await hasCredentialForProvider(deps.credentials, ownerId, providerOf(model)))
  ) {
    throw modeUnavailableError(modeUnavailableMessage(mode))
  }
  return { mode, model }
}
