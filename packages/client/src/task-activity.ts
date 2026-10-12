import { EVENT_TYPES } from '@openharness/protocol'
import type {
  ListEventsQuery,
  SessionStatus,
  StoredEvent,
  StreamEvent,
  TodoList,
  TotalCost,
} from '@openharness/protocol'

import type { DebugHook } from './http'
import type { RequestOptions } from './client'
import type { StreamOptions } from './events/stream'
import { createTranscript, selectSessionUsage, sessionCost } from './transcript'
import type { ModelPriceLookup, SessionUsageTotals, TranscriptState } from './transcript'
import { toolCallSummary } from './tools'
import type { TranscriptToolCall } from './tools'

/**
 * A child's live activity, for the card its parent draws (epic #340, decision S9; issue #345).
 *
 * A task does not report progress (S4): the parent's log says what a task *is*, and what it is
 * doing **right now** is on the **child's** own stream. This module is the client's half of
 * that — it follows the child's log with the ordinary SSE client, folds it into a transcript,
 * and answers the one line a card draws ("web_fetch: https://…", "2 of 5", "writing…") beside
 * the tokens and the money the child has spent so far.
 *
 * It is a store with a reference count, because a frontend opens a card per task and a card
 * can be scrolled away: the child is followed while something watches it and the connection is
 * dropped when nothing does — which is what keeps a chat with six finished subagents from
 * holding six open streams for ever.
 */

/**
 * What a child is doing, as a card's activity line draws it.
 *
 * The four shapes are the whole of it: the tool call that is out, the task list the model
 * wrote when no call is (`2 of 5`), "writing…" while the model is producing a reply, and
 * nothing at all. **Waiting is not here**: it is a status, not an activity
 * ({@link TaskActivityState.waiting}), because a child can be paused on its own tasks and
 * still have a list to show.
 */
export type TaskActivityLine =
  | {
      readonly kind: 'tool'
      /** The name the model called the tool by — a built-in's own, or `<server>__<tool>`. */
      readonly name: string
      /** The call's short summary, or `null` when its input says nothing short. */
      readonly summary: string | null
    }
  | {
      readonly kind: 'todos'
      /** How many of the list's items are done. */
      readonly done: number
      /** How many it has. */
      readonly total: number
    }
  | { readonly kind: 'writing' }
  | { readonly kind: 'idle' }

/**
 * What the card of one task can say about the child right now (epic #340, S9; issue #345).
 *
 * The `activity` line, whether the child is waiting on its own tasks, its own status, the
 * model it runs, and what it has spent. A frontend draws the tokens and the cost beside the
 * card's status; the status itself comes from {@link taskCardStatus}, which this snapshot
 * feeds with `waiting`.
 */
export interface TaskActivityState {
  /** The one line saying what the child is doing, or `idle` when it is doing nothing. */
  readonly activity: TaskActivityLine
  /** Whether the child's own log says it is paused in an `agent_wait` (the "waiting" status). */
  readonly waiting: boolean
  /** The child's own status, as the transcript reads it. */
  readonly status: SessionStatus
  /** The model the child's log last said it runs, or `null` when it has not said. */
  readonly model: string | null
  /** The child's tokens so far, or `null` while its log reports none. */
  readonly usage: SessionUsageTotals | null
  /** What those tokens cost, priced with the caller's catalog, or `null` with none to price by. */
  readonly cost: TotalCost | null
}

/** What a caller can say about the activity {@link taskActivityOf} derives (issue #345). */
export interface TaskActivityOptions {
  /**
   * The price of a `provider/model` id, from the model catalog.
   *
   * Absent means no cost is computed at all — the card then shows tokens and no money, which
   * is the honest answer for a caller with no catalog, rather than a `0` nobody published.
   */
  readonly prices?: ModelPriceLookup
  /**
   * Whether the child's own log says it is paused in an `agent_wait`.
   *
   * The caller's to say rather than this function's to derive: the fact is in the child's
   * `session.status_idle`, and a caller that holds the child's transcript has read it. A
   * follower reads it for itself — see {@link watchTaskActivity}, which takes no such option.
   */
  readonly waiting?: boolean
}

/** What a caller can say about the follower {@link watchTaskActivity} opens (issue #345). */
export interface TaskActivityWatchOptions {
  /** The price of a `provider/model` id, for the cost the snapshot reports. */
  readonly prices?: ModelPriceLookup
  /** Where a child that could not be read or followed is reported. */
  readonly onDebug?: DebugHook
}

/** The state of a child nothing has read yet: nothing running, nothing spent. */
const NOTHING_YET: TaskActivityState = {
  activity: { kind: 'idle' },
  waiting: false,
  status: 'idle',
  model: null,
  usage: null,
  cost: null,
}

