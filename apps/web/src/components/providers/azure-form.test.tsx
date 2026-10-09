import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { credential } from '../../test-support/catalog'
import { makeFake, renderApp } from '../../test-support/render-app'

/**
 * The Azure OpenAI form (epic #245, A3a).
 *
 * The tile, the three fields, and the one thing an `api_key` form never does: a second
 * credential of the same type is stored under a name the reader chooses, and that name is the
 * `provider` half of the models it serves. The refusals the route would give for a bad name are
 * shown next to the field, so they are asserted here too.
 */

/** The Add-provider dialog, opened from Settings → Providers. */
async function openDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Add provider' }))
  return screen.findByRole('dialog')
}

/** Fill the azure form's three fields. */
async function fill(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  values: { endpoint?: string; apiKey?: string; deployments?: string },
): Promise<void> {
  await user.type(
    within(dialog).getByLabelText('Endpoint'),
    values.endpoint ?? 'https://my-resource.openai.azure.com',
  )
  await user.type(within(dialog).getByLabelText('API key'), values.apiKey ?? 'az-key-4242')
  await user.type(
    within(dialog).getByLabelText('Deployments'),
    values.deployments ?? 'gpt-4o, gpt-4o-mini',
  )
}

describe('the azure credential form', () => {
  it('opens on the azure tile with the endpoint, key and deployment fields', async () => {
    const user = userEvent.setup({ delay: null })
    renderApp(makeFake({ models: [], providers: [] }), { hash: '#/settings' })

    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'Azure OpenAI' }))

    expect(within(dialog).getByText('Connect Azure OpenAI')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Endpoint')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('API key')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Deployments')).toBeInTheDocument()
    // The first credential of a type takes the type's default name, so nothing asks for one.
    expect(within(dialog).queryByLabelText('Name')).not.toBeInTheDocument()
  })

  it('stores the credential under the default name, as metadata only', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ models: [], providers: [] })
    renderApp(fake, { hash: '#/settings' })

    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'Azure OpenAI' }))
    await fill(user, dialog, {})
    await user.click(within(dialog).getByRole('button', { name: 'Save key' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    const { data } = await fake.providerCredentials.list()
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ type: 'azure_openai', name: 'azure', last4: '4242' })
    // The list names it, shows the last four, and never the endpoint or the key.
    const list = within(screen.getByRole('region', { name: 'Saved credentials' }))
    expect(await list.findByText('Azure OpenAI')).toBeInTheDocument()
    expect(list.getByText('…4242')).toBeInTheDocument()
    expect(document.body.textContent ?? '').not.toContain('openai.azure.com')
    expect(document.body.textContent ?? '').not.toContain('az-key-4242')
  })

  it('asks for a name for a second credential of the type, and saves under it', async () => {
    const user = userEvent.setup({ delay: null })
    // One azure credential is already stored, so the type's default name is taken.
    const fake = makeFake({ credentials: [credential('azure', '1111')], models: [], providers: [] })
    renderApp(fake, { hash: '#/settings' })

    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'Azure OpenAI' }))

    const name = within(dialog).getByLabelText('Name')
    expect(name).toBeInTheDocument()
    await user.type(name, 'azure-eu')
    await fill(user, dialog, { apiKey: 'az-eu-7777' })
    await user.click(within(dialog).getByRole('button', { name: 'Save key' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    const { data } = await fake.providerCredentials.list()
    expect(data.map((entry) => entry.name).sort()).toEqual(['azure', 'azure-eu'])
    // The reader's own label is what the row is called, so two azure rows are told apart.
    const list = within(screen.getByRole('region', { name: 'Saved credentials' }))
    expect(await list.findByText('azure-eu')).toBeInTheDocument()
    expect(list.getByText('…7777')).toBeInTheDocument()
  })

  it('refuses a name the server would refuse, before the save', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ credentials: [credential('azure', '1111')], models: [], providers: [] })
    renderApp(fake, { hash: '#/settings' })

    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'Azure OpenAI' }))
    await fill(user, dialog, {})

    const name = within(dialog).getByLabelText('Name')
    const save = within(dialog).getByRole('button', { name: 'Save key' })

    // Uppercase is not a credential name; a fixed provider id is taken; a name in use is a
    // replace by accident.
    for (const [typed, expected] of [
      ['Azure', /short and lowercase/],
      ['openai', /belongs to one of the built-in providers/],
      ['azure', /already have a Azure OpenAI credential called that/],
    ] as const) {
      await user.clear(name)
      await user.type(name, typed)
      expect(await within(dialog).findByText(expected)).toBeInTheDocument()
      expect(save).toBeDisabled()
    }

    // A name of its own is accepted, and the save goes through.
    await user.clear(name)
    await user.type(name, 'azure-eu')
    await waitFor(() => {
      expect(save).toBeEnabled()
    })
  })
})
