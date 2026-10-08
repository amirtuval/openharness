import { ApiError } from '@openharness/client'
import { createFakeClient } from '@openharness/client/testing'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import {
  frameOf,
  pressKey,
  typeText,
  waitFor,
  waitForFrame,
  waitForScreen,
} from '../test-support/input'
import { ProviderSetup } from './provider-setup'

/** A key that is obviously not a real one. No test or capture here uses anything else. */
const KEY = 'sk-test-0000'

/** Render the flow and record how it settled. */
function renderSetup(options: { readonly provider?: string; readonly openUrl?: boolean } = {}) {
  const fake = createFakeClient()
  const saved: string[] = []
  let cancelled = 0
  let stale = 0
  const opened: string[] = []

  const instance = render(
    <ProviderSetup
      client={fake}
      context={{ server: 'http://localhost:3000' }}
      initialProvider={options.provider}
      openUrl={(url) => {
        opened.push(url)
        return options.openUrl ?? true
      }}
      onSaved={(provider) => {
        saved.push(provider)
      }}
      onCancel={() => {
        cancelled += 1
      }}
      onStaleSession={() => {
        stale += 1
      }}
    />,
  )

  return {
    ...instance,
    fake,
    saved,
    opened,
    cancelled: () => cancelled,
    stale: () => stale,
  }
}

afterEach(() => {
  cleanup()
})

describe('ProviderSetup', () => {
  it('offers every provider with its free-tier hint (X8)', async () => {
    const setup = renderSetup()

    await waitForScreen(setup, 'No provider key yet')
    const frame = frameOf(setup)
    expect(frame).toContain('❯ Anthropic')
    expect(frame).toContain('Google · Free tier in Google AI Studio')
    expect(frame).toContain('Groq · Free tier available')
    expect(frame).toContain('↑/↓ to choose')
  })

  it('moves the cursor with the arrows and connects with Enter', async () => {
    const setup = renderSetup()

    await waitForScreen(setup, 'No provider key yet')
    pressKey(setup, 'down')
    await waitForFrame(setup, '❯ OpenAI')
    pressKey(setup, 'enter')

    await waitForScreen(setup, 'Connect OpenAI')
    expect(frameOf(setup)).toContain('Get a key: https://platform.openai.com/api-keys')
  })

  it('starts on the provider the caller named, skipping the list', async () => {
    const setup = renderSetup({ provider: 'groq' })

    await waitForScreen(setup, 'Connect Groq')
    expect(frameOf(setup)).not.toContain('No provider key yet')
  })

  it('opens the key page with `o`, and says so when there is no browser', async () => {
    const withBrowser = renderSetup({ provider: 'anthropic' })
    await waitForScreen(withBrowser, 'Connect Anthropic')
    typeText(withBrowser, 'o')
    await waitForFrame(withBrowser, 'Opening https://console.anthropic.com/settings/keys')
    expect(withBrowser.opened).toEqual(['https://console.anthropic.com/settings/keys'])

    cleanup()

    const withoutBrowser = renderSetup({ provider: 'anthropic', openUrl: false })
    await waitForScreen(withoutBrowser, 'Connect Anthropic')
    typeText(withoutBrowser, 'o')
    await waitForFrame(withoutBrowser, 'No browser here')
    // `o` opened nothing and, importantly, is not part of the key.
    pressKey(withoutBrowser, 'enter')
    expect(withoutBrowser.saved).toEqual([])
  })

  it('saves the key through the credentials API, and settles with the provider', async () => {
    const setup = renderSetup({ provider: 'anthropic' })

    await waitForScreen(setup, 'Connect Anthropic')
    typeText(setup, KEY)
    pressKey(setup, 'enter')

    await waitFor(() => setup.saved.length === 1)
    expect(setup.saved).toEqual(['anthropic'])

    // The stored metadata is the server's answer; the key itself is never read back.
    const { data } = await setup.fake.providerCredentials.list()
    expect(data).toEqual([
      expect.objectContaining({ provider: 'anthropic', type: 'api_key', last4: '0000' }),
    ])
  })

  it('never shows the key, an error included', async () => {
    const setup = renderSetup({ provider: 'anthropic' })

    await waitForScreen(setup, 'Connect Anthropic')
    typeText(setup, KEY)
    await waitForFrame(setup, '•'.repeat(KEY.length))
    expect(frameOf(setup)).not.toContain(KEY)

    pressKey(setup, 'enter')
    await waitFor(() => setup.saved.length === 1)
    expect(frameOf(setup)).not.toContain(KEY)
  })

  it('shows why a rejected key was rejected, and asks again', async () => {
    const setup = renderSetup({ provider: 'anthropic' })
    // The one rejection a test can spell with no provider: an empty key. It is refused by the
    // fake exactly where the server refuses it (422 invalid_provider_credential).
    const refusing = {
      ...setup.fake,
      providerCredentials: {
        ...setup.fake.providerCredentials,
        put: (provider: string) =>
          Promise.reject(
            new ApiError(422, `The ${provider} credential was rejected by the provider.`, {
              type: 'invalid_provider_credential',
            }),
          ),
      },
    }
    cleanup()

    const retry = render(
      <ProviderSetup
        client={refusing}
        context={{}}
        initialProvider="anthropic"
        openUrl={() => false}
        onSaved={() => undefined}
        onCancel={() => undefined}
        onStaleSession={() => undefined}
      />,
    )
    await waitForScreen(retry, 'Connect Anthropic')
    typeText(retry, KEY)
    pressKey(retry, 'enter')

    await waitForFrame(retry, 'The key was rejected: The anthropic credential was rejected')
    // The box is still there — the usual mistake is a key pasted with a space in it, and the
    // fix is to paste it again rather than to start over.
    await waitForFrame(retry, '❯ ')
    expect(frameOf(retry)).not.toContain(KEY)
  })

  it('reports a stale session instead of retrying the save itself', async () => {
    const fake = createFakeClient({ authenticated: false })
    let stale = 0
    const setup = render(
      <ProviderSetup
        client={fake}
        context={{}}
        initialProvider="anthropic"
        openUrl={() => false}
        onSaved={() => undefined}
        onCancel={() => undefined}
        onStaleSession={() => {
          stale += 1
        }}
      />,
    )

    await waitForScreen(setup, 'Connect Anthropic')
    typeText(setup, KEY)
    pressKey(setup, 'enter')

    // A credential write needs a fresh session (A2); the flow hands that to the caller, which
    // knows how to sign in — a screen does not.
    await waitFor(() => stale === 1)
    expect(frameOf(setup)).not.toContain(KEY)
  })

  it('goes back to the list on Esc when it started on it', async () => {
    const setup = renderSetup()

    await waitForScreen(setup, 'No provider key yet')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'Connect Anthropic')

    pressKey(setup, 'escape')
    await waitForScreen(setup, 'No provider key yet')
    expect(setup.cancelled()).toBe(0)
  })

  it('cancels outright on Esc when the provider was named — there is no list to go back to', async () => {
    const setup = renderSetup({ provider: 'anthropic' })

    await waitForScreen(setup, 'Connect Anthropic')
    pressKey(setup, 'escape')

    await waitFor(() => setup.cancelled() === 1)
  })

  it('cancels on Ctrl+C', async () => {
    const setup = renderSetup({ provider: 'anthropic' })

    await waitForScreen(setup, 'Connect Anthropic')
    pressKey(setup, 'ctrlC')

    await waitFor(() => setup.cancelled() === 1)
  })
})
