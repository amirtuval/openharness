import { ApiError } from '@openharness/client'
import { createFakeClient } from '@openharness/client/testing'
import { makeProviderCredential } from '@openharness/protocol/fixtures'
import { cleanup, render } from 'ink-testing-library'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { frameOf, pressKey, typeText, waitForFrame, waitForScreen } from '../test-support/input'
import type { CommandIo } from './io'
import {
  formatCredentials,
  ProvidersAddApp,
  runProvidersList,
  runProvidersRemove,
} from './providers'

/** A key that is obviously not a real one. Nothing in this suite uses anything else. */
const KEY = 'sk-test-0000'

/** Collect what a print-and-stop command wrote, and how it left. */
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

afterEach(() => {
  cleanup()
})

describe('formatCredentials', () => {
  it('says where a key comes from when there are none', () => {
    expect(formatCredentials([])).toEqual([
      'No provider keys yet. Add one with `oh providers add`.',
    ])
  })

  it('names each key by display name, type, last four and when it was added', () => {
    const lines = formatCredentials([
      makeProviderCredential({ provider: 'anthropic', last4: 'a1b2' }),
      makeProviderCredential({ provider: 'openai', type: 'api_key', last4: 'z9y8' }),
    ])

    expect(lines[0]).toContain('Anthropic')
    expect(lines[0]).toContain('api_key')
    expect(lines[0]).toContain('…a1b2')
    expect(lines[0]).toContain('20')
    expect(lines[1]).toContain('OpenAI')
    expect(lines[1]).toContain('…z9y8')
    // Never the key: the API is metadata-only, and a `last4` is the most it can say.
    expect(lines.join('\n')).not.toContain(KEY)
  })

  it('falls back to the router id for a provider the metadata list does not carry', () => {
    const [line] = formatCredentials([makeProviderCredential({ provider: 'acme' })])
    expect(line).toContain('acme')
  })
})

describe('runProvidersList', () => {
  it('prints the stored keys, oldest first', async () => {
    const fake = createFakeClient({
      credentials: [makeProviderCredential({ provider: 'anthropic', last4: '1234' })],
    })
    const { io, out, err } = recorder()

    expect(await runProvidersList(fake, io)).toBe(0)
    expect(err).toEqual([])
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('Anthropic')
    expect(out[0]).toContain('…1234')
  })

  it('reports the 401 a signed-out caller gets, as the other commands do', async () => {
    const { io, err } = recorder()
    const code = await runProvidersList(createFakeClient({ authenticated: false }), io)

    expect(code).toBe(1)
    expect(err.join('\n')).toContain('not signed in to http://localhost:3000')
  })
})

describe('runProvidersRemove', () => {
  /** The remove command's IO: a recorder plus the question and the answer. */
  function removeIo(answer: string) {
    const rec = recorder()
    const asked: string[] = []
    return {
      ...rec,
      io: {
        ...rec.io,
        prompt: (text: string) => asked.push(text),
        stdin: Readable.from([answer]) as unknown as NodeJS.ReadStream,
      },
      asked,
    }
  }

  it('asks first, and removes the key on a yes', async () => {
    const fake = createFakeClient({
      credentials: [makeProviderCredential({ provider: 'anthropic' })],
    })
    const { io, out, asked } = removeIo('y\n')

    expect(await runProvidersRemove(fake, io, 'anthropic', { yes: false })).toBe(0)
    expect(asked[0]).toBe('Remove the Anthropic key? [y/N] ')
    expect(out).toEqual(['Removed the Anthropic key.'])
    expect((await fake.providerCredentials.list()).data).toEqual([])
  })

  it('removes nothing when the answer is not a yes', async () => {
    const fake = createFakeClient({
      credentials: [makeProviderCredential({ provider: 'anthropic' })],
    })
    const { io, out } = removeIo('\n')

    expect(await runProvidersRemove(fake, io, 'anthropic', { yes: false })).toBe(0)
    expect(out).toEqual(['Not removed.'])
    expect((await fake.providerCredentials.list()).data).toHaveLength(1)
  })

  it('skips the question with --yes', async () => {
    const fake = createFakeClient({
      credentials: [makeProviderCredential({ provider: 'anthropic' })],
    })
    const { io, out, asked } = removeIo('')

    expect(await runProvidersRemove(fake, io, 'anthropic', { yes: true })).toBe(0)
    expect(asked).toEqual([])
    expect(out).toEqual(['Removed the Anthropic key.'])
  })

  it('is not an error to remove a key that is not there', async () => {
    const { io, out } = removeIo('')
    expect(await runProvidersRemove(createFakeClient(), io, 'anthropic', { yes: true })).toBe(0)
    expect(out).toEqual(['Removed the Anthropic key.'])
  })
})

describe('ProvidersAddApp', () => {
  /** Render the connect flow the way the command mounts it, and record how it settled. */
  function renderAdd(fake: ReturnType<typeof createFakeClient>, provider?: string) {
    const outcomes: string[] = []
    const instance = render(
      <ProvidersAddApp
        client={fake}
        context={{ server: 'http://localhost:3000' }}
        provider={provider}
        openUrl={() => false}
      />,
    )

    return { ...instance, outcomes }
  }

  it('picks a provider, takes the key, and leaves with `saved`', async () => {
    const fake = createFakeClient()
    const app = renderAdd(fake)

    await waitForScreen(app, 'No provider key yet')
    pressKey(app, 'enter')
    await waitForScreen(app, 'Connect Anthropic')

    typeText(app, KEY)
    await waitForFrame(app, '•'.repeat(KEY.length))
    // The key is masked in every frame the screen wrote, and there is nowhere else it could be.
    expect(frameOf(app)).not.toContain(KEY)

    pressKey(app, 'enter')

    // The screen leaves as soon as the write answers, so the store is the thing to wait on.
    await vi.waitFor(async () => {
      const { data } = await fake.providerCredentials.list()
      expect(data).toEqual([expect.objectContaining({ provider: 'anthropic', last4: '0000' })])
    })
  })

  it('starts on the named provider, skipping the list', async () => {
    const app = renderAdd(createFakeClient(), 'openai')
    await waitForScreen(app, 'Connect OpenAI')
    expect(frameOf(app)).not.toContain('No provider key yet')
  })

  it('again asks for the key when the provider refused it, and never shows it', async () => {
    const fake = createFakeClient()
    const refusing = {
      ...fake,
      providerCredentials: {
        ...fake.providerCredentials,
        put: (provider: string) =>
          Promise.reject(
            new ApiError(422, `The ${provider} credential was rejected by the provider.`, {
              type: 'invalid_provider_credential',
            }),
          ),
      },
    }
    const app = render(
      <ProvidersAddApp
        client={refusing}
        context={{ server: 'http://localhost:3000' }}
        provider="anthropic"
        openUrl={() => false}
      />,
    )

    await waitForScreen(app, 'Connect Anthropic')
    typeText(app, KEY)
    pressKey(app, 'enter')

    await waitForFrame(app, 'The key was rejected')
    expect(frameOf(app)).not.toContain(KEY)
  })

  it('says no browser is available when `o` cannot open one', async () => {
    const app = renderAdd(createFakeClient(), 'anthropic')
    await waitForScreen(app, 'Connect Anthropic')

    typeText(app, 'o')
    await waitForFrame(app, 'No browser here')
    // `o` opened nothing and did not become part of the key.
    pressKey(app, 'enter')
    expect(frameOf(app)).toContain('Connect Anthropic')
  })
})
