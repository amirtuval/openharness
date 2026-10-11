import { WEB_SEARCH_TOOL_NAME } from '@openharness/hands'
import type { UserId } from '@openharness/protocol'
import { systemClock } from '@openharness/session'
import type { Clock, SessionStore } from '@openharness/session'

import { DEFAULT_TIME_ZONE, localDayOf, utcWindowOf } from './local-day'

/**
 * The operator's daily search allowance, read from the log (epic #303, #305).
 *
 * `web_search` is served by **one operator key**, so the deployment pays for every search a
 * user makes and each user has a daily cap. The count behind the cap is a fact about the log,
 * not a number kept beside it: a search is an `agent.tool_use` named `web_search` that its
 * `agent.tool_result` answered without an error, and `SessionStore.listToolUses` is the read
 * that counts them for one owner and one window (#247's pattern, one level up). Nothing is
 * stored, so nothing can drift, and two instances count the same searches.
 *
 * **The day is UTC**, and that is a deliberate limitation rather than an oversight: the usage
 * *route* takes the reader's zone as a query parameter (#247), while a cap is enforced in a
 * turn where no request named one, and a user's zone is not stored anywhere. UTC is the same
 * default the usage route answers with when a caller names no zone (`DEFAULT_TIME_ZONE`), so a
 * reader who never passes a `tz` sees exactly the day the cap is counting.
 */

/** How many searches one user may make per day, and how many they have left. */
export interface SearchAllowance {
  /**
   * How many searches the user has left today; `0` once the day's allowance is used up.
   *
   * A count rather than a boolean because it is what a caller renders ("3 left today") and
   * because the boundary — the search that takes the last one, and the one refused after it —
   * is what a test wants to state.
   */
  remaining(ownerId: UserId): Promise<number>
}

/** What {@link createSearchAllowance} needs. */
export interface SearchAllowanceOptions {
  /** The durable log the searches are counted in. */
  readonly store: SessionStore
  /** How many searches one user gets per day (`OPENHARNESS_SEARCH_DAILY_LIMIT`). */
  readonly dailyLimit: number
  /** The instant "today" is read from; the process clock when absent, for a test's own. */
  readonly now?: Clock
  /** The zone the day is read in; UTC when absent, and always UTC in production today. */
  readonly timeZone?: string
}

/** Build the allowance the tool wiring asks before it hands a turn the operator's key. */
export function createSearchAllowance(options: SearchAllowanceOptions): SearchAllowance {
  const { store, dailyLimit } = options
  const now = options.now ?? systemClock
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE
  return {
    async remaining(ownerId) {
      if (dailyLimit <= 0) {
        return 0
      }
      const day = localDayOf(new Date(now()), timeZone)
      // One query over the day's UTC window — the same read the per-user usage route makes,
      // narrowed to the one tool and the one day the cap is about.
      const searches = await store.listToolUses({
        ownerId,
        name: WEB_SEARCH_TOOL_NAME,
        ...utcWindowOf({ from: day, to: day, tz: timeZone }),
      })
      return Math.max(0, dailyLimit - searches.length)
    },
  }
}
