import type { Client } from '@openharness/client'
import { createFakeClient, type FakeClient } from '@openharness/client/testing'
import type { StoredEvent } from '@openharness/protocol'
import {
  makeAgentToolResult,
  makeAgentToolUse,
  makeStatusRunning,
} from '@openharness/protocol/fixtures'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../app'
import type { ChatOptions } from '../args'
import { shortSessionId } from '../components/status-line'
import {
  frameOf,
  pressKey,
  waitForFrame,
  waitForScreen,
  type TestInstance,
} from '../test-support/input'
import { forgetTodoFoldChoices } from './todo-fold'

/**
 * The live area under the transcript (epic #303, X5; #308).
 *
 * Two things live there and nowhere else, because Ink's `<Static>` scrollback is write-once: the
 * **task list**, which must be on screen whether a turn is running, the chat is idle or the chat
 * was just resumed (`oh -s`), and a **tool call that is still running**, whose status and result
 * line change as the turn goes on. This file drives them through the whole app — a real
 * `ChatScreen` over a client whose session log already holds them, which is exactly what a
 * resume replays.
 */

const CONTEXT = { server: 'http://localhost:3000' }

/** The flags a test does not care about. */
function chatOptions(overrides: Partial<ChatOptions> = {}): ChatOptions {
  return { debug: false, continue: false, ...overrides }
}

/**
 * A client whose session log already holds `events`, in front of whatever the fake appends.
 *
 * A resume is a replay of stored events (`events.iterate`), and the fake's brain can only make
 * the calls it can make — `ask_user` among them — so a test that needs a `todo_write` call or a
 * settled `web_fetch` in the log states it here rather than inventing a second fake. The events
 * are `@openharness/protocol`'s own builders, so what is replayed is what a server stores.
 */
function resuming(fake: FakeClient, events: readonly StoredEvent[]): Client {
  const { sessions } = fake
  return {
    ...fake,
    sessions: {
      ...sessions,
      events: {
        ...sessions.events,
        async *iterate(sessionId, params, options) {
          for (const event of events) yield event
          yield* sessions.events.iterate(sessionId, params, options)
        },
      },
    },
  }
}

/**
 * A `todo_write` pair, as the brain stores one: the newest successful call is the list.
 *
 * `seq` is where the pair sits in the log, so a test can put it after another turn's events —
 * the transcript drops anything at or below the last `seq` it has seen, so two logs stitched
 * together have to have disjoint positions.
 */
function todoLog(count: number, seq = 4): StoredEvent[] {
  const call = makeAgentToolUse(
    'todo_write',
    {
      todos: Array.from({ length: count }, (_, index) => ({
        content: `step ${index + 1}`,
        status: index === 0 ? 'done' : index === 1 ? 'in_progress' : 'pending',
      })),
    },
    { seq },
  )
  return [call, makeAgentToolResult(call, `Recorded ${count} tasks.`, { seq: seq + 1 })]
}

/** A settled `web_fetch` and a running `web_search`, with a turn open around them. */
function toolLog(): StoredEvent[] {
  const fetched = makeAgentToolUse('web_fetch', { url: 'https://example.com' }, { seq: 3 })
  const search = makeAgentToolUse('web_search', { query: 'openharness architecture' }, { seq: 5 })
  return [
    makeStatusRunning({ seq: 2 }),
    fetched,
    makeAgentToolResult(fetched, 'The page says hello.', { seq: 4 }),
    search,
  ]
}

type TestApp = TestInstance & { exits: unknown[] }

/** Open `oh` on the client's session — the resume path, with the log's history replayed. */
function renderApp(client: Client, sessionId: string): TestApp {
  const exits: unknown[] = []
  const instance = render(
    <App
      client={client}
      options={chatOptions({ session: sessionId })}
      context={CONTEXT}
      onExit={(payload) => {
        exits.push(payload)
      }}
    />,
  )
  return { ...instance, exits }
}

/** Wait for the chat screen, by the status line that proves it is up. */
async function waitForChat(app: TestApp, sessionId: string): Promise<void> {
  await waitForFrame(app, shortSessionId(sessionId))
  await waitForScreen(app, / · (idle|running)$/mu)
}

beforeEach(() => {
  forgetTodoFoldChoices()
})

afterEach(() => {
  cleanup()
})

