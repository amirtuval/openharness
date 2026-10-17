import { createToolRegistry, textResult } from '@openharness/hands'
import type { ToolDefinition } from '@openharness/hands'
import {
  AGENT_MESSAGE_TOOL_NAME,
  AGENT_STOP_TOOL_NAME,
  AGENT_TOOL_NAME,
  EVENT_TYPES,
  MESSAGE_PARENT_TOOL_NAME,
  SESSION_TITLE_MAX_LENGTH,
  TASK_WAIT_TOOL_NAME,
  newTaskId,
  ulid,
} from '@openharness/protocol'
import type {
  EventId,
  Session,
  SessionId,
  SessionTaskStartedEvent,
  StoredEvent,
  TaskId,
} from '@openharness/protocol'
import type { InMemorySessionStore } from '@openharness/session'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  EMPTY_TURN_RESULT,
  RESTARTED_TURN_RESULT,
  STOPPED_TURN_RESULT,
  childTurnDelivery,
  childTaskParent,
  offeredSubagentTools,
  stopOrphanedTasks,
  type SubagentRuntime,
} from './agents'
import { logOf, message, newSession } from './testing/harness'
import { apiCallError, mockModel, readPrompt, resolveTestCredential } from './testing/mock-model'
import type { SubagentParent, SubagentTypeResolver } from './subagent'
import {
  GENERAL_PURPOSE_DESCRIPTION,
  GENERAL_PURPOSE_TYPE,
  SUBAGENT_SYSTEM_PROMPT,
  withSubagentPrompt,
} from './subagent'
import { deliverableNotifications } from './tasks'
import { runTurn } from './turn'

/**
 * Subagents as the loop runs them (epic #340, S5/S6/S7; issue #344).
 *
 * The parent side is exercised through `runTurn` against a real store and a scripted model that
 * calls the tools, so what is asserted is what the log holds: a child is a session with a
 * parent, a task and a prompt of its own; a start, a message and a stop are events; and what a
 * child's turn owes its parent is written once, keyed by the turn.
 *
 * The resolver is a stub — whether a mode can be used is the server's question (#342) — and the
 * runtime is the three things a deployment answers: the types, and S6's two limits.
 */

/** The type the stub resolver knows beside `general-purpose`. */
const RESEARCHER = { name: 'researcher', description: 'Reads things and reports.' }

/** A resolver that answers the two types, and refuses everything else with a sentence. */
function types(overrides: Partial<SubagentTypeResolver> = {}): SubagentTypeResolver {
  return {
    list: () =>
      Promise.resolve([
        { name: GENERAL_PURPOSE_TYPE, description: GENERAL_PURPOSE_DESCRIPTION },
        RESEARCHER,
      ]),
    resolve: (_ownerId, name, parent) =>
      Promise.resolve(
        name === RESEARCHER.name
          ? {
              ok: true,
              type: {
                ...RESEARCHER,
                model: 'anthropic/claude-haiku-4-5',
                reasoningEffort: 'low',
                systemPromptAddition: 'Be terse.',
                modeId: null,
                toolOverride: null,
                tools: [],
                mcpServers: [],
              },
            }
          : name === GENERAL_PURPOSE_TYPE
            ? {
                ok: true,
                type: {
                  name: GENERAL_PURPOSE_TYPE,
                  description: GENERAL_PURPOSE_DESCRIPTION,
                  model: parent.model,
                  reasoningEffort: parent.reasoningEffort,
                  systemPromptAddition: null,
                  modeId: parent.modeId,
                  toolOverride: parent.toolOverride,
                  tools: [],
                  mcpServers: [],
                },
              }
            : { ok: false, message: `There is no subagent type named \`${name}\`.` },
      ),
    ...overrides,
  }
}

/** A deployment's answer, with the signals it sent recorded. */
function runtime(overrides: Partial<SubagentRuntime> = {}): {
  readonly runtime: SubagentRuntime
  readonly signal: ReturnType<typeof vi.fn>
} {
  const signal = vi.fn()
  return {
    runtime: { types: types(), maxDepth: 3, maxLiveTasks: 10, signal, ...overrides },
    signal,
  }
}

/** The `agent` call a scripted turn makes. */
const START = {
  name: AGENT_TOOL_NAME,
  input: { type: RESEARCHER.name, description: 'Check the rewind path', prompt: 'Read it.' },
}

/** Every stored event of one type, in order, narrowed to that kind. */
function of<T extends StoredEvent['type']>(
  log: readonly StoredEvent[],
  type: T,
): Extract<StoredEvent, { type: T }>[] {
  return log.filter((event): event is Extract<StoredEvent, { type: T }> => event.type === type)
}

/** The text of a tool result, which carries content blocks the way a message does. */
function resultText(
  event: { readonly content: readonly { readonly text: string }[] } | undefined,
): string {
  return event === undefined ? '' : event.content.map((block) => block.text).join('')
}

/** The task starts a log holds, by id. */
function starts(log: readonly StoredEvent[]): Map<TaskId, SessionTaskStartedEvent> {
  return new Map(of(log, EVENT_TYPES.sessionTaskStarted).map((event) => [event.task_id, event]))
}

/** The child session a task started, read back from the store. */
async function childOf(
  store: InMemorySessionStore,
  log: readonly StoredEvent[],
  sessionId: SessionId,
): Promise<Session> {
  const start = of(log, EVENT_TYPES.sessionTaskStarted)[0]
  const child = await store.getSessionUnscoped(start?.child_session_id ?? sessionId)
  if (child === null) {
    throw new Error('the call started no child session')
  }
  return child
}

/** Say something to a session, as a client would — a turn with nothing queued is a no-op. */
async function say(store: InMemorySessionStore, sessionId: SessionId, text: string): Promise<void> {
  await store.appendEvents(sessionId, [message(text)])
}

/** A child session of `parent`, with a prompt of its own and a task the parent's log names. */
async function childOfParent(
  store: InMemorySessionStore,
  parent: SessionId,
  prompt = 'do the thing',
): Promise<{ child: Session; taskId: TaskId }> {
  const taskId = newTaskId()
  const child = await store.createSession(null, {
    ownerId: 'user_brain_tests',
    interactive: false,
    parentSessionId: parent,
    parentTaskId: taskId,
    model: { id: 'anthropic/claude-haiku-4-5' },
    system: 'Be a helper.',
    initial_events: [{ type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: prompt }] }],
  })
  await store.appendEvents(parent, [
    {
      type: EVENT_TYPES.sessionTaskStarted,
      task_id: taskId,
      kind: 'subagent',
      child_session_id: child.id,
      description: 'A helper',
    },
    { type: EVENT_TYPES.sessionTaskStatus, task_id: taskId, status: 'running' },
  ])
  return { child, taskId }
}

/** A turn on `sessionId`, with a subagent runtime wired and a registry that holds the five. */
async function turn(
  store: InMemorySessionStore,
  sessionId: SessionId,
  scripts: Parameters<typeof mockModel>,
  subagents: SubagentRuntime,
  tools: readonly ToolDefinition[] = [],
) {
  const model = mockModel(...scripts)
  const outcome = await runTurn(sessionId, {
    store,
    model: model.factory,
    resolveCredential: resolveTestCredential,
    subagents,
    tools: tools.length === 0 ? undefined : createToolRegistry(tools),
  })
  return { outcome, model }
}

