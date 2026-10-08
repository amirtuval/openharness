import { replyCost } from '@openharness/client'
import type {
  ModelPriceLookup,
  TranscriptMessage,
  TranscriptMessageMeta,
} from '@openharness/client'

/**
 * The one dim line a settled reply carries: what it ran on, how long it took, what it cost
 * (issue #208; the metadata itself is epic #201, X1).
 *
 * Formatting only — no Ink, no React — because every rule here is a decision about words and
 * numbers rather than about a frame, and the two are easier to get right apart. The line is
 * laid out by `message-view.tsx`, which owns the label and the hanging indent.
 *
 * Nothing the log does not say is printed: a reply whose span end has not arrived has no
 * duration and no tokens, and one whose turn was written before the spans existed has
 * neither, so its line is empty and `null` is what comes back — no line at all rather than a
 * line of dashes. `0` is a number a model really did report, and the two must not look alike.
 *
 * The **cost** is the one part computed rather than read (epic #245, A2; #247): the log stores
 * tokens and never money, so a reply's counters are priced with its model's rates when the
 * line is written. A model nobody publishes a price for shows `—`, which is the honest answer
 * and never a zero — and a caller with no catalog at all leaves the cost off the line rather
 * than showing it as unknown.
 */

/** What the line is written against: the session's model, and the reply before this one. */
export interface ReplyMetaContext {
  /**
   * The model the session runs, as the transcript last said.
   *
   * A reply that names it is saying nothing new — the status line above is already showing
   * it — so the name is left off, which is what keeps the common case to `4.2s · 1.3k tokens`.
   */
  readonly currentModel: string | undefined
  /** The model the previous reply ran on, when it named one. */
  readonly previousModel: string | undefined
}

/**
 * How long a reply took: `450ms`, `4.2s`, `12s`, `1m 5s`.
 *
 * Seconds keep a decimal below ten, where the difference between 1.4s and 2s is worth
 * reading, and lose it above, where it is noise. A minute or more is read as minutes.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`
  if (ms < 60_000) {
    const seconds = ms / 1000
    return `${seconds < 10 ? trimZero(seconds.toFixed(1)) : String(Math.round(seconds))}s`
  }
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(seconds)}s`
}

/**
 * How many tokens: `850`, `1.3k`, `12k`, `1.2M`.
 *
 * The same shape the model picker gives a context window (`formatContextWindow`), except that
 * a token count keeps a decimal up to ten thousand: a reply that cost 1.3k and one that cost
 * 2.1k are different replies, and rounding both to `k` throws that away.
 */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 10_000) return `${trimZero((count / 1000).toFixed(1))}k`
  if (count < 1_000_000) return `${String(Math.floor(count / 1000))}k`
  return `${trimZero((count / 1_000_000).toFixed(1))}M`
}

/**
 * The line under one reply, or `null` when the log says nothing worth printing.
 *
 * The three fields are independent: any of them may be missing, on its own or together.
 */
export function replyMetaLine(
  meta: TranscriptMessageMeta | undefined,
  context: ReplyMetaContext,
  costOf?: ModelPriceLookup,
): string | null {
  if (meta === undefined) return null

  const parts: string[] = []
  // The model only when it is news: a reply on the session's own model, or on the one the
  // reply before it ran, is exactly what the reader already assumes.
  if (
    meta.model !== undefined &&
    meta.model !== context.currentModel &&
    meta.model !== context.previousModel
  ) {
    parts.push(meta.model)
  }
  if (meta.durationMs !== undefined) parts.push(formatDuration(meta.durationMs))
  if (meta.usage !== undefined) {
    parts.push(`${formatTokens(meta.usage.total)} tokens`)
    if (costOf !== undefined) {
      parts.push(formatCost(replyCost(meta, costOf)))
    }
  }

  return parts.length === 0 ? null : parts.join(' · ')
}

/**
 * The line for every reply in a conversation, keyed by the message's id.
 *
 * One pass rather than one per message, because "the previous reply's model" is a fact about
 * the sequence: the map is built while walking it. A reply that names no model — a client
 * that joined after its span start — leaves the previous one standing, so the next reply is
 * still compared against the last model anyone actually reported.
 *
 * @param messages the transcript, in order
 * @param currentModel the model the session runs, or `undefined` when the caller does not know
 * it — every model a reply names is then worth printing, since none of them is assumed
 * @param costOf the catalog's prices (#247); omitted, the lines carry no cost
 */
export function replyMetaLines(
  messages: readonly TranscriptMessage[],
  currentModel: string | undefined,
  costOf?: ModelPriceLookup,
): ReadonlyMap<string, string> {
  const lines = new Map<string, string>()
  let previousModel: string | undefined

  for (const message of messages) {
    if (message.role !== 'agent') continue
    const line = replyMetaLine(message.meta, { currentModel, previousModel }, costOf)
    if (line !== null) lines.set(message.id, line)
    if (message.meta?.model !== undefined) previousModel = message.meta.model
  }

  return lines
}

/**
 * What a reply cost: `$0.0013`, `$0.024`, `$1.23` — or `—` when nobody published a price
 * (epic #245, A2; #247).
 *
 * The precision follows the number: a fraction of a cent keeps the digits that make it
 * meaningful, and a dollar-scale total does not pretend to more. Anything below what four
 * decimals can say is `<$.0001`-shaped rather than rounded to zero, which would read as free.
 */
export function formatCost(cost: number | null): string {
  if (cost === null) {
    return '—'
  }
  if (cost === 0) {
    return '$0.00'
  }
  if (cost < 0.0001) {
    return '<$0.0001'
  }
  if (cost < 0.01) {
    return `$${trimCost(cost.toFixed(4))}`
  }
  if (cost < 1) {
    return `$${trimCost(cost.toFixed(3))}`
  }
  return `$${(Math.round(cost * 100) / 100).toFixed(2)}`
}

/** `4.0` → `4`, `1.3` → `1.3`: a trailing zero says nothing about how much anything cost. */
function trimZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}

/** `0.0240` → `0.024`, `0.0100` → `0.01`: the same rule, for a number with more places. */
function trimCost(value: string): string {
  const trimmed = value.replace(/0+$/, '')
  return trimmed.endsWith('.') ? `${trimmed}0` : trimmed
}
