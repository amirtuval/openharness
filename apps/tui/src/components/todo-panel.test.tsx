import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import type { Line } from '../markdown/text'
import { ThemeProvider } from './theme'
import { TodoPanel, todoLines } from './todo-panel'

/**
 * The chat's task list, as the terminal draws it (epic #303, X5; #305; #308).
 *
 * `todoLines` is the whole decision — the header, the marks, the states — and the component is
 * Ink drawing it.
 */

const DARK = { background: 'dark', color: true, level: 3 } as const

/** The lines joined back into what a reader sees. */
function textOf(lines: readonly Line[]): string {
  return lines.map((line) => line.map((span) => span.text).join('')).join('\n')
}

const TODOS = [
  { content: 'read the docs', status: 'done' as const },
  { content: 'write the code', status: 'in_progress' as const },
  { content: 'ship it', status: 'pending' as const },
]

afterEach(() => {
  cleanup()
})

describe('todoLines (#308)', () => {
  it('draws the list with a mark per state and how far along it is', () => {
    const lines = todoLines(TODOS, 80, DARK)
    const text = textOf(lines)

    expect(lines).toHaveLength(4)
    expect(text).toContain('tasks · 1 of 3 done')
    expect(text).toContain('☑ read the docs')
    expect(text).toContain('◐ write the code')
    expect(text).toContain('☐ ship it')
  })

  it('says a cleared list is cleared rather than drawing nothing', () => {
    const lines = todoLines([], 80, DARK)
    expect(lines).toHaveLength(1)
    expect(textOf(lines)).toContain('tasks · cleared')
  })

  it('truncates an item rather than overflowing a narrow terminal', () => {
    const lines = todoLines([{ content: 'x'.repeat(200), status: 'pending' }], 40, DARK)
    expect(lines[1]?.reduce((width, span) => width + span.text.length, 0)).toBeLessThanOrEqual(39)
  })
})

describe('TodoPanel (#308)', () => {
  it('draws the same list a reader reads in the frame', () => {
    const frame = render(
      <ThemeProvider theme={DARK}>
        <TodoPanel todos={TODOS} width={80} />
      </ThemeProvider>,
    ).lastFrame()

    expect(frame).toContain('write the code')
    expect(frame).toContain('1 of 3 done')
  })
})
