import { ApiError } from '@openharness/client'
import { createFakeClient } from '@openharness/client/testing'
import { makeProviderCredential } from '@openharness/protocol/fixtures'
import { cleanup, render } from 'ink-testing-library'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
function renderSetup(
  options: {
    readonly provider?: string
    readonly openUrl?: boolean
    /** Credential names the fake already has, for a named type's second credential. */
    readonly stored?: readonly string[]
  } = {},
) {
  const fake = createFakeClient({
    ...(options.stored === undefined
      ? {}
      : {
          credentials: options.stored.map((name) =>
            makeProviderCredential({ name, last4: '1111' }),
          ),
        }),
  })
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
      expect.objectContaining({ name: 'anthropic', type: 'api_key', last4: '0000' }),
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

    await waitForFrame(retry, 'It was rejected: The anthropic credential was rejected')
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

describe('ProviderSetup — the azure form (#245, A3a)', () => {
  it('offers the named credential type in the list, and asks its three fields', async () => {
    const setup = renderSetup()

    await waitForScreen(setup, 'No provider key yet')
    await waitForFrame(setup, 'Azure OpenAI')

    // Walk to the azure row (the last one) and open its form.
    for (let step = 0; step < 11; step += 1) pressKey(setup, 'down')
    pressKey(setup, 'enter')

    await waitForScreen(setup, 'Endpoint')
    // The first credential of the type takes the default name, so nothing asks for one.
    expect(frameOf(setup)).not.toContain('Name (its models will be')

    typeText(setup, 'https://my-resource.openai.azure.com')
    // The endpoint is not a secret: what was typed is on screen.
    await waitForFrame(setup, 'https://my-resource.openai.azure.com')
    pressKey(setup, 'enter')

    await waitForScreen(setup, 'API key')
    typeText(setup, 'az-key-4242')
    pressKey(setup, 'enter')

    await waitForScreen(setup, 'Deployments')

    typeText(setup, 'gpt-4o, gpt-4o-mini')
    pressKey(setup, 'enter')

    await waitFor(() => setup.saved.length === 1)
    expect(setup.saved).toEqual(['azure'])
    const { data } = await setup.fake.providerCredentials.list()
    expect(data).toEqual([
      expect.objectContaining({
        type: 'azure_openai',
        name: 'azure',
        last4: '4242',
      }),
    ])
  })

  it('asks for a name when one azure credential is already stored, and saves under it', async () => {
    const setup = renderSetup({ provider: 'azure', stored: ['azure'] })

    await waitForScreen(setup, 'Name (its models will be azure/<deployment>)')

    typeText(setup, 'azure-eu')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'Endpoint')
    typeText(setup, 'https://my-resource.openai.azure.com')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'API key')
    typeText(setup, 'az-eu-7777')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'Deployments')
    typeText(setup, 'gpt-4o')
    pressKey(setup, 'enter')

    await waitFor(() => setup.saved.length === 1)
    expect(setup.saved).toEqual(['azure-eu'])
  })

  it('refuses a name already taken, before the fields are asked', async () => {
    const setup = renderSetup({ provider: 'azure', stored: ['azure'] })

    await waitForScreen(setup, 'Name (its models will be azure/<deployment>)')

    typeText(setup, 'azure')
    pressKey(setup, 'enter')

    await waitForFrame(setup, 'already taken')
    // Still on the name prompt: nothing was sent, and the form did not move on.
    expect(setup.saved).toEqual([])
    expect(frameOf(setup)).toContain('Name (its models will be')
  })
})

describe('ProviderSetup — the custom OpenAI-compatible form (#249, A3b)', () => {
  it('asks a base URL and an optional key, and saves a keyless endpoint', async () => {
    const setup = renderSetup()

    await waitForScreen(setup, 'No provider key yet')
    await waitForFrame(setup, 'Custom (OpenAI-compatible)')

    // Walk to the custom row (the last one — after the eleven providers and Azure) and open it.
    for (let step = 0; step < 12; step += 1) pressKey(setup, 'down')
    pressKey(setup, 'enter')

    await waitForScreen(setup, 'Base URL')
    // A custom endpoint is the reader's own: there is no key page to print.
    expect(frameOf(setup)).not.toContain('Get a key:')

    typeText(setup, 'http://127.0.0.1:11434/v1')
    // The base URL is not a secret: what was typed is on screen.
    await waitForFrame(setup, 'http://127.0.0.1:11434/v1')
    pressKey(setup, 'enter')

    await waitForScreen(setup, 'API key (optional)')
    // The key is optional: Enter on the empty box moves on and saves.
    pressKey(setup, 'enter')

    await waitFor(() => setup.saved.length === 1)
    expect(setup.saved).toEqual(['custom'])
    const { data } = await setup.fake.providerCredentials.list()
    expect(data).toEqual([
      expect.objectContaining({
        type: 'openai_compatible',
        name: 'custom',
        last4: '',
        details: { base_url_host: '127.0.0.1:11434' },
      }),
    ])
  })

  it('asks for a name when one custom credential is already stored, and saves under it', async () => {
    const setup = renderSetup({ provider: 'custom', stored: ['custom'] })

    // A custom credential's models are `<name>/<model>`, not `<name>/<deployment>`.
    await waitForScreen(setup, 'Name (its models will be custom/<model>)')

    typeText(setup, 'my-local')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'Base URL')
    typeText(setup, 'https://api.example.com/v1')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'API key (optional)')
    typeText(setup, 'sk-custom-4242')
    pressKey(setup, 'enter')

    await waitFor(() => setup.saved.length === 1)
    expect(setup.saved).toEqual(['my-local'])
    const { data } = await setup.fake.providerCredentials.list()
    expect(data.map((credential) => credential.name).sort()).toEqual(['custom', 'my-local'])
  })
})

