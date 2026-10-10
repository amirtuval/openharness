import type { ModelPriceLookup } from '@openharness/client'
import type { ModelEntry, SessionStatus } from '@openharness/protocol'
import { Text, useStdout } from 'ink'
import { useEffect, useState } from 'react'

import type { ChatViewState } from '../chat/session'
import { PALETTE, paint, type TerminalTheme } from '../markdown/theme'
import { spanWidth, truncateSpans, type Span } from '../markdown/text'
import { CURSOR_COLUMNS } from './message-view'
import { useTerminalTheme } from './theme'

/**
 * The one line above the prompt: who is answering, in which session, and what is happening
 * (issue #208; the line itself is as old as the CLI).
 *
 * It is one `<Text>` for the same reason a message is: a frame with escape sequences in the
 * middle of a line is a frame a test cannot read. Its spans still carry their own colour and
 * weight — the chrome is dim, the status is not — because Ink applies a `<Text>`'s style to
 * the string its children produced, so nesting costs no extra line.
 */

/**
 * What the terminal falls back to when it will not say how wide it is — the same number the
 * message view uses, so a status line and the transcript under it agree about the width.
 */
const FALLBACK_COLUMNS = 80

/** What separates the parts of the line. */
const SEPARATOR = ' · '

/**
 * The spinner's frames, in order. Braille dots: one column each, so the line does not jump
 * as it turns, and no dependency brings them in (issue #208).
 */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** How often the spinner turns. Ten frames a second reads as motion, not as a flicker. */
export const SPINNER_INTERVAL_MS = 100

/**
 * How long a reply may go silent before the indicator comes back (issue #208).
 *
 * A reply that has started streaming and then stops for a while — the model thinking, a long
 * tool call, a slow token — is the one case that looks like a hang, so the spinner returns
 * rather than leaving the screen frozen with a cursor on it.
 */
export const WORKING_QUIET_MS = 3000

/** The line's three voices: ordinary chrome, something happening, and something that stopped. */
type Tone = 'plain' | 'busy' | 'alarm'

export interface StatusLineProps {
  /**
   * Who is answering: the name of the agent the session snapshotted — absent for a
   * model-first session, which has none and is named by its model instead (issues #93, #95).
   */
  readonly agentName?: string | undefined
  /**
   * The model the session runs: its name from the catalog when the catalog is known, and the
   * `provider/model` id otherwise — or, when a `/model` choice is pending, that model with
   * `(next message)` after it, which is the model the *next* message will run (issue #208).
   */
  readonly model: string
  /** The session's id, for `oh -s <id>`; shortened for the line by {@link shortSessionId}. */
  readonly sessionId: string
  /** What the transcript says the session is doing. */
  readonly status: SessionStatus
  /** Whether the history and the stream are in place yet. */
  readonly phase: ChatViewState['phase']
  /**
   * What the session has spent (epic #245, A2; issue #247), already formatted — `$0.0042`,
   * `$1.23 + 4 unpriced`, or `—` when nothing in the session could be priced. Omitted when there
   * is nothing to say: a session that has not answered yet, or a caller with no catalog to price
   * with.
   */
  readonly cost?: string | undefined
  /**
   * The same money for a terminal with no room for the words — `$1.23+` — used only when the
   * full line does not fit and the compact one does. Omitted alongside {@link cost} when there is
   * nothing to say.
   */
  readonly costCompact?: string | undefined
  /** Extra context, e.g. that this is the dev fake. */
  readonly banner?: string | undefined
  /** When the turn in progress started, in epoch milliseconds; `null` when none is running. */
  readonly runningSince?: number | null | undefined
  /** When the last text of the turn arrived, in epoch milliseconds; `null` before any has. */
  readonly lastTextAt?: number | null | undefined
  /** The reason a retrying turn gave, while the server is retrying it. */
  readonly retrying?: string | undefined
  /** The user cut the running turn short with Ctrl+C. */
  readonly interrupted?: boolean | undefined
  /**
   * How wide the terminal is, when the caller knows better than Ink does — the test seam the
   * frame tests use to draw a line at a width a test can read, as `MessageView` has.
   */
  readonly width?: number | undefined
  /** The clock, for the elapsed time. Tests hand in one they control. */
  readonly now?: (() => number) | undefined
}

/**
 * The status line, laid out to the terminal.
 *
 * The parts are who is answering, the session, the status and the banner, in that order, and
 * the order is also the order they are worth keeping in reverse: on a terminal too narrow for
 * all of them the banner goes first, then the session, then the model, and the status — the
 * one thing about this line that changes — is what is left. Nothing is wrapped: a status line
 * that became two lines would push the prompt down as the spinner turned.
 *
 * The ticking lives *here* rather than in the chat screen, which is the whole reason the
 * spinner can run at all: a timer that re-rendered the screen would re-render the transcript
 * with it ten times a second, and the transcript is the one thing X2 is careful about. This
 * component re-renders; nothing above it does.
 */
