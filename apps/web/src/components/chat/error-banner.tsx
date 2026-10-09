import { CircleAlert, X } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '../ui/button'

/**
 * An error, inline above the composer.
 *
 * Two kinds end up here: a `session.error` from the log — the agent's turn failed, and the
 * transcript keeps it visible until a reply supersedes it — and a failed request of our own
 * (the send, the interrupt, the history load). Both are worth showing without hiding the
 * conversation behind a dialog.
 *
 * Some failures come with the one thing to do about them — a provider with no key is fixed in
 * Settings, a stale session by signing in again — and that goes in {@link action}, under the
 * message, rather than in the words.
 */
export function ErrorBanner({
  title,
  message,
  action,
  onDismiss,
}: {
  /** A short label: the error type, or what the app was doing. */
  title: string
  /** The server's message, or ours. */
  message: string
  /** What the reader can do about it, when there is a specific thing. */
  action?: ReactNode | undefined
  /** When given, the banner can be closed. */
  onDismiss?: (() => void) | undefined
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p className="break-words text-destructive/90">{message}</p>
        {action === undefined ? null : <div className="mt-1">{action}</div>}
      </div>
      {onDismiss === undefined ? null : (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss error"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onDismiss}
        >
          <X aria-hidden="true" />
        </Button>
      )}
    </div>
  )
}
