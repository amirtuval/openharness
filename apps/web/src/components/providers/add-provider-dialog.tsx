import { providerName } from '@openharness/client'
import { useEffect, useRef, useState } from 'react'

import { useProviderCredentials } from '../../hooks/use-provider-credentials'
import { useClient } from '../client-provider'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { ProviderKeyForm } from './provider-key-form'
import { ProviderTiles } from './provider-tiles'

/**
 * "Add provider", as a dialog (epic #201, X5).
 *
 * The same key form the first-run screen uses, reachable without leaving the chat: from the
 * model picker's last row, and from a `missing_provider_credential` banner — where the provider
 * that failed is preselected, because the reader has already told us which one they meant.
 *
 * The dialog replaces the old "go to Settings → Model providers" link. That link was the whole
 * problem the epic is about: a reader mid-chat had to leave the chat, find a card on another
 * screen, come back, and pick a model again. Here the write and the catalog refresh happen
 * under the chat, and {@link onSaved} is what tells the caller to rebuild the catalog.
 *
 * Radix supplies the dialog behaviour (`components/ui/dialog.tsx`): the focus trap, Escape, and
 * focus back to whatever opened it. That last one is why the root is always mounted and only
 * `open` moves — a caller that unmounted the whole dialog on close would take the FocusScope
 * with it, and the reader would be left on the body. The body is a separate component for the
 * same reason in reverse: Radix keeps it out of the tree while the dialog is closed, so the
 * credentials read it does happens on open and not once per mounted chat.
 */
export function AddProviderDialog({
  open,
  /** The provider to open on; without one the dialog starts on the tiles. */
  initialProvider,
  /** The credential was stored. The caller refreshes the catalog and closes the dialog. */
  onSaved,
  /** The dialog was dismissed without saving. */
  onClose,
}: {
  open: boolean
  initialProvider?: string | undefined
  onSaved: (provider: string) => void
  onClose: () => void
}) {
  // Where focus goes when the dialog closes. Radix restores it to its own `DialogTrigger`, and
  // this dialog has none — the three things that open it live in three different components
  // (a picker row, an error banner's action, a card's button) — so without this the reader
  // would be left on `document.body` with the page's tab order reset. Tracking the last
  // focused element while the dialog is *closed* is what makes it the thing that opened it,
  // whatever that was.
  const openerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open) {
      return
    }
    const onFocusIn = (event: FocusEvent): void => {
      if (event.target instanceof HTMLElement) {
        openerRef.current = event.target
      }
    }
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [open])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent
        aria-label="Add a model provider"
        onCloseAutoFocus={() => {
          openerRef.current?.focus()
        }}
      >
        <AddProviderBody initialProvider={initialProvider} onSaved={onSaved} onCancel={onClose} />
      </DialogContent>
    </Dialog>
  )
}

/** The dialog's contents, mounted only while it is open. */
function AddProviderBody({
  initialProvider,
  onSaved,
  onCancel,
}: {
  initialProvider?: string | undefined
  onSaved: (provider: string) => void
  onCancel: () => void
}) {
  const client = useClient()
  const { credentials, put } = useProviderCredentials(client)
  const [provider, setProvider] = useState<string | null>(initialProvider ?? null)

  const replacing =
    provider !== null && credentials.some((credential) => credential.provider === provider)

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {provider === null ? 'Add a provider' : `Connect ${providerName(provider)}`}
        </DialogTitle>
        <DialogDescription>
          A chat runs on a model from a provider you have a key for. The key is validated against
          the provider when you save it, stored encrypted on the server, and never shown again.
        </DialogDescription>
      </DialogHeader>

      {provider === null ? (
        <ProviderTiles onPick={setProvider} />
      ) : (
        <ProviderKeyForm
          provider={provider}
          replacing={replacing}
          save={put}
          returnHash={window.location.hash}
          autoFocus
          // Back to the list, unless the provider was the one the caller named: there is
          // nothing to go back to, and the dialog's own close is the way out.
          onCancel={initialProvider === undefined ? () => setProvider(null) : onCancel}
          cancelLabel={initialProvider === undefined ? 'Back to the list' : 'Cancel'}
          onSaved={(credential) => onSaved(credential.provider)}
        />
      )}
    </>
  )
}
