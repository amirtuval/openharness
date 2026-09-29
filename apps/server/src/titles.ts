import {
  EVENT_TYPES,
  SESSION_TITLE_MAX_LENGTH,
  type Session,
  type SessionId,
  type UserEventInput,
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
 * Derivation is deliberately dumb, because a title is a label rather than a summary: the first
 * non-empty line of the message, whitespace collapsed, cut to fit the protocol's
 * `SESSION_TITLE_MAX_LENGTH`. Something smarter (a model, a keyword extractor) would name
 * sessions better and is not the point — this has to be instant, free, offline and the same
 * every time, because a list that renames itself under its reader is worse than one that shows
 * a truncated first line.
 */

/** What a title that had to be cut ends with. Part of the length, not extra. */
const ELLIPSIS = '…'

/** Half a code point, at the end of a string: a cut that must not land there. */
const HIGH_SURROGATE_END = /[\uD800-\uDBFF]$/

/**
 * The title for a session whose first user message is `text`, or `null` when the message has
 * no text to name it after.
 *
 * The first non-empty line wins: a message that opens with `Fix the SSE reload bug` and then
 * explains itself for forty lines is listed under the first line. Whitespace inside that line
 * is collapsed to single spaces and the ends are trimmed, so a title is one clean line whatever
 * the message looked like. A line longer than {@link SESSION_TITLE_MAX_LENGTH} is cut to fit,
 * the ellipsis included; the cut never lands in the middle of a surrogate pair.
 *
 * @param text the message's text: its blocks, in order
 */
export function deriveSessionTitle(text: string): string | null {
  const line = text.split(/\r\n|\r|\n/).find((candidate) => candidate.trim() !== '')
  if (line === undefined) {
    return null
  }
  return truncateTitle(line.trim().replace(/\s+/gu, ' '))
}

/**
 * Give a session the title its first message suggests, unless it already has one.
 *
 * Called with the events a request just stored, so a session is named by the same request that
 * started it: `POST …/events` and the `initial_events` of a new session both come through here.
 * A title the caller supplied at creation, and one an earlier message produced, are never
 * written over — this fills a hole, it does not rename.
 *
 * @returns the session as it is now when this named it, or `null` when it changed nothing: no
 *   message in `events`, a message with no text, or a session that already had a title
 */
export async function nameSessionFromFirstMessage(
  store: SessionStore,
  sessionId: SessionId,
  events: readonly UserEventInput[],
): Promise<Session | null> {
  const message = events.find((event) => event.type === EVENT_TYPES.userMessage)
  if (message === undefined) {
    return null
  }
  const title = deriveSessionTitle(message.content.map((block) => block.text).join('\n'))
  if (title === null) {
    return null
  }
  const session = await store.getSession(sessionId)
  if (session === null || session.title !== null) {
    return null
  }
  return store.updateSession(sessionId, { title })
}

/**
 * Cut a title to the protocol's limit.
 *
 * The ellipsis takes the place of the last character rather than extending the string, so the
 * result is at most `SESSION_TITLE_MAX_LENGTH` — a title a client can always store.
 */
function truncateTitle(title: string): string {
  if (title.length <= SESSION_TITLE_MAX_LENGTH) {
    return title
  }
  const kept = title.slice(0, SESSION_TITLE_MAX_LENGTH - 1)
  // A code point can be two UTF-16 units — an emoji, a rare ideograph. Keeping the high
  // surrogate without its low half would put the ellipsis after half a character.
  return (HIGH_SURROGATE_END.test(kept) ? kept.slice(0, -1) : kept) + ELLIPSIS
}
