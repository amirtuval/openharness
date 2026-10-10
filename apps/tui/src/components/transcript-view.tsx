import { transcriptEntries } from '@openharness/client'
import type {
  ModelPriceLookup,
  TranscriptEntry,
  TranscriptMessage,
  TranscriptSummary,
} from '@openharness/client'
import { Static, Text } from 'ink'
import { Fragment, useRef } from 'react'

import { draws, MessageView } from './message-view'
import { replyMetaLines } from './reply-meta'
import { SummaryDivider } from './summary-divider'

/**
 * The conversation: what is settled goes through Ink's `<Static>`, what is still moving
 * stays in the live area.
 *
 * This is what keeps a streamed reply from repainting the whole screen at every delta. Ink
 * writes static output once and never redraws it; the live area below is the only thing the
 * render loop touches. The split is a *prefix* — everything before the first unsettled
 * message is static, everything from it on is live — so the live area can never end up
 * above a message that is already committed to the scrollback.
 *
 * A message is settled when the brain has taken it (`pending: false`) and it is not being
 * previewed (`streaming: false`); both flags change over the life of a message, and both
 * mean the text on screen may still change.
 *
 * **A reply whose metadata is still coming is not settled either** (issue #208, epic #201
 * X2). A reply's tokens and duration arrive with its `span.model_request_end`, which the
 * server writes *after* the reply itself, so the message settles before its metadata does —
 * and a settled message is written once and never redrawn, so a metadata line drawn under it
 * would never appear. `holdLive` is the id of the reply that is still waiting for its span
 * end (`ChatViewState.awaitingMetaId`); holding it in the live area is what lets the line
 * arrive with the message rather than after the scrollback has closed over it. The hold ends
 * when the span end lands or the turn goes idle — whichever comes first, because an idle
 * empties the transcript's pending requests — so a log that has no span events at all (a
 * session written before epic #201) still settles, one turn later.
 *
 * Messages are separated by one blank line, and the blank line is part of the *following*
 * message's static output rather than a thing of its own: a reply that streams arrives as one
 * static write, and a separator rendered separately would be written twice — once when the
 * next message was still live and again when it settled. The line is a single space and not
 * an empty `<Text>`: Ink gives a text node with nothing in it no height at all, so an empty
 * one is not a blank line, it is no line.
 *
 * **A user message brings its own blank lines** (issue #229): the band it is drawn on has one
 * below it, and one above it unless the message above ended in one — the same reason. So the
 * separator here is drawn only between two messages that are not user messages, and a user's
 * message is asked for the line above it only when the message above is not a user's message
 * as well. Anywhere else the message already brought one, and drawing another would put two
 * blank lines where the transcript has always had one.
 *
 * **A message that draws nothing is not a block** (issue #233). A reply that has been announced
 * but has not produced a token yet is in the transcript with nothing in it, and the blank lines
 * here — and the one the input section owes the transcript — are about the blocks on screen:
 * drawn around a message nobody can see, they are a blank line after nothing, and one more than
 * the one the transcript is supposed to have.
 *
 * **The settled list is append-only, and a summary divider is written where it can be**
 * (epic #277, K10; #280). `<Static>` renders the *tail* of its list (Ink's `items.slice(index)`),
 * so a block inserted before the end shifts everything after it: the tail is written twice and
 * the block itself is never drawn. Messages never do that — a message settles at the frontier —
 * but a divider for a compaction that ran at the start of the turn does, because it covers
 * history already in the scrollback. {@link committedSettled} therefore keeps what is written and
 * appends the rest; a divider whose true position is inside the written prefix is drawn at the
 * frontier, just above the live area, with the history it covers still above it. It is written
 * once and never moves again; a later reload draws it at its position in the log, like the web.
 */
