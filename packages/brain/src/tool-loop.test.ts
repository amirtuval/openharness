import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { createToolRegistry, textResult } from '@openharness/hands'
import type { ToolDefinition, ToolResult } from '@openharness/hands'
import { EVENT_TYPES } from '@openharness/protocol'
import type { StoredEvent, StoredEventType } from '@openharness/protocol'
import { makeUserMessage } from '@openharness/protocol/fixtures'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { agentToolUse, spanEnd, spanStart, statusRunning } from './events'
import { ZERO_MODEL_USAGE } from './model'
import {
  DEFAULT_MAX_TOOL_STEPS,
  asToolInput,
  pendingToolUse,
  toolsFor,
  type ToolPolicyResolver,
  type ToolSupportFor,
} from './tools'
import { eventTypes, logOf, message, newSession, spanStartOf, textOf } from './testing/harness'
import { mockModel, readPrompt, resolveTestCredential } from './testing/mock-model'
import { runTurn } from './turn'

/**
 * The tool loop, driven end to end: a real store, a scripted model that calls tools, and a
 * registry of local tools that record what ran.
 *
 * The order of the events is the contract here as it is in `turn.test.ts`, with one more shape
 * to it: a step that called a tool stores the calls, runs them, stores their answers in call
 * order, and only then asks the model again — with a span of its own, exactly as any request
 * has.
 */

const TEST_MODEL_ID = 'anthropic/claude-sonnet-5'

/** An `echo` tool, and the spy that says whether it ran. */
function echo(overrides: Partial<ToolDefinition<{ text: string }>> = {}): {
  readonly tool: ToolDefinition<{ text: string }>
  readonly run: ReturnType<typeof vi.fn>
} {
  const run = vi.fn<(input: { text: string }) => ToolResult | Promise<ToolResult>>((input) =>
    textResult(input.text),
  )
  const tool: ToolDefinition<{ text: string }> = {
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: z.object({ text: z.string() }),
    permission: 'allow',
    run,
    ...overrides,
  }
  return { tool, run }
}

/** One part of a recorded request's provider-level prompt, as plain data. */
interface PromptPart {
  readonly type: string
  readonly toolCallId?: string
  readonly toolName?: string
  readonly input?: unknown
  readonly output?: { readonly type: string; readonly value?: unknown }
}

/** Every content part of a recorded request's prompt, its messages flattened in order. */
function promptParts(call: LanguageModelV4CallOptions): PromptPart[] {
  return call.prompt.flatMap((entry) =>
    typeof entry.content === 'string' ? [] : (entry.content as unknown as PromptPart[]),
  )
}

/** The tools a recorded request offered the model, if it offered any. */
function offeredTo(call: LanguageModelV4CallOptions): unknown {
  return (call as { readonly tools?: unknown }).tools
}

/** The text of a message event, or of a tool result, whichever it is. */
function textOfEvent(
  event: { readonly content: readonly { readonly text: string }[] } | undefined,
): string {
  return event === undefined ? '' : event.content.map((block) => block.text).join('')
}

/** The stored events of one type, in order, narrowed to that kind. */
function of<T extends StoredEventType>(
  log: readonly StoredEvent[],
  type: T,
): Extract<StoredEvent, { type: T }>[] {
  return log.filter((event): event is Extract<StoredEvent, { type: T }> => event.type === type)
}

