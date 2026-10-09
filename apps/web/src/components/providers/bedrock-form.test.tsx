import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { credential } from '../../test-support/catalog'
import { makeFake, renderApp } from '../../test-support/render-app'

/**
 * The Amazon Bedrock form (epic #245, A3c).
 *
 * Three things this form does that no other one does, and each is asserted here: the region is a
 * **dropdown** over the protocol's list (a free-text region would go into an AWS hostname), the
 * session token is **optional** (a long-lived IAM user key has none, and an empty one is not a
 * credential), and a second credential — another region, another account — is stored under a
 * name the reader chooses.
 */

const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
const SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'

/** The Add-provider dialog, opened from Settings → Providers. */
async function openDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Add provider' }))
  return screen.findByRole('dialog')
}

/** Fill the bedrock form's key fields, leaving the region and the token as they start. */
async function fill(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  values: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string } = {},
): Promise<void> {
  await user.type(
    within(dialog).getByLabelText('Access key ID'),
    values.accessKeyId ?? ACCESS_KEY_ID,
  )
  await user.type(
    within(dialog).getByLabelText('Secret access key'),
    values.secretAccessKey ?? SECRET_ACCESS_KEY,
  )
  if (values.sessionToken !== undefined) {
    await user.type(within(dialog).getByLabelText('Session token'), values.sessionToken)
  }
}

describe('the bedrock credential form', () => {
  it('opens on the bedrock tile with a region dropdown and the three key fields', async () => {
    const user = userEvent.setup({ delay: null })
    renderApp(makeFake({ models: [], providers: [] }), { hash: '#/settings' })

    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'Amazon Bedrock' }))

    expect(within(dialog).getByText('Connect Amazon Bedrock')).toBeInTheDocument()
    const region = within(dialog).getByLabelText('Region')
    expect(region.tagName).toBe('SELECT')
    // The dropdown is the protocol's region list, and it starts on the default — there is no
    // "no region" a Bedrock credential could be saved with.
    expect(within(region).getAllByRole('option').length).toBeGreaterThan(20)
    expect((region as HTMLSelectElement).value).toBe('us-east-1')
    expect(within(region).getByRole('option', { name: 'eu-west-1' })).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Access key ID')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Secret access key')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Session token')).toBeInTheDocument()
    // The first credential of a type takes the type's default name, so nothing asks for one.
    expect(within(dialog).queryByLabelText('Name')).not.toBeInTheDocument()
  })

  it('saves with the picked region, reports it, and keeps every secret out of the page', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ models: [], providers: [] })
    renderApp(fake, { hash: '#/settings' })

    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'Amazon Bedrock' }))
    await user.selectOptions(within(dialog).getByLabelText('Region'), 'eu-west-1')
    await fill(user, dialog, { sessionToken: 'FwoGZXIvYXdzEBYaDEXAMPLEtoken' })
    // The token is optional, but one that was typed is sent.
    await user.click(within(dialog).getByRole('button', { name: 'Save key' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    const { data } = await fake.providerCredentials.list()
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({
      type: 'bedrock',
      name: 'bedrock',
      last4: ACCESS_KEY_ID.slice(-4),
      details: { region: 'eu-west-1' },
    })
    // The row names the credential, shows the last four of the access key ID and the region —
    // and nothing else the credential carries.
    const list = within(screen.getByRole('region', { name: 'Saved credentials' }))
    expect(await list.findByText('Amazon Bedrock')).toBeInTheDocument()
    expect(list.getByText(`…${ACCESS_KEY_ID.slice(-4)}`)).toBeInTheDocument()
    expect(list.getByText('eu-west-1')).toBeInTheDocument()
    const page = document.body.textContent ?? ''
    expect(page).not.toContain(SECRET_ACCESS_KEY)
    expect(page).not.toContain('FwoGZXIvYXdzEBYaDEXAMPLEtoken')
  })

  it('saves without a session token, and omits the field entirely', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ models: [], providers: [] })
    renderApp(fake, { hash: '#/settings' })

    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'Amazon Bedrock' }))
    await fill(user, dialog)
    // The save is offered with the token left empty: it is optional.
    const save = within(dialog).getByRole('button', { name: 'Save key' })
    expect(save).toBeEnabled()
    await user.click(save)

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    const { data } = await fake.providerCredentials.list()
    expect(data[0]).toMatchObject({
      name: 'bedrock',
      last4: 'MPLE',
      details: { region: 'us-east-1' },
    })
  })

  it('asks for a name for a second credential, and shows each one’s region', async () => {
    const user = userEvent.setup({ delay: null })
    // One bedrock credential is already stored, so the type's default name is taken.
    const fake = makeFake({
      credentials: [
        credential('bedrock', '1111', { type: 'bedrock', details: { region: 'us-east-1' } }),
      ],
      models: [],
      providers: [],
    })
    renderApp(fake, { hash: '#/settings' })

    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'Amazon Bedrock' }))

    const name = within(dialog).getByLabelText('Name')
    await user.type(name, 'bedrock-us')
    await user.selectOptions(within(dialog).getByLabelText('Region'), 'us-east-2')
    await fill(user, dialog, { accessKeyId: 'AKIAIOSFODNN7EXAMPL2' })
    await user.click(within(dialog).getByRole('button', { name: 'Save key' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    const list = within(screen.getByRole('region', { name: 'Saved credentials' }))
    // Two rows of one type, told apart by their names and their regions.
    // The default name reads as the type's display name; the reader's own label stays theirs.
    expect(await list.findByText('bedrock-us')).toBeInTheDocument()
    expect(list.getByText('Amazon Bedrock')).toBeInTheDocument()
    expect(list.getByText('us-east-1')).toBeInTheDocument()
    expect(list.getByText('us-east-2')).toBeInTheDocument()
  })
})

