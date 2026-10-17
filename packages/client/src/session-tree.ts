import { MAX_PAGE_LIMIT } from '@openharness/protocol'
import type {
  ListSessionsQuery,
  ListSessionsResponse,
  Session,
  SessionId,
} from '@openharness/protocol'

import type { RequestOptions } from './client'

/**
 * The session tree, as a frontend walks it (epic #340, S1/S3; issue #345).
 *
 * A subagent is a real session with a parent (S3), so the two things a chat UI needs — the
 * children to nest under a parent in the sidebar, and the breadcrumb from a child back to the
 * top-level chat it hangs off — are ordinary session reads with one rule each: children come
 * from `?parent_session_id=`, and the chain to the root is `parent_session_id` followed until
 * it is `null`. Both live here rather than in each frontend so the web app and `oh` nest and
 * breadcrumb the same tree.
 *
 * The fields the tree is made of are read-only and the server's own to write (S1/S3): a child
 * is created by the server when a task starts, and nothing here can place a session in
 * somebody's tree.
 */

/**
 * The part of a client the tree helpers use.
 *
 * `client.sessions` satisfies it, and so does a double in a test — two reads and nothing else,
 * which is why this is a narrower interface than {@link SessionsResource}.
 */
export interface SessionTreeSource {
  /** Read one session, for the parent a child names. */
  get(sessionId: string, options?: RequestOptions): Promise<Session>
  /** Read one page of sessions, filtered by `parent_session_id` for a child list. */
  list(params?: ListSessionsQuery, options?: RequestOptions): Promise<ListSessionsResponse>
}

/**
 * The children of a session, newest first — the whole list, not its first page.
 *
 * `GET /v1/sessions?parent_session_id=` answers one page at a time, so this walks the cursor
 * the way the events list does — the cursor is opaque and handed back byte for byte — and
 * stops on a cursor the server has already given (a server that repeats itself would otherwise
 * page for ever).
 *
 * An empty array means the session has no children: the nested sidebar has nothing to hang
 * under it, and the card list is the whole of what a task started.
 *
 * @param sessions the client's sessions resource, or a double
 * @param sessionId the parent's `sesn_` id
 * @param options request options (cancellation)
 */
export async function listChildren(
  sessions: SessionTreeSource,
  sessionId: SessionId,
  options?: RequestOptions,
): Promise<readonly Session[]> {
  const children: Session[] = []
  const requested = new Set<string>()
  let page: string | undefined
  for (;;) {
    const response = await sessions.list(
      {
        parent_session_id: sessionId,
        limit: MAX_PAGE_LIMIT,
        ...(page === undefined ? {} : { page }),
      },
      options,
    )
    const next = response.next_page
    if (next !== null && requested.has(next)) {
      // The server handed back a cursor it has already given: the page would repeat one
      // already read, so the walk ends here rather than adding the same children twice. The
      // rule the events walk follows.
      return children
    }
    children.push(...response.data)
    if (next === null) {
      return children
    }
    requested.add(next)
    page = next
  }
}

/**
 * The chain from a session up to the top-level chat it hangs off, **root first**.
 *
 * The breadcrumb a child's own screen draws ("back to the parent", and each step above it):
 * the array opens with the root — the chat a reader started — and ends with the session
 * itself, so a frontend renders it in order and links every step but the last.
 *
 * The session is passed in rather than read, because the caller has it: a frontend that opened
 * a child holds the read it opened it with. Each step above is one `GET`, and the walk stops
 * when a session has no parent — or when it meets one it has already seen, because a server
 * that answered a cycle would otherwise loop for ever, and a breadcrumb is not worth a hang.
 *
 * @param sessions the client's sessions resource, or a double
 * @param session the session to walk up from
 * @param options request options (cancellation)
 */
export async function sessionBreadcrumb(
  sessions: SessionTreeSource,
  session: Session,
  options?: RequestOptions,
): Promise<readonly Session[]> {
  const chain: Session[] = [session]
  const seen = new Set([session.id])
  let current = session
  while (current.parent_session_id !== null) {
    const parentId = current.parent_session_id
    if (seen.has(parentId)) {
      break
    }
    const parent = await sessions.get(parentId, options)
    seen.add(parent.id)
    chain.push(parent)
    current = parent
  }
  return chain.reverse()
}
