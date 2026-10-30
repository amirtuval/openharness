import { type Client } from '@openharness/client'
import { createFakeClient } from '@openharness/client/testing'
import { newSkillId } from '@openharness/protocol'
import { makeMode, makeSkill } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import { formatModes, runModes, SUBAGENT_TYPE_HINT, SUBAGENT_TYPE_MARK } from './modes'
import type { CommandIo } from './io'

/** Collect what a command wrote. */
function recorder(): { io: CommandIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      context: { server: 'http://localhost:3000' },
    },
    out,
    err,
  }
}

describe('formatModes (#245, M6)', () => {
  it('says how to create one when there are none', () => {
    expect(formatModes([])).toEqual([
      expect.stringContaining('No modes yet. Create one in the web app under Settings → Modes'),
    ])
  })

  it('names each mode and what it resolves to', () => {
    const lines = formatModes([
      makeMode({ name: 'smart', model: 'anthropic/claude-sonnet-5', reasoning_effort: 'high' }),
      makeMode({ name: 'mine', model: 'my-default-model', reasoning_effort: null }),
    ])

    expect(lines[0]).toContain('smart')
    expect(lines[0]).toContain('anthropic/claude-sonnet-5 · high')
    expect(lines[1]).toContain('mine')
    expect(lines[1]).toContain('my default model')
  })

  it('marks a subagent type and shows its description read-only (#340, S2; #347)', () => {
    const lines = formatModes([
      makeMode({ name: 'smart' }),
      makeMode({
        name: 'researcher',
        model: 'anthropic/claude-sonnet-5',
        subagent_description: 'Researches the web and reports sources.',
      }),
    ])

    // The preset keeps its own line, and says nothing it is not.
    expect(lines[0]).toContain('smart')
    expect(lines[0]).not.toContain('subagent')

    // The type is marked, and the sentence a model chooses it by is under it — indented to the
    // second column, and never edited here.
    expect(lines[1]).toContain('researcher')
    expect(lines[1]).toContain(SUBAGENT_TYPE_MARK)
    expect(lines[2]?.trim()).toBe('Researches the web and reports sources.')
    expect(lines.at(-1)).toBe(SUBAGENT_TYPE_HINT)
  })

  it('says nothing about subagent types when the account has none', () => {
    const lines = formatModes([makeMode({ name: 'smart' })])
    expect(lines).toHaveLength(1)
    expect(lines.join('\n')).not.toContain(SUBAGENT_TYPE_MARK)
  })
})

describe('runModes (#245, M6)', () => {
  it('lists the modes the account has', async () => {
    const fake = createFakeClient({ modes: [makeMode({ name: 'smart' })] })
    const { io, out } = recorder()

    expect(await runModes(fake, io)).toBe(0)
    expect(out.join('\n')).toContain('smart')
  })

  it('reports a failure with the CLI’s own line', async () => {
    const working = createFakeClient()
    const failing: Client = {
      ...working,
      modes: {
        ...working.modes,
        list: () => Promise.reject(new Error('the server is down')),
      },
    }
    const { io, err } = recorder()

    expect(await runModes(failing, io)).toBe(1)
    expect(err.join('\n')).toContain('the server is down')
  })
})

describe('formatModes, and a mode’s skills (#349, K8; #354)', () => {
  it('shows which skills a mode turns on or off, read-only, by name', () => {
    const skill = makeSkill({ name: 'release-notes' })
    const other = makeSkill({ name: 'helper' })
    const lines = formatModes(
      [
        makeMode({
          name: 'smart',
          tools: { builtin: {}, skills: { [skill.id]: false, [other.id]: true } },
        }),
      ],
      [skill, other],
    )

    // `oh` does not edit modes, so the override is shown rather than offered (K8).
    expect(lines[0]).toContain('smart')
    expect(lines[0]).toContain('skills: release-notes off, helper on')
  })

  it('shows the three section defaults a mode carries (B8)', () => {
    const lines = formatModes([
      makeMode({
        name: 'allowlist',
        tools: { skills_default: 'off', mcp_servers_default: 'on' },
      }),
    ])
    // Every default is named, `follow` included, so a reader comparing modes sees all three.
    expect(lines[0]).toContain('not listed: tools follow · mcp on · skills off')
  })

  it('names an id it cannot resolve as the id, and says nothing for a mode that overrides none', () => {
    const gone = newSkillId()
    const lines = formatModes(
      [
        makeMode({ name: 'smart', tools: { builtin: {}, skills: { [gone]: false } } }),
        makeMode({ name: 'plain' }),
      ],
      [],
    )
    expect(lines[0]).toContain(`${gone} off`)
    expect(lines[1]).not.toContain('skills:')
  })
})

describe('runModes and the skills read (#354)', () => {
  it('reads the skills to name a mode’s override, best effort', async () => {
    const skill = makeSkill({ name: 'release-notes' })
    const fake = createFakeClient({
      modes: [makeMode({ name: 'smart', tools: { builtin: {}, skills: { [skill.id]: false } } })],
      skills: [skill],
    })
    const { io, out } = recorder()

    expect(await runModes(fake, io)).toBe(0)
    expect(out.join('\n')).toContain('skills: release-notes off')
  })

  it('still lists the modes when the skills cannot be read', async () => {
    const working = createFakeClient({ modes: [makeMode({ name: 'smart' })] })
    const failing: Client = {
      ...working,
      skills: { ...working.skills, list: () => Promise.reject(new Error('no skills for you')) },
    }
    const { io, out } = recorder()

    expect(await runModes(failing, io)).toBe(0)
    expect(out.join('\n')).toContain('smart')
  })
})
