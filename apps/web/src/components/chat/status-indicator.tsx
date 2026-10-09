import type { SessionStatus } from '@openharness/protocol'

import { cn } from '../../lib/utils'

/**
 * Whether the agent is working.
 *
 * `running` comes from the session's own status events (via the transcript), and a session
 * that is retrying counts as running — it is just a kind of running worth naming.
 */
export function StatusIndicator({
  status,
  retrying = false,
}: {
  status: SessionStatus
  retrying?: boolean
}) {
  const running = status === 'running'
  const label = running ? (retrying ? 'Retrying' : 'Running') : 'Idle'

  return (
    <span
      role="status"
      aria-label={`Status: ${label}`}
      className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
    >
      <span
        aria-hidden="true"
        className={cn(
          // Coral, the palette's "something is happening" colour (U12, #227) — it was a green
          // dot, which was the only colour in the app the violet/coral palette had no home for.
          'size-2 rounded-full',
          running ? 'animate-pulse bg-coral' : 'bg-muted-foreground/40',
        )}
      />
      {label}
    </span>
  )
}
