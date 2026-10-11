import { createFakeClient, type FakeClient } from '@openharness/client/testing'
import type { AskUserQuestion } from '@openharness/protocol'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { App, type ExitPayload } from '../app'
import type { ChatOptions } from '../args'
import {
  frameOf,
  pressKey,
  tick,
  typeText,
  waitFor,
  waitForFrame,
  waitForScreen,
  type TestInstance,
} from '../test-support/input'

/**
 * The pause in `oh`, end to end (epic #303, X6; #310).
 *
 * The fake's brain asks through `askWith` (tested in `@openharness/client`), so this is the
 * whole round trip the terminal drives: the turn ends waiting, the list is drawn from the log,
 * the keys are its own until the reader asks to write a message instead, and the answers go up
 * as one `user.tool_confirmation`.
 */

const CONTEXT = { server: 'http://localhost:3000' }

const QUESTIONS: AskUserQuestion[] = [
  {
    type: 'choice',
    question: 'Which environment?',
    header: 'Env',
    options: [{ label: 'staging' }, { label: 'production' }],
  },
  { type: 'confirm', question: 'Go ahead?', header: 'Go' },
]

function chatOptions(session: string): ChatOptions {
  return { debug: false, continue: false, session }
}

type TestApp = TestInstance & { exits: ExitPayload[] }

function renderApp(client: FakeClient, options: ChatOptions): TestApp {
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

/** A fake paused on `ask_user`, with the message that asked it already in the log. */
async function paused(): Promise<FakeClient> {
  const fake = createFakeClient()
  fake.askWith({ questions: QUESTIONS })
  await fake.sendMessage(fake.session.id, 'deploy it')
  await fake.waitForIdle()
  return fake
}

afterEach(() => {
  cleanup()
})

describe('a paused chat in oh (#303, #310)', () => {
  it('draws the questions with the keys that answer them', async () => {
    const fake = await paused()
    const app = renderApp(fake, chatOptions(fake.session.id))

    await waitForScreen(app, /↑\/↓ move/u)

    const frame = frameOf(app)
    expect(frame).toContain('Env · Which environment?')
    expect(frame).toContain('○ staging')
    expect(frame).toContain('Go · Go ahead?')
    expect(frame).toContain('Submit answers')
    expect(frame).toContain('Decline')
    expect(frame).toContain('Write a message instead')
  })

  it('answers the questions and stops waiting', async () => {
    const fake = await paused()
    const app = renderApp(fake, chatOptions(fake.session.id))
    await waitForScreen(app, /↑\/↓ move/u)

    // The first row is the first option; ↓ to the second, then Enter takes it.
    pressKey(app, 'down')
    await tick()
    pressKey(app, 'enter')
    await tick()
    expect(frameOf(app)).toContain('● production')

    // Tab crosses to the next question rather than the next option.
    pressKey(app, 'tab')
    await tick()
    pressKey(app, 'enter')
    await tick()
    expect(frameOf(app)).toContain('● Yes')

    // Submit the answers: the mark lost its cursor, so walk down to it.
    await walkTo(app, '▸ · Submit answers')
    pressKey(app, 'enter')

    await waitFor(() => fake.history().some((event) => event.type === 'user.tool_confirmation'))
    expect(fake.history()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'user.tool_confirmation',
          result: 'allow',
          answers: [
            { question: QUESTIONS[0]?.question, labels: ['production'] },
            { question: QUESTIONS[1]?.question, confirmed: true },
          ],
        }),
      ]),
    )
  })

  it('declines on Esc, and says the model is told so', async () => {
    const fake = await paused()
    const app = renderApp(fake, chatOptions(fake.session.id))
    await waitForScreen(app, /↑\/↓ move/u)

    await walkTo(app, '▸ · Decline')
    pressKey(app, 'enter')

    await waitFor(() => fake.history().some((event) => event.type === 'user.tool_confirmation'))
    expect(fake.history()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'user.tool_confirmation', result: 'deny' }),
      ]),
    )
  })

  it('keeps the keyboard until the reader asks to write a message instead', async () => {
    const fake = await paused()
    const app = renderApp(fake, chatOptions(fake.session.id))
    await waitForScreen(app, /↑\/↓ move/u)

    // The list owns every key: what is typed is not the message box's.
    typeText(app, 'hello')
    await tick()
    expect(frameOf(app)).not.toContain('hello')

    await walkTo(app, '▸ · Write a message instead')
    pressKey(app, 'enter')
    await waitForFrame(app, 'sending a message will decline')

    typeText(app, 'hello')
    await tick()
    expect(frameOf(app)).toContain('hello')
  })

  it('sends a message instead, and the brain declines what was waiting', async () => {
    const fake = await paused()
    fake.respondWith('never mind then')
    const app = renderApp(fake, chatOptions(fake.session.id))
    await waitForScreen(app, /↑\/↓ move/u)

    await walkTo(app, '▸ · Write a message instead')
    pressKey(app, 'enter')
    await waitForFrame(app, 'sending a message will decline')

    typeText(app, 'never mind')
    pressKey(app, 'enter')

    await waitFor(() =>
      fake
        .history()
        .some(
          (event) =>
            event.type === 'agent.tool_result' &&
            event.content.some(
              (block) => block.type === 'text' && block.text === 'The user sent a message instead.',
            ),
        ),
    )
    expect(fake.history()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'user.message',
          content: [{ type: 'text', text: 'never mind' }],
        }),
      ]),
    )
  })
})

describe('a free-text question in oh (#310)', () => {
  const TEXT_QUESTION: AskUserQuestion = {
    type: 'text',
    question: 'Anything else I should know?',
    header: 'Notes',
    placeholder: 'optional',
  }

  it('reads the answer through the prompt slot', async () => {
    const fake = createFakeClient()
    fake.askWith({ questions: [TEXT_QUESTION] })
    await fake.sendMessage(fake.session.id, 'deploy it')
    await fake.waitForIdle()

    const app = renderApp(fake, chatOptions(fake.session.id))
    await waitForScreen(app, /↑\/↓ move/u)

    // The text row is the first one; Enter opens the slot's one-line field, which owns the
    // input area until it settles.
    pressKey(app, 'enter')
    await waitForScreen(app, 'Anything else I should know? ›')
    typeText(app, 'the release is Thursday')
    pressKey(app, 'enter')

    await waitForFrame(app, 'the release is Thursday')
    await walkTo(app, '▸ · Submit answers')
    pressKey(app, 'enter')

    await waitFor(() => fake.history().some((event) => event.type === 'user.tool_confirmation'))
    expect(fake.history()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'user.tool_confirmation',
          result: 'allow',
          answers: [{ question: TEXT_QUESTION.question, text: 'the release is Thursday' }],
        }),
      ]),
    )
  })
})

/** Press ↓ until the frame shows the row with the cursor on it. */
async function walkTo(app: TestApp, marker: string): Promise<void> {
  for (let step = 0; step < 20; step += 1) {
    if (frameOf(app).includes(marker)) {
      return
    }
    pressKey(app, 'down')
    await tick()
  }
  throw new Error(`the cursor never reached ${marker}. The frame was:\n${frameOf(app)}`)
}
