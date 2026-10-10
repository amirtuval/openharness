import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { makeFake, renderApp } from '../../test-support/render-app'

/**
 * The Google Vertex form (epic #245, A3d).
 *
 * The second half of the credential types' two ways in: the service-account key document —
 * **uploaded or pasted** — with the project and the location, and the refusals the route would
 * give shown next to the field. What the reader types here is a secret; what the listing shows
 * afterwards is the service-account email, the project and the location, and never any part of
 * the key.
 */

/** A service-account key document, shaped as Google's console issues one. */
const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'openharness-vertex',
  private_key_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  private_key:
    '-----BEGIN PRIVATE KEY-----\nVERTEX-PRIVATE-KEY-DO-NOT-LOG\n-----END PRIVATE KEY-----\n',
  client_email: 'vertex-runner@openharness-vertex.iam.gserviceaccount.com',
  client_id: '118204773655879341057',
  token_uri: 'https://oauth2.googleapis.com/token',
}

const SERVICE_ACCOUNT_JSON = JSON.stringify(SERVICE_ACCOUNT, null, 2)

/** The Add-provider dialog, opened from Settings → Providers. */
async function openDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Add provider' }))
  return screen.findByRole('dialog')
}

/** Open the dialog on the Google Vertex form. */
async function openVertexForm(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const dialog = await openDialog(user)
  await user.click(within(dialog).getByRole('button', { name: 'Google Vertex' }))
  return dialog
}

