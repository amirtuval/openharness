import type { StoredEvent, ToolCallEvent, ToolResultEvent } from '@openharness/protocol'
import {
  EVENT_TYPES,
  isToolCallEvent,
  isToolResultEvent,
  toolCallInput,
  toolCallOfferedName,
  toolCallPermission,
  toolResultCallId,
  toolResultIsError,
} from '@openharness/protocol'

import { RESOLVED_BY_MESSAGE } from './pausing'

/**
 * Stuck detection: a model that repeats one failing call, read off the log (#331).
 *
 * The step limit (epic #303, X2) bounds a turn, but only at fifty requests — far too late for the
 * case this exists for: a model that made the same call with the same arguments and got the same
 * answer, over and over, because it has no idea what else to try. This module answers three
 * questions about that, all from the log and nothing stored beside it:
 *
 * - **The streak.** The run of the newest tool calls **in the turn** that share one tool name and
 *   byte-identical arguments (compared as canonical JSON, so key order is not a difference). A
 *   call with different arguments ends the streak, and so does the user saying anything: a turn
 *   opens after every `session.status_idle` — a reply, a pause, an interrupt — so a new turn, or
 *   a resumed one, starts the count afresh. Built-in calls and remote MCP ones are one sequence
 *   (#312): a model looping on a remote tool is stuck in exactly the same way.
 * - **The reminder.** At {@link STUCK_REMINDER_STREAK} identical calls the next request carries a
 *   one-time reminder to change approach, worded by whether the repeated answer is an error. It
 *   is one-time **per streak**, and the record is the log itself: a `span.model_request_start`
 *   since the streak began that recorded a `stuck` reminder suppresses another, so a resumed turn
 *   neither reminds twice nor forgets that it did.
 * - **The end.** At {@link STUCK_END_STREAK} identical **failing** calls the turn ends with a
 *   visible notice (`tool_loop_stuck_error`), the step limit's shape rather than a retry loop.
 *
 * A **failure** is an `is_error` result that the tool really produced and the model really could
 * change: a policy `deny`, a user's own denial, and an interrupt (or a call a message ended) are
 * not failures, because repeating the call after any of them is not a loop the model is stuck in.
 *
 * Nothing here writes, and nothing is derived from anything but `events`, which is what makes a
 * brain that inherits a turn see the same streak the brain that died saw (X3).
 */

/**
 * How many identical calls in a row earn the model a reminder to change approach (#331).
 *
 * The study's own number: a model that has asked the same question five times is not making
 * progress, and a nudge costs one line. Below it the repetition may still be a retry that is
 * about to work.
 */
export const STUCK_REMINDER_STREAK = 5

/**
 * How many identical **failing** calls in a row end the turn (#331).
 *
 * Past the reminder the model has had its nudge and kept going, so the loop is not something
 * another sentence will fix: eight calls is far past a real retry and well short of a runaway,
 * and the turn ends with a notice rather than at the fifty-step limit.
 */
export const STUCK_END_STREAK = 8

/** The sentence a call cut short by the user is answered with — from `@openharness/hands`. */
const INTERRUPTED = 'Interrupted by the user.'

/** The opening of the sentence a call the user refused is answered with ({@link denied}). */
const USER_DENIED = 'The user denied this'

/**
 * A value as canonical JSON: object keys sorted, arrays in order, so two arguments that differ
 * only in key order compare equal.
 *
 * The model writes its arguments as an object and a provider re-serializes them, so `{"a":1,"b":2}`
 * and `{"b":2,"a":1}` are the same call; a byte comparison of the two spellings would miss the
 * streak the whole feature is about.
 *
 * @param value a value a tool call's input can hold
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value))
}

/** One value with every object's keys sorted, recursively. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical)
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonical(source[key])
    }
    return sorted
  }
  return value
}

/**
 * The identical run of newest calls in the current turn, or `null` when the turn has called no
 * tool.
 *
 * "In the turn" is "since the last `session.status_idle`": a turn always ends on an idle event
 * and always opens with the calls that follow it, so this is the current turn's calls whether it
 * is running fresh or was resumed by another brain — a resume writes no idle, so the calls are
 * still the same turn's.
 */
