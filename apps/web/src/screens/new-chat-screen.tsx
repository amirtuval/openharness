import type { Session } from '@openharness/protocol'
import { useEffect, useRef, useState } from 'react'

import { ErrorBanner } from '../components/chat/error-banner'
import { Composer } from '../components/chat/composer'
import { ModelPicker } from '../components/models/model-picker'
import { useClient } from '../components/client-provider'
import type { ModelsView } from '../hooks/use-models'
import { usePreferences } from '../hooks/use-preferences'
import { useSettings } from '../hooks/use-settings'
import { describeError } from '../lib/errors'
import { chatHash, navigate, settingsHash } from '../lib/router'
import { sessionRefresh } from '../lib/session-refresh'

/**
 * New chat, immediately (epic #116, U2): an empty chat whose composer runs on the account's
 * **default model** (`GET /v1/me/preferences`), with no picker screen in the way. The session
 * is created on the first send — `sessions.create({ model })`, then the message — and the app
 * moves to it, where the reply streams in like any other chat.
 *
 * The model control in the composer is the app's one picker (compact): the default stands in
 * until the reader picks another one, and their pick is what the session is created with.
 * With no default — an account with no provider keys at all — there is nothing to run, so the
 * screen says so and links to Settings instead of pretending to be a chat. (The screen is
 * reachable signed in, after a 401, and while preferences load; each state is drawn, not
 * assumed away.)
 */
export function NewChatScreen({
  createSession,
  catalog,
}: {
  /** Create the session, refresh the list, and return it (`null` on failure). */
  createSession: (modelId: string) => Promise<Session | null>
  catalog: ModelsView
}) {
  const client = useClient()
  const { preferences, loading, error, dismissError } = usePreferences(client)
  // A failure of our own is described with the server the client is pointed at, so a request
  // that never arrived can say where it did not arrive.
  const { serverUrl } = useSettings()

  const [chosen, setChosen] = useState<string | null>(null)
  // The session this screen has already created, if a send failed after the create: the
  // reader's retry goes to the chat that exists, not a second empty one.
  const [created, setCreated] = useState<{ id: string; model: string } | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const defaultModel = preferences?.default_model ?? null
  const model = chosen ?? created?.model ?? defaultModel

  // A new chat opens with the cursor in the box, like any other chat.
  useEffect(() => {
    if (loading) {
      return
    }
    inputRef.current?.focus()
  }, [loading, model])

  const send = async (text: string): Promise<boolean> => {
    if (model === null || sending) {
      return false
    }
    setSending(true)
    setSendError(null)

    let sessionId = created?.id ?? null
    if (sessionId === null) {
      const session = await createSession(model)
      if (session === null) {
        setSending(false)
        setSendError('The chat could not be created.')
        return false
      }
      sessionId = session.id
      setCreated({ id: session.id, model })
    }

    try {
      // The session was created with this model (or with the one in `created`); only a pick
      // that came after a create rides the message, the way a mid-chat switch does (U3).
      const existing = created?.model ?? model
      await client.sendMessage(
        sessionId,
        text,
        existing === model ? undefined : { model: { id: model } },
      )
    } catch (caught) {
      setSending(false)
      setSendError(describeError(caught, { serverUrl }))
      return false
    }

    // The message this request stored is the one that named the session (the server derives a
    // title from the first `user.message`, #35). The row in the sidebar was added by the
    // create, before that name existed, and the chat is about to open already knowing it — so
    // the one re-read the store makes for this session is asked for here, and the list and the
    // header change together (lib/session-refresh).
    sessionRefresh(client).refresh(sessionId)

    setSending(false)
    navigate(chatHash(sessionId))
    return true
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p role="status" className="text-sm text-muted-foreground">
          Loading your default model…
        </p>
      </div>
    )
  }

  // No default and no session created yet: nothing to run. The one screen of #91 that
  // survives is this state — and it is a state, not a picker.
  if (defaultModel === null && created === null && error === null) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md space-y-2 text-center">
          <h1 className="text-base font-medium">New chat</h1>
          <p className="text-sm font-medium">Add a provider key to start</p>
          <p className="text-sm text-muted-foreground">
            A chat runs on a model from a provider you have a key for. Saving the first key also
            picks a default model for you.
          </p>
          <a className="text-sm underline underline-offset-2" href={settingsHash()}>
            Settings → Model providers
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <div className="space-y-1 text-center">
          <h1 className="text-base font-medium">New chat</h1>
          <p className="text-sm text-muted-foreground">
            Start typing — the chat is created with your first message, on the model below.
          </p>
        </div>
      </div>

      <div className="border-t px-4 py-3">
        <div className="mx-auto w-full max-w-3xl space-y-2">
          {error === null ? null : (
            <ErrorBanner
              title="Could not load your default model"
              message={error}
              onDismiss={dismissError}
            />
          )}
          {catalog.error === null ? null : (
            <ErrorBanner
              title="Could not load models"
              message={catalog.error}
              onDismiss={catalog.dismissError}
            />
          )}
          {sendError === null ? null : (
            <ErrorBanner
              title="Could not start the chat"
              message={sendError}
              onDismiss={() => setSendError(null)}
            />
          )}
          <Composer
            running={false}
            onSend={send}
            onStop={undefined}
            inputRef={inputRef}
            disabled={sending}
            modelSelector={
              <ModelPicker
                variant="compact"
                placement="above"
                models={catalog.models}
                providers={catalog.providers}
                value={model}
                onChange={setChosen}
                refreshing={catalog.refreshing}
                onRefresh={catalog.refresh}
              />
            }
          />
        </div>
      </div>
    </div>
  )
}
