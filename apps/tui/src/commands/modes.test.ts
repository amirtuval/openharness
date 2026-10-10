import { type Client } from '@openharness/client'
import { createFakeClient } from '@openharness/client/testing'
import { makeMode } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import { formatModes, runModes } from './modes'
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
