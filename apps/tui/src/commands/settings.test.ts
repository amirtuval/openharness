import { ApiError } from '@openharness/client'
import { createFakeClient } from '@openharness/client/testing'
import { makeModelEntry } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import { formatSettings, runSettings } from './settings'
import type { CommandIo } from './io'

/**
 * `oh settings` (epic #277, C3; #282): the three context controls, printed and set.
 *
 * The words are held still by the `formatSettings` tests, and the round trips are driven through
 * the fake client — the same preferences row the web app's Settings → Context writes.
 */

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

describe('formatSettings', () => {
  it('prints each control, with the default it follows named', async () => {
    const fake = createFakeClient()
    const lines = formatSettings(await fake.preferences.get())

    expect(lines).toEqual([
      'Summarize at 70% of the context (the server default).',
      'Summary model: same as the chat.',
      'Summary pass limit: 3 (default).',
    ])
  })

  it('prints stored choices as themselves, and the deployment’s own default', async () => {
    const fake = createFakeClient({
      preferences: {
        compaction_threshold: 0.5,
        summary_model: 'openai/gpt-5-mini',
        summary_max_passes: 5,
      },
      preferenceDefaults: { compaction_threshold: 0.4 },
    })
    const lines = formatSettings(await fake.preferences.get())

    expect(lines).toEqual([
      'Summarize at 50% of the context.',
      'Summary model: openai/gpt-5-mini.',
      'Summary pass limit: 5.',
    ])
  })
})

describe('runSettings', () => {
  it('prints the stored settings and exits 0', async () => {
    const fake = createFakeClient()
    const { io, out, err } = recorder()

    expect(await runSettings(fake, io, {})).toBe(0)
    expect(err).toEqual([])
    expect(out.join('\n')).toContain('Summarize at 70% of the context (the server default).')
  })

  it('sets each control, and says what it did', async () => {
    const fake = createFakeClient()
    const { io, out } = recorder()

    const code = await runSettings(fake, io, {
      threshold: 0.5,
      summaryModel: 'openai/gpt-5-mini',
      summaryPasses: 5,
    })

    expect(code).toBe(0)
    expect(out[0]).toBe('Saved.')
    expect(out.join('\n')).toContain('Summarize at 50% of the context.')
    expect(out.join('\n')).toContain('Summary model: openai/gpt-5-mini.')
    expect(out.join('\n')).toContain('Summary pass limit: 5.')
    expect(await fake.preferences.get()).toMatchObject({
      compaction_threshold: 0.5,
      summary_model: 'openai/gpt-5-mini',
      summary_max_passes: 5,
    })
  })

  it('clears a nullable control back to the default with null', async () => {
    const fake = createFakeClient({
      preferences: { compaction_threshold: 0.5, summary_max_passes: 5 },
    })
    const { io, out } = recorder()

    expect(await runSettings(fake, io, { threshold: null, summaryPasses: null })).toBe(0)

    expect(await fake.preferences.get()).toMatchObject({
      compaction_threshold: null,
      summary_max_passes: null,
    })
    expect(out.join('\n')).toContain('Summarize at 70% of the context (the server default).')
    expect(out.join('\n')).toContain('Summary pass limit: 3 (default).')
  })

  it('writes one setting without touching the others, or the default model', async () => {
    const fake = createFakeClient({
      preferences: {
        default_model: 'anthropic/claude-sonnet-5',
        theme: 'dim',
        compaction_threshold: 0.5,
      },
    })
    const { io } = recorder()

    expect(await runSettings(fake, io, { summaryPasses: 4 })).toBe(0)

    // The server merges: the default model, the theme and the threshold are all untouched.
    expect(await fake.preferences.get()).toMatchObject({
      default_model: 'anthropic/claude-sonnet-5',
      theme: 'dim',
      compaction_threshold: 0.5,
      summary_max_passes: 4,
    })
  })

  it('warns when the chosen summary model would need more passes than the limit allows', async () => {
    const fake = createFakeClient({
      models: [
        makeModelEntry({
          id: 'anthropic/claude-sonnet-5',
          provider: 'anthropic',
          name: 'Claude Sonnet 5',
          context_window: 200_000,
          // The budget a server reports for the limits: the window less the quarter it reserves
          // (the 64k ceiling is larger, so the quarter is what is reserved) — #280.
          context_budget: 150_000,
        }),
        makeModelEntry({
          id: 'openai/gpt-4.1-mini',
          provider: 'openai',
          name: 'GPT-4.1 mini',
          context_window: 8_000,
          max_output_tokens: 2_000,
          context_budget: 6_000,
        }),
      ],
      preferences: {
        default_model: 'anthropic/claude-sonnet-5',
        summary_model: 'openai/gpt-4.1-mini',
      },
    })
    const { io, out } = recorder()

    expect(await runSettings(fake, io, {})).toBe(0)
    expect(out.join('\n')).toContain('would need about 50 passes')
    expect(out.join('\n')).toContain('over the limit of 3')
  })

  it('says nothing about a fallback when the catalog cannot be read', async () => {
    const fake = createFakeClient({
      preferences: { summary_model: 'openai/gpt-4.1-mini' },
    })
    fake.models.list = () => Promise.reject(new ApiError(500, 'The catalog is down.'))
    const { io, out, err } = recorder()

    // The stored settings are still the answer: a settings screen does not fail because a
    // catalog read did.
    expect(await runSettings(fake, io, {})).toBe(0)
    expect(err).toEqual([])
    expect(out.join('\n')).toContain('Summary model: openai/gpt-4.1-mini.')
    expect(out.join('\n')).not.toContain('passes')
  })

  it('reports a refused write on stderr and exits 1', async () => {
    const fake = createFakeClient()
    fake.preferences.put = () => Promise.reject(new ApiError(400, 'compaction_threshold: too low'))
    const { io, out, err } = recorder()

    expect(await runSettings(fake, io, { threshold: 0.3 })).toBe(1)
    expect(out).toEqual([])
    expect(err.join('\n')).toContain('compaction_threshold: too low')
  })

  it('reports a not-signed-in read on stderr and exits 1', async () => {
    const fake = createFakeClient({ authenticated: false })
    const { io, out, err } = recorder()

    expect(await runSettings(fake, io, {})).toBe(1)
    expect(out).toEqual([])
    expect(err.join('\n')).toContain('not signed in to http://localhost:3000')
  })
})
