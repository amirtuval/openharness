/**
 * `todo_write`: the model's own task list (epic #303, #305).
 *
 * The tool **replaces the whole list** every time — there is no per-item edit, no id and no
 * partial update — which is what makes the state one value and its storage the log itself: the
 * newest call's own input *is* the list, and nothing is kept beside it
 * ({@link readTodoList} in `@openharness/protocol` is the reading, for the brain and the
 * clients). A model that has finished one task and started another writes both states in one
 * call; a model that has finished everything writes an empty list, which is a list and not an
 * absence.
 *
 * Nothing here touches the world: a call does no I/O, reads no context and uses no secret, so
 * the only thing it can be wrong about is the shape of what the model wrote — which the input
 * schema is, and which the registry answers with an `is_error` result naming the field.
 */

import { TODO_WRITE_TOOL_NAME, TodoWriteInputSchema } from '@openharness/protocol'
import type { TodoItem, TodoStatus, TodoWriteInput } from '@openharness/protocol'

import { textResult } from './tool'
import type { ToolDefinition } from './tool'

/** The marker each state is rendered with, in the result the model reads back. */
const STATUS_MARKERS: Readonly<Record<TodoStatus, string>> = {
  pending: '[ ]',
  in_progress: '[~]',
  done: '[x]',
}

/** How each state is named when the result counts them. */
const STATUS_NAMES: Readonly<Record<TodoStatus, string>> = {
  pending: 'pending',
  in_progress: 'in progress',
  done: 'done',
}

/** The order the counts are listed in, so a result reads the same way every time. */
const STATUS_ORDER: readonly TodoStatus[] = ['done', 'in_progress', 'pending']

/**
 * `todo_write` — record the list, replacing whatever was there.
 *
 * The default permission is `allow` (epic #303's default policies): the list is the model's own
 * working state, it reaches nothing, and a chat that asked before each update would be
 * unusable. A call is stored as an ordinary `agent.tool_use`, so what the model wrote is in the
 * log whether or not anything reads it back.
 */
export const todoWriteTool: ToolDefinition<TodoWriteInput> = {
  name: TODO_WRITE_TOOL_NAME,
  description:
    'Record your task list. Send the whole list every time — it replaces the previous one, so ' +
    'include the items that have not changed. Each item is `content` and one `status`: ' +
    '`pending`, `in_progress` or `done`. Send an empty list to clear it. Keep at most one item ' +
    'in progress.',
  inputSchema: TodoWriteInputSchema,
  permission: 'allow',
  run: (input) => textResult(renderTodoList(input.todos)),
}

/** The result text: how many items there are, what state they are in, and the list itself. */
function renderTodoList(todos: readonly TodoItem[]): string {
  if (todos.length === 0) {
    return 'Todo list cleared (0 items).'
  }
  return `${header(todos)}\n\n${todos.map(renderItem).join('\n')}`
}

function header(todos: readonly TodoItem[]): string {
  const counted = STATUS_ORDER.map((status) => {
    const count = todos.filter((todo) => todo.status === status).length
    return count === 0 ? null : `${count} ${STATUS_NAMES[status]}`
  }).filter((part): part is string => part !== null)
  return `Todo list (${todos.length} items: ${counted.join(', ')}):`
}

function renderItem(todo: TodoItem): string {
  return `- ${STATUS_MARKERS[todo.status]} ${todo.content}`
}
