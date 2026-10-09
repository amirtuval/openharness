import { MODE_DEFAULT_MODEL, type Mode } from '@openharness/protocol'

/**
 * Helpers over the reader's modes (epic #245, M6).
 *
 * A mode is a preset rather than a model, so a picker that offers it has to say what it stands
 * for: {@link modeLabel} is that one line, and {@link modeNameOf} is how a surface that shows
 * the mode a chat follows finds its name among the reader's own.
 */

/** What a mode resolves to, as one line: its model (or "my default model") and its effort. */
export function modeLabel(mode: Mode): string {
  const model = mode.model === MODE_DEFAULT_MODEL ? 'my default model' : mode.model
  return mode.reasoning_effort === null ? model : `${model} · ${mode.reasoning_effort}`
}

/**
 * The name of the mode a chat follows, or `null` when the id names none of the reader's modes —
 * a mode that was deleted, or one this copy of the list has not loaded yet. A chat whose mode is
 * gone keeps running the model it last ran, so a caller shows the model rather than a stale name.
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
