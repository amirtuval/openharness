import { SESSION_TITLE_MAX_LENGTH } from '@openharness/protocol'

/**
 * The server's session-naming rule, in the fake.
 *
 * The real rule lives in `apps/server/src/titles.ts` and is applied by the request that stores
 * a session's first `user.message`: the first non-empty line, whitespace collapsed, cut to the
 * protocol's maximum with an ellipsis. The fake cannot import the server, and a fake that does
 * not derive titles at all makes every title test in the frontends test nothing — the web app
 * carried a test-support reimplementation of this rule for exactly that reason (#105). So the
 * rule is restated here, for the fake, once.
 *
 * What a test against the fake must be able to rely on is the *shape* of the behaviour — a
 * title appears, derived from the first message, and never changes afterwards — not the exact
 * cut of a 200-character line; `apps/server/src/titles.test.ts` owns the character-level rule.
 */

/** What a title that had to be cut ends with. Part of the length, not extra. */
const ELLIPSIS = '…'

/** Half a code point, at the end of a string: a cut that must not land there. */
const HIGH_SURROGATE_END = /[\uD800-\uDBFF]$/

/** The title a first message suggests, or `null` when it has no text to name it after. */
export function deriveFakeSessionTitle(text: string): string | null {
  const line = text.split(/\r\n|\r|\n/).find((candidate) => candidate.trim() !== '')
  if (line === undefined) {
    return null
  }
  const collapsed = line.trim().replace(/\s+/gu, ' ')
  if (collapsed.length <= SESSION_TITLE_MAX_LENGTH) {
    return collapsed
  }
  const kept = collapsed.slice(0, SESSION_TITLE_MAX_LENGTH - 1)
  return (HIGH_SURROGATE_END.test(kept) ? kept.slice(0, -1) : kept) + ELLIPSIS
}
