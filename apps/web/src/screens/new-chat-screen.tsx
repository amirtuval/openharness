import type { Session } from '@openharness/protocol'
import { useMemo, useState } from 'react'

import { ErrorBanner } from '../components/chat/error-banner'
import { ModelPicker } from '../components/models/model-picker'
import { Button } from '../components/ui/button'
import type { ModelsView } from '../hooks/use-models'
import { readLastModel, rememberLastModel } from '../lib/last-model'
import { chatHash, navigate, settingsHash } from '../lib/router'

/**
 * New chat = pick a model (issue #91, epic #92). No agent needed, and none offered: the
 * screen is the catalog — the chat models the reader's own keys can use, grouped by provider,
 * searchable, with a free-text escape hatch — and one button that creates the session with
 * the chosen `provider/model` (`client.sessions.create({ model })`).
 *
 * The last model a chat was created with is remembered in `localStorage` and is the default
 * selection next time (falling back to the catalog's first entry), so the common case is one
 * click. With no keys at all there is nothing to pick: an empty state points at Settings →
 * Model providers instead.
 */
export function NewChatScreen({
  createSession,
  catalog,
}: {
  createSession: (modelId: string) => Promise<Session | null>
  catalog: ModelsView
}) {
  const [chosen, setChosen] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [refreshNote, setRefreshNote] = useState<string | null>(null)
  // Read once per mount: this screen is remounted by the route, so coming back from a chat
  // sees what that chat just remembered.
  const remembered = useMemo(() => readLastModel(), [])

  // The effective selection, derived rather than stored (no flash of an empty picker): an
  // explicit choice wins, then the last model used, then the catalog's first entry. With no
  // models at all the empty state replaces the form, so `null` never disables anything that
  // is rendered.
  const selected = chosen ?? remembered ?? catalog.models[0]?.id ?? null

  const start = async (): Promise<void> => {
    if (selected === null || creating) {
      return
    }
    setCreating(true)
    setCreateError(null)
    const session = await createSession(selected)
    setCreating(false)
    if (session === null) {
      setCreateError('The session could not be created.')
      return
    }
    rememberLastModel(selected)
    navigate(chatHash(session.id))
  }

  const refresh = async (): Promise<void> => {
    setRefreshNote(null)
    const outcome = await catalog.refresh()
    if (!outcome.ok) {
      // The 429 the server answers a refresh inside its window is a "come back later", not a
      // failure: the list stays, and the note repeats the server's reason.
      setRefreshNote(
        outcome.kind === 'rate_limit'
          ? outcome.message
          : `The catalog could not be refreshed. ${outcome.message}`,
      )
    }
  }

  const noModels = !catalog.loading && catalog.error === null && catalog.models.length === 0

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-md space-y-5">
        <div className="space-y-1">
          <h1 className="text-base font-medium">New chat</h1>
          <p className="text-sm text-muted-foreground">
            Pick a model. The session runs it; no agent needed.
          </p>
        </div>

        {catalog.error === null ? null : (
          <ErrorBanner
            title="Could not load models"
            message={catalog.error}
            onDismiss={catalog.dismissError}
          />
        )}
        {createError === null ? null : (
          <ErrorBanner
            title="Could not create the chat"
            message={createError}
            onDismiss={() => setCreateError(null)}
          />
        )}

        {noModels ? (
          <div className="space-y-2 rounded-md border p-4">
            <p className="text-sm font-medium">No model providers yet</p>
            <p className="text-sm text-muted-foreground">
              Add an API key for a provider, and its chat models show up here.
            </p>
            <a className="text-sm underline underline-offset-2" href={settingsHash()}>
              Settings → Model providers
            </a>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void start()
            }}
          >
            <div className="flex flex-col gap-1.5">
              <p className="text-sm leading-none font-medium">Model</p>
              {catalog.loading ? (
                <p className="text-sm text-muted-foreground">Loading models…</p>
              ) : (
                <ModelPicker
                  models={catalog.models}
                  providers={catalog.providers}
                  value={selected}
                  onChange={setChosen}
                />
              )}
              <div className="flex items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={catalog.refreshing || catalog.loading}
                  onClick={() => void refresh()}
                >
                  {catalog.refreshing ? 'Refreshing…' : 'Refresh models'}
                </Button>
                {refreshNote === null ? null : (
                  <p role="status" className="text-xs text-muted-foreground">
                    {refreshNote}
                  </p>
                )}
              </div>
            </div>

            <Button type="submit" disabled={selected === null || creating}>
              {creating ? 'Creating…' : 'Create chat'}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
