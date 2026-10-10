import type { Session } from '@openharness/protocol'

import { type ModelNameLookup } from './models'

/**
 * A session's label in the sidebar and the chat header: its title, else its model.
 *
 * Since #91 the fallback is the **model's** display name — never the agent's, now that a
 * chat is started from a model (epic #92): the catalog's name when the catalog knows the id
 * (`nameOf`), and the `provider/model` id itself otherwise.
 */
export function sessionLabel(session: Session, nameOf?: ModelNameLookup): string {
  if (session.title !== null && session.title.trim() !== '') {
    return session.title
  }
  return nameOf?.(session.model.id) ?? session.model.id
}

/**
 * A model id as a reader sees it: the catalog's display name, or the id when unknown.
 */
export function modelLabel(modelId: string, nameOf?: ModelNameLookup): string {
  return nameOf?.(modelId) ?? modelId
}

/**
 * A context window in tokens, short: `128K`, `1M`, `512`.
 *
 * The picker shows it as "128K context" next to the model id (issue #91); values that are not
 * whole millions get one decimal (`1048576` → `1.0M`), and anything under a thousand stays
 * itself.
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`
  }
  return `${tokens}`
}

/**
 * A timestamp as "just now", "12m ago", "3h ago", "5d ago", or a date.
 *
 * `now` is a parameter so a test can pin the clock.
 */
export function relativeTime(timestamp: string, now: number = Date.now()): string {
  const then = Date.parse(timestamp)
  if (Number.isNaN(then)) {
    return timestamp
  }
  const seconds = Math.round((now - then) / 1000)
  if (seconds < 45) {
    return 'just now'
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m ago`
  }
  if (seconds < 86400) {
    return `${Math.round(seconds / 3600)}h ago`
  }
  if (seconds < 604800) {
    return `${Math.round(seconds / 86400)}d ago`
  }
  return new Date(then).toLocaleDateString()
}

/**
 * How long something has been going, short: `0s`, `12s`, `1m 05s`, `1h 02m`.
 *
 * The working row's clock (epic #201, U10). It counts up rather than down because nothing in
 * the protocol says how long a turn will take, and it keeps the smaller unit once a bigger one
 * starts — "1m 05s" ticked every second reads as a clock, where "1m" would look frozen. A
 * negative or unparseable duration is `0s`: a clock that says `-3s` is worse than one that
 * says nothing happened yet.
 */
export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const two = (value: number): string => value.toString().padStart(2, '0')
  if (hours > 0) {
    return `${hours}h ${two(minutes)}m`
  }
  return minutes > 0 ? `${minutes}m ${two(seconds)}s` : `${seconds}s`
}

/**
 * How long a reply took, in a sentence: `0.4s`, `4.2s`, `12s`, `1m 05s`.
 *
 * The meta line under a reply (#212). Milliseconds are the whole story while a reply is fast —
 * 0.4s and 4.2s are different experiences — and stop being one once it is slow: nobody reads
 * "12.4s". So the tenth is kept below ten seconds, the number is rounded above it, and past a
 * minute the line becomes {@link formatElapsed}'s clock, which is what the working row counts
 * in. The two are computed the same way (round first, then choose the shape) so the line can
 * never step backwards as the number grows.
 */
export function formatDuration(milliseconds: number): string {
  const ms = Math.max(0, milliseconds)
  const tenths = Math.round(ms / 100) / 10
  if (tenths < 10) {
    return `${tenths.toFixed(1)}s`
  }
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : formatElapsed(ms)
}

/**
 * A count as a reader reads it: `1,312`.
 *
 * Pinned to `en-US` rather than the runtime's locale: this is a number inside a sentence that
 * has already been written in English ("1,312 tokens"), and a value that changed its commas
 * with the machine's locale would be a different sentence.
 */
const COUNT_FORMAT = new Intl.NumberFormat('en-US')

/** Group thousands, the way a token count is read out loud. */
export function formatCount(value: number): string {
  return COUNT_FORMAT.format(value)
}

/**
 * What something cost, in dollars — or `—` when the cost is not known (epic #245, #247).
 *
 * The em dash is not a fallback for a failure: it is the answer for a model nobody publishes a
 * price for, and the one thing this function must never do is invent a number. A cost that is
 * known is written with as much precision as it needs and no more: a reply that cost a tenth of
 * a cent is `$0.0001`-shaped, not `$0.00`, and a dollar-scale total is cents.
 */
export function formatCost(cost: number | null): string {
  if (cost === null) {
    return '—'
  }
  if (cost === 0) {
    return '$0.00'
  }
  if (cost < 0.0001) {
    // Below the precision the line has room for: say so rather than rounding to zero, which
    // would read as "free".
    return '<$0.0001'
  }
  if (cost < 0.01) {
    return `$${trimZeros(cost.toFixed(4))}`
  }
  if (cost < 1) {
    return `$${trimZeros(cost.toFixed(3))}`
  }
  return `$${(Math.round(cost * 100) / 100).toFixed(2)}`
}

/** `0.0240` → `0.024`, `0.0100` → `0.01`: trailing zeros say nothing about what was spent. */
function trimZeros(value: string): string {
  const trimmed = value.replace(/0+$/, '')
  return trimmed.endsWith('.') ? `${trimmed}0` : trimmed
}

/**
 * A total's money, with the part nobody could price named beside it (epic #245, A2; #247,
 * decided 2026-10-09).
 *
 * A total **sums the priced requests and counts the unpriced ones**: `$1.23 + 4 unpriced`. One
 * request with no published price no longer turns a whole session's total into `—`; the known
 * part is the money and the unknown part is the count, and neither is guessed. A total with
 * nothing priced is `—` alone — there is no number to qualify — and a fully priced one is just
 * the number.
 */
export function formatCostTotal(total: {
  readonly cost: number | null
  readonly unpriced_requests: number
}): string {
  if (total.cost === null) {
    return '—'
  }
  if (total.unpriced_requests === 0) {
    return formatCost(total.cost)
  }
  return `${formatCost(total.cost)} + ${formatCount(total.unpriced_requests)} unpriced`
}

/**
 * What `unpriced_requests` means, as one sentence — the explanation a title or a tooltip shows,
 * so "+ 4 unpriced" is never a riddle.
 */
export function unpricedExplanation(unpricedRequests: number): string {
  return unpricedRequests === 1
    ? '1 request had no published price and is not in the total.'
    : `${formatCount(unpricedRequests)} requests had no published price and are not in the total.`
}

/** The last path segment of a resource id, for a compact label. */
export function shortId(id: string): string {
  const [prefix = '', suffix = ''] = id.split('_')
  return suffix === '' ? id : `${prefix}_…${suffix.slice(-6)}`
}