export function StatusLine(props: StatusLineProps) {
  const theme = useTerminalTheme()
  const { stdout } = useStdout()
  const now = props.now ?? Date.now
  const [frame, setFrame] = useState(0)

  const runningSince = props.runningSince ?? null
  const running = props.status === 'running' && runningSince !== null
  const field = statusField({
    phase: props.phase,
    status: props.status,
    runningSince,
    lastTextAt: props.lastTextAt ?? null,
    retrying: props.retrying,
    interrupted: props.interrupted ?? false,
    now: now(),
  })

  // Two schedules, and only ever one of them at a time: while the indicator is up it turns
  // ten times a second, and while it is not, a single timeout is armed for the moment the
  // quiet window is up — so a reply that is streaming steadily costs no timer at all.
  useEffect(() => {
    if (!running) return undefined
    if (field.spinner) {
      const timer = setInterval(() => {
        setFrame((count) => count + 1)
      }, SPINNER_INTERVAL_MS)
      return () => {
        clearInterval(timer)
      }
    }
    const lastTextAt = props.lastTextAt ?? null
    const delay = lastTextAt === null ? 0 : Math.max(0, lastTextAt + WORKING_QUIET_MS - now())
    const timer = setTimeout(() => {
      setFrame((count) => count + 1)
    }, delay)
    return () => {
      clearTimeout(timer)
    }
  }, [running, field.spinner, props.lastTextAt, now])

  const spans = statusSpans(props, {
    field,
    frame: SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? '',
    columns: props.width ?? stdout.columns ?? FALLBACK_COLUMNS,
    theme,
  })

  return (
    <Text>
      {spans.map((span, index) => (
        // A status line's spans have no identity of their own; their order is it.
        <Text key={index} color={span.color} dimColor={span.dim}>
          {span.text}
        </Text>
      ))}
    </Text>
  )
}

/**
 * The line as the spans it is drawn from — the whole decision, in one place and without a
 * terminal.
 *
 * The component above is the clock and the terminal width; everything a reader could argue
 * about (what the status says, what is dropped when there is no room, what is coloured) is
 * here, and a test can hold it still by handing in a frame and a width.
 */
export function statusSpans(
  props: StatusLineProps,
  options: {
    readonly field: StatusField
    /** The spinner frame, when the field is spinning. */
    readonly frame: string
    readonly columns: number
    readonly theme: TerminalTheme
  },
): Span[] {
  const full = lineSegments(props, options.field, options.frame, false)
  // A cost that could not price every request carries a count the line may not have room for:
  // try the compact spelling (`$1.23+`) before letting `fitSegments` drop the money whole, so a
  // tight terminal shortens what it shows rather than losing it.
  if (props.costCompact !== undefined && lineWidth(full) > options.columns) {
    const compact = lineSegments(props, options.field, options.frame, true)
    if (lineWidth(compact) < lineWidth(full)) {
      return fitSegments(compact, options.columns, options.theme)
    }
  }
  return fitSegments(full, options.columns, options.theme)
}

/** What the status field is saying, and how loudly (issue #208). */
export interface StatusField {
  /** The words, without the spinner in front of them. */
  readonly text: string
  /** Whether a spinner turns in front of them. */
  readonly spinner: boolean
  /** How the field is drawn. */
  readonly tone: Tone
}

/** Everything {@link statusField} reads. */
export interface StatusFieldInput {
  readonly phase: ChatViewState['phase']
  readonly status: SessionStatus
  readonly runningSince: number | null
  readonly lastTextAt: number | null
  /** The reason a retrying turn gave; `undefined` when the turn is not retrying. */
  readonly retrying: string | undefined
  readonly interrupted: boolean
  /** The clock, as epoch milliseconds. */
  readonly now: number
}

/**
 * What the status field says, in one place and without a frame around it.
 *
 * The order is the order of the questions a reader asks: was the turn cut short, is the
 * server having trouble, is anything happening at all, and only then the plain state. An
 * interrupt is the user's own doing and the most recent thing that happened, so it wins over
 * a turn that is (briefly) still running; a retry is louder than the work it is retrying; and
 * "nothing has arrived yet, or nothing has for three seconds" is what turns `running` into a
 * spinner with a number beside it.
 */
