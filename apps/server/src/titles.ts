import {
  EVENT_TYPES,
  deriveSessionTitle,
  type Session,
  type SessionId,
  type EventInput,
} from '@openharness/protocol'
import type { SessionStore } from '@openharness/session'

/**
 * Naming a session after the first thing said in it.
 *
 * Nothing knows a session's title at creation: the web app opens a chat before there is
 * anything to name it after, and the CLI's `new` does the same, so a list of sessions is a
 * list of identical rows — the agent's name in the sidebar, `(untitled)` in the terminal.
 * The title is derived from the first user message instead, where it is stored, and that is
 * the only thing this module does.
 *
 * The derivation itself is the protocol's (`deriveSessionTitle`), because a **child** session
 * is named by the same rule and not by this module: the brain creates one straight through the
 * store, so no route here ever sees its first message (epic #340; the `agent` tool titles a
 * child from its task's description). One rule, one place — a title that fits one call site's
 * idea of the limit but not the log's is a write the store refuses.
 */

/**
 * Give a session the title its first message suggests, unless it already has one.
 *
 * Called with the events a request just stored, so a session is named by the same request that
 * started it: `POST …/events` and the `initial_events` of a new session both come through here.
 * A title the caller supplied at creation, and one an earlier message produced, are never
 * written over — this fills a hole, it does not rename.
 *
 * The read is owner-scoped with the caller's id — the routes call this only after they have
 * established that the session is the caller's, and the scope is what keeps it that way.
 *
 * @returns the session as it is now when this named it, or `null` when it changed nothing: no
 *   message in `events`, a message with no text, or a session that already had a title
 */
export async function nameSessionFromFirstMessage(
  store: SessionStore,
  sessionId: SessionId,
  events: readonly EventInput[],
  ownerId: string,
): Promise<Session | null> {
  const message = events.find((event) => event.type === EVENT_TYPES.userMessage)
  if (message === undefined) {
    return null
  }
  const title = deriveSessionTitle(message.content.map((block) => block.text).join('\n'))
  if (title === null) {
    return null
  }
  const session = await store.getSession(sessionId, { ownerId })
  if (session === null || session.title !== null) {
    return null
  }
  return store.updateSession(sessionId, { title })
}