describe('the pinned task list (#308)', () => {
  it('draws the list a resumed chat replays, while idle', async () => {
    const fake = createFakeClient()
    const app = renderApp(resuming(fake, todoLog(3)), fake.session.id)
    await waitForChat(app, fake.session.id)

    await waitForFrame(app, 'Tasks · 1 of 3 done')
    const frame = frameOf(app)
    expect(frame).toContain('☑ step 1')
    expect(frame).toContain('◐ step 2')
    expect(frame).toContain('☐ step 3')
    // Idle: the turn the log holds is over, and the list is still on screen.
    expect(frame).toContain('idle')
  })

  it('sits above the input section rather than in the scrollback', async () => {
    const fake = createFakeClient()
    const app = renderApp(resuming(fake, todoLog(3)), fake.session.id)
    await waitForChat(app, fake.session.id)
    await waitForFrame(app, 'Tasks · 1 of 3 done')

    const rows = frameOf(app).split('\n')
    const panel = rows.findIndex((row) => row.includes('Tasks ·'))
    const rule = rows.findIndex((row) => row.includes('─'))
    const prompt = rows.findIndex((row) => row.includes('│'))
    expect(panel).toBeGreaterThanOrEqual(0)
    expect(panel).toBeLessThan(rule)
    // The prompt is under the rule, and the rule under the list: "just above the prompt".
    if (prompt !== -1) expect(rule).toBeLessThan(prompt)
  })

  it('stays on screen while a turn runs', async () => {
    const fake = createFakeClient()
    const app = renderApp(resuming(fake, [...toolLog(), ...todoLog(3, 10)]), fake.session.id)
    await waitForChat(app, fake.session.id)

    await waitForFrame(app, 'running')
    expect(frameOf(app)).toContain('Tasks · 1 of 3 done')
  })

  it('folds and unfolds on Ctrl+T, and keeps the choice for the chat', async () => {
    const fake = createFakeClient()
    const app = renderApp(resuming(fake, todoLog(3)), fake.session.id)
    await waitForChat(app, fake.session.id)
    await waitForFrame(app, '☐ step 3')

    pressKey(app, 'ctrlT')
    await waitForFrame(app, 'Tasks · 1 of 3 done · ◐ step 2')
    expect(frameOf(app)).not.toContain('☐ step 3')

    pressKey(app, 'ctrlT')
    await waitForFrame(app, '☐ step 3')
  })

  it('starts folded when the list is longer than the threshold', async () => {
    const fake = createFakeClient()
    const app = renderApp(resuming(fake, todoLog(6)), fake.session.id)
    await waitForChat(app, fake.session.id)

    await waitForFrame(app, 'Tasks · 1 of 6 done · ◐ step 2')
    expect(frameOf(app)).not.toContain('☐ step 6')
  })

  it('windows a long unfolded list around the item in progress, counting the rest', async () => {
    const fake = createFakeClient()
    const app = renderApp(resuming(fake, todoLog(12)), fake.session.id)
    await waitForChat(app, fake.session.id)
    await waitForFrame(app, 'Tasks · 1 of 12 done')

    pressKey(app, 'ctrlT')
    await waitForFrame(app, '◐ step 2')
    const frame = frameOf(app)
    expect(frame).toContain('+4 more')
    // The window is bounded, so the prompt stays on screen: the last item is counted, not drawn.
    expect(frame).not.toContain('☐ step 12')
  })
})

describe('tool calls in the live area (#308)', () => {
  it('keeps a settled call and its result line in the committed output', async () => {
    const fake = createFakeClient()
    const app = renderApp(resuming(fake, toolLog()), fake.session.id)
    await waitForChat(app, fake.session.id)

    await waitForFrame(app, '⎿ fetched 20 B')
    const frame = frameOf(app)
    // The call's own line, then what it came to, on one indented line under it.
    expect(frame).toContain('● web_fetch https://example.com · done')
    expect(frame).toContain('⎿ fetched 20 B')
  })

  it('opens the full input of a live call on Ctrl+O, and closes it again', async () => {
    const fake = createFakeClient()
    const app = renderApp(resuming(fake, toolLog()), fake.session.id)
    await waitForChat(app, fake.session.id)
    await waitForFrame(app, 'web_search openharness architecture · running')

    expect(frameOf(app)).not.toContain('"query"')
    pressKey(app, 'ctrlO')
    await waitForFrame(app, '"query": "openharness architecture"')
    pressKey(app, 'ctrlO')
    await waitForFrame(app, 'running')
    expect(frameOf(app)).not.toContain('"query"')
  })
})