/**
 * What a child's transcript says its activity is, as the card draws it (issue #345).
 *
 * The rules, in the order they are tried:
 *
 * 1. **a running tool call** — the newest call with no result and a turn that is working — is
 *    the child's current work, drawn as its name and the shared summary;
 * 2. else **the task list**, when the model has written one: "2 of 5", the count the todo panel
 *    draws of the same list;
 * 3. else **"writing…"** while the child's turn is running, because a model that is streaming a
 *    reply and calling nothing is writing one;
 * 4. else **nothing** — `idle`, which a card draws no line for.
 *
 * The tokens are the child's own usage, reported the same way the child's chat header would
 * report them, and the cost is priced with the caller's lookup; both are `null` while the
 * child's log has said nothing.
 *
 * @param state the child's transcript
 * @param options see {@link TaskActivityOptions}
 */
export function taskActivityOf(
  state: TranscriptState,
  options: TaskActivityOptions = {},
): TaskActivityState {
  const usage = selectSessionUsage(state)
  const totals = usage.models.length === 0 ? null : usage.totals
  return {
    activity: activityLine(state),
    waiting: options.waiting === true,
    status: state.status,
    model: state.model,
    usage: totals,
    cost:
      totals === null || options.prices === undefined ? null : sessionCost(usage, options.prices),
  }
}

/**
 * The words a card's activity line is drawn with, or `null` when there is nothing to say
 * (issue #345).
 *
 * Both frontends draw the same sentence, so it is spelled once — a tool as `name: summary`
 * (or the bare name when the input has nothing short), a task list as `2 of 5`, and a model
 * that is writing as `writing…`. `idle` answers `null`: a card with nothing to report draws no
 * line rather than an empty one.
 *
 * @param activity the line {@link taskActivityOf} derived
 */
export function taskActivityLabel(activity: TaskActivityLine): string | null {
  switch (activity.kind) {
    case 'tool':
      return activity.summary === null ? activity.name : `${activity.name}: ${activity.summary}`
    case 'todos':
      return `${activity.done} of ${activity.total}`
    case 'writing':
      return 'writing…'
    case 'idle':
      return null
  }
}

/** The activity line a child's transcript implies — see {@link taskActivityOf} for the rules. */
function activityLine(state: TranscriptState): TaskActivityLine {
  const call = runningCall(state)
  if (call !== null) {
    return { kind: 'tool', name: call.name, summary: toolCallSummary(call) }
  }
  const todos = state.todos
  if (todos !== null && todos.length > 0) {
    return { kind: 'todos', done: completedCount(todos), total: todos.length }
  }
  return state.status === 'running' ? { kind: 'writing' } : { kind: 'idle' }
}

/** The newest call the child has out, or `null` when none is. */
function runningCall(state: TranscriptState): TranscriptToolCall | null {
  for (let index = state.toolCalls.length - 1; index >= 0; index -= 1) {
    const call = state.toolCalls[index]
    if (call?.status === 'running') {
      return call
    }
  }
  return null
}

/** How many of a list's items are done — the `N` of "N of M". */
function completedCount(todos: TodoList): number {
  return todos.filter((item) => item.status === 'done').length
}

/**
 * The part of a client that follows one session's log (issue #345).
 *
 * `client.sessions.events` satisfies it, and so does a hand-rolled double in a test — which is
 * what lets the activity be tested over a scripted stream without a server or a fake brain.
 */
export interface TaskActivityLog {
  /** Read the child's history once, page after page. */
  iterate(
    sessionId: string,
    params?: ListEventsQuery,
    options?: RequestOptions,
  ): AsyncIterable<StoredEvent>
  /** Follow the child live, from the `seq` the history stopped at. */
  stream(sessionId: string, options?: StreamOptions): AsyncIterable<StreamEvent>
}

/** A store that follows one child and answers what it is doing (issue #345). */
export interface TaskActivityWatcher {
  /**
   * The newest snapshot.
   *
   * **Stable between changes** — the same object comes back until something really moved — so
   * React's `useSyncExternalStore(getState, subscribe)` can compare by reference. Reading it
   * does not open a connection: nothing is followed until something subscribes.
   */
  getState(): TaskActivityState
  /**
   * Watch the child.
   *
   * The first listener starts the load (the history, then the live stream); the last one to
   * leave **unsubscribes** it, so nothing holds a connection to a child nobody is drawing. A
   * later subscriber starts it again, and the transcript's `seq` rule makes the second load a
   * no-op rather than a second copy.
   *
   * @param listener called with the new state after every change
   * @returns unsubscribe
   */
  subscribe(listener: (state: TaskActivityState) => void): () => void
  /** Stop following the child now, whether or not anything is watching. */
  close(): void
}

