import type { ToolRegistry } from '@openharness/hands'
import {
  AGENT_MESSAGE_TOOL_NAME,
  AGENT_STOP_TOOL_NAME,
  AGENT_TOOL_NAME,
  API_VERSION_PREFIX,
  EVENT_TYPES,
  MESSAGE_PARENT_TOOL_NAME,
  TASK_WAIT_TOOL_NAME,
  type AgentToolResultEvent,
  type EventId,
  type Session,
  type SessionId,
  type SessionTaskNotificationEvent,
  type Skill,
  type StoredEvent,
  type TaskId,
} from '@openharness/protocol'
import {
  MESSAGE_PARENT_MARKER,
  MOCK_AGENT_MARKER,
  MOCK_AGENT_MESSAGE_MARKER,
  MOCK_AGENT_STOP_MARKER,
  MOCK_HOLD_MARKER,
  MOCK_TERMINAL_MARKER,
  createMockModelFactory,
} from './mock-model'
import { describe, expect, it } from 'vitest'

import { createTurnRegistry } from './tools'
import { createTestApp, postJson, readHistory, waitFor, waitForIdle } from './test-support'
import type { TestContext, TestOptions } from './test-support'

/**
 * Subagent tools over the real server (epic #340, S5/S6/S7; issue #344).
 *
 * The whole loop, end to end and in process: a chat starts a helper with a prompt, the child is
 * a real session that runs its own turn (through the scheduler, the brain and the store), its
 * result reaches the parent as a notification, and the parent's next turn folds it in. The
 * parent's other tools — steering a running child, stopping it, continuing one that has already
 * reported — are driven the same way, and the child's own `message_parent` is a note the parent
 * sees.
 *
 * Everything is the **mock model's** (`OPENHARNESS_TEST_MODEL=mock`): the markers name the call,
 * so what a test asserts is the log the real server wrote, not a stub's answer.
 */

const SESSIONS = `${API_VERSION_PREFIX}/sessions`
const MODES = `${API_VERSION_PREFIX}/me/modes`
const CREDENTIALS = `${API_VERSION_PREFIX}/provider-credentials`

