import type { Session } from '@openharness/protocol'
import { Bot, Plus, Settings } from 'lucide-react'

import { relativeTime, sessionLabel } from '../lib/format'
import { chatHash } from '../lib/router'
import { cn } from '../lib/utils'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

const NAV_LINK_CLASS =
  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground'

/**
 * The session list, newest first, and the way to everything else.
 *
 * Sessions are ordinary links to `#/s/<id>`: the browser's Back button, middle-click and
 * "copy link" all work, and a reload lands on the same chat.
 */
export function Sidebar({
  sessions,
  loading,
  error,
  activeSessionId,
  fakeClient = false,
}: {
  sessions: readonly Session[]
  loading: boolean
  error: string | null
  /** The open session, highlighted in the list. */
  activeSessionId: string | undefined
  /** Show that this run is on the fake client rather than a server. */
  fakeClient?: boolean
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-muted/20">
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <a href="#/" className="rounded-sm text-sm font-semibold outline-none">
          openharness
        </a>
        {fakeClient ? (
          <Badge variant="outline" className="text-[0.65rem] text-muted-foreground">
            fake client
          </Badge>
        ) : null}
      </div>

      <div className="px-3 pb-3">
        <Button asChild variant="outline" size="sm" className="w-full justify-start">
          <a href="#/new">
            <Plus aria-hidden="true" />
            New chat
          </a>
        </Button>
      </div>

      <nav aria-label="Chats" className="min-h-0 flex-1 overflow-y-auto px-2">
        {error === null ? null : (
          <p role="alert" className="px-2 py-1 text-xs text-destructive">
            {error}
          </p>
        )}
        {loading ? <p className="px-2 py-1 text-xs text-muted-foreground">Loading…</p> : null}
        {!loading && sessions.length === 0 && error === null ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">No chats yet.</p>
        ) : null}

        <ul className="flex flex-col gap-0.5 pb-2">
          {sessions.map((session) => {
            const active = session.id === activeSessionId
            return (
              <li key={session.id}>
                <a
                  href={chatHash(session.id)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex flex-col gap-0.5 rounded-md px-2 py-1.5',
                    active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                  )}
                >
                  <span className="truncate text-sm">{sessionLabel(session)}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {session.agent.model.id} · {relativeTime(session.created_at)}
                  </span>
                </a>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="flex flex-col gap-0.5 border-t p-2">
        <a href="#/agents" className={NAV_LINK_CLASS}>
          <Bot aria-hidden="true" className="size-4" />
          Agents
        </a>
        <a href="#/settings" className={NAV_LINK_CLASS}>
          <Settings aria-hidden="true" className="size-4" />
          Settings
        </a>
      </div>
    </aside>
  )
}
