import type { Client } from '@openharness/client'
import { createFakeClient, type FakeClient } from '@openharness/client/testing'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { makeModelEntry } from '@openharness/protocol/fixtures'

import { App, type ExitPayload } from './app'
import type { ChatOptions } from './args'
import { listingAgents } from './test-support/fake'
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
function renderApp(client: Client, options: ChatOptions = chatOptions()) {
  const exits: ExitPayload[] = []
  const instance = render(
    <App
      client={client}
      options={options}
      context={CONTEXT}
      onExit={(payload) => {
        exits.push(payload)
      }}
    />,
  )

  return { ...instance, exits }
}

type TestApp = TestInstance & { exits: ExitPayload[] }

/**
 * Wait for the chat screen.
 *
 * Its status line is the proof it is up: passing a session id also proves *which* session
 * the app opened, which for a new chat is one the test did not know in advance.
 */
async function waitForChat(app: TestApp, sessionId?: string): Promise<void> {
  if (sessionId !== undefined) {
    await waitForFrame(app, sessionId)
  }
  await waitForScreen(app, / · (idle|running)$/mu)
}

/** Get past the model picker a new chat starts with: Enter on the model it starts on. */
async function pickFirstModel(app: TestApp): Promise<void> {
  await waitForScreen(app, 'Which model?')
  pressKey(app, 'enter')
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
    await waitForFrame(app, 'you › Hi there.')
    await waitForFrame(app, 'agent › Fake reply: Hi there.')
    expect(app.exits).toEqual([])
  })

  it('shows the history of the session it resumes', async () => {
    const fake = createFakeClient()
    fake.respondWith('An earlier reply.')
    await fake.sendMessage(fake.session.id, 'An earlier question.')
    await fake.waitForIdle()

    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)

    await waitForFrame(app, 'you › An earlier question.')
    await waitForFrame(app, 'agent › An earlier reply.')
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

    await waitForFrame(app, 'you › From the recent session.')
  })

  it('shows the model and the status in the status line of a model-first chat', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake)

    // The catalog's only model — the picker's first row — is what the session will run.
    await waitForScreen(app, '❯ 1. Claude Sonnet 5 · 200k context')
    pressKey(app, 'enter')

    await waitForFrame(app, 'anthropic/claude-sonnet-5 · sesn_')
    await waitForFrame(app, /sesn_[0-9A-Z]+ · idle/u)
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

    await waitForFrame(app, 'openai/gpt-4.1-mini · sesn_')
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

  it('says where to add a provider key when the account has no models', async () => {
    const fake = createFakeClient({ models: [], providers: [] })
    const app = renderApp(fake)

    await waitForFrame(app, 'No model providers yet')
    await waitForFrame(app, `Add a key in the web app at ${CONTEXT.server}`)
    await waitForFrame(app, 'Settings → Model providers')

    await waitFor(() => app.exits.length === 1)
    expect(app.exits[0]).toEqual({ code: 1 })
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

  it('interrupts a running turn with Ctrl+C, keeping the partial reply', async () => {
    const fake = createFakeClient({ delayMs: 10 })
    fake.respondWith('One two three four five six seven eight', { chunks: 8, delayMs: 40 })
    // Resuming the fake's own session is what lets the reply above be scripted for it: a
    // new chat would get a session id nobody could script in advance. (Any session works as
    // a resumed one — the seeded session simply has no history.)
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))

    await waitForChat(app, fake.session.id)
    submit(app, 'Go.')
    await waitForFrame(app, '· running')
    await waitForFrame(app, /agent › One two/u)

    pressKey(app, 'ctrlC')

    // The turn stops, the reply so far stays, and the app keeps running.
    await waitForFrame(app, '· idle')
    await waitForFrame(app, /agent › One two three/u)
    expect(app.exits).toEqual([])
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
    expect(frameOf(app)).toContain(sessionId)
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

    await waitForFrame(app, /you › first line\n\s+second line/u)
    await waitForFrame(app, 'agent › Noted.')
    expect(userTexts(fake, sessionId)).toEqual(['first line\nsecond line'])
  })

  it('steers while a reply is streaming', async () => {
    const fake = createFakeClient({ delayMs: 10 })
    fake.respondWith('First reply.', { chunks: 4, delayMs: 40 })
    fake.respondWith('Second reply.', { chunks: 4, delayMs: 10 })
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    const sessionId = fake.session.id

    await waitForChat(app, sessionId)

    submit(app, 'One.')
    await waitForFrame(app, '· running')
    await waitForFrame(app, /agent › First/u)

    submit(app, 'Two.')

    await waitForFrame(app, 'you › Two.')
    await waitForFrame(app, 'agent › Second reply.')
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

  it('says a retrying turn is retrying, and drops the error once a reply lands', async () => {
    const fake = createFakeClient({ delayMs: 40 })
    fake.failWith({ message: 'the model is overloaded', delayMs: 40 })
    fake.respondWith('Second time lucky.', { chunks: 2, delayMs: 30 })
    const app = renderApp(fake, chatOptions({ session: fake.session.id }))
    await waitForChat(app, fake.session.id)

    submit(app, 'Hello.')

    await waitForFrame(app, 'error: the model is overloaded — the server is retrying')
    await waitForFrame(app, 'agent › Second time lucky.')
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
