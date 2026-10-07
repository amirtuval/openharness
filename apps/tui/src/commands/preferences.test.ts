import { ApiError } from '@openharness/client'
import { createFakeClient, type FakeClient } from '@openharness/client/testing'
import { describe, expect, it } from 'vitest'

import { runDefaultModel } from './preferences'
import type { CommandIo } from './io'

/** Collect what the command wrote, and how it left. */
function recorder() {
  const out: string[] = []
  const err: string[] = []

  return {
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      context: { server: 'http://localhost:3000' },
    } satisfies CommandIo,
    out,
    err,
  }
}

describe('runDefaultModel', () => {
  it('prints the stored default', async () => {
    const fake = createFakeClient({ preferences: { default_model: 'anthropic/claude-sonnet-5' } })
    const { io, out, err } = recorder()

    const code = await runDefaultModel(fake, io, undefined)

    expect(code).toBe(0)
    expect(err).toEqual([])
    expect(out).toEqual(['Default model: anthropic/claude-sonnet-5'])
  })

  it('says so when there is no default, and how one gets set', async () => {
    const { io, out } = recorder()

    const code = await runDefaultModel(createFakeClient(), io, undefined)

    expect(code).toBe(0)
    expect(out.join('\n')).toContain('No default model set')
    expect(out.join('\n')).toContain('ask which model')
  })

  it('sets the default, and prints what the server stored', async () => {
    const fake = createFakeClient()
    const { io, out } = recorder()

    const code = await runDefaultModel(fake, io, 'openai/gpt-4.1-mini')

    expect(code).toBe(0)
    expect(out).toEqual(['Default model set to openai/gpt-4.1-mini.'])
    // The server round-trip is the point: a later `get` reads what `set` wrote.
    expect((await fake.preferences.get()).default_model).toBe('openai/gpt-4.1-mini')
  })

  it('replaces an existing default', async () => {
    const fake = createFakeClient({ preferences: { default_model: 'anthropic/claude-sonnet-5' } })
    const { io } = recorder()

    expect(await runDefaultModel(fake, io, 'openai/gpt-4.1-mini')).toBe(0)
    expect((await fake.preferences.get()).default_model).toBe('openai/gpt-4.1-mini')
  })

  it('leaves the web theme alone — the CLI has no theme of its own (epic #201, X3)', async () => {
    const fake = createFakeClient({
      preferences: { default_model: null, theme: 'dim' },
    })
    const { io } = recorder()

    expect(await runDefaultModel(fake, io, 'openai/gpt-4.1-mini')).toBe(0)
    // The write carries only `default_model`, and the server merges: setting a default from
    // the terminal never resets what the user chose in the browser.
    expect(await fake.preferences.get()).toEqual({
      default_model: 'openai/gpt-4.1-mini',
      theme: 'dim',
    })
  })

  it('reports a not-signed-in read on stderr and exits 1', async () => {
    const fake = createFakeClient({ authenticated: false })
    const { io, out, err } = recorder()

    const code = await runDefaultModel(fake, io, undefined)

    expect(code).toBe(1)
    expect(out).toEqual([])
    expect(err.join('\n')).toContain('not signed in to http://localhost:3000')
    expect(err.join('\n')).toContain('oh login')
  })

  it('reports a refused set on stderr and exits 1', async () => {
    const fake = createFakeClient()
    const client: FakeClient = {
      ...fake,
      preferences: {
        ...fake.preferences,
        put: () => Promise.reject(new ApiError(400, 'default_model must be a provider/model id')),
      },
    }
    const { io, out, err } = recorder()

    const code = await runDefaultModel(client, io, 'not-a-router-id')

    expect(code).toBe(1)
    expect(out).toEqual([])
    expect(err.join('\n')).toContain('must be a provider/model id')
  })

  it('reports a 401 on a set as the not-signed-in error', async () => {
    const fake = createFakeClient({ authenticated: false })
    const { io, err } = recorder()

    const code = await runDefaultModel(fake, io, 'openai/gpt-4.1-mini')

    expect(code).toBe(1)
    expect(err.join('\n')).toContain('not signed in')
  })
})
