import type { Client } from '@openharness/client'
import { createFakeClient, type FakeClient } from '@openharness/client/testing'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

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

  it('names the agent, the model and the status in the status line', async () => {
    const fake = createFakeClient()
    const app = renderApp(fake)

    await waitForFrame(app, `${fake.agent.name} · ${fake.agent.model.id} · sesn_`)
    await waitForFrame(app, /sesn_[0-9A-Z]+ · idle/u)
  })

  it('asks which agent when the server has several', async () => {
    const fake = createFakeClient()
    const reviewer = await fake.agents.create({
      name: 'Reviewer',
      model: { id: 'anthropic/claude-opus-5-5' },
    })

    const app = renderApp(listingAgents(fake, [fake.agent, reviewer]))
    await waitForScreen(app, 'Which agent?')
    await waitForFrame(app, `❯ 1. ${fake.agent.name}`)

    pressKey(app, 'down')
    await waitForFrame(app, '❯ 2. Reviewer · anthropic/claude-opus-5-5')

    pressKey(app, 'enter')
    await waitForFrame(app, 'Reviewer · anthropic/claude-opus-5-5 ·')

    const created = (await fake.sessions.list()).data.find(
      (session) => session.agent.name === 'Reviewer',
    )
    expect(created).toBeDefined()
    expect(app.exits).toEqual([])
  })

  it('picks an agent by number too', async () => {
    const fake = createFakeClient()
    const reviewer = await fake.agents.create({
      name: 'Reviewer',
      model: { id: 'anthropic/claude-opus-5-5' },
    })

    const app = renderApp(listingAgents(fake, [fake.agent, reviewer]))
    await waitForScreen(app, 'Which agent?')

    typeText(app, '2')
    await waitForFrame(app, 'Reviewer · anthropic/claude-opus-5-5 ·')
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
    expect(frameOf(app)).not.toContain('Which agent?')
  })

  it('says where to create an agent when there are none', async () => {
    const fake = createFakeClient()
    const app = renderApp(listingAgents(fake, []))

    await waitForFrame(app, 'No agents yet')
    await waitForFrame(app, `Create one in the web app at ${CONTEXT.server}`)

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
    await waitForChat(app)

    submit(app, 'Hello.')

    await waitForFrame(app, 'error: the connection dropped')
    expect(app.exits).toEqual([])
  })
})