describe('the tools a session is offered (S5/S6; #344)', () => {
  it('offers the parent side under the depth cap, and message_parent only to a child', () => {
    const { runtime: deployment } = runtime()
    const parent = 'sesn_parent' as SessionId
    const top = { depth: 0, parent_session_id: null }
    const nested = { depth: 2, parent_session_id: parent }
    const deepest = { depth: 3, parent_session_id: parent }

    expect(offeredSubagentTools(top, deployment)).toEqual([
      AGENT_TOOL_NAME,
      AGENT_MESSAGE_TOOL_NAME,
      TASK_WAIT_TOOL_NAME,
      AGENT_STOP_TOOL_NAME,
    ])
    // A child at the cap is offered the one tool that reaches up and nothing that starts work:
    // nesting is allowed and bounded, and the bound is what a tree stops at.
    expect(offeredSubagentTools(nested, deployment)).toContain(AGENT_TOOL_NAME)
    expect(offeredSubagentTools(deepest, deployment)).toEqual([MESSAGE_PARENT_TOOL_NAME])
  })

  it('offers them through a turn, with the types listed in the agent description', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const { model } = await turn(store, sessionId, [{ text: ['Done.'] }], deployment)

    const offered = (model.calls[0]?.tools ?? []).map((tool) => tool.name)
    expect(offered).toEqual(
      expect.arrayContaining([
        AGENT_TOOL_NAME,
        AGENT_MESSAGE_TOOL_NAME,
        TASK_WAIT_TOOL_NAME,
        AGENT_STOP_TOOL_NAME,
      ]),
    )
    // A top-level chat has nobody above it, so the child's one tool is not offered.
    expect(offered).not.toContain(MESSAGE_PARENT_TOOL_NAME)
    // The list is part of the `agent` tool's own description, which is what the model chooses
    // from — and it is the resolver's answer, asked for this owner.
    const agent = (model.calls[0]?.tools ?? []).find((tool) => tool.name === AGENT_TOOL_NAME)
    expect(JSON.stringify(agent)).toContain(RESEARCHER.description)
    expect(JSON.stringify(agent)).toContain(GENERAL_PURPOSE_TYPE)
  })

  it('offers the five to nobody when no runtime is wired (#365)', async () => {
    // A deployment with no `SubagentRuntime` has no subagents: the five are taken out of the
    // offer even though the process registry carries them (a settings screen lists them, and a
    // mode can override one). Offering them would hand a chat four calls whose handlers can only
    // answer `HARNESS_ANSWERED` — and a live `agent_wait`, which parks the turn for its whole
    // deadline with no task in existence to resolve it.
    const { store, sessionId } = await newSession([message('hi')])
    const wait: ToolDefinition = {
      name: TASK_WAIT_TOOL_NAME,
      description: 'Wait.',
      inputSchema: z.object({}),
      permission: 'allow',
      run: () => textResult('answered by the log'),
    }
    const keep: ToolDefinition = {
      name: 'web_fetch',
      description: 'Fetch.',
      inputSchema: z.object({}),
      permission: 'allow',
      run: () => textResult('fetched'),
    }
    const model = mockModel({ text: ['Done.'] })
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([wait, keep]),
    })
    const offered = (model.calls[0]?.tools ?? []).map((tool) => tool.name)
    // The host's own tools are untouched — only the five go.
    expect(offered).toContain('web_fetch')
    expect(offered).not.toContain(TASK_WAIT_TOOL_NAME)
  })
})

describe('starting a helper (S3/S4/S5; #344)', () => {
  it('runs an `agent` call a stored `ask` policy would pause on (#363)', async () => {
    // No client renders a subagent tool call — the parent's transcript draws a task **card**, and
    // a child's transcript is the child's own — so an `ask` on one could never be answered. The
    // loop reads a stored one as `allow`, exactly as #335 reads one on a provider-native search:
    // the call runs, and the log records the permission it really ran under.
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const model = mockModel({ toolCalls: [START] }, { text: ['Started it.'] })
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      subagents: deployment,
      toolSettings: () => ({ [AGENT_TOOL_NAME]: { enabled: true, permission: 'ask' } }),
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.agentToolUse)[0]).toMatchObject({
      name: AGENT_TOOL_NAME,
      evaluated_permission: 'allow',
    })
    expect(starts(log).size).toBe(1)
  })

  it('creates a child session and answers its handle at once', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    const { outcome, model } = await turn(
      store,
      sessionId,
      [{ toolCalls: [START] }, { text: ['Started it.'] }],
      deployment,
    )
    expect(outcome).toEqual({ outcome: 'idle' })

    const log = await logOf(store, sessionId)
    const started = of(log, EVENT_TYPES.sessionTaskStarted)[0]
    expect(started).toMatchObject({
      kind: 'subagent',
      task_type: RESEARCHER.name,
      description: 'Check the rewind path',
    })
    // The start names the call that caused it (#345): the `agent.tool_use` event's own id, which
    // is the call's id — the exact join a client draws the card at.
    const call = of(log, EVENT_TYPES.agentToolUse)[0]
    expect(call).toBeDefined()
    expect(started?.tool_use_id).toBe(call?.id)
    expect(of(log, EVENT_TYPES.sessionTaskStatus)[0]?.status).toBe('running')

    // A child is a real session: owned by the parent's owner, parented, one level deeper, not a
    // chat somebody is typing into, and running what its type resolved to.
    const child = await childOf(store, log, sessionId)
    expect(child).toMatchObject({
      owner_id: child.owner_id,
      parent_session_id: sessionId,
      parent_task_id: started?.task_id,
      root_session_id: sessionId,
      depth: 1,
      interactive: false,
      model: { id: 'anthropic/claude-haiku-4-5' },
    })
    // No history is inherited: the prompt is the whole of what the child has (S3).
    const childLog = await logOf(store, child.id)
    expect(childLog.map((event) => event.type)).toEqual([EVENT_TYPES.userMessage])
    expect(childLog[0]).toMatchObject({
      content: [{ type: 'text', text: 'Read it.' }],
      processed_at: null,
    })

    // The handle is the call's result, and the child is woken.
    const result = of(log, EVENT_TYPES.agentToolResult)[0]
    expect(resultText(result)).toContain(started?.task_id ?? '')
    expect(resultText(result)).toContain(RESEARCHER.name)
    expect(result?.is_error).not.toBe(true)
    expect(signal).toHaveBeenCalledWith(child.id, 'work')
    // The description the model read is the resolver's answer, and the tool list says the types.
    expect(JSON.stringify(model.calls[0]?.tools ?? [])).toContain(RESEARCHER.description)
  })

  it('answers an unknown type with the resolver’s own sentence, and starts nothing', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    await turn(
      store,
      sessionId,
      [
        { toolCalls: [{ name: AGENT_TOOL_NAME, input: { ...START.input, type: 'nope' } }] },
        { text: ['I will do it myself.'] },
      ],
      deployment,
    )

    const log = await logOf(store, sessionId)
    const result = of(log, EVENT_TYPES.agentToolResult)[0]
    expect(result?.is_error).toBe(true)
    expect(resultText(result)).toBe('There is no subagent type named `nope`.')
    expect(of(log, EVENT_TYPES.sessionTaskStarted)).toEqual([])
    expect(signal).not.toHaveBeenCalled()
  })

  it('refuses a start when the chat already has the limit of live helpers (S6)', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime({ maxLiveTasks: 1 })
    // One live descendant: a child with a queued prompt, which is work a turn has not started.
    const first = await store.createSession(null, {
      ownerId: 'user_brain_tests',
      parentSessionId: sessionId,
      parentTaskId: newTaskId(),
      model: { id: 'anthropic/claude-haiku-4-5' },
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'work' }] },
      ],
    })
    expect(await store.countLiveDescendants(sessionId)).toBe(1)

    await turn(store, sessionId, [{ toolCalls: [START] }, { text: ['Cannot.'] }], deployment)

    const log = await logOf(store, sessionId)
    const result = of(log, EVENT_TYPES.agentToolResult)[0]
    expect(result?.is_error).toBe(true)
    expect(resultText(result)).toContain('the limit')
    expect(of(log, EVENT_TYPES.sessionTaskStarted)).toEqual([])
    expect(await store.listDescendants(sessionId, { ownerId: 'user_brain_tests' })).toEqual([
      first.id,
    ])
  })

  it('titles the child with the description its parent gave it (epic #340)', async () => {
    // The bug the sidebar showed: a child was created with no title at all, so a list of chats
    // had nothing to label it with but its **model's** name. The description the parent model
    // wrote in its `agent` call is the name of the work, which is what the row should say.
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    await turn(store, sessionId, [{ toolCalls: [START] }, { text: ['Started it.'] }], deployment)

    const log = await logOf(store, sessionId)
    const child = await childOf(store, log, sessionId)
    expect(child.title).toBe('Check the rewind path')
  })

  it('normalises the description the way a first message is (epic #340)', async () => {
    // A description is free text a model wrote: it may open with blank lines, wrap, and be
    // padded with tabs. One clean line is what a title is, so the derivation the server uses
    // for a chat's first message is the one a child gets.
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    await turn(
      store,
      sessionId,
      [
        {
          toolCalls: [
            {
              name: AGENT_TOOL_NAME,
              input: {
                ...START.input,
                description: '\n  \nCheck\t\tthe   rewind path\nand say what it did  ',
              },
            },
          ],
        },
        { text: ['Started it.'] },
      ],
      deployment,
    )

    const log = await logOf(store, sessionId)
    const child = await childOf(store, log, sessionId)
    expect(child.title).toBe('Check the rewind path')
  })

  it('falls back to the type’s name when the description has no text in it (#380)', async () => {
    // `AgentToolInputSchema`'s `min(1)` counts UTF-16 units, so a blank description — a space, a
    // newline — passes the tool's schema and `session.task_started`'s alike, and
    // `deriveSessionTitle` then finds no non-empty line and answers `null` (never `''`). A child
    // stored untitled is a row a client can only label with its **model's** name, which is the
    // bug #379 fixed; the type's name is the fallback, because it is always there and it names
    // the helper better than the model does.
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    await turn(
      store,
      sessionId,
      [
        {
          toolCalls: [{ name: AGENT_TOOL_NAME, input: { ...START.input, description: ' \n\t ' } }],
        },
        { text: ['Started it.'] },
      ],
      deployment,
    )

    const child = await childOf(store, await logOf(store, sessionId), sessionId)
    expect(child.title).toBe(RESEARCHER.name)
  })

  it('takes a description at the protocol’s own bound whole (epic #340)', async () => {
    // A description can never be *longer* than a title may be: the tool's schema caps it at
    // `TASK_DESCRIPTION_MAX_LENGTH` and `session.task_started` enforces the same 500, both of
    // which are `SESSION_TITLE_MAX_LENGTH` — so the longest one a model can give is exactly a
    // title's length and is kept whole (the cut itself is asserted where the rule lives,
    // `@openharness/protocol`'s `titles.test.ts`).
    const description = 'y'.repeat(SESSION_TITLE_MAX_LENGTH)
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    await turn(
      store,
      sessionId,
      [
        { toolCalls: [{ name: AGENT_TOOL_NAME, input: { ...START.input, description } }] },
        { text: ['Started.'] },
      ],
      deployment,
    )

    const log = await logOf(store, sessionId)
    const child = await childOf(store, log, sessionId)
    expect(child.title).toBe(description)
  })
})

