import type { TodoList } from '@openharness/protocol'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ModesView } from '../../hooks/use-modes'
import type { ModelsView } from '../../hooks/use-models'
import type { SessionView } from '../../hooks/use-session'
import { ChatView } from './chat-view'

/**
 * The chat screen's **column layout** (#316).
 *
 * The issue is an axis: with the task list in a side panel, the transcript sat in the narrower
 * left column while the composer block — notices, banners and the box — spanned the whole view,
 * so the two were centred on different axes and read as misaligned. The fix is structural, and
 * structural is what these tests assert: the transcript and the composer block are children of
 * one container, the side panel is not.
 *
 * The screen's *content* is driven through the router in `App.test.tsx` against the fake server;
 * there is no way to seed the fake with a `todo_write` call, so the task list here comes from the
 * hook's own answer and the rest of the screen is a stub. What is under test is where the pieces
 * are drawn, which is what `chat-view.tsx` decides.
 */

/** The task list the hook answers with, when a test wants one — `null` means none. */
const hookState = vi.hoisted(() => ({ todos: null as TodoList | null }))

vi.mock('../client-provider', () => ({ useClient: () => ({}) }))

vi.mock('../../hooks/use-preferences', () => ({
  usePreferences: () => ({ preferences: null, save: () => Promise.resolve(undefined) }),
}))

// The Add-provider dialog is mounted by the screen and reads the credentials list as it renders;
// nothing here opens it, so an empty view is the whole of what it needs.
vi.mock('../../hooks/use-provider-credentials', () => ({
  useProviderCredentials: () => ({
    credentials: [],
    loading: false,
    error: null,
    put: () => Promise.resolve({ ok: true }),
    remove: () => Promise.resolve({ ok: true }),
    reload: () => Promise.resolve(undefined),
  }),
}))

vi.mock('../../hooks/use-session', () => ({
  useSession: () =>
    ({
      session: null,
      messages: [],
      summaries: [],
      summarizing: null,
      context: null,
      truncation: null,
      toolCalls: [],
      todos: hookState.todos,
      truncatedToolResults: [],
      clearedToolResults: null,
      confirmations: [],
      answering: [],
      searches: 0,
      manualCompaction: null,
      status: 'idle',
      lastError: null,
      mcpFailure: null,
      lastSeq: 0,
      loadingHistory: false,
      requestError: null,
      deleted: false,
      model: null,
      usage: { models: [] },
      send: () => Promise.resolve(true),
      compact: () => Promise.resolve(true),
      interrupt: () => Promise.resolve(undefined),
      respond: () => Promise.resolve(undefined),
      dismissError: () => undefined,
    }) as unknown as SessionView,
}))

/** A catalog with nothing in it: the picker renders, no model is chosen. */
const CATALOG = {
  models: [],
  providers: [],
  loading: false,
  error: null,
  refreshing: false,
  refresh: () => Promise.resolve({ ok: true }),
  reload: () => Promise.resolve(undefined),
  dismissError: () => undefined,
} as unknown as ModelsView

/** No modes either — the composer's selector offers the models alone. */
const MODES = {
  modes: [],
  loading: false,
  error: null,
  create: () => Promise.resolve({ ok: true }),
  update: () => Promise.resolve({ ok: true }),
  remove: () => Promise.resolve({ ok: true }),
  reload: () => Promise.resolve(undefined),
  dismissError: () => undefined,
} as unknown as ModesView

/** A list with one item in progress, which is what makes the panel say something. */
const TODOS: TodoList = [{ content: 'Write the tests', status: 'in_progress' }]

/** Render the chat screen with whatever task list the case is about. */
function renderChat(todos: TodoList | null): { readonly container: HTMLElement } {
  hookState.todos = todos
  const { container } = render(
    <ChatView
      sessionId="ses_1"
      catalog={CATALOG}
      modes={MODES}
      skills={[]}
      onDelete={() => Promise.resolve({ ok: true })}
      onDeleted={() => undefined}
    />,
  )
  return { container }
}

/** The one element the transcript and the composer block are both supposed to live in. */
function chatColumn(container: HTMLElement): HTMLElement {
  const column = container.querySelector<HTMLElement>('[data-slot="chat-column"]')
  expect(column).not.toBeNull()
  return column as HTMLElement
}

describe('the chat column and the task list (#316)', () => {
  it('puts the transcript and the whole composer block in one column when the panel shows', () => {
    const { container } = renderChat(TODOS)
    const column = chatColumn(container)

    // The transcript — the scrolling conversation — and the composer block (which holds the
    // notices and the box) are children of the same column, so they are centred on the same
    // axis: that is the alignment the issue is about.
    const transcript = screen.getByRole('log')
    const composer = container.querySelector<HTMLElement>('[data-slot="composer-column"]')
    expect(composer).not.toBeNull()
    expect(column.contains(transcript)).toBe(true)
    expect(column.contains(composer as HTMLElement)).toBe(true)
    // The box itself travels with them, so nobody can move the column's chrome without moving
    // the thing the reader types into.
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(column.contains(screen.getByRole('textbox'))).toBe(true)
  })

  it('draws the side panel beside that column, never inside it', () => {
    const { container } = renderChat(TODOS)
    const column = chatColumn(container)
    const side = container.querySelector<HTMLElement>(
      '[data-slot="todo-panel"][data-variant="side"]',
    )

    expect(side).not.toBeNull()
    // A sibling: it is the full-height right column the transcript column shares the row with,
    // so the row has exactly the two children.
    expect(column.contains(side as HTMLElement)).toBe(false)
    expect((side as HTMLElement).parentElement).toBe(column.parentElement)
    expect((column.parentElement as HTMLElement).children).toHaveLength(2)
  })

  it('leaves the single column exactly as it was when there is no task list', () => {
    const { container } = renderChat(null)
    const column = chatColumn(container)

    // No panel: the column is the row's only child, and the transcript and the composer still
    // share it — the layout the screen had before the panel existed.
    expect((column.parentElement as HTMLElement).children).toHaveLength(1)
    expect(container.querySelector('[data-slot="todo-panel"]')).toBeNull()
    expect(column.contains(screen.getByRole('log'))).toBe(true)
    expect(
      column.contains(container.querySelector('[data-slot="composer-column"]') as HTMLElement),
    ).toBe(true)
  })
})
