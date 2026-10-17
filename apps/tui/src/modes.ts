import { MODE_DEFAULT_MODEL, type Mode } from '@openharness/protocol'

/**
 * Helpers over the user's modes (epic #245, M6).
 *
 * A mode is a preset rather than a model, so anything that shows one has to say what it stands
 * for: {@link modeLabel} is that one line, and {@link modeNameOf} is how a surface that shows
 * the mode a chat follows finds its name among the user's own.
 */

/** What a mode resolves to, as one line: its model (or "my default model") and its effort. */
export function modeLabel(mode: Mode): string {
  const model = mode.model === MODE_DEFAULT_MODEL ? 'my default model' : mode.model
  return mode.reasoning_effort === null ? model : `${model} · ${mode.reasoning_effort}`
}

/**
 * Whether a mode is also a **subagent type** (epic #340, S2; #342; #347).
 *
 * A type is a mode with a description: the parent model is offered every one of the user's modes
 * that carries one, and `general-purpose` beside them. The description is what makes it a type,
 * which is why this is the test rather than a name — and why the frontends draw the description
 * read-only: it is the sentence the model chooses from, not a field `oh` invents.
 */
export function isSubagentType(mode: Mode): boolean {
  return mode.subagent_description !== null
}

/**
 * The name of the mode a chat follows, or `null` when the id names none of the user's modes —
 * one that was deleted, or one this copy of the list has not loaded. A chat whose mode is gone
 * keeps running the model it last ran, so a caller shows the model rather than a stale name.
 */
export function modeNameOf(
  modes: readonly Mode[],
  modeId: string | null | undefined,
): string | null {
  if (modeId === null || modeId === undefined) {
    return null
  }
  return modes.find((mode) => mode.id === modeId)?.name ?? null
}
