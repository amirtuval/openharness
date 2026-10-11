import { describe, expect, it } from 'vitest'

import { createToolRegistry } from './registry'
import { todoWriteTool } from './todo'

/**
 * `todo_write` (epic #303, #305).
 *
 * The tool itself does nothing but say back what it was handed — the list is the call's own
 * input, and `@openharness/protocol`'s `readTodoList` is what reads it out of a log — so what
 * is asserted here is the rendering a model reads, the schema a call is held to, and that a
 * call reaches nothing at all.
 */

/** One call through the real registry, so the input schema and the result shape are the real ones. */
async function call(input: unknown): Promise<{ text: string; isError: boolean }> {
  const registry = createToolRegistry([todoWriteTool])
  const result = await registry.execute('todo_write', input, { secrets: {} })
  return {
    text: result.content.map((block) => block.text).join(''),
    isError: result.isError === true,
  }
}

describe('todo_write', () => {
  it('reads the list back with a marker per state and a count of each', async () => {
    const result = await call({
      todos: [
        { content: 'read the issue', status: 'done' },
        { content: 'write the tool', status: 'in_progress' },
        { content: 'write the docs', status: 'pending' },
      ],
    })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('Todo list (3 items: 1 done, 1 in progress, 1 pending):')
    expect(result.text).toContain('- [x] read the issue')
    expect(result.text).toContain('- [~] write the tool')
    expect(result.text).toContain('- [ ] write the docs')
  })

  it('takes an empty list as a cleared one', async () => {
    const result = await call({ todos: [] })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('cleared')
  })

  it('refuses a status it does not have, naming the field', async () => {
    const result = await call({ todos: [{ content: 'x', status: 'later' }] })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('status')
  })

  it('refuses an item with nothing to do, and a call with no list at all', async () => {
    expect((await call({ todos: [{ content: '', status: 'done' }] })).isError).toBe(true)
    expect((await call({})).isError).toBe(true)
  })

  it('is offered to the model under its own name and description', () => {
    expect(todoWriteTool.name).toBe('todo_write')
    expect(todoWriteTool.permission).toBe('allow')
    expect(todoWriteTool.description).toContain('replaces the previous one')
  })
})