export function statusField(input: StatusFieldInput): StatusField {
  if (input.interrupted) {
    return { text: 'Interrupted', spinner: false, tone: 'alarm' }
  }

  const running = input.status === 'running' && input.runningSince !== null
  if (running && input.retrying !== undefined) {
    return { text: `Retrying… ${input.retrying}`, spinner: true, tone: 'busy' }
  }
  if (running && isQuiet(input.lastTextAt, input.now)) {
    return {
      text: `Working… ${formatElapsed(input.now - (input.runningSince ?? input.now))}`,
      spinner: true,
      tone: 'busy',
    }
  }
  if (input.phase === 'loading') {
    return { text: 'loading history', spinner: false, tone: 'plain' }
  }
  return {
    text: input.status,
    spinner: false,
    tone: input.status === 'running' ? 'busy' : 'plain',
  }
}

/**
 * Whether a turn has gone quiet: nothing has arrived yet, or nothing has for
 * {@link WORKING_QUIET_MS}.
 */
export function isQuiet(lastTextAt: number | null, now: number): boolean {
  return lastTextAt === null || now - lastTextAt >= WORKING_QUIET_MS
}

/** A running turn's elapsed time: `0s`, `12s`, `4m 5s`. Whole seconds — it is a heartbeat. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`
}

/**
 * A session id as the status line shows it: `sesn_` and the last six characters of its ULID.
 *
 * A ULID is 26 characters and mostly timestamp, so the tail is the part that tells two
 * sessions apart and the length is the part that does not fit a status line. It is a *handle*
 * for recognising the session on screen, not one to type: `oh -s` wants the whole id, which
 * is what the CLI prints on the way out, and what a partial one would be answered with is a
 * 404.
 */
export function shortSessionId(sessionId: string): string {
  const prefix = 'sesn_'
  return sessionId.startsWith(prefix) && sessionId.length > prefix.length + 6
    ? `${prefix}…${sessionId.slice(-6)}`
    : sessionId
}

/**
 * A model as the line names it: the catalog's display name where the catalog is known, and
 * the `provider/model` id otherwise (issue #208).
 *
 * "Where the catalog is known" is the honest half of that: a chat opened with `--model` or on
 * a stored default never reads the catalog — that is what makes it start immediately — so the
 * id is what there is until a `/model` pick loads the list. The id is also what a model the
 * catalog has never heard of keeps forever, which is the `provider/model` a reader typed.
 */
export function modelLabel(modelId: string, catalog: readonly ModelEntry[]): string {
  return catalog.find((entry) => entry.id === modelId)?.name ?? modelId
}

/**
 * The catalog's prices, by model id (epic #245, A2; issue #247).
 *
 * The catalog is where prices reach the CLI — each entry carries the model's list rates — so
 * this is the lookup the status line's session total and every reply's footer are computed
 * with. A model it does not carry has no price, and its cost reads `—`: the CLI never invents
 * a rate, and a chat that never read the catalog (one opened on `--model`, before the
 * background read lands) simply shows no cost at all.
 */
export function modelPriceLookup(catalog: readonly ModelEntry[]): ModelPriceLookup {
  const byId = new Map(catalog.map((entry) => [entry.id, entry.cost]))
  return (modelId) => byId.get(modelId) ?? null
}

/** One part of the line, with what it takes to drop it. */
interface Segment {
  /** The span as it will be drawn, spinner included. */
  readonly span: Span
  /** Higher survives longer; see {@link fitSegments}. */
  readonly priority: number
}

/**
 * How much each part of the line is worth when there is not room for all of it.
 *
 * The status is the line's reason to exist; the model is what the chat *is*; what it has cost
 * so far is the next thing a reader looks for (#247) and goes when the line is tight; the
 * session is a handle nobody needs at a glance (and which the CLI prints in full on the way
 * out); and the banner is for whoever is developing the CLI.
 */
const PRIORITY = { banner: 1, session: 2, who: 3, cost: 3, status: 4 } as const

/** The line's parts, in the order they are drawn and with the weight they carry. */
function lineSegments(
  props: StatusLineProps,
  field: StatusField,
  frame: string,
  compactCost: boolean,
): Segment[] {
  const who = props.agentName === undefined ? props.model : `${props.agentName} · ${props.model}`
  const status = field.spinner ? `${frame} ${field.text}` : field.text
  const cost = compactCost ? (props.costCompact ?? props.cost) : props.cost

  const segments: Segment[] = [
    { span: chrome(who), priority: PRIORITY.who },
    { span: chrome(shortSessionId(props.sessionId)), priority: PRIORITY.session },
    ...(cost === undefined ? [] : [{ span: chrome(cost), priority: PRIORITY.cost }]),
    {
      span: { text: status, color: toneColor(field.tone), dim: field.tone === 'plain' },
      priority: PRIORITY.status,
    },
  ]
  if (props.banner !== undefined) {
    segments.push({ span: chrome(props.banner), priority: PRIORITY.banner })
  }
  return segments
}

/** A part of the line that is structure rather than news: dim, and in no colour of its own. */
function chrome(text: string): Span {
  return { text, dim: true }
}

