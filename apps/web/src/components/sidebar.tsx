import type { Session, User } from '@openharness/protocol'
import { LogOut, MoreHorizontal, Plus, Settings } from 'lucide-react'
import { useEffect, useRef, useState, type Ref } from 'react'

import type { DeleteSessionResult } from '../hooks/use-sessions'
import { relativeTime, sessionLabel } from '../lib/format'
import type { ModelNameLookup } from '../lib/models'
import { MAX_PAGE_ITEMS } from '../lib/paging'
import { chatHash } from '../lib/router'
import { cn } from '../lib/utils'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

const NAV_LINK_CLASS =
  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground'

/** The drawer panel's id, so the menu button can point at it with `aria-controls`. */
export const SIDEBAR_ID = 'app-sidebar'

/**
 * The session list, newest first, and the way to everything else.
 *
 * Sessions are ordinary links to `#/s/<id>`: the browser's Back button, middle-click and
 * "copy link" all work, and a reload lands on the same chat.
 *
 * One element serves both layouts, and the `max-md:` variants are what switch it: from `md`
 * up it is the static 256px column it has always been, and below `md` — where 256px of a
 * 390px screen leaves the chat unreadable — it becomes an overlay drawer that the app shell
 * opens from its top bar and overlays with a backdrop. Both are the same list, the same
 * links; only the positioning differs, which is why a chat opened from either one is the
 * same chat.
 *
 * Since epic #116 (U5) each row also carries a kebab menu with **Delete chat**: the kebab
 * shows on hover or focus (it stays in the DOM and reachable by keyboard either way), and
 * the delete itself asks in the page — a `window.confirm` would block and cannot be themed.
 * Deleting the open chat is the shell's call, not this list's: it navigates to New chat.
 */