describe('the tool loop', () => {
  it('runs a call in one step and answers it before asking again', async () => {
    const { store, sessionId } = await newSession([message('hi')])
    const { tool, run } = echo()
    const { factory, calls } = mockModel(
      { text: ['Let me check.'], toolCalls: [{ name: 'echo', input: { text: 'hi' } }] },
      { text: ['It said hi.'] },
    )

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toEqual({ text: 'hi' })

    const log = await logOf(store, sessionId)
    expect(eventTypes(log)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      // The step that called the tool: its reply, then the request's end. The reply's chunks
      // are stored (D9) and the message supersedes them, so the replay read does not hold
      // them — `turn.test.ts` asserts that on the raw log.
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionUsage,
      // What the loop then ran, in the order it asked and answered.
      EVENT_TYPES.agentToolUse,
      EVENT_TYPES.agentToolResult,
      // The step the answer bought.
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionUsage,
      EVENT_TYPES.sessionStatusIdle,
    ])

    const spans = of(log, EVENT_TYPES.modelRequestStart)
    expect(spans[0]).toMatchObject({
      consumes: [log[0]?.id],
      model: TEST_MODEL_ID,
      tools: [{ name: 'echo', source: 'builtin' }],
    })
    expect(spans[1]?.tools).toEqual([{ name: 'echo', source: 'builtin' }])

    const use = of(log, EVENT_TYPES.agentToolUse)[0]
    const result = of(log, EVENT_TYPES.agentToolResult)[0]
    expect(use).toMatchObject({
      name: 'echo',
      input: { text: 'hi' },
      evaluated_permission: 'allow',
    })
    expect(result).toMatchObject({
      tool_use_id: use?.id,
      content: [{ type: 'text', text: 'hi' }],
      is_error: false,
    })

    // The second request is built from the call and its answer: the assistant's turn carries
    // the text it streamed and the call it made, and the tool message answers it by id.
    expect(readPrompt(calls[1]!).map((entry) => entry.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ])
    expect(promptParts(calls[1]!).filter((part) => part.type === 'tool-call')).toMatchObject([
      { toolCallId: use?.id, toolName: 'echo', input: { text: 'hi' } },
    ])
    expect(promptParts(calls[1]!).filter((part) => part.type === 'tool-result')).toMatchObject([
      { toolCallId: use?.id, toolName: 'echo', output: { type: 'text', value: 'hi' } },
    ])
  })

  it('runs several calls of one step together and stores them in call order', async () => {
    const { store, sessionId } = await newSession([message('both')])
    const finished: string[] = []
    // A gate the second call opens: if the calls ran one after another the first could never
    // wait for the second, so this deadlocks rather than passing slowly.
    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      open = () => {
        resolve()
      }
    })
    const first: ToolDefinition<{ text: string }> = {
      ...echo({ name: 'slow' }).tool,
      run: async (input) => {
        finished.push('first started')
        await gate
        finished.push('first finished')
        return textResult(input.text)
      },
    }
    const second: ToolDefinition<{ text: string }> = {
      ...echo().tool,
      run: (input) => {
        finished.push('second finished')
        open()
        return textResult(input.text)
      },
    }
    const { factory, calls } = mockModel(
      {
        toolCalls: [
          { name: 'slow', input: { text: 'one' } },
          { name: 'echo', input: { text: 'two' } },
        ],
      },
      { text: ['Both done.'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([first, second]),
    })

    // The second call finished while the first was still waiting on it: they ran together,
    // and the answers are still stored in the order the model asked.
    expect(finished).toEqual(['first started', 'second finished', 'first finished'])
    const log = await logOf(store, sessionId)
    const uses = of(log, EVENT_TYPES.agentToolUse)
    const results = of(log, EVENT_TYPES.agentToolResult)
    expect(results.map(textOfEvent)).toEqual(['one', 'two'])
    expect(results.map((event) => event.tool_use_id)).toEqual(uses.map((event) => event.id))
    // The first step streamed no text, so it stored no message — the assistant's turn is its
    // calls — and the only reply in the log is the one the answers bought.
    expect(of(log, EVENT_TYPES.agentMessage)).toHaveLength(1)
    expect(readPrompt(calls[1]!).map((entry) => entry.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ])
  })

  it('keeps looping across steps until the model stops calling tools', async () => {
    const { store, sessionId } = await newSession([message('walk')])
    const { tool, run } = echo()
    const { factory, calls } = mockModel(
      { toolCalls: [{ name: 'echo', input: { text: 'step 1' } }] },
      { text: ['Almost.'], toolCalls: [{ name: 'echo', input: { text: 'step 2' } }] },
      { text: ['There.'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
    })

    expect(calls).toHaveLength(3)
    expect(run).toHaveBeenCalledTimes(2)
    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.modelRequestStart)).toHaveLength(3)
    expect(of(log, EVENT_TYPES.agentToolResult)).toHaveLength(2)
    expect(eventTypes(log).at(-1)).toBe(EVENT_TYPES.sessionStatusIdle)
  })

  it('ends the turn with a notice when the step limit is reached', async () => {
    const { store, sessionId } = await newSession([message('forever')])
    const { tool, run } = echo()
    const { factory, calls } = mockModel({
      toolCalls: [{ name: 'echo', input: { text: 'again' } }],
    })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      maxToolSteps: 2,
    })

    expect(outcome).toEqual({ outcome: 'error' })
    // Exactly the budget: two model requests, and no third.
    expect(calls).toHaveLength(2)
    expect(run).toHaveBeenCalledTimes(2)
    const log = await logOf(store, sessionId)
    const notice = of(log, EVENT_TYPES.sessionError)[0]
    expect(notice?.error.type).toBe('tool_steps_exhausted_error')
    expect(notice?.error.retry_status).toEqual({ type: 'terminal' })
    expect(notice?.error.message).toContain('limit of 2 model requests')
    // A notice, not an error loop: the turn goes idle and nothing is rescheduled.
    expect(eventTypes(log).at(-1)).toBe(EVENT_TYPES.sessionStatusIdle)
    expect(of(log, EVENT_TYPES.sessionStatusRescheduled)).toEqual([])
    // Every call the turn made was answered before it ended.
    expect(pendingToolUse(log)).toEqual([])
  })

  it('answers a call that runs past its timeout, and carries on', async () => {
    const { store, sessionId } = await newSession([message('slow tool')])
    const held = echo({
      name: 'slow',
      timeoutMs: 5,
      run: () => new Promise<never>(() => undefined),
    })
    const { factory, calls } = mockModel(
      { toolCalls: [{ name: 'slow', input: { text: 'x' } }] },
      { text: ['Never mind.'] },
    )

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([held.tool]),
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    const log = await logOf(store, sessionId)
    const result = of(log, EVENT_TYPES.agentToolResult)[0]
    expect(result).toMatchObject({ is_error: true })
    expect(textOfEvent(result)).toContain('timed out')
    // The model was told and answered: a timeout is information, not the end of the turn.
    expect(calls).toHaveLength(2)
  })

  it('answers an interrupted call and ends the turn as interrupted', async () => {
    const { store, sessionId } = await newSession([message('interrupt me')])
    const controller = new AbortController()
    const held = echo({
      name: 'hold',
      timeoutMs: 30_000,
      // Never resolves of its own accord: the call ends on the signal, which the registry
      // reports as the interrupt it is.
      run: () => new Promise<never>(() => undefined),
    })
    const { factory, calls } = mockModel({
      toolCalls: [{ name: 'hold', input: { text: 'x' } }],
    })
    // The interrupt arrives while the call is running, which is the case this pins.
    setTimeout(() => controller.abort(), 5)

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([held.tool]),
      signal: controller.signal,
    })

    expect(outcome).toEqual({ outcome: 'interrupted' })
    expect(calls).toHaveLength(1)
    const log = await logOf(store, sessionId)
    expect(textOfEvent(of(log, EVENT_TYPES.agentToolResult)[0])).toBe('Interrupted by the user.')
    expect(eventTypes(log).at(-1)).toBe(EVENT_TYPES.sessionStatusIdle)
  })

  it('refuses a call the policy denies, without running it', async () => {
    const { store, sessionId } = await newSession([message('denied')])
    const { tool, run } = echo()
    const { factory } = mockModel(
      { toolCalls: [{ name: 'echo', input: { text: 'x' } }] },
      { text: ['Understood.'] },
    )

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolPolicy: () => 'deny',
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(run).not.toHaveBeenCalled()
    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.agentToolUse)[0]).toMatchObject({ evaluated_permission: 'deny' })
    const result = of(log, EVENT_TYPES.agentToolResult)[0]
    expect(result).toMatchObject({ is_error: true })
    expect(textOfEvent(result)).toBe('Permission to use echo has been denied.')
    // The model still gets to answer: a refused call is information, not the end of the turn.
    expect(of(log, EVENT_TYPES.modelRequestStart)).toHaveLength(2)
  })

  it('answers a call for a tool nothing carries, and a call whose input is wrong', async () => {
    const { store, sessionId } = await newSession([message('bad calls')])
    const { tool, run } = echo()
    const { factory, calls } = mockModel(
      {
        toolCalls: [
          { name: 'nope', input: { text: 'x' } },
          { name: 'echo', input: { text: 42 } },
        ],
      },
      { text: ['Noted.'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
    })

    // Nothing was run: one call named a tool that does not exist, the other arguments the
    // tool's own schema refuses. Both are `is_error` results the model reads, and the turn
    // carries on — a bad call is information, not the end of anything.
    expect(run).not.toHaveBeenCalled()
    expect(calls).toHaveLength(2)
    const log = await logOf(store, sessionId)
    const results = of(log, EVENT_TYPES.agentToolResult)
    expect(textOfEvent(results[0])).toBe('No tool named "nope" is registered.')
    expect(textOfEvent(results[1])).toMatch(/^Invalid input for echo: /)
    expect(results.map((result) => result.is_error)).toEqual([true, true])
    // Both are recorded as denied: a call nothing may run is what `deny` says.
    expect(of(log, EVENT_TYPES.agentToolUse).map((event) => event.evaluated_permission)).toEqual([
      'deny',
      'allow',
    ])
  })

  it('treats an unhonoured `ask` as a refusal rather than running the call', async () => {
    const { store, sessionId } = await newSession([message('maybe')])
    const { tool, run } = echo()
    const { factory } = mockModel(
      { toolCalls: [{ name: 'echo', input: { text: 'x' } }] },
      { text: ['Fine.'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolPolicy: () => 'ask',
    })

    // `ask` is the pause of #309; until pausing exists the safe reading is "do not run it".
    expect(run).not.toHaveBeenCalled()
    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.agentToolUse)[0]).toMatchObject({ evaluated_permission: 'ask' })
    expect(of(log, EVENT_TYPES.agentToolResult)[0]).toMatchObject({ is_error: true })
  })

  it('asks the policy once per call with the session’s owner', async () => {
    const { store, sessionId } = await newSession([message('who')])
    const { tool } = echo()
    const policy = vi.fn<ToolPolicyResolver>(() => 'allow')
    const { factory } = mockModel(
      {
        toolCalls: [
          { name: 'echo', input: { text: 'a' } },
          { name: 'echo', input: { text: 'b' } },
        ],
      },
      { text: ['Done.'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolPolicy: policy,
    })

    expect(policy.mock.calls).toEqual([
      ['echo', 'user_brain_tests'],
      ['echo', 'user_brain_tests'],
    ])
  })

  it('hands a tool the turn’s resolved values, and scrubs them out of its answer', async () => {
    const { store, sessionId } = await newSession([message('secret')])
    const tool: ToolDefinition = {
      name: 'leak',
      description: 'Say the key back.',
      inputSchema: z.object({}),
      permission: 'allow',
      run: (_input, context) => textResult(`the key is ${context.secrets['key'] ?? 'none'}`),
    }
    const { factory } = mockModel(
      { toolCalls: [{ name: 'leak', input: {} }] },
      { text: ['Noted.'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      resolveToolSecrets: () => Promise.resolve({ key: 'hunter2' }),
    })

    const result = of(await logOf(store, sessionId), EVENT_TYPES.agentToolResult)[0]
    expect(textOfEvent(result)).toBe('the key is [REDACTED]')
  })

  it('offers no tools to a model the registry says cannot call them', async () => {
    const { store, sessionId } = await newSession([message('plain chat')])
    const { tool, run } = echo()
    const support: ToolSupportFor = () => false
    const { factory, calls } = mockModel({ text: ['Just chat.'] })

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolSupportFor: support,
    })

    expect(run).not.toHaveBeenCalled()
    expect(offeredTo(calls[0]!)).toBeUndefined()
    const span = of(await logOf(store, sessionId), EVENT_TYPES.modelRequestStart)[0]
    expect(span?.tools).toBeUndefined()
  })

  it('offers tools when nothing is known about the model', async () => {
    const { store, sessionId } = await newSession([message('unknown model')])
    const { tool } = echo()
    const { factory, calls } = mockModel({ text: ['Hi.'] })

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
    })

    expect(offeredTo(calls[0]!)).toMatchObject([
      { type: 'function', name: 'echo', description: 'Echo the text back.' },
    ])
    const span = of(await logOf(store, sessionId), EVENT_TYPES.modelRequestStart)[0]
    expect(span?.tools).toEqual([{ name: 'echo', source: 'builtin' }])
  })

  it('offers nothing at all when the host wired no registry', async () => {
    const { store, sessionId } = await newSession([message('no registry')])
    const { factory, calls } = mockModel({ text: ['Just chat.'] })

    await runTurn(sessionId, { store, model: factory, resolveCredential: resolveTestCredential })

    expect(offeredTo(calls[0]!)).toBeUndefined()
    expect(of(await logOf(store, sessionId), EVENT_TYPES.agentToolUse)).toEqual([])
  })
})

