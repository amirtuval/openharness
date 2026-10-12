import type { Client } from '@openharness/client'
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

import { App } from '../app'
import type { ChatOptions } from '../args'
import { shortSessionId } from '../components/status-line'
import {
  frameOf,
  pressKey,
  submit,
  waitForFrame,
  waitForScreen,
  type TestInstance,
} from '../test-support/input'

/**
 * Subagents in `oh`, through the whole app (epic #340, S9; issue #347).
 *
 * The task cards live in the transcript and `/agents` is the way into a task's own chat, so the
 * two are one feature: this file drives a **resumed** chat — the log already holds the `agent`
 * call, the task's start and its result — and checks what a reader sees and what their keys do.
 * The events are `@openharness/protocol`'s own builders, so what is replayed is what a server
 * stores.
 */

const CONTEXT = { server: 'http://localhost:3000' }
const CHILD_ID = 'sesn_child0000000000000000000' as SessionId
const PARENT_ID = 'sesn_parent000000000000000000' as SessionId
const TASK_ID = 'task_01' as TaskId

/** The flags a test does not care about. */
function chatOptions(overrides: Partial<ChatOptions> = {}): ChatOptions {
  return { debug: false, continue: false, ...overrides }
}

/**
 * A chat that started one helper and heard it finish: the call, the task, a note from the child
 * and its result.
 *
 * Positions are explicit and disjoint — the transcript drops anything at or below the last `seq`
 * it has seen — and the card's own position is the `agent` call's, which is the join the client
 * makes by description.
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
    makeSessionTaskNotification(TASK_ID, {
      seq: 7,
      kind: 'result',
      text: 'One assertion was flaky; it is fixed now.',
    }),
    makeSessionTaskStatus(TASK_ID, 'idle', { seq: 8 }),
  ]
}

/** A client whose session log already holds `events`, with a child session to open. */
function resuming(fake: FakeClient, events: readonly StoredEvent[], session: Session): Client {
  const base: Client = fake
  const child: Session = { ...makeChildSession(fake.session), id: CHILD_ID }
  return {
    ...base,
    sessions: {
      ...base.sessions,
      get: async (sessionId) => {
        if (sessionId === session.id) return session
        if (sessionId === CHILD_ID) return child
        if (sessionId === PARENT_ID) return { ...makeSession(), id: PARENT_ID, title: 'root chat' }
        return base.sessions.get(sessionId)
      },
      events: {
        ...base.sessions.events,
        async *iterate(sessionId, params, options) {
          if (sessionId === session.id) {
            for (const event of events) yield event
          }
          yield* base.sessions.events.iterate(sessionId, params, options)
        },
      },
    },
  }
}

type TestApp = TestInstance & { exits: unknown[]; fake: FakeClient }

/**
 * Open `oh` on a chat whose history holds `events`.
 *
 * `overrides` is what the session resource says about itself — a child chat is one with a
 * parent — and the client is handed that same session so the read and the replay agree.
 */
function renderApp(events: readonly StoredEvent[], overrides: Partial<Session> = {}): TestApp {
  const fake = createFakeClient()
  const session: Session = { ...fake.session, ...overrides }
  const client = resuming(fake, events, session)
  const exits: unknown[] = []
  const instance = render(
    <App
      client={client}
      options={chatOptions({ session: session.id })}
      context={CONTEXT}
      onExit={(payload) => {
        exits.push(payload)
      }}
    />,
  )
  return { ...instance, exits, fake }
}

/** Wait for the chat screen, by the status line that proves it is up. */
async function waitForChat(app: TestApp, sessionId: string): Promise<void> {
  await waitForFrame(app, shortSessionId(sessionId))
  await waitForScreen(app, / · (idle|running)$/mu)
}

afterEach(cleanup)

describe('a task card in the transcript (#347)', () => {
  it('draws the task a resumed chat replayed, in the transcript', async () => {
    const app = renderApp(subagentLog())
    await waitForChat(app, 'sesn_')

    await waitForFrame(app, '● done · researcher · Check the flaky test')
    const frame = frameOf(app)
    // The note the child sent and the result it finished with, both folded into the card.
    expect(frame).toContain('researcher →: found it — one assertion was flaky')
    expect(frame).toContain('⎿ One assertion was flaky; it is fixed now.')
  })
})

describe('/agents (#347)', () => {
  it('opens the chat’s tasks from the prompt', async () => {
    const app = renderApp(subagentLog())
    await waitForChat(app, 'sesn_')
    await waitForFrame(app, '● done · researcher')

    submit(app, '/agents')

    await waitForScreen(app, 'Agents')
    await waitForFrame(app, '❯ ● done · researcher: Check the flaky test')
    expect(frameOf(app)).toContain('Enter open · s stop')
  })
})

describe('a task’s own chat (#347)', () => {
  it('says where it sits — the chain from the root, and the chat itself last', async () => {
    const app = renderApp(subagentLog(), {
      parent_session_id: PARENT_ID,
      title: 'child chat',
      parent_task_id: TASK_ID,
    })
    await waitForChat(app, 'sesn_')

    await waitForFrame(app, 'root chat › child chat')
  })

  it('**stops its own turn on Esc** — the one key a reader has over a helper (S1)', async () => {
    const app = renderApp([], {
      parent_session_id: PARENT_ID,
      title: 'child chat',
    })
    await waitForChat(app, 'sesn_')
    await waitForFrame(app, 'root chat › child chat')

    app.fake.respondWith('one two three four five six seven eight', { chunks: 8, delayMs: 60 })
    submit(app, 'do the work')
    await waitForFrame(app, 'running')

    pressKey(app, 'escape')
    await waitForFrame(app, 'Interrupted')
  })

  it('leaves a top-level chat’s turn alone: Esc is the prompt’s key there', async () => {
    const app = renderApp([])
    await waitForChat(app, 'sesn_')

    app.fake.respondWith('one two three four five six seven eight', { chunks: 8, delayMs: 60 })
    submit(app, 'do the work')
    await waitForFrame(app, 'running')

    pressKey(app, 'escape')
    // The turn runs to its end: nothing interrupted it.
    await waitForFrame(app, 'eight')
    expect(frameOf(app)).not.toContain('Interrupted')
  })
})
