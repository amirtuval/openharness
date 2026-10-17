import { newMcpServerId, newSkillId } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import {
  modeMcpServerChoice,
  modeSectionDefault,
  modeSkillChoice,
  modeToolChoice,
  withModeMcpServerChoice,
  withModeSectionDefault,
  withModeSkillChoice,
  withModeToolChoice,
} from './tools'

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

describe('a mode’s MCP server choice (#311; #313)', () => {
  // The ids are the protocol's own: `mcp_servers` is keyed by a branded `mcps_` id, so a
  // hand-typed string is not the shape the wire holds.
  const NOTES = newMcpServerId()
  const GIT = newMcpServerId()
  const PATCH = { builtin: { web_search: true }, mcp_servers: { [NOTES]: false } }

  it('reads a missing server as "follow my settings"', () => {
    expect(modeMcpServerChoice(null, NOTES)).toBe('follow')
    expect(modeMcpServerChoice({ builtin: {} }, NOTES)).toBe('follow')
    expect(modeMcpServerChoice({ builtin: {}, mcp_servers: {} }, NOTES)).toBe('follow')
  })

  it('reads an explicit boolean as on or off', () => {
    expect(modeMcpServerChoice({ builtin: {}, mcp_servers: { [NOTES]: true } }, NOTES)).toBe('on')
    expect(modeMcpServerChoice(PATCH, NOTES)).toBe('off')
  })

  it('sets one server without disturbing the tools or the other servers', () => {
    const both = {
      builtin: { web_search: true },
      mcp_servers: { [NOTES]: false, [GIT]: true },
    }
    expect(withModeMcpServerChoice(both, NOTES, 'on')).toEqual({
      builtin: { web_search: true },
      mcp_servers: { [NOTES]: true, [GIT]: true },
    })
  })

  it('leaves the builtin map in place, even when it names nothing', () => {
    // `builtin` is optional since B8, so a mode that says something about servers only is
    // `{ mcp_servers: { … } }` — the smallest patch that says it.
    expect(withModeMcpServerChoice(null, NOTES, 'off')).toEqual({
      mcp_servers: { [NOTES]: false },
    })
    expect(withModeMcpServerChoice(PATCH, NOTES, 'follow')).toEqual({
      builtin: { web_search: true },
    })
  })

  it('folds a patch that names nothing back to null', () => {
    expect(
      withModeMcpServerChoice({ builtin: {}, mcp_servers: { [NOTES]: false } }, NOTES, 'follow'),
    ).toBeNull()
  })
})

describe('a mode’s skill choice (#349, K8; #353)', () => {
  const NOTES = newSkillId()
  const CHANGELOG = newSkillId()

  it('reads a missing skill as "follow my settings"', () => {
    expect(modeSkillChoice(null, NOTES)).toBe('follow')
    expect(modeSkillChoice({ builtin: {} }, NOTES)).toBe('follow')
    expect(modeSkillChoice({ builtin: {}, skills: {} }, NOTES)).toBe('follow')
  })

  it('reads an explicit boolean as on or off', () => {
    expect(modeSkillChoice({ builtin: {}, skills: { [NOTES]: true } }, NOTES)).toBe('on')
    expect(modeSkillChoice({ builtin: {}, skills: { [NOTES]: false } }, NOTES)).toBe('off')
  })

  it('sets one skill without disturbing the tools, the servers or the other skills', () => {
    const both = {
      builtin: { web_search: true },
      mcp_servers: { mcps_notes: false },
      skills: { [NOTES]: true, [CHANGELOG]: false },
    }
    expect(withModeSkillChoice(both, NOTES, 'off')).toEqual({
      builtin: { web_search: true },
      mcp_servers: { mcps_notes: false },
      skills: { [NOTES]: false, [CHANGELOG]: false },
    })
    // Back to following is the absence of the id, and every other half is untouched.
    expect(withModeSkillChoice(both, CHANGELOG, 'follow')).toEqual({
      builtin: { web_search: true },
      mcp_servers: { mcps_notes: false },
      skills: { [NOTES]: true },
    })
  })

  it('keeps a mode’s other halves when a built-in tool or a server is set', () => {
    const patch = { builtin: {}, skills: { [NOTES]: true } }
    expect(withModeToolChoice(patch, 'web_search', 'on')).toEqual({
      builtin: { web_search: true },
      skills: { [NOTES]: true },
    })
    expect(withModeMcpServerChoice(patch, 'mcps_notes', 'off')).toEqual({
      mcp_servers: { mcps_notes: false },
      skills: { [NOTES]: true },
    })
  })

  it('folds a patch that names nothing back to null', () => {
    expect(
      withModeSkillChoice({ builtin: {}, skills: { [NOTES]: false } }, NOTES, 'follow'),
    ).toBeNull()
  })
})

describe('a mode’s section defaults (B8)', () => {
  it('reads an absent default as follow, for all three sections', () => {
    expect(modeSectionDefault(null, 'builtin')).toBe('follow')
    expect(modeSectionDefault(null, 'mcp_servers')).toBe('follow')
    expect(modeSectionDefault(null, 'skills')).toBe('follow')
    expect(modeSectionDefault({ skills_default: 'off' }, 'skills')).toBe('off')
    expect(modeSectionDefault({ skills_default: 'off' }, 'builtin')).toBe('follow')
  })

  it('writes one default without disturbing the maps or the others', () => {
    const patch = {
      builtin: { web_search: false },
      mcp_servers: { mcps_notes: true },
      skills: { [newSkillId()]: true },
      skills_default: 'on' as const,
    }
    expect(withModeSectionDefault(patch, 'builtin', 'off')).toEqual({
      ...patch,
      builtin_default: 'off',
    })
    // Back to follow is the absence of the key, not a stored `'follow'`.
    expect(
      withModeSectionDefault({ ...patch, builtin_default: 'off' as const }, 'builtin', 'follow'),
    ).toEqual(patch)
    // A default alone is a mode that says something, not `null`.
    expect(withModeSectionDefault(null, 'mcp_servers', 'off')).toEqual({
      mcp_servers_default: 'off',
    })
    expect(
      withModeSectionDefault({ mcp_servers_default: 'off' }, 'mcp_servers', 'follow'),
    ).toBeNull()
  })
})