describe('a turn that inherits a lost execution', () => {
  it('answers a call whose request never stored a result, without running it', async () => {
    const { store, sessionId } = await newSession()
    const { tool, run } = echo()
    // The log a brain that died mid-execution leaves: the request finished, the model had
    // asked for a tool, and nothing ever answered it.
    const stored = await store.appendEvents(sessionId, [
      makeUserMessage('do it', { processed_at: null }),
      statusRunning(),
      spanStart([], TEST_MODEL_ID),
    ])
    const crashed = spanStartOf(stored[2])
    await store.appendEvents(sessionId, [
      agentToolUse('echo', { text: 'once' }, 'allow'),
      spanEnd(crashed.id, ZERO_MODEL_USAGE),
    ])
    const { factory, calls } = mockModel({ text: ['The tool was lost.'] })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    // Never re-run (X3): whatever the call did may already have happened.
    expect(run).not.toHaveBeenCalled()
    const log = await logOf(store, sessionId)
    const use = of(log, EVENT_TYPES.agentToolUse)[0]
    const result = of(log, EVENT_TYPES.agentToolResult)[0]
    expect(result).toMatchObject({ tool_use_id: use?.id, is_error: true })
    expect(textOfEvent(result)).toContain('execution lost')
    // The model gets the loss as the answer to its call — a provider refuses a call with no
    // answer — and answers it.
    expect(promptParts(calls[0]!).filter((part) => part.type === 'tool-result')).toMatchObject([
      { toolCallId: result?.tool_use_id, toolName: 'echo', output: { type: 'error-text' } },
    ])
    expect(textOf(of(log, EVENT_TYPES.agentMessage)[0])).toBe('The tool was lost.')
  })

  it('closes the span a dead brain left open, then repairs the call', async () => {
    const { store, sessionId } = await newSession()
    const { tool, run } = echo()
    const stored = await store.appendEvents(sessionId, [
      makeUserMessage('do it', { processed_at: null }),
      statusRunning(),
      spanStart([], TEST_MODEL_ID),
      agentToolUse('echo', { text: 'once' }, 'allow'),
    ])
    const crashed = spanStartOf(stored[2])
    const { factory, calls } = mockModel({ text: ['Carried on.'] })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(run).not.toHaveBeenCalled()
    const log = await logOf(store, sessionId)
    expect(
      of(log, EVENT_TYPES.modelRequestEnd).find(
        (event) => event.model_request_start_id === crashed.id,
      ),
    ).toMatchObject({ error: { type: 'brain_lost' } })
    expect(textOfEvent(of(log, EVENT_TYPES.agentToolResult)[0])).toContain('execution lost')
    expect(calls).toHaveLength(1)
  })
})

