import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { ToolDefinition, ToolExecutionContext } from './tool'
import { DEFAULT_TOOL_TIMEOUT_MS, textResult } from './tool'
import { createToolRegistry, scrubText } from './registry'

/**
 * The registry on its own: which call runs, what a tool is handed, and every way a call can
 * end. The tools here are locals — the built-in ones arrive with #305 — because what is under
 * test is the contract between the registry and *any* tool.
 */

/** `echo`, the tool every test starts from: it returns the text it was called with. */
function echoTool(overrides: Partial<ToolDefinition<{ text: string }>> = {}) {
  return {
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: z.object({ text: z.string() }),
    permission: 'allow',
    run: (input: { text: string }) => textResult(input.text),
    ...overrides,
  } satisfies ToolDefinition<{ text: string }>
}

describe('createToolRegistry', () => {
  it('holds the tools in registration order and looks one up by name', () => {
    const echo = echoTool()
    const other: ToolDefinition = { ...echoTool(), name: 'other', description: 'Other.' }
    const registry = createToolRegistry([echo, other])

    expect(registry.tools).toEqual([echo, other])
    expect(registry.get('other')).toBe(other)
    expect(registry.get('missing')).toBeUndefined()
  })

  it('refuses two tools under one name', () => {
    expect(() => createToolRegistry([echoTool(), echoTool()])).toThrow(/two tools are registered/)
  })

  it('hands the tool its parsed input and the turn it runs in', async () => {
    const run = vi.fn((_input: { text: string }, _context: ToolExecutionContext) =>
      textResult('ok'),
    )
    const registry = createToolRegistry([echoTool({ run, timeoutMs: 1234 })])

    const result = await registry.execute('echo', { text: 'hi' }, { secrets: { key: 's3cret' } })

    expect(result).toEqual(textResult('ok'))
    expect(run).toHaveBeenCalledTimes(1)
    const [input, context] = run.mock.calls[0] ?? []
    expect(input).toEqual({ text: 'hi' })
    expect(context?.timeoutMs).toBe(1234)
    expect(context?.secrets).toEqual({ key: 's3cret' })
    expect(context?.signal).toBeInstanceOf(AbortSignal)
  })

  it('answers with no context at all: no values, and the tool’s own timeout', async () => {
    const run = vi.fn((_input: { text: string }, _context: ToolExecutionContext) =>
      textResult('ok'),
    )
    const registry = createToolRegistry([echoTool({ run })])

    await registry.execute('echo', { text: 'hi' })

    expect(run.mock.calls[0]?.[1]).toMatchObject({
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      secrets: {},
    })
  })
})

describe('ToolRegistry.execute', () => {
  it('fails an unregistered name without running anything', async () => {
    const registry = createToolRegistry([echoTool()])

    const result = await registry.execute('nope', {})

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'No tool named "nope" is registered.' }])
  })

  it('fails input its own schema refuses, naming the field', async () => {
    const run = vi.fn(() => textResult('ok'))
    const registry = createToolRegistry([echoTool({ run })])

    const result = await registry.execute('echo', { text: 42 })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toMatch(/^Invalid input for echo: text: /)
    expect(run).not.toHaveBeenCalled()
  })

  it('fails a tool that throws, with the error’s message and no stack', async () => {
    const registry = createToolRegistry([
      echoTool({
        run: () => {
          throw new Error('the tool blew up')
        },
      }),
    ])

    const result = await registry.execute('echo', { text: 'hi' })

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Tool echo failed: the tool blew up' }],
      isError: true,
    })
  })

  it('reports a failure with nothing to say as one plain sentence', async () => {
    const registry = createToolRegistry([
      // An `Error` with an empty message is what a library that classifies its own failures
      // often throws; `String(error)` would store the bare word `Error`.
      echoTool({
        run: () => {
          throw new Error('')
        },
      }),
    ])

    const result = await registry.execute('echo', { text: 'hi' })

    expect(result.content).toEqual([{ type: 'text', text: 'Tool echo failed: an unknown error' }])
  })

  it('fails a call that runs past its timeout', async () => {
    const registry = createToolRegistry([
      echoTool({
        timeoutMs: 5,
        // Ignores the signal entirely: the registry still cuts the call short, which is what
        // makes one hung tool unable to hold a turn open.
        run: () => new Promise((resolve) => setTimeout(() => resolve(textResult('late')), 50)),
      }),
    ])

    const result = await registry.execute('echo', { text: 'hi' })

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Tool echo timed out after 5 ms.' }],
      isError: true,
    })
  })

  it('lets the host lower a tool’s own timeout, and never raise it', async () => {
    const run = vi.fn((_input: { text: string }, _context: ToolExecutionContext) =>
      textResult('ok'),
    )
    const registry = createToolRegistry([echoTool({ run, timeoutMs: 60_000 })])

    await registry.execute('echo', { text: 'hi' }, { timeoutMs: 2_000 })
    const context = run.mock.calls[0]?.[1]
    expect(context?.timeoutMs).toBe(2_000)

    await registry.execute('echo', { text: 'hi' }, { timeoutMs: 900_000 })
    expect(run.mock.calls[1]?.[1]?.timeoutMs).toBe(60_000)
  })

  it('reports a call the turn aborted as interrupted, whatever the tool answered', async () => {
    const controller = new AbortController()
    const registry = createToolRegistry([
      echoTool({
        run: async () => {
          controller.abort()
          // A tool that cooperates by returning its own "stopped" answer is still reported as
          // the interrupt it was: the model is owed one story about the call.
          await Promise.resolve()
          return textResult('stopped early')
        },
      }),
    ])

    const result = await registry.execute('echo', { text: 'hi' }, { signal: controller.signal })

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Interrupted by the user.' }],
      isError: true,
    })
  })

  it('does not start a call for a turn already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = vi.fn(() => textResult('ok'))
    const registry = createToolRegistry([echoTool({ run })])

    const result = await registry.execute('echo', { text: 'hi' }, { signal: controller.signal })

    expect(run).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })
})

describe('the turn’s secrets', () => {
  it('are scrubbed out of a result, whole-value only', async () => {
    const registry = createToolRegistry([
      echoTool({ run: () => textResult('the key is hunter2-not-quite') }),
    ])

    const result = await registry.execute('echo', { text: 'hi' }, { secrets: { key: 'hunter2' } })

    expect(result.content).toEqual([{ type: 'text', text: 'the key is [REDACTED]-not-quite' }])
  })

  it('are scrubbed out of a thrown message, so a tool cannot leak one into the log', async () => {
    const registry = createToolRegistry([
      echoTool({
        run: () => {
          throw new Error('the server refused hunter2')
        },
      }),
    ])

    const result = await registry.execute('echo', { text: 'hi' }, { secrets: { key: 'hunter2' } })

    expect(result.content).toEqual([
      { type: 'text', text: 'Tool echo failed: the server refused [REDACTED]' },
    ])
  })

  it('leaves an empty value alone', () => {
    expect(scrubText('a-b', ['', '-'])).toBe('a[REDACTED]b')
  })
})
