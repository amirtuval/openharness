import { createToolRegistry, textResult } from '@openharness/hands'
import type { ToolDefinition, ToolResult } from '@openharness/hands'
import type { AskUserInput, EventId, StoredEvent, StoredEventType } from '@openharness/protocol'
import { ASK_USER_TOOL_NAME, AskUserInputSchema, EVENT_TYPES } from '@openharness/protocol'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { NON_INTERACTIVE_REFUSAL, withoutAskUser } from './tools'
import { logOf, message, newSession } from './testing/harness'
import { mockModel, resolveTestCredential } from './testing/mock-model'
import { runTurn } from './turn'

/**
 * A non-interactive session (epic #340, S1): one whose model cannot stop to ask the user
 * anything.
 *
 * Two things make it one, and both are asserted here against a real store and a scripted model:
 * `ask_user` is **not in the request at all**, and a call whose effective policy is `ask` is
 * denied at once — stored with the permission it was evaluated under, answered with the
 * sentence saying why, and carried on from — rather than pausing a turn nobody is there to
 * answer. A person may still steer it, which is what makes the flag about the model and not
 * about the reader.
 */

/** What the scripted question call asks, whatever it is never allowed to ask. */
const QUESTIONS: AskUserInput = {
  questions: [{ question: 'Which one?', header: 'Pick', type: 'text' }],
}

/** A tool that answers whatever it was called with, and records that it ran. */
function echo(): {
  readonly tool: ToolDefinition<{ text: string }>
  readonly run: ReturnType<typeof vi.fn>
} {
  const run = vi.fn<(input: { text: string }) => ToolResult>((input) => textResult(input.text))
  return {
    tool: {
      name: 'echo',
      description: 'Echo the text back.',
      inputSchema: z.object({ text: z.string() }),
      permission: 'allow',
      run,
    },
    run,
  }
}

/**
 * The `ask_user` tool as the server registers it: the protocol's schema and a `run` that is
 * never reached. A non-interactive session must not be offered it at all — the assertion that
 * matters is that the request does not carry it, not that a call to it is refused.
 */
function askUser(): ToolDefinition<AskUserInput> {
  return {
    name: ASK_USER_TOOL_NAME,
    description: 'Ask the user a question.',
    inputSchema: AskUserInputSchema,
    permission: 'allow',
    run: () => textResult('ask_user is answered by the user.'),
  }
}

