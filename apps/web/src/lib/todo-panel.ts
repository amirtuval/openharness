/**
 * The task list's own state: whether the panel is folded away (#314, item 2).
 *
 * The panel is drawn twice — beside the transcript on a wide screen, above the composer below
 * `xl` — and one of those is `display: none`; the *state* is one value, so the two cannot
 * disagree, and this module is where it is read and written.
 *
 * It is remembered **per chat**, in `localStorage`, because "I folded the task list away" is a
 * thing about the work in front of the reader and not about the deployment or the account: the
 * next chat's list starts from its own default. Nothing here is authoritative — the run's own
 * source of truth is the log (the newest `todo_write` call) — so a browser that refuses storage
 * (Safari's private mode, a policy, a full quota) loses nothing but the memory: every read and
 * write is wrapped, and an unreadable or unknown value reads as "no choice stored", which is
 * the same state as a first visit.
 */

/** The prefix every chat's key carries. Namespaced like the settings and theme keys. */
export const TODO_PANEL_STORAGE_PREFIX = 'openharness:task-list:'

/**
 * How long a list may be before the panel starts folded, where the reader has not said.
 *
 * The panel is pinned above the composer below `xl`, where it takes room from the conversation:
 * a list of five items and its header is about as much chrome as a chat can carry without the
 * reader having asked for it. A longer list is folded to its header and the item in progress —
 * one line — and opening it is one click away, remembered from then on. The side panel ignores
 * the rule: there it costs the conversation nothing, so it starts open.
 */
export const TODO_PANEL_COLLAPSED_ITEM_LIMIT = 5

/** The key one chat's choice is stored under. */
export function todoPanelStorageKey(sessionId: string): string {
  return `${TODO_PANEL_STORAGE_PREFIX}${sessionId}`
}

/**
 * Whether this chat's task list was folded, or `null` for a reader who has not said.
 *
 * `null` is a real answer and not a synonym for `false`: it is what lets a long list start
 * folded ({@link todoPanelStartsCollapsed}) while a short one starts open, without writing a
 * choice the reader never made.
 */
export function readTodoPanelCollapsed(sessionId: string): boolean | null {
  try {
    const stored = localStorage.getItem(todoPanelStorageKey(sessionId))
    if (stored === 'collapsed') {
      return true
    }
    return stored === 'expanded' ? false : null
  } catch {
    // No storage (a private window, a policy, a quota): nothing is remembered, and the panel
    // falls back to its own default rather than failing to draw.
    return null
  }
}

/** Remember one chat's choice. A refused write is swallowed for the same reason. */
export function writeTodoPanelCollapsed(sessionId: string, collapsed: boolean): void {
  try {
    localStorage.setItem(todoPanelStorageKey(sessionId), collapsed ? 'collapsed' : 'expanded')
  } catch {
    // See above: the panel works, it is just not remembered.
  }
}

/** Whether a list of `count` items starts folded, for a reader who has not said. */
export function todoPanelStartsCollapsed(count: number): boolean {
  return count > TODO_PANEL_COLLAPSED_ITEM_LIMIT
}
