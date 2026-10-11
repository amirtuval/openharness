import { describe, expect, it } from 'vitest'

import { makeModelEntry } from '@openharness/protocol/fixtures'

import {
  TOOL_STEPS_EXHAUSTED_NOTICE,
  clearedResultsNotice,
  formatToolInput,
  modelSupportsTools,
  stepLimitNotice,
  toolCallStatus,
  toolCallSummary,
  toolStatusLabel,
  truncatedResultsNotice,
} from './tools'

describe('toolCallStatus', () => {
  const running = { waiting: false, running: true }
  const idle = { waiting: false, running: false }

  it('is running while a call is out on a working turn', () => {
    expect(toolCallStatus('allow', undefined, running)).toBe('running')
  })

  it('is lost when the turn ends and nothing answered the call', () => {
    expect(toolCallStatus('allow', undefined, idle)).toBe('lost')
  })

  it('waits when the policy asked the user, even on a working turn', () => {
    expect(toolCallStatus('ask', undefined, running)).toBe('waiting')
    expect(toolCallStatus('ask', undefined, idle)).toBe('waiting')
  })

  it('waits when the turn ended naming the call, whatever its permission', () => {
    expect(toolCallStatus('allow', undefined, { waiting: true, running: false })).toBe('waiting')
  })

  it('is done for a result that is not an error', () => {
    expect(toolCallStatus('allow', { content: 'ok', isError: false }, idle)).toBe('done')
  })

  it('reads the brain’s own sentences out of an error result', () => {
    const cases: readonly [string, string][] = [
      ['Interrupted by the user.', 'interrupted'],
      [
        'Tool web_fetch: execution lost. The turn that started this call did not finish, so it was not run again.',
        'lost',
      ],
      ['Permission to use web_fetch has been denied.', 'denied'],
      ['The user denied this.', 'denied'],
      ['The user denied this: not that URL', 'denied'],
      ['Tool web_fetch timed out after 30s', 'error'],
      ['The user sent a message instead.', 'error'],
    ]
    for (const [content, expected] of cases) {
      expect(toolCallStatus('allow', { content, isError: true }, idle)).toBe(expected)
    }
  })
})

describe('toolStatusLabel', () => {
  it('gives "waiting for you" for a paused call — the sentence a reader is owed', () => {
    expect(toolStatusLabel('waiting')).toBe('waiting for you')
    expect(toolStatusLabel('lost')).toBe('execution lost')
    expect(toolStatusLabel('done')).toBe('done')
  })
})

describe('toolCallSummary', () => {
  it('summarizes the built-ins worth their own words', () => {
    expect(toolCallSummary({ name: 'web_fetch', input: { url: 'https://example.com' } })).toBe(
      'https://example.com',
    )
    expect(toolCallSummary({ name: 'web_search', input: { query: 'openharness', count: 5 } })).toBe(
      'openharness',
    )
    expect(
      toolCallSummary({
        name: 'todo_write',
        input: { todos: [{ content: 'a', status: 'pending' }] },
      }),
    ).toBe('1 task')
    expect(toolCallSummary({ name: 'todo_write', input: { todos: [] } })).toBe('0 tasks')
    expect(
      toolCallSummary({
        name: 'ask_user',
        input: { questions: [{ question: 'Which one?', header: 'Pick', type: 'text' }] },
      }),
    ).toBe('Which one?')
  })

  it('falls back to the first string value, so an unknown tool still says something', () => {
    expect(toolCallSummary({ name: 'echo', input: { text: 'hi' } })).toBe('hi')
    expect(toolCallSummary({ name: 'mcp__srv__fetch', input: { url: 'https://x.test' } })).toBe(
      'https://x.test',
    )
  })

  it('says nothing when the input holds no string and no known shape', () => {
    expect(toolCallSummary({ name: 'count', input: { n: 3 } })).toBeNull()
  })
})

describe('formatToolInput', () => {
  it('pretty-prints the input two-space indented', () => {
    expect(formatToolInput({ url: 'https://example.com' })).toBe(
      '{\n  "url": "https://example.com"\n}',
    )
  })
})

describe('notices', () => {
  it('says how many tool results were shortened', () => {
    expect(truncatedResultsNotice([])).toBeNull()
    expect(
      truncatedResultsNotice([
        { seq: 1, tool: 'web_fetch', tokensBefore: 9000, tokensAfter: 4000 },
      ]),
    ).toBe('One tool result was too long for this model and was shortened.')
    expect(
      truncatedResultsNotice([
        { seq: 1, tool: 'web_fetch', tokensBefore: 9000, tokensAfter: 4000 },
        { seq: 2, tool: 'web_fetch', tokensBefore: 9000, tokensAfter: 4000 },
      ]),
    ).toBe('2 tool results were too long for this model and were shortened.')
  })

  it('says how many old results were cleared', () => {
    expect(clearedResultsNotice(null)).toBeNull()
    expect(clearedResultsNotice({ results: 0, tokens: 0 })).toBeNull()
    expect(clearedResultsNotice({ results: 1, tokens: 900 })).toBe(
      'An older tool result was cleared to make room in the context.',
    )
    expect(clearedResultsNotice({ results: 3, tokens: 2700 })).toBe(
      '3 older tool results were cleared to make room in the context.',
    )
  })

  it('takes the brain’s own step-limit sentence, falling back to its own', () => {
    expect(stepLimitNotice(null)).toBeNull()
    expect(stepLimitNotice({ type: 'model_error', message: 'boom' })).toBeNull()
    expect(
      stepLimitNotice({
        type: 'tool_steps_exhausted_error',
        message: 'This turn reached its limit of 50',
      }),
    ).toBe('This turn reached its limit of 50')
    expect(stepLimitNotice({ type: 'tool_steps_exhausted_error', message: '' })).toBe(
      TOOL_STEPS_EXHAUSTED_NOTICE,
    )
  })
})

describe('modelSupportsTools', () => {
  it('reads the catalog’s flag, and claims nothing without an entry', () => {
    expect(modelSupportsTools(makeModelEntry({ tool_call: true }))).toBe(true)
    expect(modelSupportsTools(makeModelEntry({ tool_call: false }))).toBe(false)
    expect(modelSupportsTools(undefined)).toBeNull()
    expect(modelSupportsTools(null)).toBeNull()
  })
})
