import { SESSION_TITLE_MAX_LENGTH } from './resources/session'

/**
 * Naming a session after something said in it.
 *
 * A title is a **label**, never a summary, and deriving one is deliberately dumb: the first
 * non-empty line, whitespace collapsed, cut to fit `SESSION_TITLE_MAX_LENGTH`. Something
 * smarter (a model, a keyword extractor) would name sessions better and is not the point —
 * this has to be instant, free, offline and the same every time, because a list that renames
 * itself under its reader is worse than one that shows a truncated first line.
 *
 * It lives here rather than in the server because **two packages need it and neither is the
 * other's host** (epic #340): the server derives a title from the first `user.message` a chat
 * is sent (`apps/server/src/titles.ts`), and the brain derives one from
 * the `description` a parent model gave in its `agent` tool call (#344) — a child session is
 * created by the brain through the store, so the server's route-level auto-titling never sees
 * it. Two copies of "the first line, collapsed, truncated" would be two answers to what a title
 * is, and a title that fits one limit but not the other is a write the log refuses.
 *
 * Nothing here is the wire: no schema imported a shape from this file, and a frontend is free
 * to ignore it (the web app and `oh` read the title the server stored, they never derive one).
 */

/** What a title that had to be cut ends with. Part of the length, not extra. */
const ELLIPSIS = '…'

/** Half a code point, at the end of a string: a cut that must not land there. */
const HIGH_SURROGATE_END = /[\uD800-\uDBFF]$/

/**
 * The title for a session whose naming text is `text`, or `null` when there is no text to name
 * it after.
 *
 * The first non-empty line wins: a message that opens with `Fix the SSE reload bug` and then
 * explains itself for forty lines is listed under the first line. Whitespace inside that line
 * is collapsed to single spaces and the ends are trimmed, so a title is one clean line whatever
 * the input looked like. A line longer than {@link SESSION_TITLE_MAX_LENGTH} is cut to fit, the
 * ellipsis included; the cut never lands in the middle of a surrogate pair.
 *
 * @param text what names the session: a first message's text, or a task's description
 */
export function deriveSessionTitle(text: string): string | null {
  const line = text.split(/\r\n|\r|\n/).find((candidate) => candidate.trim() !== '')
  if (line === undefined) {
    return null
  }
  return truncateTitle(line.trim().replace(/\s+/gu, ' '))
}

/**
 * Cut a title to the protocol's limit.
 *
 * The ellipsis takes the place of the last character rather than extending the string, so the
 * result is at most `SESSION_TITLE_MAX_LENGTH` — a title the log can always store.
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
