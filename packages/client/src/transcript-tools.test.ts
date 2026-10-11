import { describe, expect, it } from 'vitest'

import {
  makeAgentMessage,
  makeAgentToolResult,
  makeAgentToolUse,
  makeModelRequestStart,
  makeSessionRewind,
  makeStatusIdle,
  makeStatusRunning,
  makeUserMessage,
} from '@openharness/protocol/fixtures'
import { newEventId } from '@openharness/protocol'
import type { StreamEvent } from '@openharness/protocol'

import {
  initialTranscriptState,
  reduceTranscriptAll,
  selectClearedToolResults,
  selectToolCalls,
  selectTranscriptEntries,
  selectTruncatedToolResults,
} from './transcript'

/** Fold a sequence of events into a fresh transcript. */
function reduce(events: readonly StreamEvent[]) {
  return reduceTranscriptAll(initialTranscriptState(), events)
}

/** The call a log holds, or a failure that names what was there instead. */
function onlyCall(events: readonly StreamEvent[]) {
  const calls = selectToolCalls(reduce(events))
  expect(calls).toHaveLength(1)
  return calls[0]!
}

describe('tool calls in the transcript (#303, #308)', () => {
  it('adds a call as its own entry, interleaved with the messages by position', () => {
    const user = makeUserMessage('fetch that', { seq: 1, processed_at: null })
    const call = makeAgentToolUse('web_fetch', { url: 'https://example.com' }, { seq: 2 })
    const result = makeAgentToolResult(call, 'the page', { seq: 3 })
    const reply = makeAgentMessage('It says hello.', { seq: 4 })

    const state = reduce([user, call, result, reply])

    expect(selectTranscriptEntries(state).map((entry) => entry.kind)).toEqual([
      'message',
      'tool',
      'message',
    ])
    expect(selectTranscriptEntries(state)[1]).toMatchObject({
      kind: 'tool',
      call: { name: 'web_fetch', position: 2 },
    })
  })

  it('derives the status from the result, the way the brain worded it', () => {
    const base = makeAgentToolUse('web_fetch', { url: 'https://example.com' })
    const call = { ...base, seq: 2 }

    expect(onlyCall([makeStatusRunning({ seq: 1 }), call]).status).toBe('running')

    expect(onlyCall([call, makeAgentToolResult(call, 'the page', { seq: 3 })]).status).toBe('done')

    expect(
      onlyCall([
        call,
        makeAgentToolResult(call, 'Tool web_fetch timed out', { seq: 3, is_error: true }),
      ]).status,
    ).toBe('error')

    expect(
      onlyCall([
        call,
        makeAgentToolResult(call, 'Permission to use web_fetch has been denied.', {
          seq: 3,
          is_error: true,
        }),
      ]).status,
    ).toBe('denied')

    expect(
      onlyCall([
        call,
        makeAgentToolResult(call, 'Interrupted by the user.', { seq: 3, is_error: true }),
      ]).status,
    ).toBe('interrupted')

    expect(
      onlyCall([
        call,
        makeAgentToolResult(call, 'Tool web_fetch: execution lost. …', { seq: 3, is_error: true }),
      ]).status,
    ).toBe('lost')
  })

  it('shows an `ask` policy as waiting for you, and keeps it waiting as the turn ends', () => {
    const call = makeAgentToolUse(
      'web_fetch',
      { url: 'https://x.test' },
      {
        seq: 2,
        evaluated_permission: 'ask',
      },
    )
    const idle = makeStatusIdle({
      seq: 3,
      stop_reason: { type: 'requires_action', event_ids: [call.id] },
    })

    const state = reduce([makeStatusRunning({ seq: 1 }), call, idle])

    expect(selectToolCalls(state)[0]?.status).toBe('waiting')
  })

  it('reports a call nothing answered when the turn ends as lost, not running', () => {
    const call = makeAgentToolUse('web_fetch', { url: 'https://x.test' }, { seq: 2 })
    const state = reduce([makeStatusRunning({ seq: 1 }), call, makeStatusIdle({ seq: 3 })])

    expect(selectToolCalls(state)[0]?.status).toBe('lost')
  })

  it('keeps a finished call done across the idle that ends the turn', () => {
    const call = makeAgentToolUse('echo', { text: 'hi' }, { seq: 2 })
    const state = reduce([
      makeStatusRunning({ seq: 1 }),
      call,
      makeAgentToolResult(call, 'hi', { seq: 3 }),
      makeStatusIdle({ seq: 4 }),
    ])

    expect(selectToolCalls(state)[0]?.status).toBe('done')
  })

  it('stamps the call’s source from the request’s own offered-tools record', () => {
    const start = makeModelRequestStart({
      seq: 1,
      tools: [
        { name: 'web_fetch', source: 'builtin' },
        { name: 'srv_search', source: 'mcp' },
      ],
    })
    const builtin = makeAgentToolUse('web_fetch', { url: 'https://x.test' }, { seq: 2 })
    const mcp = makeAgentToolUse('srv_search', { query: 'x' }, { seq: 3 })

    const calls = selectToolCalls(reduce([start, builtin, mcp]))

    expect(calls.map((call) => [call.name, call.source])).toEqual([
      ['web_fetch', 'builtin'],
      ['srv_search', 'mcp'],
    ])
  })

  it('defaults a call to builtin when no request record names it', () => {
    const call = makeAgentToolUse('echo', { text: 'hi' }, { seq: 2 })
    expect(selectToolCalls(reduce([call]))[0]?.source).toBe('builtin')
  })

  it('drops the calls a rewind took back, and keeps the ones before it', () => {
    const kept = makeAgentToolUse('echo', { text: 'kept' }, { seq: 2 })
    const rewind = makeSessionRewind({ seq: 6, supersedes: { from_seq: 4, to_seq: 5 } })
    const dropped = makeAgentToolUse('echo', { text: 'dropped' }, { seq: 4 })

    const state = reduce([
      makeUserMessage('one', { seq: 1, processed_at: null }),
      kept,
      makeAgentToolResult(kept, 'kept', { seq: 3 }),
      dropped,
      makeAgentMessage('reply', { seq: 5 }),
      rewind,
    ])

    expect(selectToolCalls(state).map((call) => call.id)).toEqual([kept.id])
  })

  it('records the tool results a request shortened and the old ones it cleared', () => {
    const start = makeModelRequestStart({
      seq: 1,
      truncated: {
        seq: 5,
        tokens_before: 12_000,
        tokens_after: 4_000,
        results: [{ seq: 5, tool: 'web_fetch', tokens_before: 12_000, tokens_after: 4_000 }],
      },
      cleared: { results: 2, tokens: 1800 },
    })

    const state = reduce([start])

    expect(selectTruncatedToolResults(state)).toEqual([
      { seq: 5, tool: 'web_fetch', tokensBefore: 12_000, tokensAfter: 4_000 },
    ])
    expect(selectClearedToolResults(state)).toEqual({ results: 2, tokens: 1800 })
  })

  it('clears both notices when the next real request capped and cleared nothing', () => {
    const first = makeModelRequestStart({
      seq: 1,
      truncated: { seq: 2, tokens_before: 100, tokens_after: 50 },
      cleared: { results: 1, tokens: 100 },
    })
    const next = makeModelRequestStart({ seq: 3 })

    const state = reduce([first, next])

    expect(selectTruncatedToolResults(state)).toEqual([])
    expect(selectClearedToolResults(state)).toBeNull()
  })

  it('drops the notices a rewind took back with the branch they described', () => {
    const start = makeModelRequestStart({
      seq: 4,
      cleared: { results: 1, tokens: 100 },
    })

    const state = reduce([
      start,
      makeSessionRewind({ seq: 9, supersedes: { from_seq: 3, to_seq: 8 } }),
    ])

    expect(selectClearedToolResults(state)).toBeNull()
  })

  it('ignores a result for a call the client never saw', () => {
    const orphan = makeAgentToolResult(makeAgentToolUse('echo', { text: 'x' }, { seq: 1 }), 'x', {
      id: newEventId(),
      tool_use_id: newEventId(),
      seq: 2,
    })

    expect(selectToolCalls(reduce([orphan]))).toEqual([])
  })

  it('is idempotent: folding the same call twice changes nothing', () => {
    const call = makeAgentToolUse('echo', { text: 'hi' }, { seq: 2 })
    // The same seq is dropped by the ordinary dedupe, so a re-delivered call adds no line.
    const state = reduce([call, call])

    expect(selectToolCalls(state)).toHaveLength(1)
  })
})