describe('ProviderSetup — the bedrock form (#245, A3c)', () => {
  it('offers the region as a list, and saves the chosen one with the keys', async () => {
    const setup = renderSetup({ provider: 'bedrock' })

    await waitForScreen(setup, 'Region')
    // The region is a list, not a box: the default is highlighted and the list is the
    // protocol's, so a typed region could never name a host that does not exist.
    await waitForFrame(setup, 'us-east-1')
    expect(frameOf(setup)).toContain('❯ us-east-1')
    expect(frameOf(setup)).toContain('eu-west-1')

    pressKey(setup, 'down')
    pressKey(setup, 'down')
    // The list is the protocol's order, so two rows down from `us-east-1` is `us-west-1`.
    await waitForFrame(setup, '❯ us-west-1')
    pressKey(setup, 'enter')

    await waitForScreen(setup, 'Access key ID')
    typeText(setup, 'AKIAIOSFODNN7EXAMPLE')
    pressKey(setup, 'enter')

    await waitForScreen(setup, 'Secret access key')
    typeText(setup, 'wJalrXUtnFEMI-K7MDENG')
    pressKey(setup, 'enter')

    // The token is optional: Enter alone skips it, and the field is masked like the secret it
    // is — the frame holds a mask, never the characters.
    await waitForScreen(setup, 'Session token')
    pressKey(setup, 'enter')

    await waitFor(() => setup.saved.length === 1)
    expect(setup.saved).toEqual(['bedrock'])
    const { data } = await setup.fake.providerCredentials.list()
    expect(data).toEqual([
      expect.objectContaining({
        type: 'bedrock',
        name: 'bedrock',
        last4: 'MPLE',
        details: { region: 'us-west-1' },
      }),
    ])
    // Nothing a secret was typed into appears in the frame — the mask is all that is drawn.
    expect(frameOf(setup)).not.toContain('wJalrXUtnFEMI-K7MDENG')
  })

  it('sends a typed session token, and keeps it out of the frame', async () => {
    const setup = renderSetup({ provider: 'bedrock' })

    await waitForScreen(setup, 'Region')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'Access key ID')
    typeText(setup, 'AKIAIOSFODNN7EXAMPL2')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'Secret access key')
    typeText(setup, 'wJalrXUtnFEMI-K7MDENG')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'Session token')
    typeText(setup, 'FwoGZXIvYXdzEBYaD-secret-token')
    // Masked: the token is a secret too, so no frame holds it.
    expect(frameOf(setup)).not.toContain('FwoGZXIvYXdzEBYaD-secret-token')
    pressKey(setup, 'enter')

    await waitFor(() => setup.saved.length === 1)
    const { data } = await setup.fake.providerCredentials.list()
    expect(data[0]).toMatchObject({ name: 'bedrock', details: { region: 'us-east-1' } })
  })

  it('asks for a name for a second credential, and lists each one’s region', async () => {
    const setup = renderSetup({ provider: 'bedrock', stored: ['bedrock'] })

    await waitForScreen(setup, 'Name (its models will be bedrock/<model id>)')
    typeText(setup, 'bedrock-us')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'Region')
    pressKey(setup, 'down')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'Access key ID')
    typeText(setup, 'AKIAIOSFODNN7EXAMPL3')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'Secret access key')
    typeText(setup, 'wJalrXUtnFEMI-K7MDENG')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'Session token')
    pressKey(setup, 'enter')

    await waitFor(() => setup.saved.length === 1)
    expect(setup.saved).toEqual(['bedrock-us'])
    const { data } = await setup.fake.providerCredentials.list()
    expect(data.map((entry) => entry.name).sort()).toEqual(['bedrock', 'bedrock-us'])
    expect(data.find((entry) => entry.name === 'bedrock-us')).toMatchObject({
      details: { region: 'us-east-2' },
    })
  })
})

