import { ApiError } from '@openharness/client'
import type { FakeClient } from '@openharness/client/testing'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { OPENAI, WITH_DEFAULT } from '../test-support/catalog'
import { makeFake, renderApp } from '../test-support/render-app'

/**
 * New chat is a chat, immediately (epic #116, U2): an empty composer on the account's default
 * model, the session created on the first send — no picker screen in the way. Driven against
 * `createFakeClient()`, so the session the app creates is asserted on the fake's own record
 * of the request, and the no-default and failure states are states a test renders.
 */

/** The `create` bodies the app sent, in order. */
function recordCreates(fake: FakeClient): Array<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = []
  const create = fake.sessions.create.bind(fake.sessions)
  fake.sessions.create = (body, options) => {
    calls.push(body)
    return create(body, options)
  }
  return calls
}

describe('New chat', () => {
  it('opens on the default model and creates the session with the first message', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(WITH_DEFAULT)
    const creates = recordCreates(fake)
    renderApp(fake, { hash: '#/new' })

    // The default from the server, in the composer's selector, before anything is sent.
    expect(
      await screen.findByRole('button', { name: 'Model: Claude Sonnet 5' }),
    ).toBeInTheDocument()
    // Nothing exists until the reader says something.
    expect((await fake.sessions.list()).data).toHaveLength(1)

    const input = await screen.findByLabelText('Message')
    expect(input).toHaveFocus()
    await user.type(input, 'hello there')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/s\/sesn_/)
    })
    // Created for the send, with the default model, and the message is in the new chat's log.
    expect(creates).toEqual([{ model: { id: 'anthropic/claude-sonnet-5' } }])
    const sessionId = window.location.hash.replace('#/s/', '')
    expect(fake.history(sessionId).filter((event) => event.type === 'user.message')).toHaveLength(1)
    // The chat opens on it: a model-first chat, named by its first message — the fake derives
    // titles the way the server does (#35) — with the cursor in the box.
    expect(await screen.findByRole('heading', { name: 'hello there' })).toBeInTheDocument()
    expect(await screen.findByLabelText('Message')).toHaveFocus()
  })

  it('creates the session with a model picked in the composer, not the default', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(WITH_DEFAULT)
    const creates = recordCreates(fake)
    renderApp(fake, { hash: '#/new' })

    await user.click(await screen.findByRole('button', { name: 'Model: Claude Sonnet 5' }))
    await user.click(screen.getByRole('option', { name: /GPT-4.1 mini/ }))
    expect(screen.getByRole('button', { name: 'Model: GPT-4.1 mini' })).toBeInTheDocument()

    await user.type(screen.getByLabelText('Message'), 'hello')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(creates).toEqual([{ model: { id: OPENAI.id } }])
    })
  })

  it('says to add a provider key when there is no default, and links to Settings', async () => {
    const fake = makeFake() // the fake's default: an account that never saved one
    renderApp(fake, { hash: '#/new' })

    expect(await screen.findByText('Add a provider key to start')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings → Model providers' })).toHaveAttribute(
      'href',
      '#/settings',
    )
    // Nothing to type into: there is no model a message could run on.
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
  })

  it('keeps the message and shows why when the session could not be created', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(WITH_DEFAULT)
    fake.sessions.create = () => Promise.reject(new ApiError(400, 'The model id is not valid.'))
    renderApp(fake, { hash: '#/new' })

    await user.type(await screen.findByLabelText('Message'), 'hello?')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    // Two things went wrong at once — the create failed, and the sidebar's list error shows
    // it too — so this asserts the composer's own banner, by its words.
    const banner = await screen.findByText('The chat could not be created.')
    expect(banner.closest('[role="alert"]')).toBeInTheDocument()
    // Still on New chat, with the text: the retry is one more click.
    expect(window.location.hash).toBe('#/new')
    expect(screen.getByLabelText('Message')).toHaveValue('hello?')
  })

  it('reuses the session it already created when only the message failed', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(WITH_DEFAULT)
    const creates = recordCreates(fake)
    const send = fake.sendMessage.bind(fake)
    let failNext = true
    fake.sendMessage = (sessionId, text, options) => {
      if (!failNext) {
        return send(sessionId, text, options)
      }
      failNext = false
      return Promise.reject(new ApiError(500, 'The message store is down.'))
    }
    renderApp(fake, { hash: '#/new' })

    await user.type(await screen.findByLabelText('Message'), 'hello')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The message store is down.')

    // The retry goes to the chat that exists — not a second create, not a second empty chat.
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/s\/sesn_/)
    })
    expect(creates).toHaveLength(1)
    expect((await fake.sessions.list()).data).toHaveLength(2)
  })

  it('shows a failed catalog load without blocking the composer', async () => {
    const fake = makeFake(WITH_DEFAULT)
    fake.models.list = () => Promise.reject(new ApiError(500, 'The catalog is unavailable.'))
    renderApp(fake, { hash: '#/new' })

    const banner = await screen.findByText('Could not load models')
    expect(banner.closest('[role="alert"]')).toHaveTextContent('The catalog is unavailable.')
    // The default is still known and the chat can still start; the catalog is a convenience,
    // and without it the selector falls back to the id it was handed.
    expect(
      screen.getByRole('button', { name: 'Model: anthropic/claude-sonnet-5' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeInTheDocument()
  })

  it('shows a failed preferences load, and still lets a model be picked by hand', async () => {
    const fake = makeFake(WITH_DEFAULT)
    fake.preferences.get = () => Promise.reject(new ApiError(500, 'The preferences store is down.'))
    renderApp(fake, { hash: '#/new' })

    const banner = await screen.findByText('Could not load your default model')
    expect(banner.closest('[role="alert"]')).toHaveTextContent('The preferences store is down.')
    // No default is known, so the selector starts on nothing — but the catalog is there, and
    // a pick is enough to start a chat.
    const trigger = screen.getByRole('button', { name: 'Model: Choose a model' })
    expect(trigger).toBeInTheDocument()

    const user = userEvent.setup({ delay: null })
    await user.click(trigger)
    await user.click(screen.getByRole('option', { name: /GPT-4.1 mini/ }))
    expect(screen.getByRole('button', { name: 'Model: GPT-4.1 mini' })).toBeInTheDocument()
  })
})
