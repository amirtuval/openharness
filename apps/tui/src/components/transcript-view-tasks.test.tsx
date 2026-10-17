import { transcriptEntries } from '@openharness/client'
import type { TaskCard, TranscriptMessage } from '@openharness/client'
import type { SessionId } from '@openharness/protocol'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { ThemeProvider } from './theme'
import { mergeTasks, TranscriptView, type Block } from './transcript-view'

/** A settled message at a position of its own. */
function message(
  position: number,
  text: string,
  role: 'user' | 'agent' = 'agent',
): TranscriptMessage {
  return {
    id: `msg_${String(position)}`,
    role,
    text,
    parts: [{ type: 'text', text }],
    pending: false,
    streaming: false,
    position,
  }
}

const CHILD_SESSION = 'sesn_child0000000000000000000' as SessionId

/** A card at a position of its own. */
function card(position: number, overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: `task_${String(position)}`,
    kind: 'subagent',
    childSessionId: CHILD_SESSION,
    type: 'researcher',
    description: 'Check the flaky test',
    status: 'done',
    messages: [],
    result: null,
    position,
    ...overrides,
  }
}

/** What a block is, for an assertion about the order it landed in. */
function label(block: Block): string {
  if (block.kind === 'task') return 'task'
  if (block.kind === 'message') return block.message.text
  return block.kind
}

afterEach(cleanup)

describe('mergeTasks (#347)', () => {
  it('hands back the entries untouched when there are no tasks', () => {
    const entries = transcriptEntries([message(1, 'a'), message(3, 'b')], [])
    expect(mergeTasks(entries, [])).toBe(entries)
  })

  it('places a card after everything up to its own position', () => {
    const entries = transcriptEntries([message(1, 'a'), message(3, 'b'), message(5, 'c')], [])
    const merged = mergeTasks(entries, [card(4)])
    expect(merged.map(label)).toEqual(['a', 'b', 'task', 'c'])
  })

  it('places a card before the first entry when its call came first', () => {
    const entries = transcriptEntries([message(3, 'b')], [])
    expect(mergeTasks(entries, [card(1)]).map((block) => block.kind)).toEqual(['task', 'message'])
  })

  it('appends cards whose calls the entries do not reach', () => {
    const entries = transcriptEntries([message(1, 'a')], [])
    expect(mergeTasks(entries, [card(4), card(5)]).map((block) => block.kind)).toEqual([
      'message',
      'task',
      'task',
    ])
  })

  it('orders several cards among the messages by position', () => {
    const entries = transcriptEntries([message(2, 'a'), message(6, 'b')], [])
    const merged = mergeTasks(entries, [card(5, { id: 'second' }), card(1, { id: 'first' })])
    expect(merged.map((block) => (block.kind === 'task' ? block.card.id : label(block)))).toEqual([
      'first',
      'a',
      'second',
      'b',
    ])
  })
})

describe('a task card in the transcript (#347)', () => {
  it('draws where its agent call was, with one blank line around it', () => {
    const frame = (
      render(
        <ThemeProvider theme={{ background: 'dark', color: true, level: 3 }}>
          <TranscriptView
            messages={[message(1, 'before'), message(5, 'after')]}
            tasks={[
              card(3, { status: 'done', result: { kind: 'result', text: 'All green.', seq: 4 } }),
            ]}
            width={60}
          />
        </ThemeProvider>,
      ).lastFrame() ?? ''
    ).trimEnd()

    expect(frame).toBe(
      [
        'before',
        '',
        '● done · researcher · Check the flaky test',
        '  ⎿ All green.',
        '',
        'after',
      ].join('\n'),
    )
  })

  it('draws a card that has no session to follow, and no line it cannot fill', () => {
    const frame = (
      render(
        <ThemeProvider theme={{ background: 'dark', color: true, level: 3 }}>
          <TranscriptView
            messages={[message(1, 'hi')]}
            tasks={[card(2, { childSessionId: null, type: null, status: 'stopped' })]}
            width={60}
          />
        </ThemeProvider>,
      ).lastFrame() ?? ''
    ).trimEnd()

    // A task whose starter named no type is drawn as the kind it is.
    expect(frame).toContain('⊘ stopped · subagent · Check the flaky test')
  })
})
