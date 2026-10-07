import type { Session, User } from '@openharness/protocol'
import {
  ChevronsUpDown,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Settings,
  Trash2,
} from 'lucide-react'
import { useMemo, useState, type Ref } from 'react'

import type { DeleteSessionResult } from '../hooks/use-sessions'
import { relativeTime, sessionLabel } from '../lib/format'
import type { ModelNameLookup } from '../lib/models'
import { MAX_PAGE_ITEMS } from '../lib/paging'
import { chatHash, settingsHash } from '../lib/router'
import { groupSessionsByDate } from '../lib/session-groups'
import { cn } from '../lib/utils'
import { ThemeMenuItems } from './theme-menu'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Skeleton } from './ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** The drawer panel's id, so the menu button can point at it with `aria-controls`. */
export const SIDEBAR_ID = 'app-sidebar'

/**
 * The session list, newest first, and the way to everything else.
 *
 * Sessions are ordinary links to `#/s/<id>`: the browser's Back button, middle-click and
 * "copy link" all work, and a reload lands on the same chat.
 *
 * One element serves both layouts, and the `max-md:` variants are what switch it: from `md`
 * up it is the 256px column it has always been, and below `md` — where 256px of a 390px screen
 * leaves the chat unreadable — it becomes an overlay drawer that the app shell opens from its
 * top bar and overlays with a backdrop. Both are the same list, the same links; only the
 * positioning differs, which is why a chat opened from either one is the same chat. The column
 * itself can also be put away from `md` up (`onToggleCollapsed`), which is a different thing
 * from the drawer: the drawer is how a phone reaches the list, the collapse is how a wide
 * screen gives the chat the whole width.
 *
 * What U10 changed here, and why:
 *
 * - **The list is grouped by date** ({@link groupSessionsByDate}) — Today, Yesterday, Previous
 *   7 days, Older. Forty chats in one flat column is a scroll, not a list.
 * - **The open chat is marked**, not merely tinted: `aria-current="page"` plus a bar at the
 *   row's leading edge, so "where am I" survives a colour-blind reader and a glance.
 * - **The row's menu is a real menu.** It used to be a hand-rolled `role="menu"`; it is
 *   {@link DropdownMenu} now, which brings the arrow keys, the roving focus, type-ahead and
 *   Escape, and it is portalled so the scrolling list cannot clip it.
 * - **The foot is one account menu** — Settings, the theme quick switch (as a submenu) and Sign
 *   out, behind the signed-in email. It used to be a link, an icon button and a text button
 *   sharing the corner, three of the four of which were the same person's.
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
  collapsed = false,
  onToggleCollapsed,
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
  /** Put the desktop column away. Ignored below `md`, where the drawer is the rule. */
  collapsed?: boolean
  /** When given, the header carries the collapse control. */
  onToggleCollapsed?: (() => void) | undefined
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
  // Which row is confirming a delete and which delete is in flight.
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null)

  // One moment for the whole list: every row is judged against the same "today", so two rows
  // either side of midnight cannot land in different buckets in the same render.
  const groups = useMemo(() => groupSessionsByDate(sessions, Date.now()), [sessions])

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
        // Below `md`: out of the flex row, over the content, and only while it is open. The
        // panel is opaque there — `bg-muted/20` is a tint that only works against the page it
        // sits on, and as a drawer it sits on the *chat*, which read through it.
        'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:bg-background max-md:shadow-panel',
        open ? 'max-md:flex' : 'max-md:hidden',
        // Put away from `md` up. The drawer rules above are `max-md:`-scoped, so on a phone the
        // panel is still there when the shell says it is open.
        collapsed && 'md:hidden',
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <a href="#/" className="rounded-sm text-sm font-semibold outline-none" onClick={onNavigate}>
          openharness
        </a>
        <div className="flex shrink-0 items-center gap-1">
          {fakeClient ? (
            <Badge variant="outline" className="text-2xs text-muted-foreground">
              fake client
            </Badge>
          ) : null}
          {onToggleCollapsed === undefined ? null : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Hide sidebar"
                  className="text-muted-foreground"
                  onClick={onToggleCollapsed}
                >
                  <PanelLeftClose aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Hide the sidebar</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="px-3 pb-3">
        <Button asChild variant="outline" size="sm" className="w-full justify-start">
          <a href="#/new" onClick={onNavigate}>
            <Plus aria-hidden="true" />
            New chat
          </a>
        </Button>
      </div>

      <nav aria-label="Chats" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {error === null ? null : (
          <p role="alert" className="px-2 py-1 text-xs text-destructive">
            {error}
          </p>
        )}
        {loading && sessions.length === 0 && error === null ? <SessionListSkeleton /> : null}
        {!loading && sessions.length === 0 && error === null ? <EmptyChatList /> : null}

        {groups.map((group) => (
          <div key={group.label} role="group" aria-labelledby={`chats-${group.label}`}>
            <h2
              id={`chats-${group.label}`}
              className="px-2 pt-3 pb-1 text-2xs font-medium text-muted-foreground"
            >
              {group.label}
            </h2>
            <ul className="flex flex-col gap-0.5">
              {group.sessions.map((session) => {
                const active = session.id === activeSessionId
                return (
                  <li key={session.id} className="group/row relative">
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
                      <>
                        {active ? (
                          // The leading bar is the "you are here" that survives a screenshot, a
                          // colour-blind reader and `prefers-contrast` — the tint alone is none
                          // of those things.
                          <span
                            aria-hidden="true"
                            data-slot="active-marker"
                            className="absolute top-1/2 left-0 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary"
                          />
                        ) : null}
                        <a
                          href={chatHash(session.id)}
                          onClick={onNavigate}
                          aria-current={active ? 'page' : undefined}
                          className={cn(
                            'flex min-w-0 flex-col gap-0.5 rounded-md py-1.5 pr-8 pl-2',
                            active
                              ? 'bg-accent font-medium text-accent-foreground'
                              : 'hover:bg-accent/60',
                          )}
                        >
                          <span className="truncate text-sm">{sessionLabel(session, nameOf)}</span>
                          <span className="truncate text-2xs text-muted-foreground">
                            {session.model.id} · {relativeTime(session.created_at)}
                          </span>
                        </a>
                        {onDelete === undefined ? null : (
                          <RowMenu
                            onDelete={() => {
                              setConfirming(session.id)
                              setDeleteError(null)
                            }}
                          />
                        )}
                      </>
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
          </div>
        ))}

        {truncated ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            and more… only the first {MAX_PAGE_ITEMS} are listed
          </p>
        ) : null}
      </nav>

      {user === null ? null : (
        <div className="border-t p-2">
          <AccountMenu user={user} onSignOut={onSignOut} onNavigate={onNavigate} />
        </div>
      )}
    </aside>
  )
}

/**
 * One row's actions (epic #116, U5; #211).
 *
 * Its own component because a menu is stateful and a list is not: the open menu is Radix's
 * business now, so the list keeps no "which kebab is open" state of its own.
 *
 * Delete is the only entry today — **Rename** is the next one the epic asks for, and it is
 * deliberately absent rather than inert: the sessions API has no rename, so a disabled row
 * would be a promise the backend cannot keep yet.
 */
function RowMenu({ onDelete }: { onDelete: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Chat actions"
          // On hover or focus: the action is there when the row is, and a keyboard user tabs
          // straight into it. `data-[state=open]` keeps it visible while its own menu is up.
          className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem className="text-destructive" onSelect={onDelete}>
          <Trash2 aria-hidden="true" />
          Delete chat
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The signed-in person, and everything that is about them (U10).
 *
 * Settings, the theme and signing out were three controls in the same corner, each of which
 * was really "things I can do as me". They are one menu behind the email now, which is also
 * what frees the row above it for the chat list.
 */
function AccountMenu({
  user,
  onSignOut,
  onNavigate,
}: {
  user: User
  onSignOut: (() => void) | undefined
  onNavigate: (() => void) | undefined
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          // A stable name for the trigger, because the visible email is not one: it changes with
          // the account, and a test or a QA pass should not have to know it to open the menu.
          aria-label="Account menu"
          className="h-auto w-full justify-start gap-2 px-2 py-1.5 font-normal"
        >
          <UserAvatar user={user} />
          <span className="min-w-0 flex-1 truncate text-start text-xs text-muted-foreground">
            {user.email}
          </span>
          <ChevronsUpDown aria-hidden="true" className="shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        {/* No email row: the trigger this menu hangs off is the email, a few pixels above. */}
        <DropdownMenuItem asChild>
          <a href={settingsHash()} onClick={onNavigate}>
            <Settings aria-hidden="true" className="text-muted-foreground" />
            Settings
          </a>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="text-muted-foreground">Theme</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <ThemeMenuItems />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {onSignOut === undefined ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onSignOut}>
              <LogOut aria-hidden="true" className="text-muted-foreground" />
              Sign out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The list before it arrives: four rows in the shape of the rows they will become. */
function SessionListSkeleton() {
  return (
    <div data-slot="session-skeleton" role="status" className="flex flex-col gap-3 px-2 py-1">
      <span className="sr-only">Loading your chats</span>
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex flex-col gap-1.5">
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-2.5 w-1/2" />
        </div>
      ))}
    </div>
  )
}

/** No chats at all, which is a state and not a failure. */
function EmptyChatList() {
  return (
    <div className="flex flex-col gap-0.5 px-2 py-3">
      <p className="text-xs text-muted-foreground">No chats yet.</p>
      <p className="text-xs text-muted-foreground/80">
        New chat starts one with your first message.
      </p>
    </div>
  )
}

/**
 * The signed-in user's picture, or a stand-in.
 *
 * The identity is the email (epic #65, A3), which the menu shows as its first row; the avatar
 * is only decoration, and a provider that gave no picture gets the first letter instead of an
 * empty circle.
 */
function UserAvatar({ user }: { user: User }) {
  const initial = (user.name ?? user.email).trim().slice(0, 1).toUpperCase()
  return user.image === undefined ? (
    <span
      aria-hidden="true"
      data-slot="user-avatar"
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium"
    >
      {initial}
    </span>
  ) : (
    <img
      aria-hidden="true"
      data-slot="user-avatar"
      src={user.image}
      alt=""
      className="size-6 shrink-0 rounded-full"
    />
  )
}