describe('nesting (S6; #344)', () => {
  /** A session below `parent`, as the tree stores it (the store derives root and depth). */
  async function nestedChild(
    store: InMemorySessionStore,
    parent: Session,
  ): Promise<{ child: Session; taskId: TaskId }> {
    const taskId = newTaskId()
    const child = await store.createSession(null, {
      ownerId: 'user_brain_tests',
      interactive: false,
      parentSessionId: parent.id,
      parentTaskId: taskId,
      model: { id: 'anthropic/claude-haiku-4-5' },
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'nested work' }] },
      ],
    })
    await store.appendEvents(parent.id, [
      {
        type: EVENT_TYPES.sessionTaskStarted,
        task_id: taskId,
        kind: 'subagent',
        child_session_id: child.id,
        description: 'A nested helper',
      },
    ])
    return { child, taskId }
  }

  it('offers a depth-1 child the parent-side tools through a turn, and lets it start a grandchild', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const { child } = await childOfParent(store, sessionId)
    expect(child.depth).toBe(1)

    const { model } = await turn(
      store,
      child.id,
      [{ toolCalls: [START] }, { text: ['Nested.'] }],
      deployment,
    )
    // A child below the cap is offered what starts another helper **and** the tool that reaches
    // up (S6): nesting is allowed, and bounded by `maxDepth` alone.
    expect((model.calls[0]?.tools ?? []).map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        AGENT_TOOL_NAME,
        AGENT_MESSAGE_TOOL_NAME,
        TASK_WAIT_TOOL_NAME,
        AGENT_STOP_TOOL_NAME,
        MESSAGE_PARENT_TOOL_NAME,
      ]),
    )

    // And it really starts one: the grandchild is a session below the child, one level deeper,
    // hanging off the **root** the whole tree shares.
    const grandchild = await childOf(store, await logOf(store, child.id), child.id)
    expect(grandchild).toMatchObject({
      parent_session_id: child.id,
      root_session_id: sessionId,
      depth: 2,
      interactive: false,
    })
  })

  it('counts the live cap from the ROOT, so a nesting level cannot overrun it (S6)', async () => {
    // The cap is on a tree, not on a level. This deployment allows one live helper per root
    // chat, and the depth-1 child **is** that live helper (its own turn is open) — so a count
    // taken from the child's own id would see an empty subtree and let it start a grandchild
    // over the limit the root has already reached.
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime({ maxLiveTasks: 1 })
    const { child } = await childOfParent(store, sessionId)

    const { model } = await turn(
      store,
      child.id,
      [{ toolCalls: [START] }, { text: ['Nested.'] }],
      deployment,
    )

    const result = of(await logOf(store, child.id), EVENT_TYPES.agentToolResult)[0]
    expect(resultText(result)).toContain('is the limit')
    expect(model.calls).toHaveLength(2)
    // Nothing was started: no `session.task_started` in the child's log, no session below it.
    expect(starts(await logOf(store, child.id)).size).toBe(0)
    expect(await store.listDescendants(child.id, { ownerId: 'user_brain_tests' })).toEqual([])
  })

  it('sends a depth-2 note to its immediate parent, not to the root', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    const { child } = await childOfParent(store, sessionId)
    const { child: grandchild, taskId } = await nestedChild(store, child)

    await turn(
      store,
      grandchild.id,
      [
        { toolCalls: [{ name: MESSAGE_PARENT_TOOL_NAME, input: { text: 'Halfway.' } }] },
        { text: ['Noted.'] },
      ],
      deployment,
    )

    const note = of(await logOf(store, child.id), EVENT_TYPES.sessionTaskNotification)[0]
    expect(note).toMatchObject({ task_id: taskId, kind: 'message', text: 'Halfway.' })
    // The root was not told: a note goes up **one** level, to the chat that started this one.
    expect(await store.getPendingTaskNotifications(sessionId)).toEqual([])
    expect(signal).toHaveBeenCalledWith(child.id, 'work')
  })

  it('offers a session at the cap nothing that starts work', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    // Two levels below the top is the cap by default, so a depth-3 session is the deepest a tree
    // may get — and it is offered only the tool that reaches up (S6).
    const { runtime: deployment } = runtime({ maxDepth: 3 })
    const { child } = await childOfParent(store, sessionId)
    const { child: grandchild } = await nestedChild(store, child)
    const { child: greatGrandchild } = await nestedChild(store, grandchild)
    expect(greatGrandchild.depth).toBe(3)

    const { model } = await turn(store, greatGrandchild.id, [{ text: ['Done.'] }], deployment)
    const offered = (model.calls[0]?.tools ?? []).map((tool) => tool.name)
    expect(offered).toContain(MESSAGE_PARENT_TOOL_NAME)
    // Nothing that starts, steers or stops work — and nothing that waits on it. (A model whose
    // provider has a native search is offered that one; it is not a subagent tool.)
    for (const name of [
      AGENT_TOOL_NAME,
      AGENT_MESSAGE_TOOL_NAME,
      TASK_WAIT_TOOL_NAME,
      AGENT_STOP_TOOL_NAME,
    ]) {
      expect(offered).not.toContain(name)
    }
  })
})

