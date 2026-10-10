import { credentialDisplayName, type CredentialTarget } from '@openharness/client'
import { ArrowRight } from 'lucide-react'
import { useState } from 'react'

import { ErrorBanner } from '../components/chat/error-banner'
import { useClient } from '../components/client-provider'
import type { ProviderCredential } from '@openharness/protocol'
import { ModelPicker } from '../components/models/model-picker'
import { ProviderKeyForm } from '../components/providers/provider-key-form'
import { ProviderTiles } from '../components/providers/provider-tiles'
import { Button } from '../components/ui/button'
import { usePreferences } from '../hooks/use-preferences'
import type { ModelsView } from '../hooks/use-models'
import { useProviderCredentials } from '../hooks/use-provider-credentials'
import { modelNameLookup } from '../lib/models'

/**
 * The sentence the first-run screen is headed with (U12, #227).
 *
 * Exported for the same reason `NEW_CHAT_GREETING` is: it is how a test, a QA spec and a
 * screenshot say *which screen is this*. The ✨ after it is drawn outside the gradient span —
 * an emoji is decoration, and `background-clip: text` would swallow it — so anything matching
 * the heading by name matches this sentence, not the whole heading.
 */
export const FIRST_RUN_HEADING = "Let's get you chatting"

/**
 * Connect a model provider (epic #201, X5).
 *
 * The screen a signed-in account with **no provider key** lands on, in place of New chat: the
 * sign-in is done, but nothing can run yet, and the way out used to be a Home screen, a link to
 * Settings, a `<select>`, a save and a walk back. It is one flow now — pick a provider, paste a
 * key, read back the model the server picked, start chatting — and the cursor ends up in the
 * composer either way.
 *
 * Three steps in one screen: the tiles, the key form for the picked provider (the same
 * component Settings and the Add-provider dialog render), and the confirmation. "Skip" is
 * always there, because a reader who wants to look around first should not have to produce a
 * key to do it — New chat's own empty state still says what is missing.
 *
 * The flow is skippable, not blocking: nothing here re-checks after a save, so the screen the
 * reader leaves it by is the one {@link onLeave} opens.
 */
export function FirstRunScreen({
  catalog,
  onLeave,
}: {
  /** The shell's catalog, for the confirmation's model name and its Change picker. */
  catalog: ModelsView
  /** The reader is done here — Start chatting, or Skip. */
  onLeave: () => void
}) {
  const client = useClient()
  const { credentials, put } = useProviderCredentials(client)
  const { preferences, save, reload } = usePreferences(client)

  const [target, setTarget] = useState<CredentialTarget | null>(null)
  const [connected, setConnected] = useState<ProviderCredential | null>(null)
  const [changeError, setChangeError] = useState<string | null>(null)

  const nameOf = modelNameLookup(catalog.models)
  const defaultModel = preferences?.default_model ?? null

  // The key is stored: the server has just picked a default model for this account (U4), so
  // both the preferences and the catalog are re-read — the catalog because a key that was not
  // there a moment ago is a provider's models that were not there either.
  const onSaved = (saved: ProviderCredential): void => {
    setConnected(saved)
    void reload()
    void catalog.reload()
  }

  const choose = async (modelId: string): Promise<void> => {
    setChangeError(null)
    const result = await save({ default_model: modelId })
    if (!result.ok) {
      setChangeError(result.message)
    }
  }

  return (
    // `m-auto` rather than `items-center` on the scroller (U12, #227): centred when it fits,
    // and still scrolled from the top when it does not — `items-center` clips the first line of
    // an overflowing child, which on a 400px-wide phone is exactly the heading.
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="m-auto w-full max-w-lg space-y-5 px-6 py-8">
        {connected === null ? (
          <>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">
                <span data-slot="hero-title">{FIRST_RUN_HEADING}</span> ✨
              </h1>
              <p className="text-sm text-muted-foreground">
                Pick a model provider and paste a key. Your key stays encrypted on the server, and
                we never ship one of our own.
              </p>
            </div>

            {target === null ? (
              <>
                <ProviderTiles onPick={setTarget} />
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    {credentials.length === 0
                      ? 'Nothing saved yet.'
                      : 'A key is already saved — picking its provider replaces it.'}
                  </p>
                  <Button type="button" variant="ghost" onClick={onLeave}>
                    Skip for now
                  </Button>
                </div>
              </>
            ) : (
              <div className="space-y-3">
                <ProviderKeyForm
                  target={target}
                  storedNames={credentials.map((credential) => credential.name)}
                  save={put}
                  returnHash="#/new"
                  autoFocus
                  onCancel={() => setTarget(null)}
                  onSaved={onSaved}
                />
                <Button type="button" variant="ghost" onClick={onLeave}>
                  Skip for now
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">
                <span data-slot="hero-title">You&apos;re all set!</span> 🎉
              </h1>
              <p className="text-sm text-muted-foreground">
                Saved the {credentialDisplayName(connected)} credential.{' '}
                {defaultModel === null ? (
                  'Pick a default model below and you are ready to go.'
                ) : (
                  <>
                    Your chats will use{' '}
                    <span className="font-medium text-foreground">
                      {nameOf(defaultModel) ?? defaultModel}
                    </span>{' '}
                    — the composer&apos;s selector still switches mid-chat.
                  </>
                )}
              </p>
            </div>

            {catalog.error === null ? null : (
              <ErrorBanner
                title="Could not load models"
                message={catalog.error}
                onDismiss={catalog.dismissError}
              />
            )}
            {changeError === null ? null : (
              <ErrorBanner
                title="Could not save the default model"
                message={changeError}
                onDismiss={() => setChangeError(null)}
              />
            )}

            {defaultModel === null ? null : (
              <div className="flex flex-col gap-1.5">
                <p className="text-sm leading-none font-medium">Change it</p>
                <ModelPicker
                  models={catalog.models}
                  providers={catalog.providers}
                  value={defaultModel}
                  onChange={(modelId) => void choose(modelId)}
                  refreshing={catalog.refreshing}
                  onRefresh={catalog.refresh}
                />
              </div>
            )}

            <Button type="button" onClick={onLeave}>
              Let&apos;s go
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