describe('the bedrock form’s name field and a replaced credential', () => {
  it('replaces a stored credential under its own name', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({
      credentials: [
        credential('bedrock-us', '1111', { type: 'bedrock', details: { region: 'us-east-2' } }),
      ],
      models: [],
      providers: [],
    })
    renderApp(fake, { hash: '#/settings' })

    // A row's Replace opens the form on **that** credential: the name it is stored under is
    // prefilled, and saving it must not be refused as "already taken" — the row could never be
    // replaced otherwise.
    await user.click(
      await screen.findByRole('button', { name: 'Replace the bedrock-us credential' }),
    )
    const dialog = await screen.findByRole('dialog')
    const name = within(dialog).getByLabelText<HTMLInputElement>('Name')
    expect(name.value).toBe('bedrock-us')
    await fill(user, dialog, { accessKeyId: 'AKIAIOSFODNN7EXAMPL9' })
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
    expect(data[0]).toMatchObject({ name: 'bedrock-us', last4: 'MPL9' })
  })

  it('holds the save until a name is answered, for a second credential', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({
      credentials: [credential('bedrock', '1111', { type: 'bedrock' })],
      models: [],
      providers: [],
    })
    renderApp(fake, { hash: '#/settings' })

    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'Amazon Bedrock' }))
    await fill(user, dialog)
    const save = within(dialog).getByRole('button', { name: 'Save key' })
    // The name is not one of the form's fields, so an unanswered one has to hold the save by
    // itself: a blank name would be a request against an empty path segment.
    expect(save).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Name'), 'bedrock-eu')
    await waitFor(() => {
      expect(save).toBeEnabled()
    })
  })

  it('trims the keys a reader pasted with surrounding whitespace', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ models: [], providers: [] })
    // What the form sends, as the client sees it: the fake keeps the metadata only, so the
    // body is the only place a trim can be observed.
    const bodies: unknown[] = []
    const put = fake.providerCredentials.put.bind(fake.providerCredentials)
    fake.providerCredentials.put = (name, body, options) => {
      bodies.push(body)
      return put(name, body, options)
    }
    renderApp(fake, { hash: '#/settings' })

    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'Amazon Bedrock' }))
    await fill(user, dialog, {
      accessKeyId: `  ${ACCESS_KEY_ID}  `,
      secretAccessKey: `  ${SECRET_ACCESS_KEY}  `,
    })
    await user.click(within(dialog).getByRole('button', { name: 'Save key' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    // A key copied out of a console or a downloaded `.csv` arrives with whitespace around it —
    // often a newline — and a signature computed over that whitespace is one AWS rejects.
    expect(bodies[0]).toEqual({
      type: 'bedrock',
      region: 'us-east-1',
      access_key_id: ACCESS_KEY_ID,
      secret_access_key: SECRET_ACCESS_KEY,
    })
  })
})