/**
 * Follow one child session and answer what it is doing (epic #340, S9; issue #345).
 *
 * ```ts
 * const activity = watchTaskActivity(client.sessions.events, card.childSessionId, { prices })
 * activity.subscribe(() => render(activity.getState()))
 * // … and `close()`, or the last unsubscribe, drops the connection.
 * ```
 *
 * The stream is the existing one (`events/stream`, reconnecting and resuming by `seq`), read
 * after the child's history so a card opened on a child that is already working shows its
 * current call rather than waiting for the next one. A failure to read or follow the child is
 * reported through `onDebug` and ends the follower: a card that cannot say what its child is
 * doing is a card with no activity line, never a chat that stops working.
 *
 * @param log the child's log — `client.sessions.events`, or a double in a test
 * @param sessionId the child's `sesn_` id, from {@link TaskCard.childSessionId}
 * @param options the catalog's prices and the debug hook; see
 *   {@link TaskActivityWatchOptions}
 */
export function watchTaskActivity(
  log: TaskActivityLog,
  sessionId: string,
  options: TaskActivityWatchOptions = {},
): TaskActivityWatcher {
  const transcript = createTranscript()
  const listeners = new Set<(state: TaskActivityState) => void>()
  let waiting = false
  let snapshot = NOTHING_YET
  let controller: AbortController | null = null

  const refresh = (): void => {
    const next = taskActivityOf(transcript.getState(), {
      waiting,
      ...(options.prices === undefined ? {} : { prices: options.prices }),
    })
    if (isSameActivity(snapshot, next)) {
      return
    }
    snapshot = next
    for (const listener of listeners) {
      listener(snapshot)
    }
  }

  const apply = (event: StreamEvent): void => {
    transcript.apply(event)
    if (event.type === EVENT_TYPES.sessionStatusIdle) {
      // The one thing the transcript does not keep: a turn that ended waiting on the child's
      // own tasks is what a card calls **waiting**, and the stop reason is the only record of
      // it (epic #340, S5).
      waiting = event.stop_reason.type === 'waiting_on_tasks'
    } else if (
      event.type === EVENT_TYPES.sessionStatusRunning ||
      event.type === EVENT_TYPES.sessionStatusRescheduled
    ) {
      waiting = false
    }
    refresh()
  }

  const follow = async (signal: AbortSignal): Promise<void> => {
    try {
      for await (const event of log.iterate(sessionId, undefined, { signal })) {
        if (signal.aborted) {
          return
        }
        apply(event)
      }
      for await (const event of log.stream(sessionId, {
        afterSeq: transcript.getState().lastSeq,
        signal,
      })) {
        if (signal.aborted) {
          return
        }
        apply(event)
      }
    } catch (error) {
      if (!signal.aborted) {
        options.onDebug?.('stopped following a task: its session could not be read', error)
      }
    } finally {
      // A follower that ended on its own — the child was deleted, or its log could not be read
      // — releases the slot, so the next watcher starts a fresh one instead of finding a
      // controller that no longer follows anything. A `stop` already cleared it, and the
      // guard is what keeps the two from disagreeing.
      if (controller?.signal === signal) {
        controller = null
      }
    }
  }

  const start = (): void => {
    if (controller !== null) {
      return
    }
    const next = new AbortController()
    controller = next
    void follow(next.signal)
  }

  const stop = (): void => {
    const current = controller
    controller = null
    current?.abort()
  }

  return {
    getState: () => snapshot,

    subscribe(listener) {
      listeners.add(listener)
      start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stop()
        }
      }
    },

    close() {
      listeners.clear()
      stop()
    },
  }
}

/** Whether two snapshots say the same thing, so a watcher can keep the object it had. */
function isSameActivity(current: TaskActivityState, next: TaskActivityState): boolean {
  return (
    current.waiting === next.waiting &&
    current.status === next.status &&
    current.model === next.model &&
    isSameLine(current.activity, next.activity) &&
    isSameTotals(current.usage, next.usage) &&
    current.cost?.cost === next.cost?.cost &&
    current.cost?.unpriced_requests === next.cost?.unpriced_requests
  )
}

/** Whether two activity lines are the same shape with the same words. */
function isSameLine(current: TaskActivityLine, next: TaskActivityLine): boolean {
  if (current.kind !== next.kind) {
    return false
  }
  switch (current.kind) {
    case 'tool':
      return next.kind === 'tool' && current.name === next.name && current.summary === next.summary
    case 'todos':
      return next.kind === 'todos' && current.done === next.done && current.total === next.total
    default:
      return true
  }
}

/** Whether two token totals are the same, counting `null` as "nothing reported yet". */
function isSameTotals(
  current: SessionUsageTotals | null,
  next: SessionUsageTotals | null,
): boolean {
  if (current === null || next === null) {
    return current === next
  }
  return (
    current.input === next.input &&
    current.output === next.output &&
    current.cacheCreation === next.cacheCreation &&
    current.cacheRead === next.cacheRead
  )
}