export function TranscriptView({
  messages,
  summaries = [],
  width,
  currentModel,
  costOf,
  holdLive,
  holdAll,
}: {
  readonly messages: readonly TranscriptMessage[]
  /** The summary dividers still in the conversation, in order (epic #277, K10; #280). */
  readonly summaries?: readonly TranscriptSummary[] | undefined
  /** How wide the terminal is; the tests draw at a width they can read (see `MessageView`). */
  readonly width?: number | undefined
  /** The model the session runs, for the per-reply metadata lines (issue #208). */
  readonly currentModel?: string | undefined
  /** The catalog's prices, for what each reply cost (#247); omitted, no cost is drawn. */
  readonly costOf?: ModelPriceLookup | undefined
  /** The reply to keep live until its metadata arrives (issue #208); usually the last one. */
  readonly holdLive?: string | undefined
  /**
   * Keep **every** message live, settling nothing yet (#247).
   *
   * A settled message is written once and never redrawn (#208, X2), so a footer that settled
   * before the prices were known would keep that line for the life of the screen — including
   * for the replies loaded from history, which are settled the moment they are drawn. While the
   * rates are still being read the transcript therefore draws everything live, and settles it
   * the moment the read answers (however it answered).
   */
  readonly holdAll?: boolean | undefined
}) {
  // The scrollback's write position: what a previous render handed `<Static>`. A cache, not
  // state — what is committed is a pure function of the blocks and what has already been
  // written, so re-running a render (React strict mode, a reconciler pass) leaves it where it
  // was. See {@link committedSettled} for why the list has to be built this way.
  const committed = useRef<readonly TranscriptEntry[]>([])

  // Only the messages that draw something are laid out as blocks. A reply that has been
  // announced but has not produced a token yet draws nothing at all (`message-view.tsx`), so
  // it is not one — and the blank lines the transcript draws *between* blocks, and the one
  // the input section owes the last of them (issue #233), are about the blocks, not about the
  // lines the log happens to hold.
  //
  // The summary dividers are blocks too (epic #277, K10; #280), ordered among the messages by
  // the client's `transcriptEntries` — the same function the web app orders its transcript
  // with, so a divider lands in the same place in both. A divider is *not* filtered by `draws`:
  // it always has something to say, whether or not the history under it draws.
  const blocks: readonly TranscriptEntry[] = transcriptEntries(messages.filter(draws), summaries)
  const firstLive =
    holdAll === true
      ? 0
      : blocks.findIndex((entry) => entry.kind === 'message' && isLive(entry.message, holdLive))
  const settled = committedSettled(committed.current, blocks, firstLive)
  committed.current = settled
  const live = firstLive === -1 ? [] : blocks.slice(firstLive)
  const metaLines = replyMetaLines(messages, currentModel, costOf)

  /** The block, framed by the blank line the transcript owes it after `previous`, if any. */
  const draw = (entry: TranscriptEntry, previous: TranscriptEntry | undefined) =>
    entry.kind === 'summary' ? (
      <Fragment key={entry.summary.id}>
        {setsOffDivider(previous) && <Text> </Text>}
        <SummaryDivider summary={entry.summary} width={width} />
      </Fragment>
    ) : (
      <Fragment key={entry.message.id}>
        {separates(previous, entry) && <Text> </Text>}
        <MessageView
          message={entry.message}
          width={width}
          metaLine={metaLines.get(entry.message.id)}
          blankAbove={blankAbove(previous)}
        />
      </Fragment>
    )

  return (
    <>
      <Static items={[...settled]}>{(entry, index) => draw(entry, settled[index - 1])}</Static>
      {live.map((entry, index) => draw(entry, index === 0 ? settled.at(-1) : live[index - 1]))}
    </>
  )
}

/**
 * What the scrollback has been written with, and what is due to be appended to it.
 *
 * Ink's `<Static>` is **append-only**: it renders `items.slice(index)`, where `index` is the
 * length it last saw, so a list that grows in the middle is rendered wrong — the items after
 * the insertion shift, the tail is written a second time, and the inserted block is never
 * drawn. A message only ever appends to the settled prefix (it settles at the frontier), so it
 * cannot break that; a **summary divider** can, because a compaction runs at the start of a
 * turn and covers history the terminal committed to the scrollback long ago (epic #277, K10;
 * #280). Its true position is inside the written prefix, and inserting it there is exactly what
 * Ink cannot do.
 *
 * So the settled list is built the one way `<Static>` accepts — `{@link committedSettled}`
 * keeps the entries already written (dropping only what a `session.rewind` took back) and
 * **appends** the rest in their own order. A divider whose position is before the frontier
 * therefore lands at the frontier rather than in the middle: it is drawn with the history it
 * covers still above it, which is what it says, and nothing already on screen is rewritten.
 * The live area keeps its place below it, and the divider is written into the scrollback and
 * never moves again.
 */