describe('steering a helper (S5; #344)', () => {
  it('sends a running child a message and wakes it', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    await turn(store, sessionId, [{ toolCalls: [START] }, { text: ['Started.'] }], deployment)
    const log = await logOf(store, sessionId)
    const taskId = of(log, EVENT_TYPES.sessionTaskStarted)[0]?.task_id as TaskId
    const child = await childOf(store, log, sessionId)

    // The tool is offered to this chat, and the call is a `user.message` in the child — which is
    // what steering is: the loop claims it in the request that answers it.
    await say(store, sessionId, 'check on it')
    await turn(
      store,
      sessionId,
      [
        {
          toolCalls: [{ name: AGENT_MESSAGE_TOOL_NAME, input: { task_id: taskId, text: 'go on' } }],
        },
        { text: ['Told it.'] },
      ],
      deployment,
    )

    const after = await logOf(store, sessionId)
    const told = resultText(of(after, EVENT_TYPES.agentToolResult).at(-1))
    expect(told).toContain(taskId)
    const childLog = await logOf(store, child.id)
    expect(childLog.at(-1)).toMatchObject({
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: 'go on' }],
    })
    expect(signal).toHaveBeenCalledWith(child.id, 'work')
    // The child's context is intact: the prompt it was started with is still there above it.
    expect(of(childLog, EVENT_TYPES.userMessage).map((event) => event.content[0]?.text)).toEqual([
      'Read it.',
      'go on',
    ])
  })

  it('answers an unknown or foreign task id with an is_error, and writes nothing (S5)', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const foreign = newTaskId()
    await turn(
      store,
      sessionId,
      [
        {
          toolCalls: [
            { name: AGENT_MESSAGE_TOOL_NAME, input: { task_id: foreign, text: 'hi' } },
            { name: AGENT_STOP_TOOL_NAME, input: { task_id: foreign } },
          ],
        },
        { text: ['Cannot.'] },
      ],
      deployment,
    )

    const log = await logOf(store, sessionId)
    const results = of(log, EVENT_TYPES.agentToolResult)
    expect(results.map((result) => result.is_error)).toEqual([true, true])
    for (const result of results) {
      expect(resultText(result)).toContain(foreign)
    }
    expect(of(log, EVENT_TYPES.sessionTaskStatus)).toEqual([])
  })
})

describe('stopping a helper (S5/S7; #344)', () => {
  it('marks the task stopped and interrupts the child', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    await turn(store, sessionId, [{ toolCalls: [START] }, { text: ['Started.'] }], deployment)
    const log = await logOf(store, sessionId)
    const taskId = of(log, EVENT_TYPES.sessionTaskStarted)[0]?.task_id as TaskId
    const child = await childOf(store, log, sessionId)

    await say(store, sessionId, 'stop it')
    await turn(
      store,
      sessionId,
      [
        { toolCalls: [{ name: AGENT_STOP_TOOL_NAME, input: { task_id: taskId } }] },
        { text: ['Stopped.'] },
      ],
      deployment,
    )

    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus).at(-1)?.status).toBe(
      'stopped',
    )
    expect(signal).toHaveBeenCalledWith(child.id, 'interrupt')
  })

  it('writes the stop into a child parked in a task wait too (S5/S7; #348)', async () => {
    // The child that is idle **and working**: its pause is a turn end, so the signal alone starts
    // a turn that finds the same open wait and pauses again — the helper the model stopped keeps
    // working, and the turn that eventually ends announces `idle` after the `stopped`. The
    // interrupt has to be in the child's log for that turn to read as a stop.
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const taskId = newTaskId()
    const paused = await store.createSession(null, {
      ownerId: 'user_brain_tests',
      interactive: false,
      parentSessionId: sessionId,
      parentTaskId: taskId,
      model: { id: 'anthropic/claude-haiku-4-5' },
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'work' }] },
      ],
    })
    await store.appendEvents(paused.id, [
      {
        type: EVENT_TYPES.agentToolUse,
        name: TASK_WAIT_TOOL_NAME,
        input: {},
        evaluated_permission: 'allow',
      },
    ])
    // A helper that has already finished is the control: nothing may be written into it, or a
    // later turn would answer the stop with a second, contradictory `idle`.
    const finishedTask = newTaskId()
    const finished = await store.createSession(null, {
      ownerId: 'user_brain_tests',
      interactive: false,
      parentSessionId: sessionId,
      parentTaskId: finishedTask,
      model: { id: 'anthropic/claude-haiku-4-5' },
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'work' }] },
      ],
    })
    await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.sessionTaskStarted,
        task_id: taskId,
        kind: 'subagent',
        child_session_id: paused.id,
        description: 'A paused helper',
      },
      {
        type: EVENT_TYPES.sessionTaskStarted,
        task_id: finishedTask,
        kind: 'subagent',
        child_session_id: finished.id,
        description: 'A finished helper',
      },
    ])

    await say(store, sessionId, 'stop both')
    await turn(
      store,
      sessionId,
      [
        {
          toolCalls: [
            { name: AGENT_STOP_TOOL_NAME, input: { task_id: taskId } },
            { name: AGENT_STOP_TOOL_NAME, input: { task_id: finishedTask } },
          ],
        },
        { text: ['Stopped.'] },
      ],
      deployment,
    )

    expect(of(await logOf(store, paused.id), EVENT_TYPES.userInterrupt)).toHaveLength(1)
    expect(of(await logOf(store, finished.id), EVENT_TYPES.userInterrupt)).toHaveLength(0)
  })
})

describe('a child reaching its parent (S4/S5; #344)', () => {
  it('offers a child message_parent, and runs it as a note the parent is told about', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    const { child, taskId } = await childOfParent(store, sessionId)

    const { model } = await turn(
      store,
      child.id,
      [
        { toolCalls: [{ name: MESSAGE_PARENT_TOOL_NAME, input: { text: 'half way' } }] },
        { text: ['Noted.'] },
      ],
      deployment,
    )
    const offered = (model.calls[0]?.tools ?? []).map((tool) => tool.name)
    expect(offered).toContain(MESSAGE_PARENT_TOOL_NAME)
    // A child under the cap is offered the parent's tools as well (S6).
    expect(offered).toContain(AGENT_TOOL_NAME)

    // The note is a `message` notification in the parent's log, queued for its model.
    const parentLog = await logOf(store, sessionId)
    const note = of(parentLog, EVENT_TYPES.sessionTaskNotification).find(
      (event) => event.kind === 'message',
    )
    expect(note).toMatchObject({
      task_id: taskId,
      kind: 'message',
      text: 'half way',
      processed_at: null,
    })
    expect(signal).toHaveBeenCalledWith(sessionId, 'work')
    // And the child's own turn: it says it is working, and its own log holds the note's call.
    expect(of(await logOf(store, child.id), EVENT_TYPES.agentToolResult).map(resultText)).toEqual([
      'The note was sent to the chat that started you.',
    ])
  })

  it('delivers a finished turn as a result, keyed by the turn, and moves the task to idle', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    const { child, taskId } = await childOfParent(store, sessionId)

    await turn(store, child.id, [{ text: ['The rewind drops the tail.'] }], deployment)

    const parentLog = await logOf(store, sessionId)
    // The status the child's turn start wrote, then the news its end did.
    expect(of(parentLog, EVENT_TYPES.sessionTaskStatus).map((event) => event.status)).toEqual([
      'running',
      'running',
      'idle',
    ])
    const notification = of(parentLog, EVENT_TYPES.sessionTaskNotification)[0]
    const childLog = await logOf(store, child.id)
    const idle = of(childLog, EVENT_TYPES.sessionStatusIdle)[0]
    expect(notification).toMatchObject({
      task_id: taskId,
      kind: 'result',
      text: 'The rewind drops the tail.',
      processed_at: null,
      source_key: `${child.id}:${idle?.seq}`,
    })
    expect(signal).toHaveBeenCalledWith(sessionId, 'work')
  })

  it('announces a failed turn as failed, with what the provider said', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const { child, taskId } = await childOfParent(store, sessionId)

    await turn(store, child.id, [{ failWith: apiCallError(400, 'the model refused') }], deployment)

    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)[0]).toMatchObject(
      {
        task_id: taskId,
        kind: 'failed',
        text: 'the model refused',
      },
    )
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus).at(-1)?.status).toBe(
      'failed',
    )
  })

  it('announces a turn that said nothing at all, so the parent is not left waiting', async () => {
    // A turn can end with no reply: a step that only called a tool, and a request that streamed
    // no text. The parent still has to be told the helper stopped working — the announcement is
    // what tells it — so the news is a result that says so.
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const { child } = await childOfParent(store, sessionId)
    const echo: ToolDefinition<{ text: string }> = {
      name: 'echo',
      description: 'Echo.',
      inputSchema: z.object({ text: z.string() }),
      permission: 'allow',
      run: (input) => textResult(input.text),
    }

    await turn(
      store,
      child.id,
      [{ toolCalls: [{ name: 'echo', input: { text: 'quiet' } }] }, { text: [] }],
      deployment,
      [echo],
    )

    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)[0]).toMatchObject(
      {
        kind: 'result',
        text: EMPTY_TURN_RESULT,
      },
    )
  })

  it('does not announce a turn that paused in a task wait of its own (S5)', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const { child } = await childOfParent(store, sessionId)
    // The child's own child: a task it is waiting for when its turn ends.
    const grandchildTask = newTaskId()
    await store.createSession(null, {
      ownerId: 'user_brain_tests',
      interactive: false,
      parentSessionId: child.id,
      parentTaskId: grandchildTask,
      model: { id: 'anthropic/claude-haiku-4-5' },
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'work' }] },
      ],
    })
    const wait: ToolDefinition = {
      name: TASK_WAIT_TOOL_NAME,
      description: 'Wait.',
      inputSchema: z.object({ task_ids: z.array(z.string()).optional() }),
      permission: 'allow',
      run: () => textResult('answered by the log'),
    }

    const { outcome } = await turn(
      store,
      child.id,
      [{ toolCalls: [{ name: TASK_WAIT_TOOL_NAME, input: {} }] }],
      deployment,
      [wait],
    )

    expect(outcome.outcome).toBe('waiting')
    // The parent is told nothing: the child is still working, and the news that it stopped would
    // be a lie. Its own task stays running.
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)).toEqual([])
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus).at(-1)?.status).toBe(
      'running',
    )
  })

  it('runs a child’s turn with the subagent prompt appended after its own (S2)', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const { child } = await childOfParent(store, sessionId)

    const { model } = await turn(store, child.id, [{ text: ['Done.'] }], deployment)
    expect(readPrompt(model.calls[0]!)[0]).toEqual({
      role: 'system',
      text: withSubagentPrompt('Be a helper.'),
    })
    // The check that it is the child's own prompt plus the addition, not the addition alone.
    const system = readPrompt(model.calls[0]!).find((entry) => entry.role === 'system')
    expect(system?.text).toContain('Be a helper.')
    expect(system?.text).toContain(SUBAGENT_SYSTEM_PROMPT)
  })
})

