import type { Client, TaskCard } from '@openharness/client'
import { createFakeClient, type FakeClient } from '@openharness/client/testing'
import type { Session, SessionId, StoredEvent, TaskId } from '@openharness/protocol'
import {
  makeAgentToolResult,
  makeAgentToolUse,
  makeChildSession,
  makeSession,
  makeSessionTaskNotification,
  makeSessionTaskStarted,
  makeSessionTaskStatus,
  makeUserMessage,
} from '@openharness/protocol/fixtures'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { createChatSession } from '../chat/session'
import { frameOf, pressKey, waitFor, waitForScreen, type TestInstance } from '../test-support/input'
import { AgentsScreen, agentRowLabel, agentsRows } from './agents-screen'

const CONTEXT = { server: 'http://localhost:3000' }
const CHILD_ID = 'sesn_child0000000000000000000' as SessionId
const PARENT_ID = 'sesn_parent000000000000000000' as SessionId
const TASK_ID = 'task_01' as TaskId

/** A card, for the pure row tests. */
function card(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: TASK_ID,
    kind: 'subagent',
    childSessionId: CHILD_ID,
    type: 'researcher',
    description: 'Check the flaky test',
    status: 'running',
    messages: [],
    result: null,
    position: 3,
    ...overrides,
  }
}

/**
 * The log of a chat that started one task: the `agent` call, the task's start, its status, and
 * one note from the child.
 *
 * Positions are explicit and disjoint: the transcript drops anything at or below the last `seq`
 * it has seen, so a stitched log has to be ordered like one the server would have stored.
 */
function subagentLog(): StoredEvent[] {
  const call = makeAgentToolUse(
    'agent',
    { type: 'researcher', description: 'Check the flaky test', prompt: 'Find the flaky test.' },
    { seq: 2 },
  )
  return [
    makeUserMessage('find the flaky test', { seq: 1 }),
    call,
    makeAgentToolResult(call, 'task_01', { seq: 3 }),
    makeSessionTaskStarted({
      seq: 4,
      task_id: TASK_ID,
      task_type: 'researcher',
      description: 'Check the flaky test',
      child_session_id: CHILD_ID,
    }),
    makeSessionTaskStatus(TASK_ID, 'running', { seq: 5 }),
    makeSessionTaskNotification(TASK_ID, {
      seq: 6,
      kind: 'message',
      text: 'found it — one assertion was flaky',
    }),
  ]
}

/** The same chat, with a task that has no child session — the shape the protocol allows. */
function childlessLog(): StoredEvent[] {
  return subagentLog().map((event) => {
    if (event.type !== 'session.task_started') {
      return event
    }
    // `child_session_id` is **optional** in the protocol, and absent is the childless shape — the
    // task kind that starts no session, which is why `stop()` guards it too.
    const { child_session_id: _omitted, ...childless } = event
    return childless
  })
}

/** The same chat, with its one task finished: the result delivered and the status moved. */
function finishedLog(): StoredEvent[] {
  return [
    ...subagentLog(),
    makeSessionTaskNotification(TASK_ID, {
      seq: 7,
      kind: 'result',
      text: 'One assertion was flaky; it is fixed now.',
    }),
    makeSessionTaskStatus(TASK_ID, 'idle', { seq: 8 }),
  ]
}

/**
 * A client whose session log already holds `events`, with a child and a parent to open.
 *
 * A resume is a replay of stored events (`events.iterate`), and the fake's brain starts no
 * children — a child is the server's to create (#344) — so a test that needs a task in the log
 * states it here rather than inventing a second fake. The events are `@openharness/protocol`'s
 * own builders, so what is replayed is what a server stores.
 */
function subagentClient(
  events: readonly StoredEvent[],
  overrides: { readonly interrupted?: string[] } = {},
): { readonly client: Client; readonly current: Session } {
  const fake: FakeClient = createFakeClient()
  const base: Client = fake
  const child: Session = { ...makeChildSession(fake.session), id: CHILD_ID }
  const client: Client = {
    ...base,
    // A real interrupt to a child the fake holds no session for is a 404; what this screen does
    // with the answer is nothing, so the call is recorded and answered here.
    interrupt: (sessionId) => {
      overrides.interrupted?.push(sessionId)
      return Promise.resolve({ type: 'user.interrupt' } as never)
    },
    sessions: {
      ...base.sessions,
      get: async (sessionId) => {
        if (sessionId === CHILD_ID) return child
        if (sessionId === PARENT_ID) return { ...makeSession(), id: PARENT_ID, title: 'root chat' }
        return base.sessions.get(sessionId)
      },
      events: {
        ...base.sessions.events,
        async *iterate(sessionId, params, options) {
          if (sessionId === fake.session.id) {
            for (const event of events) yield event
          }
          yield* base.sessions.events.iterate(sessionId, params, options)
        },
      },
    },
  }
  return { client, current: { ...fake.session } }
}

/** The screen, mounted over a chat whose log holds `events`. */
function renderScreen(
  events: readonly StoredEvent[],
  overrides: {
    readonly interrupted?: string[]
    readonly session?: Partial<Session>
  } = {},
): { readonly view: TestInstance; readonly opened: Session[] } {
  const { client, current: base } = subagentClient(events, overrides)
  const current: Session = { ...base, ...overrides.session }
  const session = createChatSession({ client, session: current })
  // The tasks are the chat's transcript, so the chat has to have loaded its history: this is a
  // resumed chat, exactly as `oh -s` opens one.
  void session.start()
  const opened: Session[] = []
  const view = render(
    <AgentsScreen
      client={client}
      session={session}
      current={current}
      context={CONTEXT}
      onOpen={(session) => {
        opened.push(session)
      }}
      onDone={() => undefined}
    />,
  )
  return { view, opened }
}

