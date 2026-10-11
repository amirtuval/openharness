import { describe, expect, it } from 'vitest'

import { modeToolChoice, withModeToolChoice } from './tools'

/**
 * The mode editor's tri-state (epic #303, X4; #307).
 *
 * The wire is a per-tool boolean patch; the form needs a third value — "follow my settings" —
 * which is the *absence* of a name. These two are the whole of the translation, so the form
 * writes no patch inline and the patch it sends is the one the server reads.
 */
describe('mode tool overrides (#307)', () => {
  it('reads a missing tool as "follow my settings"', () => {
    expect(modeToolChoice(null, 'web_search')).toBe('follow')
    expect(modeToolChoice({ builtin: {} }, 'web_search')).toBe('follow')
    expect(modeToolChoice({ builtin: { todo_write: false } }, 'web_search')).toBe('follow')
  })

  it('reads an explicit boolean as on or off', () => {
    expect(modeToolChoice({ builtin: { web_search: true } }, 'web_search')).toBe('on')
    expect(modeToolChoice({ builtin: { web_search: false } }, 'web_search')).toBe('off')
  })

  it('sets one tool without disturbing the others', () => {
    expect(withModeToolChoice({ builtin: { todo_write: false } }, 'web_search', 'on')).toEqual({
      builtin: { todo_write: false, web_search: true },
    })
  })

  it('turns a choice back into following, and an empty patch into null', () => {
    expect(withModeToolChoice({ builtin: { web_search: true } }, 'web_search', 'follow')).toBeNull()
    expect(
      withModeToolChoice(
        { builtin: { web_search: true, todo_write: true } },
        'web_search',
        'follow',
      ),
    ).toEqual({ builtin: { todo_write: true } })
  })

  it('sets off as an explicit false, which is not the same as absent', () => {
    expect(withModeToolChoice(null, 'todo_write', 'off')).toEqual({
      builtin: { todo_write: false },
    })
  })
})

describe('a mode’s MCP server patch is carried through a save (#311, #312)', () => {
  const PATCH = { builtin: { web_search: true }, mcp_servers: { mcps_notes: false } }

  it('keeps the server patch when a built-in tool is set', () => {
    expect(withModeToolChoice(PATCH, 'todo_write', 'on')).toEqual({
      builtin: { web_search: true, todo_write: true },
      mcp_servers: { mcps_notes: false },
    })
  })

  it('keeps the server patch when every built-in tool goes back to following', () => {
    // The patch is not empty while it names a server: dropping it here would silently undo a
    // choice this editor does not offer yet (#313).
    expect(withModeToolChoice(PATCH, 'web_search', 'follow')).toEqual({
      builtin: {},
      mcp_servers: { mcps_notes: false },
    })
  })

  it('reads and writes no server patch when the mode carries none', () => {
    expect(withModeToolChoice({ builtin: {} }, 'web_search', 'on')).toEqual({
      builtin: { web_search: true },
    })
    // An empty server map is the same as none: the mode says nothing either way.
    expect(withModeToolChoice({ builtin: {}, mcp_servers: {} }, 'web_search', 'follow')).toBeNull()
  })
})