export function Sidebar({
  sessions,
  loading,
  error,
  truncated,
  activeSessionId,
  user,
  onSignOut,
  fakeClient = false,
  open = false,
  onNavigate,
  panelRef,
  nameOf,
  onDelete,
}: {
  sessions: readonly Session[]
  loading: boolean
  error: string | null
  /** The list hit the safety cap: the server has more sessions than are listed. */
  truncated: boolean
  /** The open session, highlighted in the list. */
  activeSessionId: string | undefined
  /** Who the app is signed in as — shown at the foot, with the way out. */
  user: User | null
  /** Sign out; the shell revokes the session and shows the sign-in page. */
  onSignOut: (() => void) | undefined
  /** Show that this run is on the fake client rather than a server. */
  fakeClient?: boolean
  /** Shown as the overlay drawer below `md`; ignored from `md` up, where it is always visible. */
  open?: boolean
  /** A link in here was followed; the shell closes the drawer. */
  onNavigate?: (() => void) | undefined
  /** The panel itself, so the shell can move focus into it when the drawer opens. */
  panelRef?: Ref<HTMLElement> | undefined
  /**
   * The catalog lookup a row's label uses for a session with no title yet: the model's
   * display name, or the id when the catalog does not know it (#91). Omitted, ids show.
   */
  nameOf?: ModelNameLookup | undefined
  /**
   * Delete a session, after the in-page confirmation. Omitted, the rows have no delete
   * action (the sidebar tests render the list on its own).
   */
  onDelete?: ((sessionId: string) => Promise<DeleteSessionResult>) | undefined
}) {
  // Which row's kebab menu is open, which row is confirming, and which delete is in flight.
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // A menu closes the way any overlay does: a pointer outside it, or Escape.
  useEffect(() => {
    if (menuFor === null) {
      return
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        setMenuFor(null)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenuFor(null)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuFor])

  const confirmDelete = async (sessionId: string): Promise<void> => {
    if (onDelete === undefined) {
      return
    }
    setDeleting(sessionId)
    setDeleteError(null)
    const result = await onDelete(sessionId)
    setDeleting(null)
    if (result.ok) {
      setConfirming(null)
      return
    }
    // The row stays, with what went wrong next to it.
    setDeleteError({ id: sessionId, message: result.message })
  }

  return (
    <aside
      ref={panelRef}
      id={SIDEBAR_ID}
      tabIndex={-1}
      aria-label="Navigation"
      className={cn(
        'flex w-64 shrink-0 flex-col border-r bg-muted/20 outline-none',
        // Below `md`: out of the flex row, over the content, and only while it is open.
        'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:shadow-xl',
        open ? 'max-md:flex' : 'max-md:hidden',
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <a href="#/" className="rounded-sm text-sm font-semibold outline-none" onClick={onNavigate}>
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
          <a href="#/new" onClick={onNavigate}>
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
              <li key={session.id} className="group relative">
                {confirming === session.id && onDelete !== undefined ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5">
                    <p className="text-xs">Delete this chat?</p>
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={deleting !== null}
                        onClick={() => void confirmDelete(session.id)}
                      >
                        {deleting === session.id ? 'Deleting…' : 'Delete'}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={deleting !== null}
                        onClick={() => {
                          setConfirming(null)
                          setDeleteError(null)
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <a
                      href={chatHash(session.id)}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2 py-1.5',
                        active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                      )}
                    >
                      <span className="truncate text-sm">{sessionLabel(session, nameOf)}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {session.model.id} · {relativeTime(session.created_at)}
                      </span>
                    </a>
                    {onDelete === undefined ? null : (
                      <div
                        ref={menuFor === session.id ? menuRef : undefined}
                        className="relative shrink-0"
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Chat actions"
                          aria-haspopup="menu"
                          aria-expanded={menuFor === session.id}
                          // On hover or focus: the action is there when the row is, and a
                          // keyboard user tabs straight into it.
                          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => {
                            setMenuFor((current) => (current === session.id ? null : session.id))
                            setDeleteError(null)
                          }}
                        >
                          <MoreHorizontal aria-hidden="true" />
                        </Button>
                        {menuFor === session.id ? (
                          <div
                            role="menu"
                            aria-label="Chat actions"
                            className="absolute right-0 z-20 mt-1 w-40 rounded-md border bg-popover p-1 shadow-md"
                          >
                            <Button
                              type="button"
                              role="menuitem"
                              variant="ghost"
                              size="sm"
                              className="w-full justify-start text-destructive"
                              onClick={() => {
                                setMenuFor(null)
                                setConfirming(session.id)
                                setDeleteError(null)
                              }}
                            >
                              Delete chat
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                )}
                {deleteError !== null && deleteError.id === session.id ? (
                  <p role="alert" className="px-2 py-1 text-xs text-destructive">
                    {deleteError.message}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>

        {truncated ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            and more… only the first {MAX_PAGE_ITEMS} are listed
          </p>
        ) : null}
      </nav>

      <div className="flex flex-col gap-0.5 border-t p-2">
        <a href="#/settings" className={NAV_LINK_CLASS} onClick={onNavigate}>
          <Settings aria-hidden="true" className="size-4" />
          Settings
        </a>
      </div>

      {user === null ? null : (
        <div className="flex items-center gap-2 border-t p-2">
          <UserAvatar user={user} />
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            title={user.email}
          >
            {user.email}
          </span>
          {onSignOut === undefined ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 text-muted-foreground"
              aria-label="Sign out"
              onClick={onSignOut}
            >
              <LogOut aria-hidden="true" />
              Sign out
            </Button>
          )}
        </div>
      )}
    </aside>
  )
}

/**
 * The signed-in user's picture, or a stand-in.
 *
 * The identity is the email (epic #65, A3), which the row shows as text; the avatar is only
 * decoration, and a provider that gave no picture gets the first letter instead of an empty
 * circle.
 */
function UserAvatar({ user }: { user: User }) {
  const initial = (user.name ?? user.email).trim().slice(0, 1).toUpperCase()
  return user.image === undefined ? (
    <span
      aria-hidden="true"
      data-slot="user-avatar"
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium"
    >
      {initial}
    </span>
  ) : (
    <img
      aria-hidden="true"
      data-slot="user-avatar"
      src={user.image}
      alt=""
      className="size-7 shrink-0 rounded-full"
    />
  )
}
