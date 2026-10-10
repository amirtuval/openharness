import { makeMode } from '@openharness/protocol/fixtures'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { makeFake, renderApp } from '../test-support/render-app'
import { ANTHROPIC, OPENAI, providerStatus, credential } from '../test-support/catalog'

/**
 * Modes in the chat (#245, M6), against the fake server: the picker offers them above the
 * models, starting a chat from one resolves its model, the composer's switch follows one, and
 * an unusable mode is refused with the server's message rather than silently running something
 * else.
 */

const user = userEvent.setup()

const MODE = makeMode({ name: 'deep', model: 'anthropic/claude-sonnet-5' })

/** The composer's box. */
async function composer(): Promise<HTMLElement> {
  return await screen.findByPlaceholderText(/Send a message/)
}

/** The chat header's mode slot, once a chat is open. */
function modeSlot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="session-mode"]')
}

describe('starting a chat from a mode', () => {
  it('offers the modes above the models, and creates the chat on the picked one', async () => {
    const fake = makeFake({
      ...{ models: [ANTHROPIC, OPENAI] },
      modes: [MODE],
      credentials: [credential('anthropic'), credential('openai')],
      providers: [providerStatus('anthropic'), providerStatus('openai')],
    })
    renderApp(fake, { hash: '#/new' })

    await user.click(await screen.findByRole('button', { name: /Model|Choose a model/ }))
    // Modes come first, as their own group.
    expect(await screen.findByRole('group', { name: 'Modes' })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: /deep/ }))

    await user.type(await composer(), 'go deep{Enter}')

    await waitFor(() => expect(window.location.hash).toMatch(/^#\/s\//))
    // The header says the mode, and what it resolved to.
    await waitFor(() => expect(modeSlot()).not.toBeNull())
    expect(modeSlot()).toHaveTextContent('deep')
    // The subtitle is the mode's name and what it resolved to: the model the chat runs.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="session-subtitle"]')).toHaveTextContent(
        'anthropic/claude-sonnet-5',
      ),
    )
  })

  it('refuses a mode whose model has no key, with the server’s message', async () => {
    // The account can run OpenAI; the mode's model is Anthropic, which it has no key for.
    const fake = makeFake({
      models: [OPENAI],
      providers: [providerStatus('openai')],
      credentials: [credential('openai')],
      preferences: { default_model: OPENAI.id },
      modes: [MODE],
    })
    renderApp(fake, { hash: '#/new' })

    await user.click(await screen.findByRole('button', { name: /Model:/ }))
    await user.click(await screen.findByRole('option', { name: /deep/ }))
    await user.type(await composer(), 'go deep{Enter}')

    // It lands in the composer's banner and in the sidebar's list error alike.
    expect(await screen.findAllByText(/mode's model isn't available/)).not.toHaveLength(0)
    // Nothing was created: the reader is still on New chat.
    expect(window.location.hash).toBe('#/new')
  })
})

describe('switching a chat to a mode', () => {
  it('follows the mode after the next message', async () => {
    const fake = makeFake({
      models: [ANTHROPIC, OPENAI],
      providers: [providerStatus('anthropic'), providerStatus('openai')],
      credentials: [credential('anthropic'), credential('openai')],
      modes: [MODE],
    })
    const session = await fake.sessions.create({ model: { id: OPENAI.id } })
    fake.respondWith('ok')
    renderApp(fake, { hash: `#/s/${session.id}` })

    // Open the composer's selector and pick the mode.
    await user.click(await screen.findByRole('button', { name: /Model:/ }))
    await user.click(await screen.findByRole('option', { name: /deep/ }))

    await user.type(await composer(), 'switch to deep{Enter}')
    await fake.waitForIdle(session.id)

    await waitFor(() => expect(modeSlot()).toHaveTextContent('deep'))
    expect(await fake.sessions.get(session.id)).toMatchObject({ mode: MODE.id })
  })

  it('shows the mode a chat opened on follows', async () => {
    const fake = makeFake({
      models: [ANTHROPIC],
      providers: [providerStatus('anthropic')],
      credentials: [credential('anthropic')],
      modes: [MODE],
    })
    const session = await fake.sessions.create({ mode: MODE.id })
    renderApp(fake, { hash: `#/s/${session.id}` })

    await waitFor(() => expect(modeSlot()).not.toBeNull())
    expect(modeSlot()).toHaveTextContent('deep')
    expect(document.querySelector('[data-slot="session-subtitle"]')).toHaveTextContent(
      'anthropic/claude-sonnet-5',
    )
  })
})
