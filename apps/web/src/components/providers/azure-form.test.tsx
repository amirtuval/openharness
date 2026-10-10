import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { ProviderCredential } from '@openharness/protocol'

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
    // The row leads with the name it is typed under — `azure/<deployment>` is what its model
    // ids start with — and the type's display name sits beside it (#271); the last four follow,
    // and never the endpoint or the key.
    const list = within(screen.getByRole('region', { name: 'Saved credentials' }))
    expect(await list.findByText('azure')).toBeInTheDocument()
    expect(list.getByText('(Azure OpenAI)')).toBeInTheDocument()
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

  it('replaces a stored named credential under its own name', async () => {
    const user = userEvent.setup({ delay: null })
    // A second azure credential, stored under a name the reader chose.
    const stored: ProviderCredential = { ...credential('azure-eu', '1111'), type: 'azure_openai' }
    const fake = makeFake({ credentials: [stored], models: [], providers: [] })
    renderApp(fake, { hash: '#/settings' })

    // A row's Replace opens the form on **that** credential: the name it is stored under is
    // prefilled, and saving it must not be refused as "already taken" — the row could never be
    // replaced otherwise.
    await user.click(await screen.findByRole('button', { name: 'Replace the azure-eu credential' }))
    const dialog = await screen.findByRole('dialog')
    const name = within(dialog).getByLabelText<HTMLInputElement>('Name')
    expect(name.value).toBe('azure-eu')
    await fill(user, dialog, { apiKey: 'az-eu-9999' })
    // "Replace key", because the name is one that is already stored.
    const save = within(dialog).getByRole('button', { name: 'Replace key' })
    expect(save).toBeEnabled()
    await user.click(save)

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    const { data } = await fake.providerCredentials.list()
    // The same credential, with the new key: one row, not two.
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ name: 'azure-eu', last4: '9999' })
  })

  it('holds the save until a name is answered, for a second credential', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ credentials: [credential('azure', '1111')], models: [], providers: [] })
    renderApp(fake, { hash: '#/settings' })

    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'Azure OpenAI' }))
    await fill(user, dialog, {})
    const save = within(dialog).getByRole('button', { name: 'Save key' })
    // The name is not one of the form's fields, so an unanswered one has to hold the save by
    // itself: a blank name would be a request against an empty path segment.
    expect(save).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Name'), 'azure-eu')
    await waitFor(() => {
      expect(save).toBeEnabled()
    })
  })
})
