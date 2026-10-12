import { makeToolSettingEntry } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import {
  NOT_REGISTERED_NOTE,
  cycleToolPolicy,
  toolAvailabilityNote,
  toolPolicyChoices,
  toolPolicyNote,
} from './tool-settings'

describe('toolPolicyChoices', () => {
  it('walks allow, ask and deny for this build’s own tools', () => {
    expect(toolPolicyChoices('web_fetch')).toEqual(['allow', 'ask', 'deny'])
    expect(toolPolicyChoices('todo_write')).toEqual(['allow', 'ask', 'deny'])
  })

  it('leaves `ask` out for the provider-executed search, which cannot pause', () => {
    // The provider runs the search inside the request, so there is no moment this build could
    // ask — and the server refuses the write (#335).
    expect(toolPolicyChoices('web_search')).toEqual(['allow', 'deny'])
  })

  it('is not fooled by a remote tool that happens to be called web_search', () => {
    // A remote tool's offered name is `<server>__<tool>`, and its `ask` is the whole point of
    // the pause (#312) — it is a call of ours that would run.
    expect(toolPolicyChoices('notes__web_search')).toEqual(['allow', 'ask', 'deny'])
  })
})

describe('cycleToolPolicy', () => {
  it('walks the three permissions and wraps', () => {
    expect(cycleToolPolicy('web_fetch', 'allow', 1)).toBe('ask')
    expect(cycleToolPolicy('web_fetch', 'ask', 1)).toBe('deny')
    expect(cycleToolPolicy('web_fetch', 'deny', 1)).toBe('allow')
    expect(cycleToolPolicy('web_fetch', 'allow', -1)).toBe('deny')
    expect(cycleToolPolicy('web_fetch', 'deny', -1)).toBe('ask')
  })

  it('skips ask for the provider-executed search, both ways', () => {
    expect(cycleToolPolicy('web_search', 'allow', 1)).toBe('deny')
    expect(cycleToolPolicy('web_search', 'deny', 1)).toBe('allow')
    expect(cycleToolPolicy('web_search', 'deny', -1)).toBe('allow')
    expect(cycleToolPolicy('web_search', 'allow', -1)).toBe('deny')
  })

  it('starts a mixed row (no permission) at the first choice', () => {
    expect(cycleToolPolicy('web_fetch', null, 1)).toBe('allow')
    expect(cycleToolPolicy('web_fetch', null, -1)).toBe('deny')
    expect(cycleToolPolicy('web_search', null, 1)).toBe('allow')
  })

  it('treats a permission the tool may not take as nothing to start from', () => {
    // A `web_search` stored as `ask` in the operator-key era reads back as `allow`; a screen
    // that had one in hand must still land on a permission the write accepts.
    expect(cycleToolPolicy('web_search', 'ask', 1)).toBe('allow')
    expect(cycleToolPolicy('web_search', 'ask', -1)).toBe('deny')
  })
})

describe('toolPolicyNote', () => {
  it('says (default) when the permission in force is the tool’s own declaration', () => {
    expect(toolPolicyNote(makeToolSettingEntry({ policy: 'allow', default_policy: 'allow' }))).toBe(
      'allow (default)',
    )
  })

  it('names the default it differs from', () => {
    expect(toolPolicyNote(makeToolSettingEntry({ policy: 'deny', default_policy: 'ask' }))).toBe(
      'deny (default ask)',
    )
  })

  it('says nothing about a default a tool has no declaration for', () => {
    expect(
      toolPolicyNote(
        makeToolSettingEntry({ policy: 'deny', default_policy: null, available: false }),
      ),
    ).toBe('deny')
  })
})

describe('toolAvailabilityNote', () => {
  it('says nothing for an available tool', () => {
    expect(toolAvailabilityNote(makeToolSettingEntry())).toBeNull()
  })

  it('gives the server’s own reason where it sent one', () => {
    expect(
      toolAvailabilityNote(
        makeToolSettingEntry({
          name: 'web_search',
          available: false,
          reason: 'This model has no web search.',
        }),
      ),
    ).toBe('This model has no web search.')
  })

  it('falls back to the plain note for a tool this deployment does not register', () => {
    expect(
      toolAvailabilityNote(
        makeToolSettingEntry({ name: 'gone', available: false, default_policy: null }),
      ),
    ).toBe(NOT_REGISTERED_NOTE)
  })
})