describe('what a child’s turn owes its parent (S4; #344)', () => {
  it('reads the delivery off the log: the kind, the text and the key', () => {
    const child = { id: 'sesn_child' as SessionId }
    const idle = {
      id: 'sevt_1',
      type: EVENT_TYPES.sessionStatusIdle,
      seq: 3,
      processed_at: null,
      stop_reason: { type: 'end_turn' },
    } as unknown as StoredEvent
    const reply = {
      id: 'sevt_2',
      type: EVENT_TYPES.agentMessage,
      seq: 2,
      processed_at: null,
      content: [{ type: 'text', text: 'Done.' }],
    } as unknown as StoredEvent
    const running = {
      id: 'sevt_0',
      type: EVENT_TYPES.sessionStatusRunning,
      seq: 1,
      processed_at: null,
    } as unknown as StoredEvent

    expect(childTurnDelivery([running, reply, idle], child)).toEqual({
      kind: 'result',
      text: 'Done.',
      sourceKey: 'sesn_child:3',
      status: 'idle',
    })
    // A turn that has not ended owes nothing: a log whose newest status is a running one, and
    // one with no status at all.
    expect(childTurnDelivery([running], child)).toBeNull()
    expect(childTurnDelivery([], child)).toBeNull()
    // A pause is not an end.
    const paused = {
      ...idle,
      stop_reason: { type: 'requires_action', event_ids: [] },
    } as unknown as StoredEvent
    expect(childTurnDelivery([running, reply, paused], child)).toBeNull()
  })

  it('reads a stopped turn as a stop, keeping what it had produced (S7; #348)', () => {
    // The gap both UI PRs found: read as an ordinary `result`/`idle`, a stopped turn tells the
    // parent model its helper finished and the card says **done**. The `user.interrupt` in the
    // turn is the stop — a person's Stop, or the one `agent_stop` writes — and the delivery is
    // the stopped variant, with whatever the child had said so far still in reach.
    const child = { id: 'sesn_child' as SessionId }
    const running = {
      id: 'sevt_0',
      type: EVENT_TYPES.sessionStatusRunning,
      seq: 1,
      processed_at: null,
    } as unknown as StoredEvent
    const reply = {
      id: 'sevt_2',
      type: EVENT_TYPES.agentMessage,
      seq: 2,
      processed_at: null,
      content: [{ type: 'text', text: 'Half a report.' }],
    } as unknown as StoredEvent
    const idle = {
      id: 'sevt_1',
      type: EVENT_TYPES.sessionStatusIdle,
      seq: 4,
      processed_at: null,
      stop_reason: { type: 'end_turn' },
    } as unknown as StoredEvent
    const interrupt = {
      id: 'sevt_i',
      type: EVENT_TYPES.userInterrupt,
      seq: 3,
      processed_at: null,
    } as unknown as StoredEvent

    expect(childTurnDelivery([running, reply, interrupt, idle], child)).toEqual({
      kind: 'result',
      text: `${STOPPED_TURN_RESULT} Its partial output: Half a report.`,
      sourceKey: 'sesn_child:4',
      status: 'stopped',
    })

    // A turn aborted by a signal with **no event** for it is not a user stop (#378): a rolling
    // deploy's drain and a shutdown abort exactly this way, and the log records no human intent
    // for them. The parent is told what really happened — the server interrupted the turn, and
    // the helper can be continued — and the card does not move to `stopped`.
    const aborted = {
      id: 'sevt_s',
      type: EVENT_TYPES.modelRequestEnd,
      seq: 3,
      processed_at: null,
      error: { type: 'interrupted', message: 'The request was interrupted.' },
    } as unknown as StoredEvent

    expect(childTurnDelivery([running, aborted, idle], child)).toEqual({
      kind: 'result',
      text: RESTARTED_TURN_RESULT,
      sourceKey: 'sesn_child:4',
      status: 'idle',
    })

    // ...and the partial output the aborted turn had produced is kept in the sentence, exactly
    // as a user stop's is: what the helper said is not thrown away because the server went away.
    expect(childTurnDelivery([running, reply, aborted, idle], child)).toEqual({
      kind: 'result',
      text: `${RESTARTED_TURN_RESULT} Its partial output: Half a report.`,
      sourceKey: 'sesn_child:4',
      status: 'idle',
    })
  })

  it('reads a paused child’s stop off the claim, not the window (S5/S7; #348)', () => {
    // A child parked in a task wait is idle, so the interrupt that ends that wait is appended
    // **before** the turn the signal starts — outside the window the delivery slices. The idle
    // event that ends the turn carries the interrupt in its `consumes` (P4), and that is the
    // record the delivery has to read: without it the parent is told the helper **finished**
    // after a person stopped it, and the card says done (S7).
    const child = { id: 'sesn_child' as SessionId }
    const ev = (id: string, type: string, seq: number, extra: object = {}): StoredEvent =>
      ({ id, type, seq, processed_at: null, ...extra }) as unknown as StoredEvent

    const log = [
      ev('sevt_1', EVENT_TYPES.sessionStatusRunning, 1),
      ev('sevt_w', EVENT_TYPES.agentToolUse, 2, {
        name: TASK_WAIT_TOOL_NAME,
        input: {},
        evaluated_permission: 'allow',
      }),
      ev('sevt_p', EVENT_TYPES.sessionStatusIdle, 3, {
        stop_reason: {
          type: 'waiting_on_tasks',
          deadline: '2026-01-01T00:00:00.000Z',
          task_ids: [],
        },
      }),
      ev('sevt_i', EVENT_TYPES.userInterrupt, 4),
      ev('sevt_2', EVENT_TYPES.sessionStatusRunning, 5),
      ev('sevt_r', EVENT_TYPES.agentToolResult, 6, {
        tool_use_id: 'sevt_w',
        content: [],
        is_error: true,
      }),
      ev('sevt_3', EVENT_TYPES.sessionStatusIdle, 7, {
        stop_reason: { type: 'end_turn' },
        consumes: ['sevt_i'],
      }),
    ]

    expect(childTurnDelivery(log, child)).toEqual({
      kind: 'result',
      text: STOPPED_TURN_RESULT,
      sourceKey: 'sesn_child:7',
      status: 'stopped',
    })

    // The control: the same turn without the claim is an ordinary end — a log stored before P4
    // carries no `consumes`, and one whose interrupt belongs to somebody else must not be read as
    // a stop of this turn.
    const [start, call, paused, interrupt, running, result, idle] = log
    const unclaimed = {
      ...(idle as unknown as { consumes?: string[] }),
      consumes: ['sevt_other'],
    } as unknown as StoredEvent
    expect(
      childTurnDelivery([start!, call!, paused!, interrupt!, running!, result!, unclaimed], child),
    ).toEqual({
      kind: 'result',
      text: EMPTY_TURN_RESULT,
      sourceKey: 'sesn_child:7',
      status: 'idle',
    })
  })

  it('delivers once: a second turn on an idle child writes nothing more', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const taskId = newTaskId()
    const child = await store.createSession(null, {
      ownerId: 'user_brain_tests',
      interactive: false,
      parentSessionId: sessionId,
      parentTaskId: taskId,
      model: { id: 'anthropic/claude-haiku-4-5' },
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'work' }] },
      ],
    })
    await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.sessionTaskStarted,
        task_id: taskId,
        kind: 'subagent',
        child_session_id: child.id,
        description: 'A helper',
      },
    ])
    // Its turn runs and ends, and the announcement is written.
    await turn(store, child.id, [{ text: ['Done.'] }], deployment)
    const first = of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)
    expect(first.map((event) => event.kind)).toEqual(['result'])

    // A second turn on the same idle child — what the store's work scan started — delivers the
    // same key again, which the store folds: no second notification, no second status.
    const statuses = of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus).length
    const { outcome } = await turn(store, child.id, [{ text: ['Nothing to do.'] }], deployment)
    // A `noop`: there is nothing queued and nothing left to announce, so the turn writes nothing
    // and makes no request — which is the whole of "once".
    expect(outcome).toEqual({ outcome: 'noop' })
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)).toHaveLength(1)
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus)).toHaveLength(statuses)
  })

  it('announces a turn a person stopped as stopped, once, and a later message restarts it (S7; #348)', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const { child, taskId } = await childOfParent(store, sessionId)

    // A person's Stop while the child's turn is streaming — exactly what the web card's Stop,
    // `oh`'s `/agents` → `s` and Esc in a child do: the route appends the `user.interrupt` and
    // signals the abort, and the span end it stopped claims the event (P4).
    const controller = new AbortController()
    const stopped = mockModel({
      text: ['Half a ', 'report.'],
      onChunk: async (_chunk, index) => {
        if (index === 0) {
          await store.appendEvents(child.id, [{ type: EVENT_TYPES.userInterrupt }])
          controller.abort()
        }
      },
    })
    const outcome = await runTurn(child.id, {
      store,
      model: stopped.factory,
      resolveCredential: resolveTestCredential,
      subagents: deployment,
      signal: controller.signal,
    })
    expect(outcome.outcome).toBe('interrupted')

    // One notification **for that turn**, plainly a stop rather than a completion, beside the
    // status a card follows: `stopped`, which reads as stopped and not as **done** (S9).
    const notifications = of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ task_id: taskId, kind: 'result' })
    expect(notifications[0]?.text).toContain(STOPPED_TURN_RESULT)
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus).at(-1)?.status).toBe(
      'stopped',
    )

    // A second turn on the stopped child — what the store's work scan runs for one whose news had
    // not landed — delivers the same key again, which the store folds: still one notification, and
    // no model request, because there is nothing to ask.
    await turn(store, child.id, [{ text: ['unused'] }], deployment)
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)).toHaveLength(1)

    // A later message restarts it as usual: the stop is not a tombstone (S7).
    await say(store, child.id, 'keep going')
    await turn(store, child.id, [{ text: ['Second wind.'] }], deployment)
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus).at(-1)?.status).toBe(
      'idle',
    )
  })

  it('writes the stop into the child’s log, so `agent_stop` and a person’s Stop are one (S7; #348)', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    await turn(store, sessionId, [{ toolCalls: [START] }, { text: ['Started.'] }], deployment)
    const log = await logOf(store, sessionId)
    const taskId = of(log, EVENT_TYPES.sessionTaskStarted)[0]?.task_id as TaskId
    const child = await childOf(store, log, sessionId)

    // The child is working when both stops happen: a person interrupts it, and the parent model
    // then calls `agent_stop` on the same task.
    await store.appendEvents(child.id, [
      { type: EVENT_TYPES.sessionStatusRunning },
      { type: EVENT_TYPES.userInterrupt },
    ])
    await say(store, sessionId, 'stop it')
    await turn(
      store,
      sessionId,
      [
        { toolCalls: [{ name: AGENT_STOP_TOOL_NAME, input: { task_id: taskId } }] },
        { text: ['Stopped.'] },
      ],
      deployment,
    )
    // The model's stop is written the same way a person's is — a `user.interrupt` in the child's
    // own log — which is what makes them one kind of stop and one delivery.
    expect(signal).toHaveBeenCalledWith(child.id, 'interrupt')
    expect(of(await logOf(store, child.id), EVENT_TYPES.userInterrupt)).toHaveLength(2)
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus).at(-1)?.status).toBe(
      'stopped',
    )

    // The child's turn ends on those interrupts, and the parent is told **once**: one stopped
    // result keyed by the turn, and no second, contradictory status.
    const { outcome, model } = await turn(store, child.id, [{ text: ['unused'] }], deployment)
    expect(outcome.outcome).toBe('interrupted')
    expect(model.calls).toHaveLength(0)
    const notifications = of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ task_id: taskId, kind: 'result' })
    expect(notifications[0]?.text).toContain(STOPPED_TURN_RESULT)
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus).at(-1)?.status).toBe(
      'stopped',
    )
  })

  it('announces a turn the **server** aborted as the server’s doing, not as a user stop (#378)', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const { child, taskId } = await childOfParent(store, sessionId)

    // A rolling deploy drains by aborting the turns in flight — the same abort a shutdown and a
    // delete use — and **no `user.interrupt` is written** for it, because no person spoke. The
    // turn really ended, so the parent has to hear about it; what it must not hear is that the
    // *user* stopped a helper the operator restarted.
    const controller = new AbortController()
    const drained = mockModel({
      text: ['Half a ', 'report.'],
      onChunk: (_chunk, index) => {
        // After the first chunk has streamed, so there is partial output to keep.
        if (index === 1) {
          controller.abort()
        }
      },
    })
    const outcome = await runTurn(child.id, {
      store,
      model: drained.factory,
      resolveCredential: resolveTestCredential,
      subagents: deployment,
      signal: controller.signal,
    })
    expect(outcome.outcome).toBe('interrupted')

    const notifications = of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ task_id: taskId, kind: 'result' })
    expect(notifications[0]?.text).toContain(RESTARTED_TURN_RESULT)
    expect(notifications[0]?.text).not.toContain(STOPPED_TURN_RESULT)
    // The card reads `idle` — done — and not `stopped`: nothing the user did, and the helper can
    // be continued with `agent_message`.
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus).at(-1)?.status).toBe(
      'idle',
    )
  })

  it('leaves a finished child’s card and news alone when an interrupt lands in it (#371)', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const { child } = await childOfParent(store, sessionId)
    // The helper finishes and reports: the parent's log holds its result and an `idle`, so the
    // card says **done**.
    await turn(store, child.id, [{ text: ['All done.'] }], deployment)
    const before = await logOf(store, sessionId)
    expect(of(before, EVENT_TYPES.sessionTaskNotification)).toHaveLength(1)

    // A person's Stop on a helper that has already finished — `oh`'s `/agents` Stop calls
    // `interrupt` unconditionally, and a frontend's Stop is gated on a status that can lag a
    // round trip behind the child's real turn end. The interrupt opens and immediately ends a
    // turn of its own, and announcing that would tell the parent model its helper was stopped
    // *before it finished* — after it had — and flip the card from done to stopped.
    await store.appendEvents(child.id, [{ type: EVENT_TYPES.userInterrupt }])
    const { outcome, model } = await turn(store, child.id, [{ text: ['unused'] }], deployment)
    expect(outcome.outcome).toBe('interrupted')
    expect(model.calls).toHaveLength(0)

    const after = await logOf(store, sessionId)
    expect(of(after, EVENT_TYPES.sessionTaskNotification)).toEqual(
      of(before, EVENT_TYPES.sessionTaskNotification),
    )
    expect(of(after, EVENT_TYPES.sessionTaskStatus)).toEqual(
      of(before, EVENT_TYPES.sessionTaskStatus),
    )
    // The interrupt is not left queued either: the turn claimed it (P4), so nothing will wake
    // this child again for it.
    expect(await store.getPendingUserEvents(child.id)).toEqual([])
    expect(
      of(await logOf(store, child.id), EVENT_TYPES.userInterrupt)[0]?.processed_at,
    ).not.toBeNull()
  })

  it('delivers an undelivered turn before starting a new one, with a message queued (#365)', async () => {
    // The crash window: the child's turn ended and its news never landed. Before the recovery
    // scan reaches it, the parent sends `agent_message` — and the child's next turn must still
    // hand over the older announcement: `childTurnDelivery` reads the **newest** ended turn
    // only, so the answer to the prompt the parent actually wrote would be lost for good.
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const { child } = await childOfParent(store, sessionId)
    const promptId = of(await logOf(store, child.id), EVENT_TYPES.userMessage)[0]?.id
    await store.appendEvents(child.id, [
      { type: EVENT_TYPES.sessionStatusRunning },
      { type: EVENT_TYPES.agentMessage, content: [{ type: 'text', text: 'First answer.' }] },
      {
        type: EVENT_TYPES.sessionStatusIdle,
        stop_reason: { type: 'end_turn' },
        consumes: [promptId as EventId],
      },
    ])
    // The message is already queued for the child — the parent's `agent_message`, or the user
    // steering it — which is what used to skip the no-op guard and so the delivery.
    await store.appendEvents(child.id, [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'now also do Y' }] },
    ])

    const { outcome } = await turn(store, child.id, [{ text: ['Second answer.'] }], deployment)
    expect(outcome).toEqual({ outcome: 'idle' })

    // Both turns were announced, each under its own key: the older one first, then the turn the
    // message started.
    const texts = of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification).map(
      (notification) => notification.text,
    )
    expect(texts).toContain('First answer.')
    expect(texts).toContain('Second answer.')
    expect(texts.indexOf('First answer.')).toBeLessThan(texts.indexOf('Second answer.'))
  })

  it('is what an idle child with an undelivered turn wakes up for (S4; #344)', async () => {
    // The crash recovery: a child whose turn ended and whose announcement never landed is work
    // (the store's scan says so), and the turn that runs for it writes the news and nothing to
    // its own log — a `noop`, like any other turn with nothing to do.
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    const taskId = newTaskId()
    const child = await store.createSession(null, {
      ownerId: 'user_brain_tests',
      interactive: false,
      parentSessionId: sessionId,
      parentTaskId: taskId,
      model: { id: 'anthropic/claude-haiku-4-5' },
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'work' }] },
      ],
    })
    await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.sessionTaskStarted,
        task_id: taskId,
        kind: 'subagent',
        child_session_id: child.id,
        description: 'A helper',
      },
    ])
    // A turn that ran, ended, and died before it could say so: the prompt was claimed by the
    // request it answered, so nothing is queued and no turn is open.
    const promptId = of(await logOf(store, child.id), EVENT_TYPES.userMessage)[0]?.id
    await store.appendEvents(child.id, [
      { type: EVENT_TYPES.sessionStatusRunning },
      { type: EVENT_TYPES.agentMessage, content: [{ type: 'text', text: 'I am done.' }] },
      {
        type: EVENT_TYPES.sessionStatusIdle,
        stop_reason: { type: 'end_turn' },
        consumes: [promptId as EventId],
      },
    ])

    const { outcome, model } = await turn(store, child.id, [{ text: ['unused'] }], deployment)
    expect(outcome).toEqual({ outcome: 'noop' })
    // No model request was made: the turn had nothing to ask the model, only something to write.
    expect(model.calls).toHaveLength(0)
    const notification = of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)[0]
    expect(notification).toMatchObject({ task_id: taskId, kind: 'result', text: 'I am done.' })
    expect(signal).toHaveBeenCalledWith(sessionId, 'work')
  })

  it('delivers the stopped variant when the turn an idle child owes was stopped (S7; #348)', async () => {
    // The same recovery, one fact different: the turn that ended and was never announced was a
    // **stopped** turn. The delivery reads the turn's own log, so what a crash between the turn
    // and its news costs is the stopped announcement the reader and the model would have had —
    // not an `idle` that says the helper finished.
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    const taskId = newTaskId()
    const child = await store.createSession(null, {
      ownerId: 'user_brain_tests',
      interactive: false,
      parentSessionId: sessionId,
      parentTaskId: taskId,
      model: { id: 'anthropic/claude-haiku-4-5' },
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'work' }] },
      ],
    })
    await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.sessionTaskStarted,
        task_id: taskId,
        kind: 'subagent',
        child_session_id: child.id,
        description: 'A helper',
      },
    ])
    const promptId = of(await logOf(store, child.id), EVENT_TYPES.userMessage)[0]?.id
    await store.appendEvents(child.id, [
      { type: EVENT_TYPES.sessionStatusRunning },
      { type: EVENT_TYPES.agentMessage, content: [{ type: 'text', text: 'Half a report.' }] },
    ])
    const [interrupt] = await store.appendEvents(child.id, [{ type: EVENT_TYPES.userInterrupt }])
    await store.appendEvents(child.id, [
      {
        type: EVENT_TYPES.sessionStatusIdle,
        stop_reason: { type: 'end_turn' },
        consumes: [promptId as EventId, interrupt?.id as EventId],
      },
    ])

    const { outcome, model } = await turn(store, child.id, [{ text: ['unused'] }], deployment)
    expect(outcome).toEqual({ outcome: 'noop' })
    expect(model.calls).toHaveLength(0)
    const notification = of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)[0]
    expect(notification).toMatchObject({ task_id: taskId, kind: 'result' })
    expect(notification?.text).toContain(STOPPED_TURN_RESULT)
    expect(notification?.text).toContain('Half a report.')
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus).at(-1)?.status).toBe(
      'stopped',
    )
    expect(signal).toHaveBeenCalledWith(sessionId, 'work')

    // Exactly once: a second turn on the child writes the same key again, which the store folds.
    await turn(store, child.id, [{ text: ['unused'] }], deployment)
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)).toHaveLength(1)
  })
})

