import type { TodoList, TodoStatus } from '@openharness/protocol'
import { Check, ChevronDown, Circle, Loader2, ListTodo } from 'lucide-react'

import { todoPanelStartsCollapsed } from '../../lib/todo-panel'
import { cn } from '../../lib/utils'

/**
 * The chat's current task list (epic #303, X5; #305; issue #308; the panel's own shape: #314).
 *
 * A model working through several steps writes a list with `todo_write`, and the list it last
 * wrote is the current state — nothing is stored beside the call, and the shared reducer reads
 * it with the protocol's own `readTodoList`. This is where a reader sees it, updating live as the
 * model rewrites it.
 *
 * Four things it deliberately does:
 *
 * - **It updates where it is, and it is somewhere different by width.** On a wide screen the list
 *   is a panel **beside the transcript** (`variant: 'side'`): the chat column has room for it,
 *   the panel scrolls on its own and the conversation keeps its full height. Below `xl` there is
 *   no such room, so it is drawn **above the composer** (`variant: 'bottom'`) where it was — one
 *   instance per breakpoint and a `display: none` on one of them, which is the shell's own way
 *   of switching layouts (a CSS rule, not a JavaScript breakpoint, so the first paint is already
 *   right). Where it is drawn is a fact about the space, not about the reader, which is why
 *   neither variant is remembered.
 * - **It folds, and the fold is remembered per chat.** The header is the control — "Tasks · 2 of
 *   5 done" with a chevron — and a folded panel is one line: the header and the item in progress,
 *   which is the one thing a reader glancing at a long run wants. The choice lives in
 *   `localStorage` under the session's own key, and a list longer than the limit
 *   `lib/todo-panel.ts` names starts folded where the reader has not said anything.
 * - **It draws the three states differently** (X5's whole point): done is struck through and
 *   muted, `in_progress` is the coral one, pending is plain. That is the only signal that says
 *   what the model is on now.
 * - **It says how far along it is** — "2 of 5 done" — which is the number a reader actually
 *   wants and the one a bare list makes them count.
 */
export function TodoPanel({
  todos,
  collapsed,
  onToggle,
  variant,
}: {
  todos: TodoList
  /**
   * Whether the list is folded to its header and the item in progress, or `null` for a reader
   * who has not said: the placement then decides ({@link foldedByDefault}), because the row
   * above the composer costs the conversation room and the side panel does not.
   */
  collapsed: boolean | null
  /**
   * Fold or unfold it, with what the panel's own state was — the reader's choice to remember.
   * The screen owns the remembering (`lib/todo-panel.ts`).
   */
  onToggle: (collapsed: boolean) => void
  /**
   * Where the panel is drawn: `side` is the transcript's right-hand panel from `xl` up, `bottom`
   * is the row above the composer below it. Exactly one of the two is ever visible.
   */
  variant: 'side' | 'bottom'
}) {
  const done = todos.filter((item) => item.status === 'done').length
  const current = todos.find((item) => item.status === 'in_progress')
  const folded = collapsed ?? foldedByDefault(variant, todos.length)
  // The list only exists while it is open, so `aria-controls` names it exactly then — a control
  // pointing at an element that is not there is worse than one that says what it does twice.
  const listId = `task-list-${variant}`
  const label = todos.length === 0 ? 'cleared' : `${String(done)} of ${String(todos.length)} done`

  return (
    <section
      data-slot="todo-panel"
      data-variant={variant}
      aria-label="Task list"
      className={cn(
        'text-xs',
        variant === 'side'
          ? // A column of its own beside the transcript: the chat keeps its full height, and a
            // long list scrolls here rather than in the conversation.
            'relative hidden w-[280px] shrink-0 overflow-y-auto border-l bg-muted/20 px-3 py-4 xl:block'
          : 'rounded-lg border bg-muted/30 px-3 py-2 xl:hidden',
      )}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <ListTodo aria-hidden="true" className="size-3.5 shrink-0" />
        {/* The header is the control (`aria-expanded`), and its name is the sentence a reader
            reads: "Tasks · 2 of 5 done". The current item is trailing text, never part of it. */}
        <button
          type="button"
          data-slot="todo-toggle"
          aria-expanded={!folded}
          {...(folded ? {} : { 'aria-controls': listId })}
          onClick={() => {
            onToggle(!folded)
          }}
          className="flex min-w-0 items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className="font-medium text-foreground">Tasks</span>
          {/* The separator an explicit string rather than its own element: JSX drops the
              whitespace between two elements on separate lines, and "Tasks1 of 3 done" is not
              the sentence the header is supposed to be. */}
          {' · '}
          <span data-slot="todo-progress" className="shrink-0 tabular-nums">
            {label}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn('size-3.5 shrink-0 transition-transform', folded && '-rotate-90')}
          />
        </button>
        {current === undefined || folded ? null : (
          <span data-slot="todo-current" className="ml-auto min-w-0 truncate text-coral-ink">
            {current.content}
          </span>
        )}
      </div>
      {folded ? (
        // The folded panel is one line more than its header: what the model is on now. With
        // nothing in progress there is nothing to add — the count in the header is the answer.
        current === undefined ? null : (
          <p className="mt-1.5 flex items-start gap-2 text-foreground">
            <TodoStatusIcon status={current.status} />
            <span data-slot="todo-current" className="min-w-0 break-words">
              {current.content}
            </span>
          </p>
        )
      ) : (
        <ul id={listId} className="mt-1.5 space-y-0.5">
          {todos.map((item, index) => (
            <li
              key={`${String(index)}:${item.content}`}
              data-slot="todo-item"
              data-status={item.status}
              className="flex items-start gap-2"
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

/**
 * Whether the panel starts folded for a reader who has not said anything (#314).
 *
 * The two placements are not the same thing: the row above the composer takes its height from
 * the conversation, so a list longer than the limit starts folded there and the reader opens it
 * when they want it; the side panel is a column of its own from `xl` up, which costs the
 * conversation nothing, so it starts open however long the list is.
 */
function foldedByDefault(variant: 'side' | 'bottom', count: number): boolean {
  return variant === 'bottom' && todoPanelStartsCollapsed(count)
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
