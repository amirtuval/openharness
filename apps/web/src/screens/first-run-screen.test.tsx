import { ApiError, AuthenticationError, PROVIDERS } from '@openharness/client'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { FIRST_RUN_HEADING } from './first-run-screen'
import { NEW_CHAT_GREETING } from './new-chat-screen'
import { TWO_PROVIDERS, credential } from '../test-support/catalog'
import { makeFake, renderApp } from '../test-support/render-app'

/**
 * The first-run flow (epic #201, X5): what a signed-in account with no provider key sees in
 * place of New chat, and where it leaves them.
 *
 * The whole journey is driven through the app — the tiles, the key form, the confirmation and
 * the composer that follows — because that is what the issue is about: one flow, from signing
 * in to typing, with no trip to Settings and no dead end in between.
 */
describe('the first-run screen', () => {
  it('is what the root route shows with no credentials', async () => {
    renderApp(makeFake({ models: [], providers: [] }), { hash: '#/' })

    // The ✨ is drawn outside the gradient span, so the heading's name is the sentence plus it;
    // matching on the sentence is what keeps this assertion about the copy, not the decoration.
    expect(
      await screen.findByRole('heading', { name: new RegExp(FIRST_RUN_HEADING) }),
    ).toBeInTheDocument()
    // The sentence that says why: the reader's own keys, not the server's.
    expect(screen.getByText(/we never ship one of our own/)).toBeInTheDocument()
    // No composer yet — there is no model a message could run on.
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
  })

  it('is not shown to an account that already has a key', async () => {
    renderApp(makeFake(TWO_PROVIDERS), { hash: '#/' })

    // New chat, straight away: the whole point of the gate is that it is invisible to
    // everyone it does not apply to.
    expect(await screen.findByRole('heading', { name: NEW_CHAT_GREETING })).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: new RegExp(FIRST_RUN_HEADING) }),
    ).not.toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeInTheDocument()
  })

  it('offers every provider as a tile, with the free-tier hint where there is one', async () => {
    renderApp(makeFake({ models: [], providers: [] }), { hash: '#/' })

    expect(await screen.findByRole('button', { name: /Anthropic/ })).toBeInTheDocument()
    // A hint follows the provider's name on its own tile (X8).
    expect(screen.getByRole('button', { name: /Groq/ })).toHaveTextContent('Free tier available')
    expect(screen.getByRole('button', { name: /Google/ })).toHaveTextContent(
      'Free tier in Google AI Studio',
    )
    expect(screen.getByRole('button', { name: 'OpenAI' })).toHaveTextContent('OpenAI')
    expect(screen.getByRole('button', { name: 'OpenAI' })).not.toHaveTextContent('Free tier')
    // The named credential type is a tile too (#245, A3a): an exact name, because "Azure
    // OpenAI" also matches a loose /OpenAI/.
    expect(screen.getByRole('button', { name: 'Azure OpenAI' })).toBeInTheDocument()
  })

  it('saves a key, names the default model, and starts chatting with the cursor in the box', async () => {
    const user = userEvent.setup({ delay: null })
    // No default yet: the server picks one when the first key lands (U4), and the fake does
    // the same. The catalog is what that pick comes from.
    const fake = makeFake({ models: TWO_PROVIDERS.models, providers: TWO_PROVIDERS.providers })
    renderApp(fake, { hash: '#/' })

    await user.click(await screen.findByRole('button', { name: /Anthropic/ }))

    // The form the issue describes: the "get a key" link, the key field, Save (X5).
    expect(screen.getByRole('link', { name: 'Get a key' })).toHaveAttribute(
      'href',
      'https://console.anthropic.com/settings/keys',
    )
    const key = screen.getByLabelText('API key')
    expect(key).toHaveAttribute('placeholder', 'sk-ant-…')

    await user.type(key, 'sk-ant-first-run-1234')
    await user.click(screen.getByRole('button', { name: 'Save key' }))

    // The key never comes back: what the server stored is metadata. The confirmation names
    // the model the server picked when the first key landed (U4) — in the sentence under the
    // heading, which is where U12 moved it.
    expect(await screen.findByRole('heading', { name: /all set/ })).toBeInTheDocument()
    expect(await screen.findByText(/Your chats will use/)).toHaveTextContent('Claude Sonnet 5')
    expect(document.body.textContent ?? '').not.toContain('sk-ant-first-run-1234')
    await waitFor(async () => {
      expect((await fake.providerCredentials.list()).data.map((entry) => entry.last4)).toEqual([
        '1234',
      ])
    })

    // Let's go: New chat, on the model just chosen, with the cursor in the composer.
    await user.click(screen.getByRole('button', { name: "Let's go" }))
    expect(await screen.findByRole('heading', { name: NEW_CHAT_GREETING })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Model: Claude Sonnet 5' })).toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toHaveFocus()
  })

  it('lets the default the server picked be changed before starting', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ models: TWO_PROVIDERS.models, providers: TWO_PROVIDERS.providers })
    renderApp(fake, { hash: '#/' })

    await user.click(await screen.findByRole('button', { name: /Anthropic/ }))
    await user.type(screen.getByLabelText('API key'), 'sk-ant-pick-5678')
    await user.click(screen.getByRole('button', { name: 'Save key' }))
    await screen.findByRole('heading', { name: /all set/ })

    // The Change option is the app's own picker, over the same catalog the composer uses.
    await user.click(screen.getByRole('button', { name: /Model/ }))
    await user.click(screen.getByRole('option', { name: /GPT-4.1 mini/ }))

    await waitFor(async () => {
      expect((await fake.preferences.get()).default_model).toBe('openai/gpt-4.1-mini')
    })
    expect(await screen.findByText(/Your chats will use/)).toHaveTextContent('GPT-4.1 mini')
  })

  it('shows a rejected key inline, with the form still there to try another', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ models: [], providers: [] })
    renderApp(fake, { hash: '#/' })

    // The one provider rejection a test can spell without a provider: the 422 the server
    // answers when its validating call is refused (epic #65, A5).
    fake.providerCredentials.put = () =>
      Promise.reject(
        new ApiError(422, 'The OpenAI credential was rejected by the provider.', {
          type: 'invalid_provider_credential',
        }),
      )
    await user.click(await screen.findByRole('button', { name: 'OpenAI' }))
    await user.type(screen.getByLabelText('API key'), 'sk-openai-nope')
    await user.click(screen.getByRole('button', { name: 'Save key' }))

    const alert = await screen.findByRole('alert')
    // Warm, and still the server's own sentence underneath: the provider is named in the
    // title, and the 422's message is the body (U12, #227).
    expect(alert).toHaveTextContent("Hmm, OpenAI didn't accept that")
    expect(alert).toHaveTextContent('rejected by the provider')
    // Still on the form, and nothing was stored.
    expect(screen.getByLabelText('API key')).toBeInTheDocument()
    expect(await fake.providerCredentials.list()).toEqual({ data: [] })
  })

  it('asks for a fresh sign-in when the write needs one, and says where to come back to', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ models: [], providers: [] })
    // The server wants a session younger than a day for a credential write (A2): the reader
    // has to sign in again, and the return hash is this flow, not Settings.
    fake.providerCredentials.put = () => Promise.reject(new AuthenticationError('Not signed in.'))
    renderApp(fake, { hash: '#/' })

    await user.click(await screen.findByRole('button', { name: /Groq/ }))
    await user.type(screen.getByLabelText('API key'), 'gsk_whatever')
    await user.click(screen.getByRole('button', { name: 'Save key' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Sign in again')
    expect(within(alert).getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      '#/signin?next=%23%2Fnew',
    )
  })

  it('goes to New chat on Skip, with its own empty state', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ models: [], providers: [] })
    renderApp(fake, { hash: '#/' })

    await user.click(await screen.findByRole('button', { name: 'Skip for now' }))

    // New chat's existing empty state (#146), not a second first-run screen.
    expect(await screen.findByText('Add a provider key to start')).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: new RegExp(FIRST_RUN_HEADING) }),
    ).not.toBeInTheDocument()
    expect((await fake.providerCredentials.list()).data).toEqual([])
  })

  it('offers a way back to the tiles from a picked provider', async () => {
    const user = userEvent.setup({ delay: null })
    renderApp(makeFake({ models: [], providers: [] }), { hash: '#/' })

    await user.click(await screen.findByRole('button', { name: /DeepSeek/ }))
    expect(screen.getByText('DeepSeek')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('button', { name: /Anthropic/ })).toBeInTheDocument()
  })

  it('says a key is already saved when the account has one but no models', async () => {
    // A key whose provider listed nothing: the tiles still work, and replacing is what a save
    // would do — the form says so.
    renderApp(makeFake({ models: [], providers: [], credentials: [credential('anthropic')] }), {
      hash: '#/',
    })

    // The first-run screen does not show at all once a key exists — this is New chat's empty
    // state, which is the honest thing to say.
    expect(await screen.findByText('Add a provider key to start')).toBeInTheDocument()
  })

  it('draws the tiles from the shared provider list', async () => {
    renderApp(makeFake({ models: [], providers: [] }), { hash: '#/' })

    // One tile per provider `@openharness/client` carries, and no others: that list is built
    // from `@openharness/protocol`'s provider list (#245), so it is the server's set too.
    await screen.findByRole('heading', { name: new RegExp(FIRST_RUN_HEADING) })
    for (const provider of PROVIDERS) {
      expect(
        screen.getByRole('button', { name: new RegExp(`^${provider.name}`) }),
      ).toBeInTheDocument()
    }
  })
})