export interface StuckStreak {
  /** How many calls the run holds — at least 1. */
  readonly length: number
  /** The name the model called the tool by, built-in or remote (#312). */
  readonly name: string
  /** The canonical JSON of the arguments all of them share. */
  readonly input: string
  /** The `seq` of the run's first call — where a reminder for this streak would sit after. */
  readonly startedAt: number
  /** How many of the run's calls ended in a failure (see the module note). */
  readonly failures: number
}

/**
 * The streak the log's newest calls form, or `null` when the turn has called no tool (or the
 * newest call is the first of a run — a run of one is still a streak, `length: 1`).
 *
 * The walk is backwards from the newest call, and it stops at the first call that names another
 * tool or carries other arguments; a call with no result yet is not a failure, but the streak is
 * the calls, whether they are answered or not.
 *
 * @param events the session's log, as `readLog` handed it over
 */
export function stuckStreak(events: readonly StoredEvent[]): StuckStreak | null {
  const turnStart = lastTurnStartSeq(events)
  const calls = events.filter(
    (event): event is ToolCallEvent => isToolCallEvent(event) && event.seq > turnStart,
  )
  const newest = calls[calls.length - 1]
  if (newest === undefined) {
    return null
  }
  const results = resultsByCall(events)
  const name = toolCallOfferedName(newest)
  const input = canonicalJson(toolCallInput(newest))
  const run: ToolCallEvent[] = []
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]
    if (
      call === undefined ||
      toolCallOfferedName(call) !== name ||
      canonicalJson(toolCallInput(call)) !== input
    ) {
      break
    }
    run.push(call)
  }
  run.reverse()
  const failures = run.filter((call) => isFailure(call, results.get(call.id))).length
  const first = run[0]
  return {
    length: run.length,
    name,
    input,
    startedAt: first?.seq ?? newest.seq,
    failures,
  }
}

/**
 * The one-time reminder the next request should carry for this streak, or `null` (#331).
 *
 * The wording is by whether the repeated calls are **failing**: a run of identical successful
 * results says "you already have this"; a run of identical errors says "it keeps failing the same
 * way; read the error and try something different". The reminder fires at
 * {@link STUCK_REMINDER_STREAK} and once only — a `stuck` reminder already recorded on a
 * `span.model_request_start` since the streak began is what "once" means, and reading it off the
 * log is what survives a crash. At {@link STUCK_END_STREAK} failing calls the turn ends instead,
 * so none is offered then.
 *
 * @param events the session's log, as `readLog` handed it over
 */
export function stuckReminder(events: readonly StoredEvent[]): StuckReminder | null {
  const streak = stuckStreak(events)
  if (streak === null || streak.length < STUCK_REMINDER_STREAK) {
    return null
  }
  if (stuckEnd(events) !== null) {
    return null
  }
  if (remindedSince(events, streak.startedAt)) {
    return null
  }
  const errors = streak.failures === streak.length
  return {
    kind: 'stuck',
    variant: errors ? 'errors' : 'results',
    streak: streak.length,
    text: errors
      ? stuckErrorsReminder(streak.name, streak.length)
      : stuckResultsReminder(streak.name, streak.length),
  }
}

/** A reminder a request carries, with the id of what it is about (#331). */
export interface StuckReminder {
  /** Always `'stuck'` — the tag a span record and the caller's reminder list share. */
  readonly kind: 'stuck'
  /** `'errors'` when the repeated calls kept failing, `'results'` when they kept succeeding. */
  readonly variant: 'errors' | 'results'
  /** How many identical calls the streak held when the reminder was earned. */
  readonly streak: number
  /** The sentence the model is told. */
  readonly text: string
}