/** The stored events of one type, in order, narrowed to that kind. */
function of<T extends StoredEventType>(
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

/** The tools a recorded request really offered the model, by name. */
function offeredNames(call: unknown): string[] {
  const tools = (call as { readonly tools?: readonly { readonly name: string }[] }).tools ?? []
  return tools.map((tool) => tool.name)
}

describe('a non-interactive session (epic #340, S1)', () => {
  it('is never offered ask_user, at the request and on the span', async () => {
    const { store, sessionId } = await newSession([message('hi')], { interactive: false })
    const echoTool = echo()
    const { factory, calls } = mockModel({ text: ['Done.'] })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([askUser(), echoTool.tool]),
    })
    expect(outcome).toEqual({ outcome: 'idle' })

    // The offer itself: the definitions the provider was really handed, and the record the
    // span keeps of them. Both are without the question tool, and `echo` is still there — the
    // registry was filtered rather than dropped.
    expect(offeredNames(calls[0])).not.toContain(ASK_USER_TOOL_NAME)
    expect(offeredNames(calls[0])).toContain('echo')
    const span = of(await logOf(store, sessionId), EVENT_TYPES.modelRequestStart)[0]
    expect(span?.tools?.map((tool) => tool.name)).not.toContain(ASK_USER_TOOL_NAME)
    expect(span?.tools?.map((tool) => tool.name)).toContain('echo')
  })

  it('offers ask_user to an interactive session, which is what the flag takes away', async () => {
    // The control: the same registry, the same model, the same turn — only `interactive`
    // differs, so an empty offer cannot be a test that proves nothing.
    const { store, sessionId } = await newSession([message('hi')])
    const { factory, calls } = mockModel({ text: ['Done.'] })

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([askUser(), echo().tool]),
    })

    expect(offeredNames(calls[0])).toContain(ASK_USER_TOOL_NAME)
  })

  it('answers a call to ask_user as one naming no tool: it is not in the registry', async () => {
    const { store, sessionId } = await newSession([message('hi')], { interactive: false })
    const { factory } = mockModel(
      { toolCalls: [{ name: ASK_USER_TOOL_NAME, input: QUESTIONS }] },
      { text: ['I will work it out myself.'] },
    )

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([askUser(), echo().tool]),
    })

    // The turn does not pause on it: the call is answered like a call to a tool the request
    // was not built with, because it really is one — the registry this step was handed has no
    // `ask_user` in it.
    expect(outcome).toEqual({ outcome: 'idle' })
    const log = await logOf(store, sessionId)
    const use = of(log, EVENT_TYPES.agentToolUse)[0]
    const result = of(log, EVENT_TYPES.agentToolResult)[0]
    expect(use).toMatchObject({ name: ASK_USER_TOOL_NAME, evaluated_permission: 'deny' })
    expect(resultText(result)).toBe(`No tool named "${ASK_USER_TOOL_NAME}" is registered.`)
    expect(result?.is_error).toBe(true)
    expect(
      log.filter(
        (event) =>
          event.type === EVENT_TYPES.sessionStatusIdle &&
          event.stop_reason.type === 'requires_action',
      ),
    ).toEqual([])
  })

  it('denies an ask call at once, with the reason, and carries on', async () => {
    const { store, sessionId } = await newSession([message('do it')], { interactive: false })
    const echoTool = echo()
    const { factory } = mockModel(
      { toolCalls: [{ name: 'echo', input: { text: 'x' } }] },
      { text: ['Fine — I could not run that.'] },
    )

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echoTool.tool]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })

    // Not `paused`: the turn runs to its end, with the refusal as an ordinary tool result.
    expect(outcome).toEqual({ outcome: 'idle' })
    expect(echoTool.run).not.toHaveBeenCalled()

    const log = await logOf(store, sessionId)
    const use = of(log, EVENT_TYPES.agentToolUse)[0]
    const result = of(log, EVENT_TYPES.agentToolResult)[0]
    // The call keeps the permission it was evaluated under (#307), so the log still says this
    // was one the settings ask about — the answer is what says why nothing ran.
    expect(use).toMatchObject({ name: 'echo', evaluated_permission: 'ask' })
    expect(result).toMatchObject({ tool_use_id: use?.id, is_error: true })
    expect(resultText(result)).toBe(NON_INTERACTIVE_REFUSAL)
    // The turn continues: the model was asked again, and its reply is in the log.
    expect(of(log, EVENT_TYPES.modelRequestStart)).toHaveLength(2)
    expect(of(log, EVENT_TYPES.agentMessage).at(-1)?.content).toEqual([
      { type: 'text', text: 'Fine — I could not run that.' },
    ])
    // The turn ended on its own terms, not waiting on anyone.
    expect(of(log, EVENT_TYPES.sessionStatusIdle).at(-1)?.stop_reason).toEqual({ type: 'end_turn' })
  })

  it('pauses on the very same ask call when the session is interactive', async () => {
    // The control for the denial: without the flag this is the pause of #309, which is what
    // makes the sentence above a decision the flag made rather than one the loop always took.
    const { store, sessionId } = await newSession([message('do it')])
    const echoTool = echo()
    const { factory } = mockModel({ toolCalls: [{ name: 'echo', input: { text: 'x' } }] })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echoTool.tool]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })

    expect(outcome).toEqual({ outcome: 'paused' })
    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.agentToolResult)).toEqual([])
    expect(of(log, EVENT_TYPES.sessionStatusIdle).at(-1)?.stop_reason).toMatchObject({
      type: 'requires_action',
    })
  })

  it('takes a steering message and answers it, like any other session', async () => {
    const { store, sessionId } = await newSession([message('start')], { interactive: false })
    let steeringId: EventId | undefined
    const { factory } = mockModel(
      {
        text: ['Working on ', 'the first'],
        onChunk: async (_chunk, index) => {
          if (index === 0) {
            const [steering] = await store.appendEvents(sessionId, [
              {
                type: EVENT_TYPES.userMessage,
                content: [{ type: 'text', text: 'Actually, stop' }],
              },
            ])
            steeringId = steering?.id
          }
        },
      },
      { text: ['Answering the steering message.'] },
    )

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echo().tool]),
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.agentMessage).at(-1)?.content).toEqual([
      { type: 'text', text: 'Answering the steering message.' },
    ])
    // The steering message was claimed by the request that answered it (P4): nothing about a
    // non-interactive session changes how a person reaches it.
    const claims = of(log, EVENT_TYPES.modelRequestStart).map((span) => span.consumes ?? [])
    expect(claims[1]).toContain(steeringId)
  })
})

describe('withoutAskUser', () => {
  it('returns what it was given whenever there is nothing to take out', () => {
    const registry = createToolRegistry([echo().tool])
    // The same instance, so an interactive session and a non-interactive one that never had
    // the question tool build identical requests.
    expect(withoutAskUser(registry, true)).toBe(registry)
    expect(withoutAskUser(registry, false)).toBe(registry)
    expect(withoutAskUser(undefined, false)).toBeUndefined()
  })

  it('takes ask_user out, and answers undefined when it was the only tool', () => {
    const both = createToolRegistry([askUser(), echo().tool])
    expect(withoutAskUser(both, false)?.tools.map((tool) => tool.name)).toEqual(['echo'])
    expect(withoutAskUser(createToolRegistry([askUser()]), false)).toBeUndefined()
  })
})
