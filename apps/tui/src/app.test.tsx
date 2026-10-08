import { ApiError, type Client } from '@openharness/client'
import { createFakeClient, type FakeClient } from '@openharness/client/testing'
import { cleanup, render } from 'ink-testing-library'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { makeModelEntry, makeProviderCredential } from '@openharness/protocol/fixtures'

import { App, type AppProps, type ExitPayload } from './app'
import type { ChatOptions } from './args'
import { shortSessionId } from './components/status-line'
import type { PromptHistory } from './history'
import { firstRunFake, listingAgents } from './test-support/fake'
import {
  frameOf,
  pressKey,
  submit,
  typeText,
  waitFor,
  waitForFrame,
  waitForScreen,
  type TestInstance,
} from './test-support/input'

const CONTEXT = { server: 'http://localhost:3000' }

/** The flags a test does not care about. */
function chatOptions(overrides: Partial<ChatOptions> = {}): ChatOptions {
  return { debug: false, continue: false, ...overrides }
}

/** Render the app against a client and record how it leaves. */
function renderApp(
  client: Client,
  options: ChatOptions = chatOptions(),
  history?: PromptHistory,
  props: Partial<AppProps> = {},
) {
  const exits: ExitPayload[] = []
  const instance = render(
    <App
      client={client}
      options={options}
      context={CONTEXT}
      loadHistory={history === undefined ? undefined : () => Promise.resolve(history)}
      onExit={(payload) => {
        exits.push(payload)
      }}
      {...props}
    />,
  )

  return { ...instance, exits }
}

/**
 * A prompt history that is only a list, for the tests that go through the whole app.
 *
 * The store's own file is covered in `history.test.ts`; what these tests are about is that
 * the screen hands the history down to the prompt, and that a send reaches it.
 */
function fakeHistory(entries: readonly string[] = []): PromptHistory {
  const list = [...entries]
  return {
    path: join(tmpdir(), 'oh-app-test', 'history.json'),
    entries: () => list,
    add(text) {
      list.push(text)
    },
  }
}

type TestApp = TestInstance & { exits: ExitPayload[] }

/**
 * Wait for the chat screen.
 *
 * Its status line is the proof it is up: passing a session id also proves *which* session
 * the app opened, which for a new chat is one the test did not know in advance. The line
 * shows the shortened id (#208), so that is what is matched.
 */
async function waitForChat(app: TestApp, sessionId?: string): Promise<void> {
  if (sessionId !== undefined) {
    await waitForFrame(app, shortSessionId(sessionId))
  }
  await waitForScreen(app, / · (idle|running)$/mu)
}

/** Get past the picker a chat with no default starts with: Enter, then "no" to the save. */
async function pickFirstModel(app: TestApp): Promise<void> {
  await waitForScreen(app, 'Which model?')
  pressKey(app, 'enter')
  await waitForScreen(app, 'as your default model for new chats?')
  typeText(app, 'n')
}

/** The session a new chat opened: the fake's newest. */
async function openedSession(fake: FakeClient): Promise<string> {
  const [newest] = (await fake.sessions.list()).data
  if (newest === undefined) throw new Error('the app did not open a session')
  return newest.id
}

/** The stored user messages of a session, as text. */
function userTexts(fake: FakeClient, sessionId: string): readonly string[] {
  return fake
    .history(sessionId)
    .flatMap((event) =>
      event.type === 'user.message'
        ? event.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : [],
    )
}

afterEach(() => {
  cleanup()
})

