/**
 * Whether a chat's task list is folded, remembered **per chat for the process lifetime**
 * (epic #303, #305; issue #308).
 *
 * The choice belongs to the chat rather than to the component: a list the reader folded stays
 * folded while the model rewrites it, when the turn ends, and — because the panel is drawn in
 * the live area rather than in the scrollback — across every re-render in between. Nothing here
 * is written to disk: the list itself lives in the log on the server, and a fold is a view of it
 * for as long as this process runs, the same kind of state the prompt's own buffer is.
 *
 * A chat nothing was chosen for has no entry, and the screen falls back to the auto-fold rule
 * (`TODO_AUTO_FOLD_THRESHOLD`): a list longer than that starts folded.
 */

/** The folded choice per session id. Absent means "the reader has not said". */
const choices = new Map<string, boolean>()

/** The reader's fold choice for a chat, or `undefined` when they have not made one. */
export function todoFoldChoice(sessionId: string): boolean | undefined {
  return choices.get(sessionId)
}

/** Remember the reader's fold choice for a chat. */
export function setTodoFoldChoice(sessionId: string, folded: boolean): void {
  choices.set(sessionId, folded)
}

/**
 * Forget every choice — a test seam, and the only way one is needed: two chats in one process
 * have two entries, but two tests sharing a fake session id would share one.
 */
export function forgetTodoFoldChoices(): void {
  choices.clear()
}
