import { z } from 'zod'

import { EVENT_TYPES } from './events/common'
import type { StoredEvent } from './events/union'
import type { DeepReadonly } from './readonly'

/**
 * The `todo_write` tool's vocabulary, and the one way to read a list back out of a log
 * (epic #303, [#305](https://github.com/amirtuval/openharness/issues/305)).
 *
 * A model that is working through several steps can be given a list, and the tool it writes one
 * with replaces the **whole** list every time — there is no per-item edit, so "the list" is one
 * value rather than a sequence of mutations. Nothing stores it beside the call: the newest
 * `todo_write` call and its result **are** the state, which is the same rule every other piece
 * of the log follows (D9) — a client replaying a session sees the list the model last wrote, and
 * a session that never wrote one has none.
 *
 * `readTodoList` is that reading, and it lives here because **this is what both sides of the
 * log can reach**: the brain writes the call, and the web app and `oh` render it, and both
 * import this package. What a list *looks like* on screen is the client's
 * ([#308](https://github.com/amirtuval/openharness/issues/308)).
 */

/** The name the model calls the tool by, and the name a reader looks for in the log. */
export const TODO_WRITE_TOOL_NAME = 'todo_write'

/**
 * What one item's state is.
 *
 * `pending` is not started, `in_progress` is what the model is on now, `done` is finished —
 * Anthropic's own three states, and the ones a client renders differently.
 */
export const TodoStatusSchema = z.enum(['pending', 'in_progress', 'done'])

export type TodoStatus = z.infer<typeof TodoStatusSchema>

/** One item of the list: what to do, and where it stands. */
export const TodoItemSchema = z.object({
  /** The task, as the model wrote it. */
  content: z.string().min(1),
  /** Where the task stands. */
  status: TodoStatusSchema,
})

export type TodoItem = DeepReadonly<z.infer<typeof TodoItemSchema>>

/**
 * The whole list, in the order the model wrote it.
 *
 * An empty list is meaningful — it is a model clearing a list it no longer needs — and is told
 * apart from "no list has ever been written" by {@link readTodoList}'s `null`.
 */
export const TodoListSchema = z.array(TodoItemSchema)

export type TodoList = readonly TodoItem[]

/**
 * What a `todo_write` call carries: the whole list.
 *
 * An object wrapping the array rather than the array itself, because that is what a tool call's
 * input must be ({@link ToolInput}): a model's arguments are an object, and a call whose
 * arguments were a bare array is not a call any registered tool can be run with. The array is
 * the list as the issue spells it.
 */
export const TodoWriteInputSchema = z.object({
  todos: TodoListSchema,
})

export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>

/**
 * The list a log holds, or `null` when no `todo_write` call has taken effect in it.
 *
 * The **newest successful call wins**, and its own input is the list: a call is the whole list,
 * so the last one the model made is the current state. A call that failed — refused under a
 * policy, refused by the tool's schema, timed out, interrupted, or `execution lost` — changed
 * nothing and is skipped, which is why only a call with a non-error result counts: a call the
 * brain stored and never answered is a call that never ran.
 *
 * A `session.rewind` that took a call back removes it from the array the caller passes (the
 * replay read skips what a range covers), so a branch nobody is on contributes nothing. The
 * events are read in the order they are given: a log is in `seq` order, so the last match wins.
 *
 * @param events a session's log, as a replay read handed it over
 */
export function readTodoList(events: readonly StoredEvent[]): TodoList | null {
  const results = new Map<string, boolean>()
  for (const event of events) {
    if (event.type === EVENT_TYPES.agentToolResult) {
      results.set(event.tool_use_id, event.is_error)
    }
  }
  let list: TodoList | null = null
  for (const event of events) {
    if (event.type !== EVENT_TYPES.agentToolUse || event.name !== TODO_WRITE_TOOL_NAME) {
      continue
    }
    // A call with no result is one this brain never ran (a turn that died between the two
    // appends, a call `execution lost` answered); one with an error result ran and did not take.
    if (results.get(event.id) !== false) {
      continue
    }
    const parsed = TodoWriteInputSchema.safeParse(event.input)
    if (parsed.success) {
      list = parsed.data.todos
    }
  }
  return list
}