describe('the vertex credential form', () => {
  it('opens on the vertex tile with the key document, project and location fields', async () => {
    const user = userEvent.setup({ delay: null })
    renderApp(makeFake({ models: [], providers: [] }), { hash: '#/settings' })

    const dialog = await openVertexForm(user)

    expect(within(dialog).getByText('Connect Google Vertex')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Service account key')).toBeInTheDocument()
    // The document can be uploaded as well as pasted, which is how most readers have one.
    expect(within(dialog).getByLabelText('Upload Service account key')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Project ID')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Location')).toBeInTheDocument()
    // The first credential of a type takes the type's default name, so nothing asks for one.
    expect(within(dialog).queryByLabelText('Name')).not.toBeInTheDocument()
  })

  it('keeps the key box a fixed size, so a pasted document cannot widen the dialog', async () => {
    // The `Textarea` primitive is `field-sizing-content` (right for the composer, wrong for a
    // document whose PEM newlines are escapes and whose content is one very long line): a box
    // that grew to fit it would be wider than a phone's screen. This is the regression guard.
    const user = userEvent.setup({ delay: null })
    renderApp(makeFake({ models: [], providers: [] }), { hash: '#/settings' })

    const dialog = await openVertexForm(user)
    const box = within(dialog).getByLabelText('Service account key')
    expect(box.className).toContain('field-sizing-fixed')
  })

  it('defaults the project from the key document the reader pasted', async () => {
    const user = userEvent.setup({ delay: null })
    renderApp(makeFake({ models: [], providers: [] }), { hash: '#/settings' })

    const dialog = await openVertexForm(user)
    await user.click(within(dialog).getByLabelText('Service account key'))
    // A paste, not typing: the document is what a reader has on their clipboard.
    await user.paste(SERVICE_ACCOUNT_JSON)

    expect(within(dialog).getByLabelText('Project ID')).toHaveValue('openharness-vertex')
    // A project the reader typed itself is never overwritten by the document's.
    await user.clear(within(dialog).getByLabelText('Project ID'))
    await user.type(within(dialog).getByLabelText('Project ID'), 'another-project-9f3a')
    expect(within(dialog).getByLabelText('Project ID')).toHaveValue('another-project-9f3a')
  })

  it('fills the field from an uploaded key file', async () => {
    const user = userEvent.setup({ delay: null })
    renderApp(makeFake({ models: [], providers: [] }), { hash: '#/settings' })

    const dialog = await openVertexForm(user)
    const file = new File([SERVICE_ACCOUNT_JSON], 'openharness-vertex.json', {
      type: 'application/json',
    })
    await user.upload(within(dialog).getByLabelText('Upload Service account key'), file)

    // The uploaded document parses, so the box is replaced by its summary — the same thing a
    // paste does. What is on screen is the document's public facts, never the key.
    const summary = await within(dialog).findByText(
      'vertex-runner@openharness-vertex.iam.gserviceaccount.com',
    )
    expect(summary).toBeInTheDocument()
    expect(dialog.textContent).not.toContain('VERTEX-PRIVATE-KEY-DO-NOT-LOG')
    expect(within(dialog).getByLabelText('Project ID')).toHaveValue('openharness-vertex')
  })

  it('collapses a pasted document to a summary, and Replace brings the empty field back', async () => {
    const user = userEvent.setup({ delay: null })
    renderApp(makeFake({ models: [], providers: [] }), { hash: '#/settings' })

    const dialog = await openVertexForm(user)
    await user.click(within(dialog).getByLabelText('Service account key'))
    await user.paste(SERVICE_ACCOUNT_JSON)

    // The textarea is gone the moment the document parses: a service-account key is the one
    // field drawn unmasked, and a private key left on a shared screen is the risk this closes.
    expect(within(dialog).queryByLabelText('Service account key')).not.toBeInTheDocument()
    const summary = within(dialog).getByText(
      'vertex-runner@openharness-vertex.iam.gserviceaccount.com',
    )
    expect(summary).toBeInTheDocument()
    // The public facts and the key id's tail; no part of the document itself.
    expect(dialog.textContent).toContain(
      `project openharness-vertex · key ${SERVICE_ACCOUNT.private_key_id}`,
    )
    expect(dialog.textContent).not.toContain('VERTEX-PRIVATE-KEY-DO-NOT-LOG')

    // Replace clears it and shows the empty field again.
    await user.click(within(dialog).getByRole('button', { name: 'Replace' }))
    const box = within(dialog).getByLabelText('Service account key')
    expect(box).toHaveValue('')
    expect(within(dialog).getByLabelText('Upload Service account key')).toBeInTheDocument()
  })

  it('refuses a document that is not a service-account key, before a save is attempted', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ models: [], providers: [] })
    renderApp(fake, { hash: '#/settings' })

    const dialog = await openVertexForm(user)
    await user.click(within(dialog).getByLabelText('Service account key'))
    await user.paste('{"type":"authorized_user","refresh_token":"x"}')
    await user.selectOptions(within(dialog).getByLabelText('Location'), 'us-central1')

    expect(within(dialog).getByText(/That is not a service-account key file/)).toBeInTheDocument()
    const save = within(dialog).getByRole('button', { name: 'Save key' })
    expect(save).toBeDisabled()
    // Nothing was sent: the refusal is the form's, not a round trip's.
    expect((await fake.providerCredentials.list()).data).toEqual([])
  })

  it('stores the credential under the default name and lists only what is not secret', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ models: [], providers: [] })
    renderApp(fake, { hash: '#/settings' })

    const dialog = await openVertexForm(user)
    await user.click(within(dialog).getByLabelText('Service account key'))
    await user.paste(SERVICE_ACCOUNT_JSON)
    await user.selectOptions(within(dialog).getByLabelText('Location'), 'europe-west4')
    await user.click(within(dialog).getByRole('button', { name: 'Save key' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    const { data } = await fake.providerCredentials.list()
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({
      type: 'vertex',
      name: 'vertex',
      // The key **id**'s tail, never a piece of the private key.
      last4: '5678',
      details: {
        email: 'vertex-runner@openharness-vertex.iam.gserviceaccount.com',
        project: 'openharness-vertex',
        location: 'europe-west4',
      },
    })

    // The list row is the three facts the type knows — not the key, and not its id.
    const list = within(screen.getByRole('region', { name: 'Saved credentials' }))
    expect(await list.findByText('Google Vertex')).toBeInTheDocument()
    expect(
      list.getByText(
        'vertex-runner@openharness-vertex.iam.gserviceaccount.com · openharness-vertex · europe-west4',
      ),
    ).toBeInTheDocument()
    const page = document.body.textContent ?? ''
    expect(page).not.toContain('VERTEX-PRIVATE-KEY-DO-NOT-LOG')
    expect(page).not.toContain('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'.slice(0, 20))
  })

  it('asks for a name for a second credential of the type, and saves under it', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ models: [], providers: [] })
    renderApp(fake, { hash: '#/settings' })

    // The first one takes the type's default name.
    const first = await openVertexForm(user)
    await user.click(within(first).getByLabelText('Service account key'))
    await user.paste(SERVICE_ACCOUNT_JSON)
    await user.selectOptions(within(first).getByLabelText('Location'), 'europe-west4')
    await user.click(within(first).getByRole('button', { name: 'Save key' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    // The second has to be told apart from it.
    const second = await openVertexForm(user)
    const name = within(second).getByLabelText('Name')
    expect(name).toHaveValue('')
    // A Vertex credential's models are `<name>/<model>` — not Azure's `<deployment>`, which
    // is what this help said before the noun became the type's to say.
    expect(
      within(second).getByText(/Its models are named after it — vertex\/<model>/),
    ).toBeInTheDocument()
    await user.type(name, 'vertex-eu')
    await user.click(within(second).getByLabelText('Service account key'))
    await user.paste(SERVICE_ACCOUNT_JSON)
    await user.selectOptions(within(second).getByLabelText('Location'), 'europe-west1')
    await user.click(within(second).getByRole('button', { name: 'Save key' }))

    await waitFor(async () => {
      expect((await fake.providerCredentials.list()).data).toHaveLength(2)
    })
    expect((await fake.providerCredentials.list()).data.map((entry) => entry.name)).toEqual([
      'vertex',
      'vertex-eu',
    ])
  })
})
