import type { TodoList } from '@openharness/protocol'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import type { Line } from '../markdown/text'
import { ThemeProvider } from './theme'
import {
  LIVE_AREA_HINT,
  TODO_AUTO_FOLD_THRESHOLD,
  TodoPanel,
  todoItemRows,
  todoLines,
} from './todo-panel'

/**
 * The chat's task list, as the terminal draws it (epic #303, X5; #305; #308).
 *
 * `todoLines` is the whole decision — the header, the marks, the states, the fold and the window
 * — and the component is Ink drawing it.
 */

const DARK = { background: 'dark', color: true, level: 3 } as const

/** The lines joined back into what a reader sees. */
function textOf(lines: readonly Line[]): string {
  return lines.map((line) => line.map((span) => span.text).join('')).join('\n')
}

/** A list of `count` items: the first done, the second in progress, the rest pending. */
function list(count: number): TodoList {
  return Array.from({ length: count }, (_, index) => ({
    content: `step ${index + 1}`,
    status:
      index === 0
        ? ('done' as const)
        : index === 1
          ? ('in_progress' as const)
          : ('pending' as const),
  }))
}

const TODOS = list(3)

afterEach(() => {
  cleanup()
})

describe('todoLines (#308)', () => {
  it('draws the list with a mark per state and how far along it is', () => {
    const lines = todoLines(TODOS, 80, DARK, { maxItems: 8 })
    const text = textOf(lines)

    expect(text).toContain('Tasks · 1 of 3 done')
    expect(text).toContain('☑ step 1')
    expect(text).toContain('◐ step 2')
    expect(text).toContain('☐ step 3')
  })

  it('says a cleared list is cleared rather than drawing nothing', () => {
    const text = textOf(todoLines([], 80, DARK))
    expect(text.split('\n')[0]).toContain('Tasks · cleared')
  })

  it('names the keys the live area answers to, so the fold and the detail view are findable', () => {
    expect(textOf(todoLines(TODOS, 80, DARK))).toContain(LIVE_AREA_HINT)
  })

  it('folds to the header and the item in progress, on one line', () => {
    const lines = todoLines(TODOS, 80, DARK, { folded: true })
    expect(lines).toHaveLength(1)
    expect(textOf(lines)).toBe('Tasks · 1 of 3 done · ◐ step 2')
  })

  it('folds to the header alone when nothing is in progress', () => {
    const done: TodoList = [{ content: 'all of it', status: 'done' }]
    expect(textOf(todoLines(done, 80, DARK, { folded: true }))).toBe('Tasks · 1 of 1 done')
  })

  it('windows a long list around the item in progress, counting what is out of view', () => {
    const lines = todoLines(list(20), 80, DARK, { maxItems: 5 })
    const text = textOf(lines)

    // The item in progress (the second of twenty) is visible, and everything above and below it
    // is counted rather than dropped.
    expect(text).toContain('◐ step 2')
    expect(text).toContain('+15 more')
    expect(lines.length).toBe(1 + 5 + 1 + 1)
  })

  it('windows around a list whose in-progress item is deep, keeping it in view', () => {
    const deep: TodoList = Array.from({ length: 20 }, (_, index) => ({
      content: `step ${index + 1}`,
      status: index === 12 ? ('in_progress' as const) : ('pending' as const),
    }))
    const text = textOf(todoLines(deep, 80, DARK, { maxItems: 5 }))
    expect(text).toContain('◐ step 13')
    expect(text).toContain('+10 more')
    expect(text).toContain('+5 more')
  })

  it('draws a list of exactly the threshold whole, and folds the one past it', () => {
    expect(textOf(todoLines(list(TODO_AUTO_FOLD_THRESHOLD), 80, DARK, { maxItems: 8 }))).toContain(
      '☐ step 5',
    )
    // The fold itself is the screen's decision (`todos.length > TODO_AUTO_FOLD_THRESHOLD`), and
    // the panel draws what it is told: folded is one line, however long the list is.
    expect(todoLines(list(TODO_AUTO_FOLD_THRESHOLD + 1), 80, DARK, { folded: true })).toHaveLength(
      1,
    )
  })

  it('leaves the terminal a window it can use, whatever height it reports', () => {
    expect(todoItemRows(24)).toBe(8)
    expect(todoItemRows(40)).toBe(8)
    expect(todoItemRows(15)).toBe(3)
  })

  it('truncates an item rather than overflowing a narrow terminal', () => {
    const lines = todoLines([{ content: 'x'.repeat(200), status: 'pending' }], 40, DARK)
    for (const line of lines) {
      expect(line.reduce((width, span) => width + span.text.length, 0)).toBeLessThanOrEqual(39)
    }
  })
})

describe('TodoPanel (#308)', () => {
  it('draws the same list a reader reads in the frame', () => {
    const frame = render(
      <ThemeProvider theme={DARK}>
        <TodoPanel todos={TODOS} width={80} rows={24} />
      </ThemeProvider>,
    ).lastFrame()

    expect(frame).toContain('step 2')
    expect(frame).toContain('1 of 3 done')
  })

  it('draws the folded list in the frame too', () => {
    const frame = render(
      <ThemeProvider theme={DARK}>
        <TodoPanel todos={TODOS} folded width={80} rows={24} />
      </ThemeProvider>,
    ).lastFrame()

    expect(frame).toContain('Tasks · 1 of 3 done · ◐ step 2')
  })
})