function committedSettled(
  previous: readonly TranscriptEntry[],
  blocks: readonly TranscriptEntry[],
  firstLive: number,
): readonly TranscriptEntry[] {
  const candidates = firstLive === -1 ? blocks : blocks.slice(0, firstLive)
  const settledIds = new Set(candidates.map(entryId))
  const kept = previous.filter((entry) => settledIds.has(entryId(entry)))
  const written = new Set(kept.map(entryId))
  const appended = candidates.filter((entry) => !written.has(entryId(entry)))
  if (appended.length === 0) {
    // Nothing new: hand back the same array, so `<Static>` does not think the list changed.
    return kept.length === previous.length ? previous : kept
  }
  return [...kept, ...appended]
}

/** The id a block is written under: its message's, or its summary's (its `<Static>` key). */
function entryId(entry: TranscriptEntry): string {
  return entry.kind === 'summary' ? entry.summary.id : entry.message.id
}

/**
 * The last message of the transcript that draws anything, or `undefined` for an empty one.
 *
 * The block under the transcript — a notice, and the input section's rule (issue #233) — has to
 * ask what is above it before drawing a blank line of its own, and the answer is about the last
 * thing *drawn* rather than the last thing in the log: a reply with no tokens yet is neither.
 */
export function lastDrawn(messages: readonly TranscriptMessage[]): TranscriptMessage | undefined {
  return messages.filter(draws).at(-1)
}

/** Whether a message may still change on screen, and so belongs in the live area. */
function isLive(message: TranscriptMessage, holdLive: string | undefined): boolean {
  return message.pending || message.streaming || message.id === holdLive
}

/**
 * Whether the transcript draws an explicit separator line before `entry`.
 *
 * Only between two messages that are not user messages: a user's message brings the blank line
 * around its band itself (see `message-view.tsx`), and a separator as well would be two blank
 * lines where there has always been one. The first block of a conversation has none either —
 * `previous` is `undefined` there — and a divider brings its own line above, so `entry` being
 * one is never this function's business.
 *
 * A message **below** a divider does owe it one: a divider ends in the summary's last line, not
 * in a blank one. That is the case `previous.kind === 'summary'` covers, and a user's message
 * there is excluded because it draws the line itself (see {@link blankAbove}).
 */
function separates(previous: TranscriptEntry | undefined, entry: TranscriptEntry): boolean {
  if (previous === undefined || entry.kind === 'summary') {
    return false
  }
  if (previous.kind === 'summary') {
    return entry.message.role !== 'user'
  }
  return previous.message.role !== 'user' && entry.message.role !== 'user'
}

/**
 * Whether the block after `previous` is the one that draws the blank line above itself.
 *
 * A block with nothing above it is not one that needs setting off; one whose predecessor was a
 * user's message already has the blank line that band ended in. Everything else — an agent's
 * reply above it, a divider above it, or the transcript's own separator — is a case the message
 * has to cover itself, and only a user's message ever does.
 */
function blankAbove(previous: TranscriptEntry | undefined): boolean {
  if (previous === undefined) {
    return false
  }
  return previous.kind === 'summary' || previous.message.role !== 'user'
}

/**
 * Whether a divider is the block that draws the blank line above itself.
 *
 * Always, except as the first block — a divider is drawn as structure rather than as a banded
 * message, so nothing above it brings a line of its own. A user's message above it is the
 * exception: that band already ends in a blank line.
 */
function setsOffDivider(previous: TranscriptEntry | undefined): boolean {
  if (previous === undefined) {
    return false
  }
  return previous.kind === 'summary' || previous.message.role !== 'user'
}
