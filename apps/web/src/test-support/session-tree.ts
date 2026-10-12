import type { FakeClient } from '@openharness/client/testing'
import type { ListSessionsResponse, Session } from '@openharness/protocol'

/**
 * The children a test says a chat has, for the sidebar's nesting (epic #340, S1/S3; issue #346).
 *
 * The fake client lists **every** session whatever filter it is given: it starts no child
 * sessions of its own (#344), so `GET /v1/sessions?parent_session_id=` is not part of its world
 * and it answers the whole list instead. The real server answers one session's children — a child
 * is a real session with a parent (`Session.parent_session_id`) and is never listed as a chat —
 * and the web app's sidebar reads exactly that, so a fake that answered the whole list would nest
 * every chat under every chat.
 *
 * {@link honourSessionTree} makes the fake behave like the server for that one query, and
 * {@link seedChildSession} is how a test says which children a chat has. Both are test-support
 * rather than a change to `@openharness/client`: the fake's gap is the client package's (the
 * background-task work is #345's), and this app's tests are not the place to close it.
 */

/** The children a fake has been told a chat has, keyed by the parent's id. */
const TREES = new WeakMap<FakeClient, Map<string, Session[]>>()

/** Fakes whose list endpoint has already been wrapped, so a second call is not a second layer. */
const WRAPPED = new WeakSet<FakeClient>()

/**
 * Teach a fake to answer `?parent_session_id=` the way the server does.
 *
 * Every read that names a parent answers that chat's seeded children — nothing at all for a chat
 * no test has given any — and every other query goes to the fake untouched. Idempotent: wrapping a
 * fake twice would answer the same thing twice over and is simply not done.
 */
export function honourSessionTree(fake: FakeClient): FakeClient {
  if (WRAPPED.has(fake)) {
    return fake
  }
  WRAPPED.add(fake)
  const list = fake.sessions.list.bind(fake.sessions)
  fake.sessions.list = async (params, options): Promise<ListSessionsResponse> => {
    const parentId = params?.parent_session_id
    if (parentId === undefined) {
      return list(params, options)
    }
    // One page, no cursor: a test's tree is a handful of sessions, and `listChildren` stops on a
    // `null` `next_page`. The children come back as the fake holds them, which is a live view of
    // each session's status — what the sidebar's running dot reads.
    return { data: TREES.get(fake)?.get(parentId) ?? [], next_page: null }
  }
  return fake
}

/**
 * Give a chat the children a test wants the sidebar to nest.
 *
 * The child is a `Session` the caller builds (`makeChildSession(parent)`) and seeds itself, so a
 * test states its title, model and status rather than inheriting whatever a helper decided.
 */
export function seedChildSession(fake: FakeClient, parentId: string, child: Session): void {
  const tree = TREES.get(fake) ?? new Map<string, Session[]>()
  TREES.set(fake, tree)
  tree.set(parentId, [...(tree.get(parentId) ?? []), child])
}