describe('a rewind that took an `agent` call back (S7; #344)', () => {
  it('stops the child the call started, and drops its news', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    const taskId = newTaskId()
    const child = await store.createSession(null, {
      ownerId: 'user_brain_tests',
      interactive: false,
      parentSessionId: sessionId,
      parentTaskId: taskId,
      model: { id: 'anthropic/claude-haiku-4-5' },
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'work' }] },
      ],
    })
    await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.sessionTaskStarted,
        task_id: taskId,
        kind: 'subagent',
        child_session_id: child.id,
        description: 'A helper',
      },
    ])
    // The reader edits the message that started it: one rewind from that message covers the
    // `session.task_started` and everything after it.
    await store.appendEvents(sessionId, [
      { type: EVENT_TYPES.sessionRewind, from_seq: 1 },
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'never mind' }] },
    ])
    expect(starts(await logOf(store, sessionId)).has(taskId)).toBe(false)

    // And the child — which nobody told — finishes and says so, **after** the rewind, so its
    // news is a queued event the log really holds.
    await store.appendTaskNotification(sessionId, {
      taskId,
      kind: 'result',
      text: 'I finished before you took it back.',
      sourceKey: `${child.id}:3`,
    })

    // A turn after the edit: the orphan is stopped, and the news is not delivered — it is not
    // this chat's task any more.
    const { model } = await turn(store, sessionId, [{ text: ['Fine.'] }], deployment)
    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.sessionTaskStatus).at(-1)).toMatchObject({
      task_id: taskId,
      status: 'stopped',
    })
    expect(signal).toHaveBeenCalledWith(child.id, 'interrupt')
    expect(
      readPrompt(model.calls[0]!)
        .map((entry) => JSON.stringify(entry))
        .join(''),
    ).not.toContain('I finished before you took it back.')
    expect(
      deliverableNotifications(
        of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification),
        starts(log),
      ),
    ).toEqual([])
  })

  it('delivers nothing when a rewind took the task back while the child was finishing (#382)', async () => {
    // The delivery reads the **parent's** log, not only the child's: the reader may have taken
    // the `agent` call back while the child's turn was ending, and a task the parent's log no
    // longer names has no news to bring. Written anyway, the notification would be a queued
    // event nothing may claim — the store's work scan and `SessionRunner`'s `#hasMoreWork`
    // would both find it on every pass — and the parent would wake for ever over news the
    // rewind said did not happen.
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    const { child, taskId } = await childOfParent(store, sessionId)
    // The reader edits the message that started it, covering the `session.task_started`.
    await store.appendEvents(sessionId, [
      { type: EVENT_TYPES.sessionRewind, from_seq: 1 },
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'never mind' }] },
    ])
    expect(starts(await logOf(store, sessionId)).has(taskId)).toBe(false)
    signal.mockClear()

    await turn(store, child.id, [{ text: ['I finished before you took it back.'] }], deployment)

    const parentLog = await logOf(store, sessionId)
    expect(of(parentLog, EVENT_TYPES.sessionTaskNotification)).toEqual([])
    expect(signal).not.toHaveBeenCalledWith(sessionId, 'work')
  })

  it('interrupts a paused orphan with an event, so the card cannot flip back (S7; #348)', async () => {
    // The same hole as `agent_stop`'s, on the rewind path: a child parked in a task wait is not
    // stopped by a signal alone, so the turn it eventually ends would announce `idle` after the
    // `stopped` the rewind wrote — a card reading **done** for work the reader took back.
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const taskId = newTaskId()
    const child = await store.createSession(null, {
      ownerId: 'user_brain_tests',
      interactive: false,
      parentSessionId: sessionId,
      parentTaskId: taskId,
      model: { id: 'anthropic/claude-haiku-4-5' },
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'work' }] },
      ],
    })
    await store.appendEvents(child.id, [
      {
        type: EVENT_TYPES.agentToolUse,
        name: TASK_WAIT_TOOL_NAME,
        input: {},
        evaluated_permission: 'allow',
      },
    ])
    await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.sessionTaskStarted,
        task_id: taskId,
        kind: 'subagent',
        child_session_id: child.id,
        description: 'A helper',
      },
    ])
    await store.appendEvents(sessionId, [
      { type: EVENT_TYPES.sessionRewind, from_seq: 1 },
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'never mind' }] },
    ])

    await turn(store, sessionId, [{ text: ['Fine.'] }], deployment)

    expect(of(await logOf(store, child.id), EVENT_TYPES.userInterrupt)).toHaveLength(1)
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus).at(-1)?.status).toBe(
      'stopped',
    )
  })

  it('interrupts a **running** orphan with an event too, so a lost signal cannot leave it working (#371)', async () => {
    // The paused case above is one step of the same fact: a signal is a hint, and this path's
    // own invariant (a signal on an idle session starts a turn that finds the same wait) has a
    // running twin — a dropped notification (`LISTEN` lost, an instance restarting) leaves a
    // helper working on work the reader took back, and it later delivers news for a task the
    // log no longer names. The event is what makes the stop durable, exactly as `agent_stop`
    // writes it (`./agents`' stop), so the child's own log records what stopped it.
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    const taskId = newTaskId()
    const child = await store.createSession(null, {
      ownerId: 'user_brain_tests',
      interactive: false,
      parentSessionId: sessionId,
      parentTaskId: taskId,
      model: { id: 'anthropic/claude-haiku-4-5' },
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'work' }] },
      ],
    })
    // A turn in flight: the stop the rewind writes is one the child can read, not a hint.
    await store.appendEvents(child.id, [{ type: EVENT_TYPES.sessionStatusRunning }])
    await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.sessionTaskStarted,
        task_id: taskId,
        kind: 'subagent',
        child_session_id: child.id,
        description: 'A helper',
      },
    ])
    await store.appendEvents(sessionId, [
      { type: EVENT_TYPES.sessionRewind, from_seq: 1 },
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'never mind' }] },
    ])

    await turn(store, sessionId, [{ text: ['Fine.'] }], deployment)

    expect(of(await logOf(store, child.id), EVENT_TYPES.userInterrupt)).toHaveLength(1)
    expect(signal).toHaveBeenCalledWith(child.id, 'interrupt')
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus).at(-1)?.status).toBe(
      'stopped',
    )
  })

  it('finds no orphan when every child’s task is still in the log', async () => {
    const { store, sessionId } = await newSession([message('hi')])
    const { runtime: deployment, signal } = runtime()
    const taskId = newTaskId()
    await store.createSession(null, {
      ownerId: 'user_brain_tests',
      interactive: false,
      parentSessionId: sessionId,
      parentTaskId: taskId,
      model: { id: 'anthropic/claude-haiku-4-5' },
    })
    await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.sessionTaskStarted,
        task_id: taskId,
        kind: 'subagent',
        description: 'A helper',
      },
    ])
    const session = await store.getSessionUnscoped(sessionId)
    expect(await stopOrphanedTasks(store, session as Session, deployment)).toBe(0)
    expect(signal).not.toHaveBeenCalledWith(expect.anything(), 'interrupt')
  })
})

