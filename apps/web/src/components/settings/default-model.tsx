import { useState } from 'react'

import { usePreferences } from '../../hooks/use-preferences'
import type { ModelsView } from '../../hooks/use-models'
import { useClient } from '../client-provider'
import { ErrorBanner } from '../chat/error-banner'
import { ModelPicker } from '../models/model-picker'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'

/**
 * Settings → Default model (epic #116, U1/U2).
 *
 * The one model a new chat opens with, stored on the server (`PUT /v1/me/preferences`) so the
 * web app and `oh` agree on it. The card shows what the server holds — including a default
 * the **server chose by itself** when the first provider key was saved (U4), because this is
 * a read of the same value the picker writes, not a local choice — and the same catalog
 * picker the composer uses, so a default can be any `provider/model` id,
 * catalog entry or typed id.
 *
 * The catalog comes from the shell (`AppFrame`), which loaded it once for the whole app (#91);
 * the card never fetches its own.
 */
export function DefaultModelCard({ catalog }: { catalog: ModelsView }) {
  const client = useClient()
  const { preferences, loading, error, saving, save, dismissError } = usePreferences(client)
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const choose = async (modelId: string): Promise<void> => {
    if (saving) {
      return
    }
    setNotice(null)
    setFailure(null)
    const result = await save({ default_model: modelId })
    if (result.ok) {
      setNotice('Saved the default model.')
    } else {
      // The stored default is untouched — the server refused the write — so the picker keeps
      // showing what is in effect, and the failure says what happened.
      setFailure(result.message)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Default model</CardTitle>
        <CardDescription>
          New chats start on this model — the composer's selector still lets you switch mid-chat.
          When you save your first provider key, the server picks a default for you; changing it
          here replaces that choice.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {catalog.error === null ? null : (
          <ErrorBanner
            title="Could not load models"
            message={catalog.error}
            onDismiss={catalog.dismissError}
          />
        )}
        {error === null ? null : (
          <ErrorBanner
            title="Could not load your default model"
            message={error}
            onDismiss={dismissError}
          />
        )}
        {failure === null ? null : (
          <ErrorBanner
            title="Could not save the default model"
            message={failure}
            onDismiss={() => setFailure(null)}
          />
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading your default model…</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <p className="text-sm leading-none font-medium">Model</p>
            <ModelPicker
              models={catalog.models}
              providers={catalog.providers}
              value={preferences?.default_model ?? null}
              onChange={(modelId) => void choose(modelId)}
              refreshing={catalog.refreshing}
              onRefresh={catalog.refresh}
            />
          </div>
        )}

        {saving ? (
          <p role="status" className="text-xs text-muted-foreground">
            Saving…
          </p>
        ) : notice === null ? null : (
          <p role="status" className="text-xs text-muted-foreground">
            {notice}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
