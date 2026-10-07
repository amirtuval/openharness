import { providerName } from '@openharness/client'
import { Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useClient } from '../client-provider'
import type { DeleteSessionResult } from '../../hooks/use-sessions'
import { useSession } from '../../hooks/use-session'
import type { ModelsView } from '../../hooks/use-models'
import { shortId, sessionLabel } from '../../lib/format'
import { providerOf, type ModelNameLookup } from '../../lib/models'
import { showNotice } from '../../lib/notice'
import { ModelPicker } from '../models/model-picker'
import { AddProviderDialog } from '../providers/add-provider-dialog'
import { Button } from '../ui/button'
import { Composer } from './composer'
import { ErrorBanner } from './error-banner'
import { MessageList } from './message-list'
import { StatusIndicator } from './status-indicator'

/**
 * An open session: header, conversation, errors, composer.
 *
 * All of it is `useSession(client, sessionId)` — the hook loads the history, follows the live
 * stream, and owns the transcript; this screen only decides what it looks like.
 *
 * Two things of its own since epic #116:
 *
 * - **The composer's model switch (U3).** The selector shows the session's current model —
 *   the log's last `user.message.model`, else the model the session was created with. A
 *   pick that differs is held here and sent with the *next* message (`{ model }`); the
 *   transcript then moves the session's model, so the selector and the "Switched to …"
 *   marker both follow the log rather than this state.
 * - **Delete (U5).** The header's action confirms in the page — a `window.confirm` would
 *   block the page and cannot be styled or tested like the rest of the app — and the shell
 *   leaves the chat after it (the open chat goes to New chat). A chat deleted somewhere else
 *   announces itself through the stream's `session.deleted`: the app shows the notice and
 *   leaves, so the reader is never left typing into a log that no longer exists.
 */
export function ChatView({
  sessionId,
  nameOf,
  catalog,
  onDelete,
  onDeleted,
}: {
  sessionId: string
  /**
   * The catalog lookup behind the label (#91): an untitled session is headed by its model's
   * display name, or by the `provider/model` id when the catalog does not know it. The agent
   * is never named — a chat is started from a model now (epic #92).
   */
  nameOf?: ModelNameLookup | undefined
  /** The shell's catalog: what the composer's model selector offers. */
  catalog: ModelsView
  /** Delete this chat; the shell navigates away when it was the open one. */
  onDelete: (sessionId: string) => Promise<DeleteSessionResult>
  /** This chat was deleted elsewhere: the shell drops its row and leaves it. */
  onDeleted: (sessionId: string) => void
}) {
  const client = useClient()
  const {
    session,
    messages,
    status,
    lastError,
    loadingHistory,
    requestError,
    deleted,
    model,
    send,
    interrupt,
    dismissError,
  } = useSession(client, sessionId)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // The model the session runs as the log last said it; a session created with a model shows
  // it through the header resource until a message carries one (the transcript's `model`).
  const sessionModel = model ?? session?.model.id ?? null
  // A pick that has not been sent yet (U3): the selector shows it, the next message carries it.
  const [chosen, setChosen] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // The Add-provider dialog (X5). Three states in one value: `undefined` is closed, `null` is
  // open with the provider left to the reader (the picker's "+ Add provider"), and a provider
  // id is open on that provider's form (the missing-key banner, which knows which one failed).
  const [addingProvider, setAddingProvider] = useState<string | null | undefined>(undefined)

  // A chat opens with the cursor in the box: whether it was picked from the sidebar or just
  // created from New chat, the next thing the user does is type.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Deleted elsewhere (#111, U5): the stream's last event says so. Leave the chat — the shell
  // drops the row and navigates — and let the screen the reader lands on say why.
  useEffect(() => {
    if (!deleted) {
      return
    }
    showNotice('This chat was deleted.')
    onDeleted(sessionId)
  }, [deleted, onDeleted, sessionId])

  const sendFromComposer = useCallback(
    async (text: string): Promise<boolean> => {
      const switching = chosen !== null && chosen !== sessionModel
      const stored = await send(text, switching ? { model: chosen } : undefined)
      if (stored && switching) {
        // The stored event moves the transcript's model to the pick; from here the selector
        // reads the log, and the message carries the "Switched to …" marker.
        setChosen(null)
      }
      return stored
    },
    [chosen, sessionModel, send],
  )

  const confirmDelete = async (): Promise<void> => {
    setDeleting(true)
    setDeleteError(null)
    const result = await onDelete(sessionId)
    setDeleting(false)
    if (result.ok) {
      // The shell navigates when this was the open chat; the row is already gone otherwise.
      return
    }
    setDeleteError(result.message)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-medium">
            {session === null ? shortId(sessionId) : sessionLabel(session, nameOf)}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {session === null ? 'Loading…' : session.model.id}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <StatusIndicator status={status} retrying={lastError?.retryStatus === 'retrying'} />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Delete chat"
            onClick={() => {
              setConfirmingDelete(true)
              setDeleteError(null)
            }}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      </header>

      {confirmingDelete ? (
        <div className="flex flex-wrap items-center gap-2 border-b bg-destructive/5 px-4 py-2 text-sm">
          <span>Delete this chat and all its messages?</span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={deleting}
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <MessageList messages={messages} loading={loadingHistory} nameOf={nameOf} />

      <div className="border-t px-4 py-3">
        <div className="mx-auto w-full max-w-3xl space-y-2">
          {deleteError === null ? null : (
            <ErrorBanner
              title="Could not delete the chat"
              message={deleteError}
              onDismiss={() => setDeleteError(null)}
            />
          )}
          {lastError === null ? null : (
            <ErrorBanner
              title={
                lastError.retryStatus === 'retrying'
                  ? `${lastError.type} · retrying`
                  : lastError.type
              }
              message={lastError.message}
              // The one error in the log the reader can fix themselves: the session's owner
              // has no key for the model's provider (epic #65, A5), so the turn ended and no
              // retry will help until one is saved. The fix opens **here** (X5): leaving the
              // chat for Settings, saving, and finding the way back was the whole detour this
              // issue removes. The provider is the one the failed model names.
              action={
                lastError.type === 'missing_provider_credential' ? (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="h-auto p-0 text-destructive"
                    onClick={() => setAddingProvider(providerOf(sessionModel))}
                  >
                    Add a provider key
                  </Button>
                ) : undefined
              }
            />
          )}
          {requestError === null ? null : (
            <ErrorBanner title="Request failed" message={requestError} onDismiss={dismissError} />
          )}
          <Composer
            running={status === 'running'}
            onSend={sendFromComposer}
            onStop={interrupt}
            inputRef={inputRef}
            modelSelector={
              <ModelPicker
                variant="compact"
                placement="above"
                models={catalog.models}
                providers={catalog.providers}
                value={chosen ?? sessionModel}
                onChange={setChosen}
                refreshing={catalog.refreshing}
                onRefresh={catalog.refresh}
                // From the picker the provider is the reader's to choose, so the dialog opens
                // on the tiles rather than on a form.
                onAddProvider={() => setAddingProvider(null)}
              />
            }
          />
        </div>
      </div>

      <AddProviderDialog
        open={addingProvider !== undefined}
        initialProvider={addingProvider ?? undefined}
        onSaved={(provider) => {
          setAddingProvider(undefined)
          showNotice(`Saved the ${providerName(provider)} key.`)
          // A key that was not there a moment ago is a provider's models that were not there
          // either: the picker offers them from here, without leaving the chat (X5).
          void catalog.reload()
        }}
        onClose={() => setAddingProvider(undefined)}
      />
    </div>
  )
}