/** A credential for `provider`, saved through the real route (the default validator accepts). */
async function putKey(context: TestContext, provider: string): Promise<void> {
  const response = await context.request(`${CREDENTIALS}/${provider}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'api_key', api_key: `sk-test-${provider}-0123456789` }),
  })
  expect(response.status).toBe(200)
}

/** A skill snapshot stored through the app's own store, so a request's resolver reads it. */
async function seedSkill(context: TestContext, name: string): Promise<Skill> {
  const me = await context.currentUser()
  return context.skills.create({
    ownerId: me.id,
    name,
    description: `The ${name} skill.`,
    frontmatter: {},
    source: {
      url: 'https://github.com/example/skills',
      ref: 'main',
      path: name,
      commit_sha: '9f2c1b4e5a6d7c8b9a0f1e2d3c4b5a69788796a5',
    },
    enabled: true,
    files: [
      {
        path: 'SKILL.md',
        content: `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nDo ${name}.`,
      },
    ],
  })
}

/** `/name` as a client sends it: the text the user typed and the skill it names. */
function invocation(name: string): {
  type: string
  content: { type: string; text: string }[]
  skill: { name: string }
} {
  return {
    type: EVENT_TYPES.userMessage,
    content: [{ type: 'text', text: `/${name}` }],
    skill: { name },
  }
}

/** The registry the harness runs with — the same one a mock deployment registers. */
function registry(): ToolRegistry {
  return createTurnRegistry({ kind: 'mock' })
}

/**
 * An app with the subagent half wired and the **mock** model driving the turns.
 *
 * Both halves matter: `subagents: true` is what puts the five tools into a chat's offer, and the
 * mock model is what turns a marker in a message into a call of one of them. The harness's
 * default scripted model would ignore the markers, so a test that wants the end-to-end path
 * asks for this.
 */
function test(overrides: TestOptions = {}): TestContext {
  return createTestApp({
    tools: registry(),
    subagents: true,
    model: createMockModelFactory(),
    ...overrides,
  })
}

/** A top-level chat created through the route. */
async function createSession(context: TestContext): Promise<Session> {
  const response = await postJson(context, SESSIONS, { model: { id: 'openai/gpt-5-mini' } })
  expect(response.status).toBe(201)
  return (await response.json()) as Session
}

/** Post one event to a session and assert the append was accepted. */
async function send(context: TestContext, sessionId: SessionId, text: string): Promise<void> {
  const response = await postJson(context, `${SESSIONS}/${sessionId}/events`, {
    events: [{ type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }] }],
  })
  expect(response.status).toBe(200)
}

/** Every stored event of a session. */
async function log(context: TestContext, sessionId: SessionId): Promise<StoredEvent[]> {
  return await readHistory(context.store, sessionId)
}

/** The stored events of one type, in order. */
function of<T extends StoredEvent['type']>(
  events: readonly StoredEvent[],
  type: T,
): Extract<StoredEvent, { type: T }>[] {
  return events.filter((event): event is Extract<StoredEvent, { type: T }> => event.type === type)
}

/** The text a result carried, joined. */
function resultText(result: AgentToolResultEvent | undefined): string {
  return result === undefined ? '' : result.content.map((block) => block.text).join('')
}

/** The task a parent's log holds, or a failure saying it started none. */
function startedTask(events: readonly StoredEvent[]): TaskId {
  const start = of(events, EVENT_TYPES.sessionTaskStarted)[0]
  if (start === undefined) {
    throw new Error('the turn started no subagent task')
  }
  return start.task_id
}

/** The child the parent's log names, or a failure saying there is none. */
function childId(events: readonly StoredEvent[]): SessionId {
  const child = of(events, EVENT_TYPES.sessionTaskStarted)[0]?.child_session_id
  if (child === undefined) {
    throw new Error('the turn started no child session')
  }
  return child
}

/** The notification a parent's log holds for one task and kind. */
function notificationOf(
  events: readonly StoredEvent[],
  taskId: TaskId,
  kind: SessionTaskNotificationEvent['kind'],
): SessionTaskNotificationEvent | undefined {
  return of(events, EVENT_TYPES.sessionTaskNotification).find(
    (event) => event.task_id === taskId && event.kind === kind,
  )
}

/**
 * Run a message to completion on a session, and read its log back.
 *
 * The two waits before the send are what make a marker deterministic: a task's news is a
 * **user**-role message and the mock model answers the newest one, so a notification that
 * arrives between two turns — the child's result, which wakes the parent and starts a turn of
 * its own — would be what the model answers instead of the test's prompt. Waiting for the chat
 * to be idle with nothing queued puts the test's message last.
 */
async function say(
  context: TestContext,
  sessionId: SessionId,
  text: string,
): Promise<StoredEvent[]> {
  await waitForIdle(context.store, sessionId)
  await waitFor(
    async () => (await context.store.getPendingTaskNotifications(sessionId)).length === 0,
    { message: 'the session kept news of its own to fold in' },
  )
  await send(context, sessionId, text)
  await waitForIdle(context.store, sessionId)
  return await log(context, sessionId)
}

describe('starting a helper (S3/S4/S5; #344)', () => {
  it('starts a child, and the result reaches the parent as a notification it uses', async () => {
    const context = test()
    const session = await createSession(context)

    // The parent starts a helper: the call returns at once with a handle, and the child runs
    // its own turn — `echo` is no marker, so the child answers its prompt by echoing it.
    const parent = await say(
      context,
      session.id,
      `${MOCK_AGENT_MARKER} general-purpose | Report the tail.`,
    )
    const taskId = startedTask(parent)
    const child = childId(parent)
    expect(resultText(of(parent, EVENT_TYPES.agentToolResult)[0])).toContain(taskId)

    // The child is a real session: not a chat of the caller's list, a non-interactive child of
    // this one, running with the prompt the parent wrote as its whole context.
    const children = await context.request(`${SESSIONS}?parent_session_id=${session.id}`)
    const listed = (await children.json()) as { readonly data: readonly Session[] }
    expect(listed.data.map((entry) => entry.id)).toEqual([child])
    const childSession = await context.store.getSessionUnscoped(child)
    expect(childSession).toMatchObject({
      parent_session_id: session.id,
      parent_task_id: taskId,
      root_session_id: session.id,
      depth: 1,
      interactive: false,
    })

    // The child's own turn ends, and its last word arrives in the parent's log, queued, keyed by
    // the turn it ended: the status the child's turn start wrote, and the result it owes.
    await waitFor(
      async () => notificationOf(await log(context, session.id), taskId, 'result') !== undefined,
      { message: 'the child’s result never reached the parent' },
    )
    const withResult = await log(context, session.id)
    const notification = notificationOf(withResult, taskId, 'result')
    const childLog = await log(context, child)
    const idle = of(childLog, EVENT_TYPES.sessionStatusIdle)[0]
    // Keyed by the turn it ends — `<child_session_id>:<idle seq>` — which is what makes the
    // delivery idempotent, and carrying the child's own words.
    expect(notification?.source_key).toBe(`${child}:${idle?.seq}`)
    expect(notification?.text).toContain('Report the tail.')
    expect(of(withResult, EVENT_TYPES.sessionTaskStatus).map((event) => event.status)).toEqual([
      'running',
      'running',
      'idle',
    ])

    // And the parent uses it: the notification is a queued event, and the next request of the
    // chat claims it — told once, to the request that answers it.
    const used = await log(context, session.id)
    const notificationId = notification?.id
    expect(notificationId).toBeDefined()
    const claim = of(used, EVENT_TYPES.modelRequestStart).find((event) =>
      event.consumes?.includes(notificationId as EventId),
    )
    expect(claim).toBeDefined()
    expect(await context.store.getPendingTaskNotifications(session.id)).toEqual([])
  })

  it('gives a child on a subagent type only its allowlisted skills (B8)', async () => {
    const context = test()
    await putKey(context, 'openai')
    // The type's mode says `skills_default: 'off'` and turns exactly one skill on: the child is
    // created **on** that mode, so its every request resolves the same allowlist a chat would.
    const allowed = await seedSkill(context, 'release-notes')
    const created = await postJson(context, MODES, {
      name: 'tidy',
      model: 'openai/gpt-5-mini',
      subagent_description: 'Tidies a changelog.',
      tools: { skills_default: 'off', skills: { [allowed.id]: true } },
    })
    expect(created.status).toBe(201)

    const session = await createSession(context)
    const parent = await say(
      context,
      session.id,
      `${MOCK_AGENT_MARKER} tidy | Use only the allowed skills.`,
    )
    const child = childId(parent)
    await waitForIdle(context.store, child)

    // A skill imported **after** the mode was defined is not in force in the child: the
    // allowlist is the map, so anything added later stays off in this mode.
    await seedSkill(context, 'later-skill')
    const refused = await postJson(context, `${SESSIONS}/${child}/events`, {
      events: [invocation('later-skill')],
    })
    expect(refused.status).toBe(400)

    // The one the mode names is accepted, and the brain loads its instructions once. The
    // request that answers it is offered the skill tools because a skill is in force there.
    const accepted = await postJson(context, `${SESSIONS}/${child}/events`, {
      events: [invocation('release-notes')],
    })
    expect(accepted.status).toBe(200)
    await waitForIdle(context.store, child)
    const childLog = await log(context, child)
    const loaded = of(childLog, EVENT_TYPES.sessionSkillLoaded)
    expect(loaded.some((event) => event.name === 'release-notes')).toBe(true)
    expect(loaded.some((event) => event.name === 'later-skill')).toBe(false)
  })

  it('runs two helpers in parallel and reports both', async () => {
    const context = test()
    const session = await createSession(context)

    // Two messages start two helpers, and both children work while the parent is idle: the
    // parent does not wait for either, which is the whole of S5.
    const first = await say(
      context,
      session.id,
      `${MOCK_AGENT_MARKER} general-purpose | First job.`,
    )
    const second = await say(
      context,
      session.id,
      `${MOCK_AGENT_MARKER} general-purpose | Second job.`,
    )
    // Two starts, and the second turn's is the new one: a helper is not started twice.
    expect(of(first, EVENT_TYPES.sessionTaskStarted)).toHaveLength(1)
    expect(of(second, EVENT_TYPES.sessionTaskStarted)).toHaveLength(2)
    const tasks = of(second, EVENT_TYPES.sessionTaskStarted).map((event) => event.task_id)
    const children = new Set(
      of(second, EVENT_TYPES.sessionTaskStarted).map((event) => event.child_session_id),
    )
    expect(children.size).toBe(2)

    await waitFor(
      async () => {
        const events = await log(context, session.id)
        return tasks.every((task) => notificationOf(events, task, 'result') !== undefined)
      },
      { message: 'both helpers never reported' },
    )

    const events = await log(context, session.id)
    for (const task of tasks) {
      expect(notificationOf(events, task, 'result')).toBeDefined()
      expect(
        of(events, EVENT_TYPES.sessionTaskStatus)
          .filter((event) => event.task_id === task)
          .at(-1)?.status,
      ).toBe('idle')
    }
    expect(children.size).toBe(2)
  })

  it('answers an unknown type with the resolver’s sentence, and starts nothing', async () => {
    const context = test()
    const session = await createSession(context)

    const events = await say(context, session.id, `${MOCK_AGENT_MARKER} nope | Do something.`)
    const result = of(events, EVENT_TYPES.agentToolResult)[0]
    expect(result?.is_error).toBe(true)
    // The sentence names the types that are available, which is what the model chooses from.
    expect(resultText(result)).toContain('general-purpose')
    expect(of(events, EVENT_TYPES.sessionTaskStarted)).toEqual([])
  })
})

describe('the title a child is created with (epic #340)', () => {
  it('is the description the parent model gave, through both session reads', async () => {
    const context = test()
    const session = await createSession(context)
    const parent = await say(
      context,
      session.id,
      `${MOCK_AGENT_MARKER} general-purpose | Check the rewind path.`,
    )
    const child = childId(parent)
    expect(of(parent, EVENT_TYPES.sessionTaskStarted)[0]?.description).toBe(
      'Check the rewind path.',
    )

    // The list a client nests the helpers under their parent with.
    const listed = await context.request(`${SESSIONS}?parent_session_id=${session.id}`)
    const page = (await listed.json()) as { readonly data: readonly Session[] }
    expect(page.data.map((entry) => entry.title)).toEqual(['Check the rewind path.'])

    // And the one session read a child's own chat opens with.
    const read = await context.request(`${SESSIONS}/${child}`)
    expect(read.status).toBe(200)
    expect(((await read.json()) as Session).title).toBe('Check the rewind path.')
  })

  it('is not replaced by a message a person later sends the child', async () => {
    const context = test()
    const session = await createSession(context)
    const parent = await say(context, session.id, `${MOCK_AGENT_MARKER} general-purpose | Keep it.`)
    const child = childId(parent)

    // The route's auto-titling names a session from its first message and only ever fills a
    // hole — a child created with a title keeps it, which is what makes the title a name rather
    // than a race between the parent's call and the next message.
    await send(context, child, 'Actually, also do this.')
    await waitForIdle(context.store, child)

    const read = await context.request(`${SESSIONS}/${child}`)
    expect(((await read.json()) as Session).title).toBe('Keep it.')
  })
})

describe('steering, stopping and continuing (S5; #344)', () => {
  it('steers a child with a message, and it answers with the context it already had', async () => {
    const context = test()
    const session = await createSession(context)
    const parent = await say(
      context,
      session.id,
      `${MOCK_AGENT_MARKER} general-purpose | First job.`,
    )
    const taskId = startedTask(parent)
    const child = childId(parent)
    await waitFor(
      async () => notificationOf(await log(context, session.id), taskId, 'result') !== undefined,
    )

    // The child is idle and has already reported; a message starts another turn with its context
    // intact — the prompt it was started with is still above the message in its log.
    const steered = await say(
      context,
      session.id,
      `${MOCK_AGENT_MESSAGE_MARKER} ${taskId} | now do the other half`,
    )
    expect(resultText(of(steered, EVENT_TYPES.agentToolResult).at(-1))).toContain(taskId)
    const childLog = await log(context, child)
    expect(of(childLog, EVENT_TYPES.userMessage).map((event) => event.content[0]?.text)).toEqual([
      'First job.',
      'now do the other half',
    ])

    await waitFor(
      async () => {
        const events = await log(context, session.id)
        return (
          of(events, EVENT_TYPES.sessionTaskNotification).filter(
            (event) => event.task_id === taskId && event.kind === 'result',
          ).length === 2
        )
      },
      { message: 'the continued child never reported again' },
    )
  })

  it('stops a child and marks the task stopped', async () => {
    const context = test()
    const session = await createSession(context)
    const parent = await say(
      context,
      session.id,
      `${MOCK_AGENT_MARKER} general-purpose | First job.`,
    )
    const taskId = startedTask(parent)

    const stopped = await say(context, session.id, `${MOCK_AGENT_STOP_MARKER} ${taskId}`)
    expect(resultText(of(stopped, EVENT_TYPES.agentToolResult).at(-1))).toContain(taskId)
    expect(of(stopped, EVENT_TYPES.sessionTaskStatus).at(-1)).toMatchObject({
      task_id: taskId,
      status: 'stopped',
    })
  })

  it('answers an unknown handle with an is_error the model can act on', async () => {
    const context = test()
    const session = await createSession(context)
    const unknown = 'task_01JQZ8R6X9M4V0W7Y2B3C5D6E7'
    const events = await say(context, session.id, `${MOCK_AGENT_STOP_MARKER} ${unknown}`)
    const result = of(events, EVENT_TYPES.agentToolResult)[0]
    expect(result?.is_error).toBe(true)
    expect(resultText(result)).toContain(unknown)
  })
})

describe('a child reaching its parent (S4/S5; #344)', () => {
  it('writes a note the parent is told about, and a failing turn as failed', async () => {
    const context = test()
    const session = await createSession(context)
    const parent = await say(
      context,
      session.id,
      `${MOCK_AGENT_MARKER} general-purpose | First job.`,
    )
    const taskId = startedTask(parent)
    const child = childId(parent)
    await waitFor(
      async () => notificationOf(await log(context, session.id), taskId, 'result') !== undefined,
    )

    // The child sends a note: a `message` notification, which does not end its turn.
    await send(context, child, `${MESSAGE_PARENT_MARKER} half way there`)
    await waitFor(
      async () => notificationOf(await log(context, session.id), taskId, 'message') !== undefined,
    )
    expect(notificationOf(await log(context, session.id), taskId, 'message')?.text).toBe(
      'half way there',
    )

    // A turn that fails: the news is `failed`, carrying what the provider said, and the card
    // moves to failed rather than staying "running" for ever.
    await send(context, child, `${MOCK_TERMINAL_MARKER} now break`)
    await waitForIdle(context.store, child)
    await waitFor(
      async () => notificationOf(await log(context, session.id), taskId, 'failed') !== undefined,
    )
    const events = await log(context, session.id)
    expect(notificationOf(events, taskId, 'failed')?.text).toContain('fail')
    expect(
      of(events, EVENT_TYPES.sessionTaskStatus)
        .filter((event) => event.task_id === taskId)
        .at(-1)?.status,
    ).toBe('failed')
  })
})

describe('the limits (S6; #344)', () => {
  it('refuses a start past the live-task cap, with a sentence the model can act on', async () => {
    const context = test({ maxLiveTasks: 1 })
    const session = await createSession(context)
    const first = await say(
      context,
      session.id,
      `${MOCK_AGENT_MARKER} general-purpose | First job.`,
    )
    const taskId = startedTask(first)
    // The first child has reported, so it is idle and not live — the cap is about work in
    // flight, so a second start is allowed.
    await waitFor(
      async () => notificationOf(await log(context, session.id), taskId, 'result') !== undefined,
    )

    // Hold the child open with something it will not finish: `__hold__` streams for ever, and
    // its turn stays running until the test aborts it — which is what makes it a live
    // descendant for the second start.
    const child = childId(first)
    await send(context, child, `${MOCK_HOLD_MARKER} hold`)
    await waitFor(async () => (await context.store.getTurnState(child)).state === 'running', {
      message: 'the held child never started its turn',
    })

    const second = await say(
      context,
      session.id,
      `${MOCK_AGENT_MARKER} general-purpose | Second job.`,
    )
    const result = of(second, EVENT_TYPES.agentToolResult).at(-1)
    expect(result?.is_error).toBe(true)
    expect(resultText(result)).toContain('the limit')
    expect(of(second, EVENT_TYPES.sessionTaskStarted)).toHaveLength(1)
  })
})

describe('the tools a chat is offered (S5/S6; #344)', () => {
  it('lists the five for a settings screen, and offers them to a chat', async () => {
    const context = test()
    const session = await createSession(context)

    const listed = await context.request(`${API_VERSION_PREFIX}/me/tools`)
    const body = (await listed.json()) as {
      readonly data: readonly { readonly name: string; readonly default_policy: string }[]
    }
    for (const name of [
      AGENT_TOOL_NAME,
      AGENT_MESSAGE_TOOL_NAME,
      AGENT_STOP_TOOL_NAME,
      'agent_wait',
    ]) {
      expect(body.data.find((entry) => entry.name === name)?.default_policy).toBe('allow')
    }

    // And a request really carries them: the span records what the turn offered.
    const events = await say(context, session.id, 'hello')
    const offered = of(events, EVENT_TYPES.modelRequestStart)[0]?.tools?.map((tool) => tool.name)
    expect(offered).toEqual(expect.arrayContaining([AGENT_TOOL_NAME, TASK_WAIT_TOOL_NAME]))
    // A top-level chat has nobody above it, so the child's own tool is not offered.
    expect(offered).not.toContain(MESSAGE_PARENT_TOOL_NAME)
  })
})
