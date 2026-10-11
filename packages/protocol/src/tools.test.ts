import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MCP_TOOL_PERMISSION,
  MCP_TOOL_NAME_MAX_LENGTH,
  MCP_TOOL_NAME_PATTERN,
  MCP_TOOL_NAME_SEPARATOR,
  isMcpToolOfferedName,
  mcpToolOfferedName,
} from './tools'

describe('mcpToolOfferedName', () => {
  it('is the server name, the separator, and the tool name', () => {
    expect(mcpToolOfferedName('notes', 'search')).toBe(`notes${MCP_TOOL_NAME_SEPARATOR}search`)
    expect(mcpToolOfferedName('my-notes', 'find_by_tag')).toBe('my-notes__find_by_tag')
  })

  it('sanitizes what a provider’s tool-name rule would refuse', () => {
    // A tool name is whatever the server called it: dots, spaces, slashes and unicode all
    // become `_`, because a provider accepts letters, digits, `_` and `-` and nothing else.
    expect(mcpToolOfferedName('notes', 'find.by tag')).toBe('notes__find_by_tag')
    expect(mcpToolOfferedName('notes', 'a/b/c')).toBe('notes__a_b_c')
    expect(mcpToolOfferedName('notes', 'café')).toBe('notes__caf_')
    const offered = mcpToolOfferedName('notes', '💡 idea')
    expect(MCP_TOOL_NAME_PATTERN.test(offered)).toBe(true)
  })

  it('truncates to the length every provider accepts', () => {
    const offered = mcpToolOfferedName('a-server-with-a-name-32-long-xx', 'x'.repeat(200))
    expect(offered.length).toBe(MCP_TOOL_NAME_MAX_LENGTH)
    expect(MCP_TOOL_NAME_PATTERN.test(offered)).toBe(true)
  })

  it('is pure — the same pair always gives the same name', () => {
    // The property a reader of the log relies on: nothing about what else was offered changes
    // the name of this pair, so a call event is enough to recompute the name the model saw.
    const first = mcpToolOfferedName('notes', 'search')
    mcpToolOfferedName('other', 'tool')
    expect(mcpToolOfferedName('notes', 'search')).toBe(first)
  })

  it('can never collide with a built-in tool name', () => {
    // Single underscores are what the built-ins use; the separator is a double one, and a
    // server name may not contain an underscore at all.
    for (const builtin of ['web_fetch', 'web_search', 'todo_write', 'ask_user', 'echo']) {
      expect(mcpToolOfferedName('web', 'fetch')).not.toBe(builtin)
      expect(mcpToolOfferedName('ask', 'user')).not.toBe(builtin)
    }
  })
})

describe('isMcpToolOfferedName', () => {
  it('accepts what the sanitizer produces and refuses anything else', () => {
    expect(isMcpToolOfferedName(mcpToolOfferedName('notes', 'search'))).toBe(true)
    expect(isMcpToolOfferedName('x'.repeat(MCP_TOOL_NAME_MAX_LENGTH))).toBe(true)
    expect(isMcpToolOfferedName('')).toBe(false)
    expect(isMcpToolOfferedName('x'.repeat(MCP_TOOL_NAME_MAX_LENGTH + 1))).toBe(false)
    expect(isMcpToolOfferedName('has a space')).toBe(false)
    expect(isMcpToolOfferedName('has.dot')).toBe(false)
  })
})

describe('DEFAULT_MCP_TOOL_PERMISSION', () => {
  it('is ask — a remote tool is somebody else’s code until the user says otherwise', () => {
    expect(DEFAULT_MCP_TOOL_PERMISSION).toBe('ask')
  })
})