describe('App', () => {
  it('streams a reply to a message in a new chat', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake)

    await pickFirstModel(app)
    await waitForChat(app)
    submit(app, 'Hi there.')

    // The fake echoes the message when nothing is scripted — which also proves the chat
    // opened a session of its own and the brain got the text.
    await waitForFrame(app, 'Hi there.')
    await waitForFrame(app, 'Fake reply: Hi there.')
    expect(app.exits).toEqual([])
  })

  it('shows the history of the session it resumes', async () => {
    const fake = createFakeClient()
    fake.respondWith('An earlier reply.')
    await fake.sendMessage(fake.session.id, 'An earlier question.')
    await fake.waitForIdle()

    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)

    await waitForFrame(app, 'An earlier question.')
    await waitForFrame(app, 'An earlier reply.')
  })

  it('resumes the newest session with --continue', async () => {
    const fake = createFakeClient()
    const resumed = await fake.sessions.create({
      agent: fake.agent.id,
      title: 'The recent one',
      initial_events: [
        { type: 'user.message', content: [{ type: 'text', text: 'From the recent session.' }] },
      ],
    })
    fake.respondWith('Its reply.', { sessionId: resumed.id })
    await fake.waitForIdle(resumed.id)

    const app = renderApp(fake, chatOptions({ continue: true }))
    await waitForChat(app, resumed.id)

    await waitForFrame(app, 'From the recent session.')
  })

  it('shows the model and the status in the status line of a model-first chat', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake)

    // The catalog's only model — the picker's first row — is what the session will run.
    await waitForScreen(app, '❯ 1. Claude Sonnet 5 · 200k context')
    pressKey(app, 'enter')
    await waitForScreen(app, 'as your default model for new chats?')
    typeText(app, 'n')

    // The picker read the catalog, so the line names the model the way the picker did (#208).
    await waitForFrame(app, 'Claude Sonnet 5 · sesn_')
    // …and the session is named by a short id, not the whole `sesn_` ULID.
    await waitForFrame(app, /sesn_…[0-9A-Z]{6} · idle/u)
  })

  it('names the model by its id when no catalog was read (#208)', async () => {
    // `--model` skips the catalog by design: there is nothing to look a display name up in.
    const fake = createFakeClient()
    const app = renderApp(fake, chatOptions({ model: 'anthropic/claude-opus-5-5' }))

    await waitForFrame(app, 'anthropic/claude-opus-5-5 · sesn_…')
    expect(frameOf(app)).not.toContain('Claude Opus 5.5')
  })

  it('starts on the default model with no picker (#114, U1)', async () => {
    const fake = createFakeClient({ preferences: { default_model: 'openai/gpt-4.1-mini' } })
    const app = renderApp(fake)

    await waitForChat(app)
    expect(frameOf(app)).not.toContain('Which model?')

    const created = (await fake.sessions.list()).data[0]
    expect(created?.model.id).toBe('openai/gpt-4.1-mini')
    expect(created?.agent).toBeNull()
  })

  it('offers to save the picked model as the default, and saves it on yes (#114, U1)', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake)

    await waitForScreen(app, '❯ 1. Claude Sonnet 5 · 200k context')
    pressKey(app, 'enter')

    await waitForScreen(app, 'Save anthropic/claude-sonnet-5 as your default model for new chats?')
    typeText(app, 'y')

    await waitForChat(app)
    expect((await fake.preferences.get()).default_model).toBe('anthropic/claude-sonnet-5')
  })

  it('offers to save on a free-text model id too, and Enter skips the save', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake)

    await waitForScreen(app, 'Which model?')
    typeText(app, '2')
    await waitForScreen(app, 'type a model id as provider/model')
    submit(app, 'meta/llama-4')

    await waitForScreen(app, 'Save meta/llama-4 as your default model for new chats?')
    pressKey(app, 'enter')

    await waitForFrame(app, 'meta/llama-4 · sesn_')
    expect((await fake.preferences.get()).default_model).toBeNull()
  })

  it('chats without saving when the default cannot be stored, saying why', async () => {
    const fake = createFakeClient()
    const client: Client = {
      ...fake,
      preferences: {
        ...fake.preferences,
        put: () => Promise.reject(new ApiError(500, 'the server failed')),
      },
    }
    const app = renderApp(client)

    await waitForScreen(app, 'Which model?')
    pressKey(app, 'enter')
    await waitForScreen(app, 'as your default model for new chats?')
    typeText(app, 'y')

    await waitForScreen(app, 'could not save the default model')
    pressKey(app, 'enter')

    await waitForChat(app)
    expect((await fake.sessions.list()).data[0]?.model.id).toBe('anthropic/claude-sonnet-5')
  })

  it('switches models with /model, sending the choice on the next message (#114, U3)', async () => {
    const fake = createFakeClient({
      models: [
        makeModelEntry({ id: 'anthropic/claude-sonnet-5' }),
        makeModelEntry({ id: 'openai/gpt-4.1-mini', provider: 'openai', name: 'GPT-4.1 Mini' }),
      ],
    })
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    const sessionId = fake.session.id
    await waitForChat(app, sessionId)

    submit(app, '/model')
    await waitForScreen(app, 'Which model?')
    pressKey(app, 'down')
    await waitForFrame(app, '❯ 2. GPT-4.1 Mini')
    pressKey(app, 'enter')

    // The pick is not sent until a message is: the status line says when it applies, naming
    // the model as the picker did (the catalog is loaded by now).
    await waitForFrame(app, 'GPT-4.1 Mini (next message)')
    expect(fake.history(sessionId).filter((event) => event.type === 'user.message')).toEqual([])

    submit(app, 'On the other model.')

    await waitForFrame(app, 'On the other model.')
    const sent = fake.history(sessionId).find((event) => event.type === 'user.message')
    expect(sent?.type === 'user.message' && sent.model?.id).toBe('openai/gpt-4.1-mini')
    await waitForFrame(app, /GPT-4\.1 Mini · sesn_/)
  })

  it('leaves the chat with /model on Ctrl+C, changing nothing', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)

    submit(app, '/model')
    await waitForScreen(app, 'Which model?')
    pressKey(app, 'ctrlC')

    // The picker is gone, the chat is back, and no model was picked.
    await waitForScreen(app, '❯ ')
    expect(frameOf(app)).not.toContain('Which model?')
    expect(app.exits).toEqual([])
  })

  it('gives the input area to the picker, which is the only thing taking keys', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)

    submit(app, '/model')
    await waitForScreen(app, 'Which model?')

    // The prompt is not mounted while a flow is up, so what is typed reaches nothing: the
    // picker's own keys (its Ctrl+C cancel included) are the only ones that do anything.
    typeText(app, 'zz')
    pressKey(app, 'ctrlC')
    await waitFor(() => !frameOf(app).includes('Which model?'), { describe: () => frameOf(app) })

    expect(frameOf(app)).not.toContain('zz')
    // And the prompt it gave back is the one that was there: empty, and ready.
    submit(app, 'Back on the prompt.')
    await waitForFrame(app, 'Back on the prompt.')
    expect(app.exits).toEqual([])
  })

  it('reports a catalog the picker could not load, and keeps chatting', async () => {
    const fake = createFakeClient()
    const client: Client = {
      ...fake,
      models: { list: () => Promise.reject(new Error('the catalog is down')) },
    }
    const app = renderApp(client, chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)

    submit(app, '/model')

    await waitForFrame(app, 'error: the catalog is down')
    expect(frameOf(app)).not.toContain('Which model?')
  })

  // --- the slash commands and the menu (#207) ------------------------------------------------

  it('opens the command menu on /, and runs the row Enter picks', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)

    typeText(app, '/')

    await waitForFrame(app, 'Tab to complete')
    expect(frameOf(app)).toContain('/model')
    expect(frameOf(app)).toContain('/new')
    expect(frameOf(app)).toContain('/help')
    expect(frameOf(app)).toContain('/exit (/quit)')

    // `/model` is the first row, so a bare `/` and Enter is the picker.
    pressKey(app, 'enter')
    await waitForScreen(app, 'Which model?')
  })

  it('starts a new chat on the current model with /new, leaving the old one behind', async () => {
    const fake = createFakeClient()
    const previous = fake.session.id
    const modelId = fake.session.model.id
    const app = renderApp(fake, chatOptions({ session: previous }))
    await waitForChat(app, previous)

    submit(app, '/new')

    // The status line names a session that did not exist a moment ago, on the same model.
    await waitFor(() => !frameOf(app).includes(shortSessionId(previous)), {
      describe: () => frameOf(app),
    })
    const [newest] = (await fake.sessions.list()).data
    expect(newest?.id).not.toBe(previous)
    expect(newest?.model.id).toBe(modelId)
    // The line shows the shortened handle (#208); the whole id is in the exit payload.
    expect(frameOf(app)).toContain(shortSessionId(newest?.id ?? ''))
    // The chat carries on in the new session, which is the point of `/new`.
    submit(app, 'A message in the new chat.')
    await waitForFrame(app, 'A message in the new chat.')
    expect(userTexts(fake, newest?.id ?? '')).toEqual(['A message in the new chat.'])
  })

  it('clears the screen with /clear, and keeps the chat', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)
    submit(app, 'Hi.')
    await waitForFrame(app, 'Hi.')

    submit(app, '/clear')

    // A test's stdout is not a terminal, so the wipe itself does nothing here — what it
    // must not do is end the chat or lose the session behind it.
    expect(app.exits).toEqual([])
    expect(frameOf(app)).toContain('Hi.')
    submit(app, 'Still here.')
    await waitForFrame(app, 'Still here.')
  })

  it('lists the commands and the keys with /help, and sends nothing', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)

    submit(app, '/help')

    await waitForFrame(app, 'Commands and keys')
    const frame = frameOf(app)
    expect(frame).toContain('/model')
    expect(frame).toContain('/exit (/quit)')
    expect(frame).toContain('Ctrl+C')
    expect(userTexts(fake, fake.session.id)).toEqual([])
  })

  it('connects a provider from inside the chat with /providers (#210)', async () => {
    // A chat on a stored default, with no credential yet: the flow is reachable from the
    // prompt, not only from the first run.
    const catalog = [makeModelEntry({ id: 'anthropic/claude-sonnet-5' })]
    const fake = createFakeClient({
      models: catalog,
      preferences: { default_model: 'anthropic/claude-sonnet-5' },
    })
    const app = renderApp(firstRunFake(fake, catalog), chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)

    submit(app, '/providers')
    await waitForScreen(app, 'No provider key yet')
    pressKey(app, 'enter')
    await waitForScreen(app, 'Connect Anthropic')
    typeText(app, 'sk-test-0000')
    pressKey(app, 'enter')

    // The save is a notice in the chat, the prompt comes back, and nothing was sent to the
    // model — the conversation is untouched.
    await waitForFrame(app, 'Connected Anthropic.')
    await waitForFrame(app, "You're set: default model Claude Sonnet 5")
    // The prompt is back: the flow handed the input area over and gave it back.
    expect(frameOf(app)).toContain('❯')
    expect(userTexts(fake, fake.session.id)).toEqual([])

    const { data } = await fake.providerCredentials.list()
    expect(data).toEqual([expect.objectContaining({ provider: 'anthropic', last4: '0000' })])
  })

  it('leaves the chat unchanged when /providers is cancelled', async () => {
    const fake = createFakeClient({ preferences: { default_model: 'anthropic/claude-sonnet-5' } })
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)

    submit(app, '/providers')
    await waitForScreen(app, 'No provider key yet')
    pressKey(app, 'escape')

    await waitForFrame(app, '❯')
    expect((await fake.providerCredentials.list()).data).toEqual([])
    expect(app.exits).toEqual([])
  })

  it('names an unknown command back, with the closest match, and sends nothing', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)

    submit(app, '/modl')

    await waitForFrame(app, 'error: Unknown command /modl. Did you mean /model?')
    expect(frameOf(app)).not.toContain('Which model?')
    expect(userTexts(fake, fake.session.id)).toEqual([])
  })

  it('sends a literal slash for a message that starts with //', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)

    submit(app, '//model')

    await waitForFrame(app, '/model')
    expect(userTexts(fake, fake.session.id)).toEqual(['/model'])
    expect(frameOf(app)).not.toContain('Which model?')
  })

  it('leaves with /exit, and with its alias /quit', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)

    submit(app, '/quit')

    await waitFor(() => app.exits.length === 1)
    expect(app.exits).toEqual([{ code: 0, sessionId: fake.session.id }])
  })

  it('leaves cleanly with a notice when the chat is deleted elsewhere (#114, U5)', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)

    await fake.sessions.delete(fake.session.id)

    await waitFor(() => app.exits.length === 1)
    expect(app.exits[0]).toEqual({ code: 0, deleted: true })
  })

  it('offers the catalog grouped by provider, and chats on the model Enter picks', async () => {
    const fake = createFakeClient({
      models: [
        makeModelEntry({
          id: 'anthropic/claude-opus-5-5',
          provider: 'anthropic',
          name: 'Claude Opus 5.5',
          context_window: 200_000,
        }),
        makeModelEntry({
          id: 'openai/gpt-4.1-mini',
          provider: 'openai',
          name: 'GPT-4.1 Mini',
          context_window: 1_000_000,
        }),
      ],
    })
    const app = renderApp(fake)

    await waitForScreen(app, 'Which model?')
    await waitForFrame(app, '❯ 1. Claude Opus 5.5 · 200k context')
    // Each provider has its heading, and the rows are numbered across the whole list.
    expect(frameOf(app)).toContain('anthropic')
    await waitForFrame(app, ' 2. GPT-4.1 Mini · 1M context')
    expect(frameOf(app)).toContain('openai')

    pressKey(app, 'down')
    await waitForFrame(app, '❯ 2. GPT-4.1 Mini · 1M context')
    pressKey(app, 'enter')
    await waitForScreen(app, 'Save openai/gpt-4.1-mini as your default model for new chats?')
    typeText(app, 'n')

    await waitForFrame(app, 'GPT-4.1 Mini · sesn_')
    const created = (await fake.sessions.list()).data[0]
    expect(created?.model.id).toBe('openai/gpt-4.1-mini')
    // Model-first: the session has no agent, and is identified by its model.
    expect(created?.agent).toBeNull()
    expect(app.exits).toEqual([])
  })

  it('starts a chat on a free-text model id typed into the picker', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake)

    await waitForScreen(app, 'Which model?')
    // One catalog model, so "Other model id…" is the second row.
    typeText(app, '2')
    await waitForScreen(app, 'type a model id as provider/model')
    submit(app, 'meta/llama-4')
    await waitForScreen(app, 'as your default model for new chats?')
    typeText(app, 'n')

    await waitForFrame(app, 'meta/llama-4 · sesn_')
    expect((await fake.sessions.list()).data[0]?.model.id).toBe('meta/llama-4')
  })

  it('skips the picker with --model', async () => {
    const fake = createFakeClient()
    // A catalog that fails if it is read at all: --model means it is never read.
    const client: Client = {
      ...fake,
      models: {
        list: () => Promise.reject(new Error('the catalog should not be read')),
      },
    }
    const app = renderApp(client, chatOptions({ model: 'openai/gpt-4.1-mini' }))

    await waitForFrame(app, 'openai/gpt-4.1-mini · sesn_')
    expect(frameOf(app)).not.toContain('Which model?')
    const created = (await fake.sessions.list()).data[0]
    expect(created?.model.id).toBe('openai/gpt-4.1-mini')
    expect(created?.agent).toBeNull()
  })

  it('starts on the agent --agent names', async () => {
    const fake = createFakeClient()
    const reviewer = await fake.agents.create({
      name: 'Reviewer',
      model: { id: 'anthropic/claude-opus-5-5' },
    })

    const app = renderApp(
      listingAgents(fake, [fake.agent, reviewer]),
      chatOptions({ agent: 'Reviewer' }),
    )

    await waitForFrame(app, 'Reviewer · anthropic/claude-opus-5-5 ·')
    expect(frameOf(app)).not.toContain('Which model?')
  })

  it('offers to connect a provider when the account has no key (#210)', async () => {
    const fake = createFakeClient({ models: [makeModelEntry()] })
    const app = renderApp(firstRunFake(fake, [makeModelEntry()]))

    await waitForScreen(app, 'No provider key yet')
    // The list is built from PROVIDERS, free-tier hints and all (X8).
    await waitForFrame(app, 'Anthropic')
    await waitForFrame(app, 'Google · Free tier in Google AI Studio')
    await waitForFrame(app, 'OpenRouter · Free models available')
  })

  it('connects a provider, names the default model, and opens the chat (#210)', async () => {
    const catalog = [makeModelEntry({ id: 'anthropic/claude-sonnet-5' })]
    const fake = createFakeClient({ models: catalog })
    const app = renderApp(firstRunFake(fake, catalog))
    const key = 'sk-test-0000'

    await waitForScreen(app, 'No provider key yet')
    pressKey(app, 'enter')
    await waitForScreen(app, 'Connect Anthropic')
    await waitForFrame(app, 'Get a key: https://console.anthropic.com/settings/keys')

    typeText(app, key)
    await waitForFrame(app, '❯ •••••••••••')
    // The key is nowhere on screen — the input masks it, character for character.
    expect(frameOf(app)).not.toContain(key)

    pressKey(app, 'enter')
    await waitForScreen(app, "You're set: default model Claude Sonnet 5.")
    expect(app.exits).toEqual([])

    pressKey(app, 'enter')
    await waitForChat(app)

    const { data } = await fake.providerCredentials.list()
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ provider: 'anthropic', last4: '0000' })
  })

  it('keeps a saved key out of the prompt history and the config directory (#210)', async () => {
    const catalog = [makeModelEntry({ id: 'anthropic/claude-sonnet-5' })]
    const fake = createFakeClient({ models: catalog })
    const history = fakeHistory()
    const app = renderApp(firstRunFake(fake, catalog), chatOptions(), history)
    const key = 'sk-test-0000'

    await waitForScreen(app, 'No provider key yet')
    pressKey(app, 'enter')
    await waitForScreen(app, 'Connect Anthropic')
    typeText(app, key)
    pressKey(app, 'enter')
    await waitForScreen(app, "You're set: default model Claude Sonnet 5.")
    pressKey(app, 'enter')
    await waitForChat(app)

    // Nothing typed into the hidden input is a prompt: the history is for messages, and a
    // secret never reaches `history.json` (the seam #206 left for exactly this).
    expect(history.entries()).toEqual([])
  })

  it('says a rejected key was rejected, without echoing it (#210)', async () => {
    const catalog = [makeModelEntry({ id: 'anthropic/claude-sonnet-5' })]
    const fake = createFakeClient({ models: catalog })
    // An empty key is the one rejection the fake can spell with no provider behind it.
    const client: Client = {
      ...firstRunFake(fake, catalog),
      providerCredentials: {
        ...fake.providerCredentials,
        put: () =>
          Promise.reject(
            new ApiError(422, 'The anthropic credential was rejected by the provider.', {
              type: 'invalid_provider_credential',
            }),
          ),
      },
    }
    const app = renderApp(client)
    const key = 'sk-test-0000'

    await waitForScreen(app, 'No provider key yet')
    pressKey(app, 'enter')
    await waitForScreen(app, 'Connect Anthropic')
    typeText(app, key)
    pressKey(app, 'enter')

    await waitForFrame(app, 'The key was rejected: The anthropic credential was rejected')
    // The error is the server's, and the key is not in it, in the frame, or anywhere else.
    expect(frameOf(app)).not.toContain(key)
    expect(frameOf(app)).not.toContain('sk-test')
  })

  it('says where a key comes from when keys exist but no model does (#210)', async () => {
    const fake = createFakeClient({
      models: [],
      providers: [],
      credentials: [makeProviderCredential({ provider: 'anthropic' })],
    })
    const app = renderApp(fake)

    await waitForFrame(app, 'No model yet — your keys did not list one to chat with.')
    await waitForFrame(app, `Add or replace a key with \`oh providers add\``)

    await waitFor(() => app.exits.length === 1)
    expect(app.exits[0]).toEqual({ code: 1 })
  })

  it('leaves with needsSignIn when the session is refused and this run can sign in (#210)', async () => {
    const fake = createFakeClient({ authenticated: false })
    const app = renderApp(fake, chatOptions(), undefined, { offerSignIn: true })

    await waitFor(() => app.exits.length === 1)
    // The signal the run turns into "Sign in now? [Y/n]" and a second mount — the app does not
    // run the device flow itself.
    expect(app.exits[0]).toEqual({ code: 1, needsSignIn: true })
  })

  it('shows the not-signed-in error when the run cannot sign in (#210)', async () => {
    const fake = createFakeClient({ authenticated: false })
    const app = renderApp(fake)

    await waitForFrame(app, `not signed in to ${CONTEXT.server}`)
    await waitFor(() => app.exits.length === 1)
    expect(app.exits[0]).toEqual({ code: 1 })
  })

  it('offers the sign-in again when connecting a provider hits a stale session (#210)', async () => {
    const fake = createFakeClient({ authenticated: false })
    const app = renderApp(firstRunFake(fake, [makeModelEntry()]), chatOptions(), undefined, {
      offerSignIn: true,
    })

    await waitFor(() => app.exits.length === 1)
    expect(app.exits[0]).toEqual({ code: 1, needsSignIn: true })
  })

  it('explains an --agent that matches nothing', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake, chatOptions({ agent: 'Nope' }))

    await waitForFrame(app, "no agent matches 'Nope'")
    await waitForFrame(app, `This server has: ${fake.agent.name}`)

    await waitFor(() => app.exits.length === 1)
    expect(app.exits[0]).toEqual({ code: 1 })
  })

  it('explains a session that does not exist', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake, chatOptions({ session: 'sesn_missing' }))

    await waitForFrame(app, /error: .*missing/i)
    await waitFor(() => app.exits.length === 1)
    expect(app.exits[0]).toEqual({ code: 1 })
  })

  it('draws an agent reply as markdown, all the way through the chat (epic #201, U4)', async () => {
    const fake = createFakeClient({ delayMs: 5 })
    fake.respondWith('# Report\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |', {
      chunks: 4,
      delayMs: 10,
    })
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))

    await waitForChat(app, fake.session.id)
    submit(app, 'Go.')
    // The heading is a heading, the list is bulleted and the table is drawn: what the
    // transcript renders is what `message-view` renders (see `message-view.test.tsx`).
    await waitForFrame(app, 'Report')
    await waitForFrame(app, /• one\n• two/u)
    await waitForFrame(app, /│ a │ b │/u)
    expect(app.exits).toEqual([])
  })

  it('interrupts a running turn with Ctrl+C, keeping the partial reply', async () => {
    const fake = createFakeClient({ delayMs: 10 })
    fake.respondWith('One two three four five six seven eight', { chunks: 8, delayMs: 40 })
    // Resuming the fake's own session is what lets the reply above be scripted for it: a
    // new chat would get a session id nobody could script in advance. (Any session works as
    // a resumed one — the seeded session simply has no history.)
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))

    await waitForChat(app, fake.session.id)
    submit(app, 'Go.')
    // Nothing has arrived yet, so the status field shows the spinner rather than `running`
    // (#208); the word comes back once the reply's first chunk lands.
    await waitForFrame(app, 'Working… ')
    await waitForFrame(app, /One two/u)

    pressKey(app, 'ctrlC')

    // The turn stops, the reply so far stays, and the app keeps running — and the status
    // line says what happened to it.
    await waitForFrame(app, 'Interrupted')
    await waitForFrame(app, /One two three/u)
    expect(app.exits).toEqual([])

    // …until there is something newer to say: the next send turns the line over.
    submit(app, 'Again.')
    await waitForFrame(app, 'Again.')
    await waitFor(() => !frameOf(app).includes('Interrupted'))
  })

  it('leaves on the second Ctrl+C when idle, pointing at the session', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake)
    await pickFirstModel(app)
    await waitForChat(app)
    const sessionId = await openedSession(fake)

    pressKey(app, 'ctrlC')
    await waitForFrame(app, 'Press Ctrl+C again to exit.')
    expect(app.exits).toEqual([])

    pressKey(app, 'ctrlC')
    await waitFor(() => app.exits.length === 1)
    expect(app.exits[0]).toEqual({ code: 0, sessionId })
    // The exit payload carries the whole id — it is what `oh -s` takes — where the line shows
    // the shortened one on the way out (#208).
    expect(frameOf(app)).toContain(shortSessionId(sessionId))
  })

  it('drops the exit hint once the user types again', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake)
    await pickFirstModel(app)
    await waitForChat(app)

    pressKey(app, 'ctrlC')
    await waitForFrame(app, 'Press Ctrl+C again to exit.')

    typeText(app, 'h')

    await waitFor(() => !frameOf(app).includes('Press Ctrl+C again to exit.'))
    await waitForFrame(app, '❯ h')
    expect(app.exits).toEqual([])
  })

  it('inserts a newline with Ctrl+J and sends the multi-line message', async () => {
    const fake = createFakeClient()
    fake.respondWith('Noted.')
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    const sessionId = fake.session.id
    await waitForChat(app, sessionId)

    typeText(app, 'first line')
    pressKey(app, 'newline')
    typeText(app, 'second line')

    await waitForFrame(app, '❯ first line')
    await waitForFrame(app, '  second line')
    expect(userTexts(fake, sessionId)).toEqual([])

    pressKey(app, 'enter')

    await waitForFrame(app, /first line\nsecond line/u)
    await waitForFrame(app, 'Noted.')
    expect(userTexts(fake, sessionId)).toEqual(['first line\nsecond line'])
  })

  it('walks the history the screen handed the prompt, and adds to it (#206)', async () => {
    const fake = createFakeClient()
    fake.respondWith('Noted.')
    const history = fakeHistory(['an older prompt'])
    const app = renderApp(fake, chatOptions({ session: fake.session.id }), history)
    await waitForChat(app, fake.session.id)

    // ↑ recalls what an earlier `oh` was told, on this server and by this user.
    pressKey(app, 'up')
    await waitForFrame(app, '❯ an older prompt')

    pressKey(app, 'down')
    submit(app, 'something new')
    await waitForFrame(app, 'something new')

    // …and what this chat sent is there for the next ↑, which is the point of a history.
    pressKey(app, 'up')
    await waitForFrame(app, '❯ something new')
  })

  it('clears the screen on Ctrl+L and keeps the chat (#206)', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)
    submit(app, 'Hi.')
    await waitForFrame(app, 'Hi.')

    pressKey(app, 'ctrlL')

    // The session is untouched: the transcript is still there and the chat still takes keys.
    expect(app.exits).toEqual([])
    expect(frameOf(app)).toContain('Hi.')
    submit(app, 'Still here.')
    await waitForFrame(app, 'Still here.')
  })

  it('steers while a reply is streaming', async () => {
    const fake = createFakeClient({ delayMs: 10 })
    fake.respondWith('First reply.', { chunks: 4, delayMs: 40 })
    fake.respondWith('Second reply.', { chunks: 4, delayMs: 10 })
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    const sessionId = fake.session.id

    await waitForChat(app, sessionId)

    submit(app, 'One.')
    await waitForFrame(app, 'Working… ')
    await waitForFrame(app, /First/u)

    submit(app, 'Two.')

    // Queued: the brain has not reached it yet, and the line says so (#208).
    await waitForFrame(app, 'Two. (queued)')

    await waitForFrame(app, 'Second reply.')
    await waitForFrame(app, 'Two.')
    // Delivered: the request that folded it in claimed it, so the tag is gone.
    await waitFor(() => !frameOf(app).includes('(queued)'))
    expect(userTexts(fake, sessionId)).toEqual(['One.', 'Two.'])
  })

  it('shows a turn that failed as an inline error, from the session log', async () => {
    const fake = createFakeClient()
    fake.failWith({
      type: 'model_overloaded_error',
      message: 'the model is overloaded',
      retryStatus: 'exhausted',
    })
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)

    submit(app, 'Hello.')

    await waitForFrame(app, 'error: the model is overloaded')
    await waitForFrame(app, '· idle')
    expect(app.exits).toEqual([])
  })

  it('says a retrying turn is retrying in the status line, and drops it once a reply lands', async () => {
    const fake = createFakeClient({ delayMs: 40 })
    fake.failWith({ message: 'the model is overloaded', delayMs: 40 })
    fake.respondWith('Second time lucky.', { chunks: 2, delayMs: 30 })
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)

    submit(app, 'Hello.')

    // A retry is the status line's news (#208), so it is said there and not in a notice of
    // its own: `error:` would be a second line about the same thing.
    await waitForFrame(app, 'Retrying… the model is overloaded')
    expect(frameOf(app)).not.toContain('error: the model is overloaded')
    await waitForFrame(app, 'Second time lucky.')
    await waitFor(() => !frameOf(app).includes('the model is overloaded'))
  })

  it('shows a send that failed as an inline error', async () => {
    const fake = createFakeClient()
    const failing: Client = {
      ...fake,
      sendMessage: () => Promise.reject(new Error('the connection dropped')),
    }
    const app = renderApp(failing)
    await pickFirstModel(app)
    await waitForChat(app)

    submit(app, 'Hello.')

    await waitForFrame(app, 'error: the connection dropped')
    expect(app.exits).toEqual([])
  })
})