describe('steering during a tool step', () => {
  it('folds a message that arrives while a tool runs into the next request', async () => {
    const { store, sessionId } = await newSession([message('start')])
    const late = echo({
      name: 'late',
      run: async (input: { text: string }) => {
        await store.appendEvents(sessionId, [makeUserMessage('also this', { processed_at: null })])
        return textResult(input.text)
      },
    })
    const { factory, calls } = mockModel(
      { toolCalls: [{ name: 'late', input: { text: 'done' } }] },
      { text: ['And the steered message.'] },
    )

    await runTurn(sessionId, {
      store,
      model: factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([late.tool]),
    })

    expect(calls).toHaveLength(2)
    expect(readPrompt(calls[1]!).map((entry) => entry.text)).toContain('also this')
    const spans = of(await logOf(store, sessionId), EVENT_TYPES.modelRequestStart)
    // The steered message is claimed by the request after the tool step, not by the step's own
    // — the step answers the calls it was given, and nothing else.
    expect(spans[1]?.consumes).toHaveLength(1)
  })
})

describe('the tool helpers on their own', () => {
  it('coerces a call’s arguments to the JSON the log stores', () => {
    expect(asToolInput({ a: 1, b: [true, null, { c: 'd' }] })).toEqual({
      a: 1,
      b: [true, null, { c: 'd' }],
    })
    // Nothing JSON can carry: a function, a non-finite number, an absent value.
    expect(
      asToolInput({ keep: 'me', drop: () => undefined, nan: Number.NaN, gone: undefined }),
    ).toEqual({ keep: 'me' })
    expect(asToolInput('not an object')).toEqual({})
    expect(asToolInput(null)).toEqual({})
    expect(asToolInput([1, 2])).toEqual({})
  })

  it('pairs calls with their answers by id', () => {
    const first = { ...agentToolUse('a', {}, 'allow'), id: 'sevt_a' } as never
    const answered = { ...agentToolUse('b', {}, 'allow'), id: 'sevt_b' } as never
    const result = { type: EVENT_TYPES.agentToolResult, tool_use_id: 'sevt_b' } as never

    expect(pendingToolUse([first, answered, result]).map((event) => event.name)).toEqual(['a'])
  })

  it('answers the offering question with the registry, not a boolean', () => {
    const registry = createToolRegistry([echo().tool])

    expect(toolsFor(registry, undefined, 'any/model', 'api_key')).toBe(registry)
    expect(toolsFor(registry, () => true, 'any/model', 'api_key')).toBe(registry)
    expect(toolsFor(registry, () => false, 'any/model', 'api_key')).toBeUndefined()
    expect(toolsFor(undefined, undefined, 'any/model', 'api_key')).toBeUndefined()
  })

  it('caps the step budget where a real task cannot reach it by accident', () => {
    expect(DEFAULT_MAX_TOOL_STEPS).toBe(50)
  })
})
