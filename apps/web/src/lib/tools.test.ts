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
