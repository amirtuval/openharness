import type { ProviderCredential } from '@openharness/protocol'
import { useState } from 'react'

import { useProviderCredentials, type CredentialResult } from '../../hooks/use-provider-credentials'
import { relativeTime } from '../../lib/format'
import { PROVIDER_IDS } from '../../lib/providers'
import { signInHash, settingsHash } from '../../lib/router'
import { useClient } from '../client-provider'
import { ErrorBanner } from '../chat/error-banner'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

/** The picker's escape hatch: type any router provider name. */
const CUSTOM_PROVIDER = '__custom__'

/**
 * Settings → Model providers (epic #65, A5).
 *
 * Each user brings their own model-provider keys; the server stores them encrypted and the
 * API is **write-only**. This card is built around that: a saved key is never rendered back —
 * the list shows the provider, the last four characters and when it was validated, and the
 * password field is cleared the moment a save succeeds. "Add" and "replace" are the same
 * form, because `PUT /v1/provider-credentials/{provider}` is the same request.
 *
 * Two failures get words of their own, because they are the two the reader can act on: a key
 * the provider refused (`invalid_provider_credential`, shown next to the form) and a session
 * the server considers too old for a credential write (shown with a link to sign in again).
 * Deleting asks in place — a `window.confirm` would block the page and cannot be styled or
 * tested like the rest of the app.
 */
export function ModelProvidersCard() {
  const client = useClient()
  const { credentials, loading, error, save, remove, dismissError } = useProviderCredentials(client)

  const [choice, setChoice] = useState<string>(PROVIDER_IDS[0])
  const [customProvider, setCustomProvider] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<CredentialResult | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const provider = choice === CUSTOM_PROVIDER ? customProvider.trim() : choice
  const existing = credentials.find((credential) => credential.provider === provider)

  const submit = async (): Promise<void> => {
    if (provider === '' || apiKey === '' || submitting) {
      return
    }
    setSubmitting(true)
    setFailure(null)
    setNotice(null)
    const result = await save(provider, apiKey)
    setSubmitting(false)
    if (!result.ok) {
      setFailure(result)
      return
    }
    // Cleared on success, and it was never rendered anywhere: the field the user typed into
    // is the only place the key ever lived in this app.
    setApiKey('')
    setNotice(`Saved the ${provider} key.`)
  }

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
    setNotice(`Deleted the ${target} key.`)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Model providers</CardTitle>
        <CardDescription>
          The keys your chats run on. Each is validated against its provider when you save it,
          stored encrypted on the server, and never shown again — a list entry shows the provider,
          the last four characters and when it was validated.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error === null ? null : (
          <ErrorBanner
            title="Could not load your provider keys"
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
            title={failure.kind === 'invalid' ? 'The key was rejected' : 'The request failed'}
            message={failure.message}
            onDismiss={() => setFailure(null)}
          />
        ) : null}

        <section aria-label="Saved provider keys" className="space-y-2">
          {loading ? <p className="text-sm text-muted-foreground">Loading your keys…</p> : null}
          {!loading && credentials.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No provider keys yet. Add one below — a chat cannot run a model whose provider has no
              key here.
            </p>
          ) : null}
          <ul className="flex flex-col gap-2">
            {credentials.map((credential) => (
              <li
                key={credential.provider}
                data-slot="provider-credential"
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    <span className="font-medium">{credential.provider}</span>{' '}
                    <span className="font-mono text-muted-foreground">…{credential.last4}</span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {validatedLabel(credential)}
                  </p>
                </div>

                {confirming === credential.provider ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted-foreground">Delete this key?</span>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={deleting !== null}
                      onClick={() => void confirmDelete(credential.provider)}
                    >
                      {deleting === credential.provider ? 'Deleting…' : 'Delete'}
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
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    aria-label={`Delete the ${credential.provider} key`}
                    onClick={() => {
                      setConfirming(credential.provider)
                      setNotice(null)
                    }}
                  >
                    Delete
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="provider-picker">Provider</Label>
            <select
              id="provider-picker"
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
            >
              {PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
              <option value={CUSTOM_PROVIDER}>Custom…</option>
            </select>
          </div>

          {choice === CUSTOM_PROVIDER ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="provider-id">Provider id</Label>
              <Input
                id="provider-id"
                value={customProvider}
                autoComplete="off"
                spellCheck={false}
                placeholder="any router provider, e.g. mistral"
                onChange={(event) => setCustomProvider(event.target.value)}
              />
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="provider-api-key">API key</Label>
            <Input
              id="provider-api-key"
              type="password"
              value={apiKey}
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-…"
              onChange={(event) => setApiKey(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Sent once, stored encrypted, never shown again. Saving replaces the key stored for
              this provider.
            </p>
          </div>

          <Button
            type="submit"
            className="self-start"
            disabled={submitting || provider === '' || apiKey === ''}
          >
            {submitting ? 'Saving…' : existing === undefined ? 'Save key' : 'Replace key'}
          </Button>
        </form>
      </CardContent>
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
