import { describe, expect, it } from 'vitest'

import {
  makeAgentMcpToolResult,
  makeAgentMcpToolUse,
  makeAgentToolResult,
  makeAgentToolUse,
  makeUserMessage,
} from '../fixtures'
import { newEventId } from '../ids'
import {
  isMcpToolCall,
  isToolCallEvent,
  isToolResultEvent,
  toolCallId,
  toolCallInput,
  toolCallName,
  toolCallOfferedName,
  toolCallPermission,
  toolCallServer,
  toolCallSource,
  toolResultCallId,
  toolResultIsError,
} from './tool'

describe('the tool call / tool result abstraction', () => {
  const builtinCall = { ...makeAgentToolUse('web_fetch', { url: 'https://example.com' }), seq: 1 }
  const builtinResult = makeAgentToolResult(builtinCall, 'the page')
  const mcpCall = { ...makeAgentMcpToolUse('notes', 'find.by tag', { tag: 'x' }), seq: 2 }
  const mcpResult = makeAgentMcpToolResult(mcpCall, 'a note')

  it('tells a call from a result, for both pairs, and neither for anything else', () => {
    for (const call of [builtinCall, mcpCall]) {
      expect(isToolCallEvent(call)).toBe(true)
      expect(isToolResultEvent(call)).toBe(false)
    }
    for (const result of [builtinResult, mcpResult]) {
      expect(isToolResultEvent(result)).toBe(true)
      expect(isToolCallEvent(result)).toBe(false)
    }
    const message = makeUserMessage('hello')
    expect(isToolCallEvent(message)).toBe(false)
    expect(isToolResultEvent(message)).toBe(false)
  })

  it('pairs a result with its call by the id the result names', () => {
    expect(toolCallId(builtinCall)).toBe(builtinCall.id)
    expect(toolResultCallId(builtinResult)).toBe(builtinCall.id)
    expect(toolCallId(mcpCall)).toBe(mcpCall.id)
    expect(toolResultCallId(mcpResult)).toBe(mcpCall.id)
    // The two id fields are named differently on the wire; the abstraction is what makes a
    // reader not have to care.
    expect(builtinResult.tool_use_id).toBe(builtinCall.id)
    expect(mcpResult.mcp_tool_use_id).toBe(mcpCall.id)
  })

  it('reports the source, the server and the permission of a call', () => {
    expect(toolCallSource(builtinCall)).toBe('builtin')
    expect(toolCallSource(mcpCall)).toBe('mcp')
    expect(isMcpToolCall(builtinCall)).toBe(false)
    expect(isMcpToolCall(mcpCall)).toBe(true)
    expect(toolCallServer(builtinCall)).toBeUndefined()
    expect(toolCallServer(mcpCall)).toBe('notes')
    expect(toolCallPermission(builtinCall)).toBe('allow')
    expect(toolCallPermission(mcpCall)).toBe('ask')
  })

  it('answers the name the model called the tool by, whichever pair it is', () => {
    expect(toolCallOfferedName(builtinCall)).toBe('web_fetch')
    // The MCP call records the server's own names; the offered name is recomputed from them,
    // sanitized exactly as the offer built it.
    expect(toolCallName(mcpCall)).toBe('find.by tag')
    expect(toolCallOfferedName(mcpCall)).toBe('notes__find_by_tag')
  })

  it('reads a call’s input and a result’s error flag the same way for both', () => {
    expect(toolCallInput(builtinCall)).toEqual({ url: 'https://example.com' })
    expect(toolCallInput(mcpCall)).toEqual({ tag: 'x' })
    expect(toolResultIsError(builtinResult)).toBe(false)
    expect(toolResultIsError(makeAgentToolResult(builtinCall, 'no', { is_error: true }))).toBe(true)
    expect(toolResultIsError(makeAgentMcpToolResult(mcpCall, 'no', { is_error: true }))).toBe(true)
  })

  it('keeps an event whose id is not the call’s out of the pairing', () => {
    // A result naming a call that is not the one it was built from: the abstraction reads what
    // the event says, not what a caller meant.
    const orphan = makeAgentMcpToolResult(mcpCall, 'x', { mcp_tool_use_id: newEventId() })
    expect(toolResultCallId(orphan)).not.toBe(mcpCall.id)
  })
})