/** The colour a tone is drawn in; the plain one is the terminal's own foreground. */
function toneColor(tone: Tone): string | undefined {
  switch (tone) {
    case 'busy':
      return PALETTE.busy
    case 'alarm':
      return PALETTE.alarm
    default:
      return undefined
  }
}

/**
 * The line, as the spans that fit in `columns` — whole parts, least valuable first out.
 *
 * A part of the line is a fact about the chat, and half of one ("Claude Sonne… · sesn_…") is
 * neither that fact nor a readable one, so parts go whole, in priority order, until what is
 * left fits. The last part standing is the status; if even that does not fit, it is truncated
 * rather than wrapped, which is the only case where the line is cut mid-word — a status line
 * that became two lines would push the prompt down as the spinner turned.
 */
function fitSegments(segments: readonly Segment[], columns: number, theme: TerminalTheme): Span[] {
  let kept = [...segments]
  while (kept.length > 1 && lineWidth(kept) > columns) {
    let worst = 0
    for (let index = 1; index < kept.length; index += 1) {
      const candidate = kept[index]
      const lowest = kept[worst]
      if (
        candidate !== undefined &&
        lowest !== undefined &&
        candidate.priority <= lowest.priority
      ) {
        worst = index
      }
    }
    kept = kept.filter((_, index) => index !== worst)
  }

  const spans = lineSpans(kept, theme)
  return spanWidth(spans) > columns ? truncateSpans(spans, columns) : spans
}

/** The segments as one run of spans, joined — no colour: a colour costs no columns. */
function joined(segments: readonly Segment[]): Span[] {
  return segments.flatMap((segment, index) =>
    index === 0 ? [segment.span] : [{ text: SEPARATOR, dim: true }, segment.span],
  )
}

/** The segments as one run of spans, painted — `NO_COLOR` drops the paint, not the text. */
function lineSpans(segments: readonly Segment[], theme: TerminalTheme): Span[] {
  return joined(segments).map((span) => ({ ...span, color: paint(theme, span.color) }))
}

/** The width of the line the segments would draw, separators included. */
function lineWidth(segments: readonly Segment[]): number {
  return spanWidth(joined(segments))
}

/**
 * The rule that opens the input area (issue #233).
 *
 * The bottom of the screen is one section — the rule, the status line, the prompt, the command
 * menu under it, a flow in the prompt slot, the hidden key input — and this is what says so:
 * above it is the conversation, below it is the console. It goes *above* the status line
 * because the status line is part of the console: it is the one line of chrome the user reads
 * while typing, not a line of the reply.
 *
 * It is drawn from column 0 to the column the transcript leaves empty for its streaming cursor
 * (`CURSOR_COLUMNS`), so the two agree about where the right edge is — and so the rule is never
 * a line exactly as wide as the terminal, which is the same trouble that reserves the column in
 * the first place.
 *
 * It is structure, so it is drawn the way the transcript draws structure (X4): the `chrome`
 * named colour, and dim. Under `NO_COLOR` there is no colour to drop and no surface to lose —
 * the rule is the plain `─` it always was, and the section it opens is unchanged.
 */
export function InputRule({
  width,
  blankAbove = true,
}: {
  /**
   * How wide the terminal is, when the caller knows better than Ink does — the test seam the
   * frame tests draw at a width they can read, as `MessageView` and `StatusLine` have.
   */
  readonly width?: number | undefined
  /**
   * Whether this section draws the blank line above it (issue #233): the line that sets the
   * section off from the transcript. Never asked for when the message above already ends in
   * one — a user's message is banded and its band ends in a blank line of its own — or when
   * there is nothing above it at all, which is how a session starts.
   */
  readonly blankAbove?: boolean | undefined
}) {
  const theme = useTerminalTheme()
  const { stdout } = useStdout()
  const columns = width ?? stdout.columns ?? FALLBACK_COLUMNS

  return (
    <>
      {blankAbove && <Text> </Text>}
      <Text color={ruleSpan(theme, columns).color} dimColor>
        {ruleSpan(theme, columns).text}
      </Text>
    </>
  )
}

/** The character a rule is drawn with: the transcript's own, from `markdown/render.ts`. */
export const RULE_CHARACTER = '─'

/**
 * How many columns a rule spans: the terminal's, less the column the transcript reserves for
 * its streaming cursor (`message-view.tsx`). At least one, so the section always has an edge.
 */
export function ruleWidth(columns: number): number {
  return Math.max(1, columns - CURSOR_COLUMNS)
}

/**
 * The rule as the span it is drawn from — the whole decision, in one place and without a
 * terminal, as {@link statusSpans} is for the line under it.
 */
export function ruleSpan(theme: TerminalTheme, columns: number): Span {
  return {
    text: RULE_CHARACTER.repeat(ruleWidth(columns)),
    color: paint(theme, PALETTE.chrome),
    dim: true,
  }
}