afterEach(cleanup)

describe('agentsRows (#347)', () => {
  it('lists the chat’s tasks in the transcript’s order', () => {
    const rows = agentsRows(
      [card({ messages: [{ from: 'child', text: 'hi', seq: 6 }] })],
      null,
      new Map(),
      makeSession(),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('task')
    expect(agentRowLabel(rows[0]!)).toBe('running · researcher: Check the flaky test · 1 note')
  })

  it('offers the way back up when this chat is a task’s own', () => {
    const parent = { ...makeSession(), title: 'root chat' }
    const current = { ...makeChildSession(parent), parent_session_id: PARENT_ID }
    const rows = agentsRows([card()], parent, new Map(), current)
    expect(rows[0]?.kind).toBe('back')
    expect(agentRowLabel(rows[0]!)).toBe('‹ back to root chat')
  })

  it('says nothing about going back for a top-level chat', () => {
    const rows = agentsRows([card()], null, new Map(), makeSession())
    expect(rows.every((row) => row.kind === 'task')).toBe(true)
  })

  it('names the result, the subtasks and the notes a task has', () => {
    const rows = agentsRows(
      [
        card({
          status: 'done',
          result: { kind: 'result', text: 'done', seq: 9 },
          messages: [{ from: 'parent', text: 'a', seq: 5 }],
        }),
      ],
      null,
      new Map([['task_01', 2]]),
      makeSession(),
    )
    expect(agentRowLabel(rows[0]!)).toBe(
      'done · researcher: Check the flaky test · 1 note · has a result · › 2 subtasks',
    )
  })

  it('names a task by the description its parent gave, not by its model', () => {
    // The row the maintainer read on staging: a helper is listed under the words it was started
    // with — the description of the `agent` call — and never under the model it runs (epic
    // #340). Unlike the web sidebar this screen needs no title off the session: the card is
    // built from the **parent's** log, which is where the description is.
    const rows = agentsRows(
      [card({ description: 'Check the changelog' })],
      null,
      new Map(),
      makeSession(),
    )
    const label = agentRowLabel(rows[0]!)

    expect(label).toContain('Check the changelog')
    expect(label).not.toContain('deepseek')
  })
})

describe('AgentsScreen (#347)', () => {
  it('draws the chat’s tasks, with the selected row marked', async () => {
    const { view } = renderScreen(subagentLog())
    await waitForScreen(view, 'Agents')
    await waitFor(() => frameOf(view).includes('researcher: Check the flaky test'))
    expect(frameOf(view)).toContain('❯ ◐ running · researcher: Check the flaky test · 1 note')
    expect(frameOf(view)).toContain('Enter open · s stop')
  })

  it('switches into the task’s own chat on Enter', async () => {
    const { view, opened } = renderScreen(subagentLog())
    await waitForScreen(view, 'Agents')
    await waitFor(() => frameOf(view).includes('researcher'))
    pressKey(view, 'enter')
    await waitFor(() => opened.length === 1)
    expect(opened[0]?.id).toBe(CHILD_ID)
  })

  it('stops the highlighted task with s — one interrupt to the child', async () => {
    const interrupted: string[] = []
    const { view } = renderScreen(subagentLog(), { interrupted })
    await waitForScreen(view, 'Agents')
    await waitFor(() => frameOf(view).includes('researcher'))
    pressKey(view, 'down')
    pressKey(view, 'up')
    view.stdin.write('s')
    await waitFor(() => interrupted.length === 1)
    expect(interrupted).toEqual([CHILD_ID])
    await waitFor(() => frameOf(view).includes('Stopped researcher'))
  })

  it('stops nothing on `s` for a task that has already finished, and says why (#368)', async () => {
    // The guard the web already had, where Stop is drawn only for a live task. An interrupt of a
    // child that has reported claims a turn of its own that ends on nothing, and the brain's
    // delivery reads that as a stop — so the parent's log would gain a `result` saying the *user*
    // stopped a helper that had finished, and the row would flip done → stopped under the reader.
    const interrupted: string[] = []
    const { view } = renderScreen(finishedLog(), { interrupted })
    await waitForScreen(view, 'Agents')
    await waitFor(() => frameOf(view).includes('● done'))

    view.stdin.write('s')

    await waitFor(() => frameOf(view).includes('nothing left to stop'))
    expect(interrupted).toEqual([])
    expect(frameOf(view)).toContain('● done')
  })

  it('opens nothing for a task with no child session, and says so (#368)', async () => {
    // `child_session_id` is optional in the protocol — `stop()` already guards the null — and
    // Enter used to fall back to the row's `task_…` id, which the server answers as a 404 drawn
    // as a generic error notice. The two verbs now agree about what a childless row can do.
    const { view, opened } = renderScreen(childlessLog())
    await waitForScreen(view, 'Agents')
    await waitFor(() => frameOf(view).includes('◐ running · researcher'))

    pressKey(view, 'enter')

    await waitFor(() => frameOf(view).includes('no chat of its own to open'))
    expect(opened).toEqual([])
  })

  it('goes back up from a task’s own chat on Enter', async () => {
    const { view, opened } = renderScreen(subagentLog(), {
      session: { parent_session_id: PARENT_ID, title: 'child chat' },
    })
    await waitForScreen(view, 'Agents')
    await waitFor(() => frameOf(view).includes('‹ back to root chat'))
    pressKey(view, 'enter')
    await waitFor(() => opened.length === 1)
    expect(opened[0]?.id).toBe(PARENT_ID)
  })

  it('says where a task comes from when the chat has none', async () => {
    const { view } = renderScreen([makeUserMessage('hello', { seq: 1 })])
    await waitForScreen(view, 'Agents')
    await waitFor(() => frameOf(view).includes('A model starts one by calling'))
  })
})
