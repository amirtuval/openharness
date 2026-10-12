import type { TodoList, TodoStatus } from '@openharness/protocol'
import { Check, Circle, Loader2, ListTodo } from 'lucide-react'

import { cn } from '../../lib/utils'

/**
 * The chat's current task list (epic #303, X5; #305; issue #308).
 *
 * A model working through several steps writes a list with `todo_write`, and the list it last
 * wrote is the current state — nothing is stored beside the call, and the shared reducer reads
 * it with the protocol's own `readTodoList`. This is where a reader sees it: a pinned block above
 * the composer, while the chat has one, updating live as the model rewrites it.
 *
 * Three things it deliberately does:
 *
 * - **It updates where it is.** The block is in the chat's own column (not the transcript's
 *   scroll), so a rewrite is visible without hunting for it — and it does not push the
 *   conversation around as it grows, because the composer's section is below the scroller.
 * - **It draws the three states differently** (X5's whole point): done is struck through and
 *   muted, `in_progress` is the coral one, pending is plain. That is the only signal that says
 *   what the model is on now.
 * - **It says how far along it is** — "2 of 5 done" — which is the number a reader actually
 *   wants and the one a bare list makes them count.
 */
export function TodoPanel({ todos }: { todos: TodoList }) {
  const done = todos.filter((item) => item.status === 'done').length
  const current = todos.find((item) => item.status === 'in_progress')

  return (
    <section
      data-slot="todo-panel"
      aria-label="Task list"
      className="rounded-lg border bg-muted/30 px-3 py-2"
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ListTodo aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="font-medium">Task list</span>
        <span data-slot="todo-progress" className="tabular-nums">
          {todos.length === 0 ? 'cleared' : `${String(done)} of ${String(todos.length)} done`}
        </span>
        {current === undefined ? null : (
          <span data-slot="todo-current" className="ml-auto min-w-0 truncate text-coral-ink">
            {current.content}
          </span>
        )}
      </div>
      {todos.length === 0 ? null : (
        <ul className="mt-1.5 space-y-0.5">
          {todos.map((item, index) => (
            <li
              key={`${String(index)}:${item.content}`}
              data-slot="todo-item"
              data-status={item.status}
              className="flex items-start gap-2 text-xs"
            >
              <TodoStatusIcon status={item.status} />
              <span
                className={cn(
                  'min-w-0 break-words',
                  item.status === 'done' && 'text-muted-foreground line-through',
                  item.status === 'in_progress' && 'text-foreground',
                )}
              >
                {item.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The mark one item's state is drawn with: pending, in progress (coral), done. */
function TodoStatusIcon({ status }: { status: TodoStatus }) {
  if (status === 'done') {
    return <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
  }
  if (status === 'in_progress') {
    return (
      <Loader2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 animate-spin text-coral" />
    )
  }
  return <Circle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" />
}