describe('the pieces on their own (#344)', () => {
  it('reads the parent and the handle off a child session', () => {
    expect(
      childTaskParent({
        parent_session_id: 'sesn_parent' as SessionId,
        parent_task_id: 'task_1' as TaskId,
      }),
    ).toEqual({ parentSessionId: 'sesn_parent', taskId: 'task_1' })
    expect(childTaskParent({ parent_session_id: null, parent_task_id: null })).toBeNull()
    // A child no task names — A1's own children — owes nobody anything.
    expect(
      childTaskParent({ parent_session_id: 'sesn_parent' as SessionId, parent_task_id: null }),
    ).toBeNull()
  })

  it('keys a note by the child, not by a turn', () => {
    // Two notes from one child are two pieces of news: what the store makes unique is the key,
    // and a shared one would drop the second. Unique per note is all that is needed — a call is
    // never re-run after a crash, so there is no repeat to fold.
    const first = `${ulid()}`
    expect(first).not.toBe(`${ulid()}`)
  })

  it('carries what the parent is into the resolver, mode and all (S2/S6)', async () => {
    const seen: SubagentParent[] = []
    const resolver = types({
      resolve: (_owner, name, parent) => {
        seen.push(parent)
        return Promise.resolve({
          ok: true,
          type: {
            name,
            description: 'Anything.',
            model: parent.model,
            reasoningEffort: parent.reasoningEffort,
            systemPromptAddition: null,
            modeId: parent.modeId,
            toolOverride: parent.toolOverride,
            tools: [],
            mcpServers: [],
          },
        })
      },
    })
    const { store, sessionId } = await newSession([message('start', 'high')])
    const signal = vi.fn()
    await turn(
      store,
      sessionId,
      [
        {
          toolCalls: [
            {
              name: AGENT_TOOL_NAME,
              input: { type: GENERAL_PURPOSE_TYPE, description: 'Work', prompt: 'Go.' },
            },
          ],
        },
        { text: ['Started.'] },
      ],
      { types: resolver, maxDepth: 3, maxLiveTasks: 10, signal },
    )
    // The parent's own request is what a `general-purpose` child continues: the model it runs,
    // the effort in force, and no mode (the fixture chat follows none).
    expect(seen[0]).toEqual({
      model: 'anthropic/claude-sonnet-5',
      reasoningEffort: 'high',
      toolOverride: null,
      modeId: null,
    })
  })
})