/** What the model is told when it keeps getting the same answer back. */
export function stuckResultsReminder(name: string, count: number): string {
  return (
    `You have called ${name} with the same arguments ${count} times and gotten the same ` +
    `result each time. That result is above — you already have it, so do not call ${name} ` +
    'again with these arguments; move on to something that makes progress.'
  )
}

/** What the model is told when the same call keeps failing. */
export function stuckErrorsReminder(name: string, count: number): string {
  return (
    `You have called ${name} with the same arguments ${count} times and it has failed the ` +
    'same way each time. Read the error above and try something different rather than ' +
    'repeating the same call.'
  )
}

/**
 * The streak of failing identical calls that should end the turn, or `null` (#331).
 *
 * The turn ends when {@link STUCK_END_STREAK} calls of the run — **all** of them failing — are
 * behind it, which is the point past which the model has been reminded and did not change
 * approach. A run that is not uniformly failing never ends the turn: mixed results mean the call
 * is doing something, not looping.
 *
 * @param events the session's log, as `readLog` handed it over
 */
export function stuckEnd(events: readonly StoredEvent[]): StuckStreak | null {
  const streak = stuckStreak(events)
  if (streak === null) {
    return null
  }
  return streak.length >= STUCK_END_STREAK && streak.failures === streak.length ? streak : null
}

/**
 * Whether a result reports a failure the model could act on (see the module note).
 *
 * @param call the call the result answers
 * @param result its result, or `undefined` for a call nothing has answered yet
 */
export function isFailure(call: ToolCallEvent, result: ToolResultEvent | undefined): boolean {
  if (result === undefined || !toolResultIsError(result)) {
    return false
  }
  // A policy denial is the loop refusing the call, not the tool failing: calling again cannot
  // change the answer, but neither is the model stuck — the setting is the reason.
  if (toolCallPermission(call) === 'deny') {
    return false
  }
  const text = resultText(result)
  // A denial the user made and an interrupt are the user's doing, not the call's own failure.
  return text !== RESOLVED_BY_MESSAGE && text !== INTERRUPTED && !text.startsWith(USER_DENIED)
}

/** The text a result carries, its blocks joined. */
function resultText(result: ToolResultEvent): string {
  return result.content.map((block) => block.text).join('')
}

/** Every answer in the log, by the call it names. */
function resultsByCall(events: readonly StoredEvent[]): Map<string, ToolResultEvent> {
  const results = new Map<string, ToolResultEvent>()
  for (const event of events) {
    if (isToolResultEvent(event)) {
      results.set(toolResultCallId(event), event)
    }
  }
  return results
}

/**
 * The `seq` the turn's own calls start after: the newest `session.status_idle`, or `0` for a log
 * that has not ended a turn yet.
 *
 * An idle event is what closes a turn whatever ended it — a reply, a pause, an interrupt, an
 * error — so the calls after the newest one are the current turn's. A resumed turn writes no
 * idle, so its calls stay in the same run.
 */
function lastTurnStartSeq(events: readonly StoredEvent[]): number {
  let start = 0
  for (const event of events) {
    if (event.type === EVENT_TYPES.sessionStatusIdle) {
      start = event.seq
    }
  }
  return start
}

/**
 * Whether a request since the streak began already carried a stuck reminder (X3).
 *
 * The span is where a reminder is recorded, so the log answers "have we told it yet" without
 * anything stored beside it — and a reminder the turn that died had already sent suppresses a
 * second one when another brain takes over.
 */
function remindedSince(events: readonly StoredEvent[], startedAt: number): boolean {
  return events.some(
    (event) =>
      event.type === EVENT_TYPES.modelRequestStart &&
      event.seq > startedAt &&
      (event.reminders?.some((reminder) => reminder.kind === 'stuck') ?? false),
  )
}
