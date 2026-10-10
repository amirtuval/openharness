import {
  credentialDisplayName,
  credentialTargetFor,
  type CredentialTarget,
} from '@openharness/client'
import type { ProviderCredential } from '@openharness/protocol'
import { useState } from 'react'

import { useProviderCredentials, type CredentialResult } from '../../hooks/use-provider-credentials'
import { relativeTime } from '../../lib/format'
import { signInHash, settingsHash } from '../../lib/router'
import { useClient } from '../client-provider'
import { ErrorBanner } from '../chat/error-banner'
import { AddProviderDialog } from '../providers/add-provider-dialog'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'

/**
 * Settings → Providers (epic #65 A5; epic #201 X5).
 *
 * Each account brings its own model-provider keys; the server stores them encrypted and the API
 * is **write-only**. This card is built around that: a saved key is never rendered back — the
 * list shows the provider, the last four characters and when it was validated, and the password
 * field is cleared the moment a save succeeds.
 *
 * It is the list and the destructive half of the flow. **Adding and replacing are the
 * Add-provider dialog** — the same one the model picker and the missing-key banner open
 * (`components/providers/add-provider-dialog.tsx`) — so a key is collected by one form in one
 * place, and the Settings card cannot drift from what a first-run reader sees.
 *
 * Deleting asks in place: a `window.confirm` would block the page and cannot be styled or
 * tested like the rest of the app.
 */
export function ProvidersCard() {
  const client = useClient()
  const { credentials, loading, error, remove, reload, dismissError } =
    useProviderCredentials(client)

  // The dialog to open: `{}` for "pick one", `{ target, name }` for a row's Replace.
  const [adding, setAdding] = useState<{ target?: CredentialTarget; name?: string } | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [failure, setFailure] = useState<CredentialResult | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const confirmDelete = async (target: string): Promise<void> => {
    setDeleting(target)
    setFailure(null)
    setNotice(null)
    const result = await remove(target)
    setDeleting(null)
    setConfirming(null)
    if (!result.ok) {
      setFailure(result)
      return
    }
    setNotice(`Deleted the ${target} credential.`)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Providers</CardTitle>
        <CardDescription>
          The credentials your chats run on. Each is validated against its provider when you save
          it, stored encrypted on the server, and never shown again — a list entry shows what it is
          called, the last four characters and when it was validated.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error === null ? null : (
          <ErrorBanner
            title="Could not load your credentials"
            message={error}
            onDismiss={dismissError}
          />
        )}
        {notice === null ? null : (
          <p role="status" className="text-xs text-muted-foreground">
            {notice}
          </p>
        )}
        {failure !== null && !failure.ok && failure.kind === 'session' ? (
          <ErrorBanner
            title="Sign in again"
            message={failure.message}
            action={
              <a className="underline underline-offset-2" href={signInHash(settingsHash())}>
                Sign in again
              </a>
            }
          />
        ) : failure !== null && !failure.ok ? (
          <ErrorBanner
            // The row's own failure has no provider to name here (the dialog owns the form), so
            // this is the same warm sentence without one (U12, #227). The server's own message
            // is still the body, verbatim.
            title={failure.kind === 'invalid' ? "Hmm, that key didn't work" : 'The request failed'}
            message={failure.message}
            onDismiss={() => setFailure(null)}
          />
        ) : null}

        <section aria-label="Saved credentials" className="space-y-2">
          {loading ? <p className="text-sm text-muted-foreground">Loading your keys…</p> : null}
          {!loading && credentials.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No credentials yet. Add one below — a chat cannot run a model whose provider has no
              credential here.
            </p>
          ) : null}
          <ul className="flex flex-col gap-2">
            {credentials.map((credential) => (
              <li
                key={credential.name}
                data-slot="provider-credential"
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    <span className="font-medium">{credentialDisplayName(credential)}</span>{' '}
                    <span className="font-mono text-muted-foreground">…{credential.last4}</span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {validatedLabel(credential)}
                  </p>
                </div>

                {confirming === credential.name ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted-foreground">Delete this key?</span>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={deleting !== null}
                      onClick={() => void confirmDelete(credential.name)}
                    >
                      {deleting === credential.name ? 'Deleting…' : 'Delete'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={deleting !== null}
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Replace the ${credential.name} credential`}
                      onClick={() => {
                        setAdding({
                          target: credentialTargetFor(credential),
                          name: credential.name,
                        })
                        setNotice(null)
                      }}
                    >
                      Replace
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Delete the ${credential.name} credential`}
                      onClick={() => {
                        setConfirming(credential.name)
                        setNotice(null)
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>

        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={() => {
            setAdding({})
            setNotice(null)
          }}
        >
          Add provider
        </Button>
      </CardContent>

      <AddProviderDialog
        open={adding !== null}
        initialTarget={adding?.target}
        replacingName={adding?.name}
        onSaved={(name) => {
          setAdding(null)
          setFailure(null)
          setNotice(`Saved the ${name} credential.`)
          // The dialog holds its own list; this card's copy is one read behind it.
          void reload()
        }}
        onClose={() => setAdding(null)}
      />
    </Card>
  )
}

/** When the credential was last validated against its provider, in the reader's words. */
function validatedLabel(credential: ProviderCredential): string {
  if (credential.validated_at === undefined) {
    return `Saved ${relativeTime(credential.updated_at)} — not validated yet`
  }
  return `Validated ${relativeTime(credential.validated_at)}`
}
