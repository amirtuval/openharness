import { useEffect, useRef } from 'react'

import { useClient } from '../client-provider'
import { useSession } from '../../hooks/use-session'
import { shortId, sessionLabel } from '../../lib/format'
import { Composer } from './composer'
import { ErrorBanner } from './error-banner'
import { MessageList } from './message-list'
import { StatusIndicator } from './status-indicator'

/**
 * An open session: header, conversation, errors, composer.
 *
 * All of it is `useSession(client, sessionId)` — the hook loads the history, follows the live
 * stream, and owns the transcript; this screen only decides what it looks like.
 */
export function ChatView({ sessionId }: { sessionId: string }) {
  const client = useClient()
  const {
    session,
    messages,
    status,
    lastError,
    loadingHistory,
    requestError,
    send,
    interrupt,
    dismissError,
  } = useSession(client, sessionId)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // A chat opens with the cursor in the box: whether it was picked from the sidebar or just
  // created on the new-chat screen, the next thing the user does is type.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-medium">
            {session === null ? shortId(sessionId) : sessionLabel(session)}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {session === null ? 'Loading…' : `${session.agent.name} · ${session.agent.model.id}`}
          </p>
        </div>
        <StatusIndicator status={status} retrying={lastError?.retryStatus === 'retrying'} />
      </header>

      <MessageList messages={messages} loading={loadingHistory} />

      <div className="border-t px-4 py-3">
        <div className="mx-auto w-full max-w-3xl space-y-2">
          {lastError === null ? null : (
            <ErrorBanner
              title={
                lastError.retryStatus === 'retrying'
                  ? `${lastError.type} · retrying`
                  : lastError.type
              }
              message={lastError.message}
            />
          )}
          {requestError === null ? null : (
            <ErrorBanner title="Request failed" message={requestError} onDismiss={dismissError} />
          )}
          <Composer
            running={status === 'running'}
            onSend={send}
            onStop={interrupt}
            inputRef={inputRef}
          />
        </div>
      </div>
    </div>
  )
}
