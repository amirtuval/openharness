import { describe, expect, it } from 'vitest'

import {
  GENERAL_PURPOSE_DESCRIPTION,
  GENERAL_PURPOSE_TYPE,
  SUBAGENT_SYSTEM_PROMPT,
  SUBAGENT_SYSTEM_PROMPT_VERSION,
  withSubagentPrompt,
} from './subagent'

/**
 * The subagent vocabulary on its own (epic #340, S2; #342): the child's system prompt, the
 * built-in type's name, and the way the addition is joined to a prompt a child already has.
 *
 * What the *resolver* answers is the server's half and is tested there
 * (`apps/server/src/subagent-types.test.ts`); this suite is what the brain owns.
 */
describe('the child system prompt (#342)', () => {
  it('says the four things a subagent could not learn from its own conversation', () => {
    // Each assertion is one of S2's four facts. They are spelled out rather than compared to a
    // fixture so that a rewrite which drops one fails here: the prompt is the whole of what
    // tells a child it is one, and nothing else in a run says so.
    expect(SUBAGENT_SYSTEM_PROMPT).toMatch(/subagent/i)
    expect(SUBAGENT_SYSTEM_PROMPT).toMatch(/parent/i)
    expect(SUBAGENT_SYSTEM_PROMPT).toMatch(/cannot ask the user/i)
    expect(SUBAGENT_SYSTEM_PROMPT).toMatch(
      /final message is the whole of what the parent receives/i,
    )
    expect(SUBAGENT_SYSTEM_PROMPT).toContain('message_parent')
  })

  it('is versioned, so a change to what a child is told is visible', () => {
    expect(SUBAGENT_SYSTEM_PROMPT_VERSION).toBe('subagent-v1')
  })

  it('names the built-in type the way the `agent` tool spells it (#344)', () => {
    // The name is what a parent model passes back to start the type, so it is part of the
    // tool's vocabulary rather than an internal label: fixing it here is what keeps a rename
    // from quietly changing what a model has to ask for.
    expect(GENERAL_PURPOSE_TYPE).toBe('general-purpose')
    expect(GENERAL_PURPOSE_DESCRIPTION.length).toBeGreaterThan(0)
  })
})

describe('withSubagentPrompt', () => {
  it('appends the addition after the prompt the child already has, after a blank line', () => {
    expect(withSubagentPrompt('Be terse.')).toBe(`Be terse.\n\n${SUBAGENT_SYSTEM_PROMPT}`)
  })

  it('is the whole prompt when the child has none of its own', () => {
    // A `null` and an empty string are the same statement — "nothing of its own" — and neither
    // may produce a leading blank line or an empty prompt.
    expect(withSubagentPrompt(null)).toBe(SUBAGENT_SYSTEM_PROMPT)
    expect(withSubagentPrompt('')).toBe(SUBAGENT_SYSTEM_PROMPT)
  })
})
