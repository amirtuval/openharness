import { describe, expect, it } from 'vitest'

import type { StoredEvent } from './events/union'
import { makeAgentToolResult, makeAgentToolUse, makeUserMessage } from './fixtures'
import type { ToolInput } from './tools'
import { TODO_WRITE_TOOL_NAME, TodoWriteInputSchema, readTodoList } from './todo'

/** One `todo_write` call and the result that answers it, as the brain stores the pair. */
function todoWrite(
  todos: readonly { content: string; status: string }[],
  options: { readonly error?: boolean; readonly input?: ToolInput } = {},
): StoredEvent[] {
  const call = makeAgentToolUse(
    TODO_WRITE_TOOL_NAME,
    options.input ?? { todos: todos as unknown as ToolInput[keyof ToolInput] },
  )
  const result = makeAgentToolResult(call, options.error === true ? 'nope' : 'ok', {
    is_error: options.error === true,
  })
  return [call, result]
}

describe('TodoWriteInputSchema', () => {
  it('takes the whole list, in the three states', () => {
    const input = {
      todos: [
        { content: 'write the parser', status: 'done' },
        { content: 'wire the tool', status: 'in_progress' },
        { content: 'write the docs', status: 'pending' },
      ],
    }
    expect(TodoWriteInputSchema.parse(input)).toEqual(input)
  })

  it('refuses an unknown status, an empty item and a missing list', () => {
    expect(
      TodoWriteInputSchema.safeParse({ todos: [{ content: 'x', status: 'later' }] }).success,
    ).toBe(false)
    expect(
      TodoWriteInputSchema.safeParse({ todos: [{ content: '', status: 'done' }] }).success,
    ).toBe(false)
    expect(TodoWriteInputSchema.safeParse({}).success).toBe(false)
  })
})

describe('readTodoList', () => {
  it('answers null for a log that never wrote one', () => {
    expect(readTodoList([makeUserMessage('hello')])).toBeNull()
  })

  it('reads the list back from a call and its result', () => {
    const events = todoWrite([
      { content: 'one', status: 'done' },
      { content: 'two', status: 'pending' },
    ])
    expect(readTodoList(events)).toEqual([
      { content: 'one', status: 'done' },
      { content: 'two', status: 'pending' },
    ])
  })

  it('takes the newest call: the list is replaced whole, every time', () => {
    const events: StoredEvent[] = [
      ...todoWrite([{ content: 'old', status: 'pending' }]),
      ...todoWrite([{ content: 'new', status: 'in_progress' }]),
    ]
    expect(readTodoList(events)).toEqual([{ content: 'new', status: 'in_progress' }])
  })

  it('reads a cleared list as empty rather than as none', () => {
    const events: StoredEvent[] = [
      ...todoWrite([{ content: 'gone', status: 'done' }]),
      ...todoWrite([]),
    ]
    expect(readTodoList(events)).toEqual([])
  })

  it('ignores a call whose result failed — it changed nothing', () => {
    const events: StoredEvent[] = [
      ...todoWrite([{ content: 'kept', status: 'done' }]),
      ...todoWrite([{ content: 'refused', status: 'pending' }], { error: true }),
    ]
    expect(readTodoList(events)).toEqual([{ content: 'kept', status: 'done' }])
  })

  it('ignores a call nothing answered: a call that never ran is not a list', () => {
    const call = makeAgentToolUse(TODO_WRITE_TOOL_NAME, { todos: [] })
    expect(readTodoList([call])).toBeNull()
    expect(
      readTodoList([
        ...todoWrite([{ content: 'kept', status: 'done' }]),
        makeAgentToolUse(TODO_WRITE_TOOL_NAME, { todos: [] }),
      ]),
    ).toEqual([{ content: 'kept', status: 'done' }])
  })

  it('ignores an input its own schema refuses', () => {
    const events = todoWrite([], { input: { todos: [{ content: 'x', status: 'later' }] } })
    expect(readTodoList(events)).toBeNull()
  })

  it('ignores calls of another tool, whichever way they are spelled', () => {
    const call = makeAgentToolUse('web_fetch', { url: 'https://example.com' })
    expect(readTodoList([call, makeAgentToolResult(call, 'body')])).toBeNull()
  })
})
