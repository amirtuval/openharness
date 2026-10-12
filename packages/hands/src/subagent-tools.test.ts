import { newTaskId } from '@openharness/protocol'
import { describe, expect, it, vi } from 'vitest'

import { createToolRegistry } from './registry'
import {
  AGENT_TOOL_DESCRIPTION,
  HARNESS_ANSWERED,
  HARNESS_TOOL_HANDLERS,
  SUBAGENT_TOOL_NAMES,
  agentToolDescription,
  agentWaitTool,
  createSubagentTools,
  isSubagentToolName,
  type SubagentToolHandlers,
} from './subagent-tools'
import { errorResult, textResult } from './tool'

/**
 * The handlers a test watches, each answering what the harness would answer.
 *
 * The spies are handed back beside the handler set rather than kept as methods on it, so an
 * assertion names one of them without reading a method off an object (the shape
 * `@typescript-eslint/unbound-method` is there to catch).
 */
function testHandlers() {
  const start = vi.fn(() => textResult('task_handle'))
  const message = vi.fn(() => textResult('The task was told.'))
  const stop = vi.fn(() => textResult('The task was stopped.'))
  const messageParent = vi.fn(() => textResult('The parent was told.'))
  return {
    handlers: { start, message, stop, messageParent },
    spies: { start, message, stop, messageParent },
  }
}

/** One registry over the five tools, with the types a real deployment would offer. */
function registryFacing(handlers: SubagentToolHandlers) {
  return createToolRegistry(
    createSubagentTools({
      types: [
        { name: 'general-purpose', description: 'Anything, in a fresh context.' },
        { name: 'researcher', description: 'Reads the web and reports.' },
      ],
      handlers,
    }),
  )
}

/** The text of a result, whichever tool answered it. */
function textOf(result: { content: readonly { text: string }[] }): string {
  return result.content.map((block) => block.text).join('')
}

describe('the subagent tools (S5; #344)', () => {
  it('offers the five under the names the model calls them by, all allowed by default', () => {
    const tools = createSubagentTools({ types: [], handlers: HARNESS_TOOL_HANDLERS })
    expect(tools.map((tool) => tool.name)).toEqual([
      'agent',
      'agent_message',
      'agent_wait',
      'agent_stop',
      'message_parent',
    ])
    expect(tools.map((tool) => tool.permission)).toEqual(Array(5).fill('allow'))
  })

  it('names the five once, and tells them from a tool that is not one', () => {
    for (const name of ['agent', 'agent_message', 'agent_wait', 'agent_stop', 'message_parent']) {
      expect(SUBAGENT_TOOL_NAMES).toContain(name)
      expect(isSubagentToolName(name)).toBe(true)
    }
    expect(isSubagentToolName('task_start')).toBe(false)
    expect(isSubagentToolName('web_fetch')).toBe(false)
    expect(isSubagentToolName('message')).toBe(false)
  })

  it('lists the types in the `agent` description, in the order it was handed them', () => {
    const description = agentToolDescription([
      { name: 'general-purpose', description: 'Anything, in a fresh context.' },
      { name: 'researcher', description: 'Reads the web and reports.' },
    ])
    expect(description.startsWith(AGENT_TOOL_DESCRIPTION)).toBe(true)
    expect(description).toContain('Types:\n- general-purpose: Anything, in a fresh context.')
    expect(description.indexOf('general-purpose')).toBeLessThan(description.indexOf('researcher'))
    expect(description).toContain('- researcher: Reads the web and reports.')
  })

  it('carries the description alone when the deployment offers no type at all', () => {
    // A deployment whose resolver answered nothing still describes the tool: the words are the
    // model's, and an empty list is nothing to render.
    expect(agentToolDescription([])).toBe(AGENT_TOOL_DESCRIPTION)
    expect(AGENT_TOOL_DESCRIPTION).toContain('notification')
  })

  it('runs a call through the handler, with the input its own schema parsed', async () => {
    const { handlers, spies } = testHandlers()
    const registry = registryFacing(handlers)
    const result = await registry.execute('agent', {
      type: 'general-purpose',
      description: 'Check the rewind path',
      prompt: 'Read the rewind code and report what it does.',
    })
    expect(spies.start).toHaveBeenCalledTimes(1)
    expect(spies.start).toHaveBeenCalledWith({
      type: 'general-purpose',
      description: 'Check the rewind path',
      prompt: 'Read the rewind code and report what it does.',
    })
    expect(textOf(result)).toBe('task_handle')
    expect(result.isError).not.toBe(true)
  })

  it('runs the three others through their own handler', async () => {
    const { handlers, spies } = testHandlers()
    const registry = registryFacing(handlers)
    const taskId = newTaskId()
    expect(
      textOf(await registry.execute('agent_message', { task_id: taskId, text: 'go on' })),
    ).toBe('The task was told.')
    expect(textOf(await registry.execute('agent_stop', { task_id: taskId }))).toBe(
      'The task was stopped.',
    )
    expect(textOf(await registry.execute('message_parent', { text: 'half way' }))).toBe(
      'The parent was told.',
    )
    expect(spies.message).toHaveBeenCalledWith({ task_id: taskId, text: 'go on' })
    expect(spies.stop).toHaveBeenCalledWith({ task_id: taskId })
    expect(spies.messageParent).toHaveBeenCalledWith({ text: 'half way' })
  })

  it('answers a call whose arguments the schema refuses without running it', async () => {
    const { handlers, spies } = testHandlers()
    const registry = registryFacing(handlers)
    const result = await registry.execute('agent_message', { task_id: 'sesn_nope', text: 'hi' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('task_id')
    expect(spies.message).not.toHaveBeenCalled()
  })

  it('passes an error result a handler answered straight through', async () => {
    // What a refusal the parent model is meant to act on looks like: an unknown type, a
    // `task_id` this session does not have. It is a result, not a throw — the model reads the
    // sentence and picks another type.
    const { handlers } = testHandlers()
    const registry = createToolRegistry(
      createSubagentTools({
        types: [],
        handlers: {
          ...handlers,
          start: () => errorResult('There is no subagent type named `nope`.'),
        },
      }),
    )
    const result = await registry.execute('agent', {
      type: 'nope',
      description: 'Anything',
      prompt: 'Anything',
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('There is no subagent type named `nope`.')
  })

  it('offers `agent_wait` as the wait it is, with the protocol’s own input', () => {
    const tool = agentWaitTool()
    expect(tool.name).toBe('agent_wait')
    expect(tool.permission).toBe('allow')
    expect(tool.description).toContain('600')
    expect(tool.inputSchema.safeParse({ task_ids: [newTaskId()], timeout_s: 30 }).success).toBe(
      true,
    )
    expect(tool.inputSchema.safeParse({ task_ids: ['nope'] }).success).toBe(false)
  })

  it('answers the sentence a harness would have run, when nothing answers it', () => {
    // The one `run` nothing in a real turn can reach: the loop recognises an `agent_wait` call by
    // name and ends the turn in a durable wait instead of running anything (`waitsForTasks`).
    // Should something call it anyway, the log says what is true rather than pretending.
    const result = agentWaitTool().run({}, { timeoutMs: 1000, secrets: {} })
    expect(result).toEqual(errorResult(HARNESS_ANSWERED))
  })

  it('hands a deployment that wired nothing the same honest sentence for the four others', async () => {
    const registry = createToolRegistry(
      createSubagentTools({ types: [], handlers: HARNESS_TOOL_HANDLERS }),
    )
    const result = await registry.execute('message_parent', { text: 'hello' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(HARNESS_ANSWERED)
  })
})
