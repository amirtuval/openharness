import type {
  TaskCard,
  TaskMessage,
  TranscriptEntry,
  SessionUsageTotals,
} from '@openharness/client'

/**
 * The background-task view this screen draws (epic #340, S9; issue #346).
 *
 * Everything about a task's *life* is `@openharness/client`'s: `selectTasks` folds the parent's
 * log into one {@link TaskCard} per task, `taskCardStatus` refines its status with what the
 * child's own stream says, and `taskActivityLabel` spells the one line its live activity draws.
 * What is left for the web app is the two things the card needs and the client does not have —
 * where the card sits among the conversation's messages and tool calls, and what to call the two
 * ends of the conversation in the card's inline lines.
 *
 * The card is deliberately **not** a fourth member of `TranscriptEntry`: that union is the
 * client's, both frontends switch on it exhaustively, and #347 (`oh`) has its own rendering of
 * the same cards. So a frontend merges `state.tasks` into the entries it already renders, by
 * position — which is what {@link mergeTaskCards} does here.
 */

/** A task's card as a render list holds it, beside the messages and the calls. */
export interface TaskEntry {
  readonly kind: 'task'
  readonly card: TaskCard
}

/** A row of the conversation as this app draws it: a client entry, or a task's card. */
export type TaskRenderEntry = TranscriptEntry | TaskEntry

/**
 * Merge the tasks into the entries the client already ordered (epic #340, S9; issue #346).
 *
 * A card's `position` is the `seq` of the `agent` call that started it, and that call is **not**
 * drawn as a tool line (`isTaskToolName`), so a card's position is normally one no entry holds
 * and the insertion order is unambiguous (the client's `tasksFromEvents` returns the cards sorted
 * by it). A tie is settled the way `transcriptEntries` settles its own — a message, a call and a
 * divider all come first — so a card can never push a message out of where a reader read it.
 *
 * A card whose position is past every entry is appended at the end: a task started by a call the
 * transcript no longer holds still belongs to the conversation, and the tail is where the work
 * it is doing happened.
 *
 * @param entries the conversation, in position order (`selectTranscriptEntries`)
 * @param tasks the cards, in position order (`selectTasks`)
 */
export function mergeTaskCards(
  entries: readonly TranscriptEntry[],
  tasks: readonly TaskCard[],
): readonly TaskRenderEntry[] {
  if (tasks.length === 0) {
    return entries
  }
  const merged: TaskRenderEntry[] = []
  let next = 0
  for (const entry of entries) {
    const position = entryPosition(entry)
    while (next < tasks.length && (tasks[next] as TaskCard).position < position) {
      merged.push({ kind: 'task', card: tasks[next] as TaskCard })
      next += 1
    }
    merged.push(entry)
  }
  while (next < tasks.length) {
    merged.push({ kind: 'task', card: tasks[next] as TaskCard })
    next += 1
  }
  return merged
}

/** Where an entry draws — the same `position` the merge compares. */
function entryPosition(entry: TranscriptEntry): number {
  switch (entry.kind) {
    case 'message':
      return entry.message.position
    case 'tool':
      return entry.call.position
    case 'summary':
      return entry.summary.position
  }
}

/**
 * What the two ends of the conversation are called in a card's inline lines (epic #340, S9).
 *
 * The type is the subagent type's own name — a mode the reader named, or `general-purpose` —
 * and a task started without one is called what it is rather than left blank. The arrow points
 * the way the message went: `→ researcher: …` is something the parent told the child, and
 * `researcher →: …` is something the child said back.
 *
 * @param message the line, as the client read it off the parent's log
 * @param type the task's type, or `null` when the starter named none
 */
export function taskMessageLabel(message: TaskMessage, type: string | null): string {
  const name = taskTypeLabel(type)
  return message.from === 'parent' ? `→ ${name}:` : `${name} →:`
}

/** What a task is called when it has no type of its own. */
export function taskTypeLabel(type: string | null): string {
  return type === null || type === '' ? 'subagent' : type
}

/**
 * Everything a child's log has spent, in tokens — the four counters summed.
 *
 * The counters are disjoint (`@openharness/protocol`'s own rule), so the sum is the child's real
 * token total and not a double count. `null` while the child's log has reported nothing: a card
 * with no tokens yet shows no number rather than a zero.
 */
export function taskTokens(usage: SessionUsageTotals | null): number | null {
  if (usage === null) {
    return null
  }
  return usage.input + usage.output + usage.cacheCreation + usage.cacheRead
}
