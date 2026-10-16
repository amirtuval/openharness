import type { TaskCard, TranscriptEntry, TranscriptMessage } from '@openharness/client'
import { newSessionId } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { mergeTaskCards, taskMessageLabel, taskTokens, taskTypeLabel } from './tasks'

/**
 * The web app's half of the task view (#346): where a card draws among the conversation, and the
 * few words it adds to the client's (the two ends of an inline message, what a typeless task is
 * called).
 *
 * The statuses, the activity line and the result are `@openharness/client`'s — `tasks.test.ts`
 * and `task-activity.test.ts` there own them — so nothing here re-tests a rule the shared module
 * states.
 */

/** A message entry at a position — the only field the merge reads. */
function message(id: string, position: number): TranscriptMessage {
  return {
    id,
    role: 'user',
    text: id,
    parts: [{ type: 'text', text: id }],
    pending: false,
    streaming: false,
    position,
  }
}

/** A card at a position, with everything else filled in as a plain subagent task. */
function card(id: string, position: number): TaskCard {
  return {
    id,
    kind: 'subagent',
    childSessionId: newSessionId(),
    type: 'researcher',
    description: `${id} something`,
    status: 'running',
    messages: [],
    result: null,
    position,
  }
}

describe('merging the cards into the conversation (#346)', () => {
  it('draws a card where its `agent` call was — between the messages around it', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'message', message: message('first', 1) },
      { kind: 'message', message: message('second', 5) },
    ]
    const merged = mergeTaskCards(entries, [card('task_a', 3)])

    expect(merged.map((entry) => (entry.kind === 'task' ? entry.card.id : 'message'))).toEqual([
      'message',
      'task_a',
      'message',
    ])
  })

  it('keeps the cards in the order the client sorted them', () => {
    const merged = mergeTaskCards(
      [{ kind: 'message', message: message('only', 1) }],
      [card('task_a', 2), card('task_b', 4)],
    )

    expect(merged.map((entry) => (entry.kind === 'task' ? entry.card.id : 'message'))).toEqual([
      'message',
      'task_a',
      'task_b',
    ])
  })

  it('appends a card whose position is past everything on screen', () => {
    // A start whose `agent` call the transcript no longer holds falls back to the start's own
    // `seq` (the client's rule), which can be past every entry a frontend has.
    const merged = mergeTaskCards(
      [{ kind: 'message', message: message('only', 1) }],
      [card('task_a', 99)],
    )

    const last = merged.at(-1)
    expect(last?.kind === 'task' ? last.card.id : null).toBe('task_a')
  })

  it('lets a message win a tie, the way the client settles its own', () => {
    const merged = mergeTaskCards(
      [{ kind: 'message', message: message('same', 7) }],
      [card('task_a', 7)],
    )

    expect(merged.map((entry) => entry.kind)).toEqual(['message', 'task'])
  })

  it('answers the entries themselves when there are no tasks', () => {
    const entries: TranscriptEntry[] = [{ kind: 'message', message: message('only', 1) }]
    expect(mergeTaskCards(entries, [])).toBe(entries)
  })
})

describe('what a task is called', () => {
  it('names the two ends of an inline message with the type', () => {
    expect(taskMessageLabel({ from: 'parent', text: 'look at this', seq: 4 }, 'researcher')).toBe(
      '→ researcher:',
    )
    expect(taskMessageLabel({ from: 'child', text: 'done', seq: 9 }, 'researcher')).toBe(
      'researcher →:',
    )
  })

  it('calls a task started without a type what it is', () => {
    expect(taskTypeLabel(null)).toBe('subagent')
    expect(taskTypeLabel('')).toBe('subagent')
    expect(taskTypeLabel('general-purpose')).toBe('general-purpose')
    expect(taskMessageLabel({ from: 'parent', text: 'hi', seq: 1 }, null)).toBe('→ subagent:')
  })
})

describe('what a task has spent', () => {
  it('sums the four disjoint counters', () => {
    expect(taskTokens({ input: 10, output: 4, cacheCreation: 2, cacheRead: 1 })).toBe(17)
  })

  it('answers nothing for a child whose log has reported nothing', () => {
    expect(taskTokens(null)).toBeNull()
  })
})