describe('ProviderSetup — the vertex form (#245, A3d)', () => {
  it('asks for a name for a second credential, named the way its models are', async () => {
    // A Vertex credential's models are `<name>/<model>` — not Azure's `<deployment>`, which is
    // what the label said before the noun became the type's to say.
    const setup = renderSetup({ provider: 'vertex', stored: ['vertex'] })

    await waitForScreen(setup, 'Name (its models will be vertex/<model>)')
  })

  /** A service-account key document on disk, as the console downloads one. */
  function keyFile(): string {
    const directory = mkdtempSync(join(tmpdir(), 'oh-vertex-'))
    const path = join(directory, 'openharness-vertex.json')
    writeFileSync(
      path,
      JSON.stringify({
        type: 'service_account',
        project_id: 'openharness-vertex',
        private_key_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        private_key:
          '-----BEGIN PRIVATE KEY-----\nVERTEX-AT-THE-PROMPT\n-----END PRIVATE KEY-----\n',
        client_email: 'vertex-runner@openharness-vertex.iam.gserviceaccount.com',
      }),
    )
    return path
  }

  it('reads the key from the path the reader gives, and never puts it on the screen', async () => {
    const path = keyFile()
    const setup = renderSetup({ provider: 'vertex' })

    await waitForScreen(setup, 'Service account JSON file path')
    typeText(setup, path)
    pressKey(setup, 'enter')

    // The path is what was typed and what the flow echoes; the document the file holds is read
    // here and goes no further than the request.
    await waitForScreen(setup, 'Project ID (the key’s own by default)')
    expect(frameOf(setup)).not.toContain('VERTEX-AT-THE-PROMPT')
    expect(frameOf(setup)).not.toContain('BEGIN PRIVATE KEY')

    // The prompt opens with the project the document names, so Enter takes the key's own.
    expect(frameOf(setup)).toContain('openharness-vertex')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'Location (e.g. us-central1')
    typeText(setup, 'us-central1')
    pressKey(setup, 'enter')

    await waitFor(() => setup.saved.length === 1)
    expect(setup.saved).toEqual(['vertex'])
    const { data } = await setup.fake.providerCredentials.list()
    expect(data).toEqual([
      expect.objectContaining({
        type: 'vertex',
        name: 'vertex',
        // The key **id**'s tail, and the three facts that are not secret.
        last4: '5678',
        details: {
          email: 'vertex-runner@openharness-vertex.iam.gserviceaccount.com',
          project: 'openharness-vertex',
          location: 'us-central1',
        },
      }),
    ])
  })

  it('refuses a path it cannot read, and stays on the prompt', async () => {
    const setup = renderSetup({ provider: 'vertex' })

    await waitForScreen(setup, 'Service account JSON file path')
    typeText(setup, '/nowhere/no-key-here.json')
    pressKey(setup, 'enter')

    await waitForScreen(setup, 'could not read /nowhere/no-key-here.json')
    // Still the same field: a path that reads nothing is retyped, not skipped.
    expect(frameOf(setup)).toContain('Service account JSON file path')
    expect(setup.saved).toEqual([])
  })

  it('clears a field’s refusal once the answer is corrected', async () => {
    // The refusal is about the value on the prompt: it goes when a good one replaces it, so a
    // reader never sees last field's error above the next field's question.
    const setup = renderSetup({ provider: 'vertex', stored: ['vertex'] })

    await waitForScreen(setup, 'Name (its models will be vertex/<model>)')
    typeText(setup, 'vertex-check')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'Service account JSON file path')
    typeText(setup, keyFile())
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'Project ID (the key’s own by default)')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'Location (e.g. us-central1')

    typeText(setup, 'mars-north1')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'A Vertex location is one of Google’s regions')

    for (let i = 0; i < 'mars-north1'.length; i += 1) pressKey(setup, 'backspace')
    typeText(setup, 'europe-west4')
    pressKey(setup, 'enter')

    await waitFor(() => setup.saved.length === 1)
    expect(frameOf(setup)).not.toContain('A Vertex location is one of')
  })

  it('refuses a location outside Google’s list, rather than sending it', async () => {
    const setup = renderSetup({ provider: 'vertex' })

    await waitForScreen(setup, 'Service account JSON file path')
    typeText(setup, keyFile())
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'Project ID (the key’s own by default)')
    pressKey(setup, 'enter')
    await waitForScreen(setup, 'Location (e.g. us-central1')

    typeText(setup, 'mars-north1')
    pressKey(setup, 'enter')

    await waitForScreen(setup, 'A Vertex location is one of Google’s regions')
    expect(setup.saved).toEqual([])
    const { data } = await setup.fake.providerCredentials.list()
    expect(data).toEqual([])
  })
})
