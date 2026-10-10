import { createTranscript, initialTranscriptState } from '@openharness/client'
import type { Client, Transcript, TranscriptState } from '@openharness/client'
import { EVENT_TYPES } from '@openharness/protocol'
import type { Mode, ModeId, ModelEntry, Session, StreamEvent } from '@openharness/protocol'

import { describeError, type ErrorContext } from '../errors'
import { CTRL_C_WINDOW_MS, decideCtrlC, type CtrlCAction } from './ctrl-c'

/**
 * A line the chat shows above the status bar.
 *
 * - `hint` is transient: typing drops it, which is what makes "press Ctrl+C again to exit"
 *   a thing that goes away rather than a thing to dismiss.
 * - `error` is something that went wrong, kept until the next message.
 * - `info` is a command's own output (`/help`) — also kept until the next message, and
 *   deliberately not dropped by a keystroke: what a command printed is not a hint.
 */
export interface Notice {
  readonly kind: 'hint' | 'error' | 'info'
  readonly text: string
  readonly hints: readonly string[]
}

/** Everything the chat screen renders, in one subscribable object. */
export interface ChatViewState {
  /** The conversation, from the client's transcript reducer. */
  readonly transcript: TranscriptState
  /** `loading` until history is in; `ready` once the stream is following. */
  readonly phase: 'loading' | 'ready' | 'closed'
  /** The transient line, or `null`. */
  readonly notice: Notice | null
  /**
   * A model `/model` picked but that no message has carried yet (#114, epic #116 U3): it
   * rides the next message, so the status line says so until then.
   */
  readonly pendingModel: string | null
  /**
   * A mode `/model` picked but that no message has carried yet (#245, M6): it rides the next
   * message, exactly as {@link ChatViewState.pendingModel} does.
   */
  readonly pendingMode: ModeId | null
  /**
   * The mode the chat follows (#245, M6), or `null` for a chat without one.
   *
   * Seeded from the session and moved by a send that carried a mode (or a plain model, which
   * detaches), because the transcript tracks models and not modes — the status line needs the
   * mode's name, and the log is the only other place it could come from.
   */
  readonly modeId: ModeId | null
  /**
   * When the turn in progress began, in epoch milliseconds — `null` between turns (#208).
   *
   * Read off the `session.status_running` event's `processed_at` rather than off the local
   * clock, so a session resumed mid-turn still counts from when the turn really started. It
   * is the baseline the working indicator's elapsed time is measured from.
   */
  readonly runningSince: number | null
  /**
   * When the last text of the turn arrived, in epoch milliseconds — `null` before any has
   * (#208). A delta or a stored reply counts; the indicator watches it to tell a reply that
   * is producing text from one that has gone quiet.
   */
  readonly lastTextAt: number | null
  /**
   * The reply whose `span.model_request_end` is still outstanding, or `null` (#208).
   *
   * The transcript keeps a model request until its span end folds that request's tokens and
   * duration into the reply, so a request that names a message is a reply whose metadata is
   * on its way. `TranscriptView` holds that reply live until it is not: a settled message is
   * written once by Ink's `<Static>` and never redrawn, so the metadata line has to land
   * before the message settles or it never lands at all (epic #201, X2).
   */
  readonly awaitingMetaId: string | null
  /** The user cut the turn short with Ctrl+C, until the next turn or the next send (#208). */
  readonly interrupted: boolean
}

/** What {@link createChatSession} needs. */
export interface ChatSessionOptions {
  /** The client to talk to — the real one, or the fake in dev mode. */
  readonly client: Client
  /** The session to chat in. Its agent supplies the name and model for the status bar. */
  readonly session: Session
  /** The clock, for the Ctrl+C window. */
  readonly now?: (() => number) | undefined
  /** How long an idle Ctrl+C stays armed; see {@link decideCtrlC}. */
  readonly ctrlCWindowMs?: number | undefined
  /** What the error messages should mention. */
  readonly context?: ErrorContext | undefined
}

/**
 * The chat's runtime: the transcript, the stream that feeds it, and the few operations the
 * UI can ask for.
 *
 * It is deliberately not a React component. The transcript is the client's store, the
 * stream is started once and left running, and everything the screen needs is in one
 * {@link ChatViewState} that a `useSyncExternalStore` can hold — which keeps the Ink code
 * down to rendering, and lets the streaming rules be tested without a terminal.
 */
export interface ChatSession {
  /** The session being chatted in. */
  readonly session: Session
  /** The current view state; stable between changes, so React can compare by reference. */
  readonly getState: () => ChatViewState
  /**
   * Watch the view state.
   *
   * A property rather than a method so `useSyncExternalStore(session.subscribe,
   * session.getState)` can take it without unbinding anything.
   */
  readonly subscribe: (listener: (state: ChatViewState) => void) => () => void
  /**
   * Load the session's history, then follow it live.
   *
   * History comes from `events.iterate` and the live tail from `events.stream`, resumed at
   * the transcript's `lastSeq` so the seam between them cannot drop or repeat an event.
   */
  readonly start: () => Promise<void>
  /** Send a message. Allowed while a turn is running — that is what steering is. */
  readonly send: (text: string) => Promise<void>
  /**
   * Ask the brain to compact the older history now — `/compact [instructions]` (#283).
   *
   * `instructions` is the reader's guidance for the summary, or empty for none. The request is
   * stored and folded into the transcript; the outcome the brain writes arrives on the stream
   * and is shown as a notice, so `/compact` is never a silent no-op.
   */
  readonly compact: (instructions: string) => Promise<void>
  /**
   * Remember a model for the next message (#114, epic #116 U3): the choice is sent on the
   * next `user.message`, which is what makes the session run it from then on.
   */
  readonly setModel: (modelId: string) => void
  /**
   * Remember a mode for the next message (#245, M6): it rides the next `user.message`, which
   * is what makes the session follow it from then on. A model pick and a mode pick are one
   * choice, so this clears any pending model.
   */
  readonly setMode: (modeId: ModeId) => void
  /** The catalog, for the in-chat model picker. */
  readonly listModels: () => Promise<readonly ModelEntry[]>
  /** The user's modes, for the in-chat picker and the status line (#245, M6). */
  readonly listModes: () => Promise<readonly Mode[]>
  /** Show an error the screen hit itself, e.g. a catalog that would not load. */
  readonly reportError: (error: unknown) => void
  /**
   * Show a line of the caller's own — a command's output (`/help`), or an unknown command's
   * suggestion (#207). It replaces whatever was there, and the next message clears it.
   */
  readonly showNotice: (notice: Notice) => void
  /** Ask a running turn to stop, keeping what it has produced so far. */
  readonly interrupt: () => Promise<void>
  /** Apply the Ctrl+C rules; the caller exits when this returns `exit`. */
  readonly pressCtrlC: () => CtrlCAction
  /** Drop a hint (typing dismisses "press Ctrl+C again"); errors stay. */
  readonly dismissHint: () => void
  /** Abort the stream and any request in flight. Idempotent. */
  readonly dispose: () => void
}

/** Build a chat session. Nothing is requested until {@link ChatSession.start} is called. */
export function createChatSession(options: ChatSessionOptions): ChatSession {
  const client = options.client
  const session = options.session
  const sessionId = session.id
  const now = options.now ?? ((): number => Date.now())
  // Seeded with the model the session runs (#268), so the first `/model` switch a reader makes
  // is a change the status line's marker state can compare against — the same baseline the web
  // hook seeds at its end. The replay corrects it from each request's span.
  const transcript: Transcript = createTranscript(
    initialTranscriptState({ model: session.model.id }),
  )

  // Aborted by `dispose()`: every request the session owns hangs off it, so exiting cannot
  // leave a socket, a timer or a reconnect loop behind.
  const lifetime = new AbortController()
  let streamAbort: AbortController | undefined
  let state: ChatViewState = {
    transcript: transcript.getState(),
    phase: 'loading',
    notice: null,
    pendingModel: null,
    pendingMode: null,
    // The mode the session resource says the chat follows (#245, M6); a send that carries one
    // (or a plain model, which detaches) moves it.
    modeId: session.mode,
    runningSince: null,
    lastTextAt: null,
    awaitingMetaId: null,
    interrupted: false,
  }
  let armedAt: number | null = null
  const listeners = new Set<(state: ChatViewState) => void>()

  transcript.subscribe(() => {
    const next = transcript.getState()
    // A `session.deleted` is terminal (epic #116 U5): the log is gone, so the chat is over.
    // The notice is what the screen has to show before it exits; the screen exits on it.
    if (next.deleted && state.phase !== 'closed') {
      setState({
        transcript: next,
        phase: 'closed',
        notice: { kind: 'hint', text: 'This chat was deleted elsewhere.', hints: [] },
      })
      return
    }
    setState({
      transcript: next,
      runningSince,
      lastTextAt,
      awaitingMetaId: awaitingMeta(next),
      interrupted,
    })
  })

  function setState(patch: Partial<ChatViewState>): void {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  function noticeFor(error: unknown): Notice {
    const report = describeError(error, options.context)
    return { kind: 'error', text: report.message, hints: report.hints }
  }

  // The working indicator's clock (issue #208): when the turn started, when text last
  // arrived, and whether the user cut it short. Beside the transcript rather than in it —
  // these are facts about the session's *time*, which the reducers have no business in.
  let runningSince: number | null = null
  let lastTextAt: number | null = null
  let interrupted = false

  /** Fold an event into the transcript, noting what it says about the clock first. */
  function apply(event: StreamEvent): void {
    noteTiming(event)
    transcript.apply(event)
  }

  /**
   * Note what an event says about the working indicator's clock (issue #208).
   *
   * A turn starts at `session.status_running` — and at `session.status_rescheduled`, which is
   * what a retry emits before it runs again — and ends at `session.status_idle`, where the
   * elapsed time and the quiet window are both reset. Text is a delta or a stored reply: the
   * two ways a reply says it is getting somewhere.
   *
   * The timestamps come from the events' own `processed_at` rather than from the local clock,
   * so history lands on the turn's real start. The local clock would have `oh -s` into a
   * session that has been running for a minute open on `Working… 0s`, which is the one number
   * a reader would act on.
   */
  function noteTiming(event: StreamEvent): void {
    switch (event.type) {
      case EVENT_TYPES.sessionStatusRunning:
      case EVENT_TYPES.sessionStatusRescheduled:
        runningSince = epochMs(event.processed_at) ?? now()
        interrupted = false
        break
      case EVENT_TYPES.sessionStatusIdle:
        runningSince = null
        lastTextAt = null
        break
      case EVENT_TYPES.eventDelta:
      case EVENT_TYPES.agentMessage:
        lastTextAt = epochMs(event.processed_at) ?? now()
        break
      default:
        break
    }
  }

  const chat: ChatSession = {
    session,

    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async start() {
      try {
        for await (const event of client.sessions.events.iterate(sessionId, undefined, {
          signal: lifetime.signal,
        })) {
          apply(event)
        }
      } catch (error) {
        if (!lifetime.signal.aborted) setState({ notice: noticeFor(error) })
      }

      if (lifetime.signal.aborted) return
      setState({ phase: 'ready' })
      void follow()
    },

    async send(text) {
      if (text.trim() === '') return
      armedAt = null
      // Sending is the end of whatever the last turn was, interrupted or not (issue #208):
      // the status line stops saying so the moment there is something newer to say.
      interrupted = false
      // A model `/model` picked rides this message (epic #116 U3); the session runs it from
      // the turn the message starts, and it is cleared whether or not the send worked —
      // a failed send stored nothing, so there is nothing for the choice to have applied to.
      const pending = state.pendingModel
      const pendingMode = state.pendingMode
      try {
        const stored = await client.sendMessage(sessionId, text, {
          signal: lifetime.signal,
          ...(pendingMode === null ? {} : { mode: pendingMode }),
          ...(pendingMode !== null || pending === null ? {} : { model: { id: pending } }),
        })
        // Fold the stored event in now rather than waiting for the stream: the message shows
        // immediately, and the stream's copy of it is dropped as already seen. The mode the
        // message carried is the mode the chat follows now — and a plain model switch detaches
        // it, which is what a chat follows one or the other means (#245, M6).
        apply(stored)
        setState({
          notice: null,
          pendingModel: null,
          pendingMode: null,
          modeId: pendingMode !== null ? pendingMode : pending !== null ? null : state.modeId,
          interrupted: false,
        })
      } catch (error) {
        if (!lifetime.signal.aborted) {
          setState({ notice: noticeFor(error), pendingModel: null, pendingMode: null })
        }
      }
    },

    async compact(instructions) {
      armedAt = null
      const guidance = instructions.trim()
      try {
        const request = await client.sessions.compact(sessionId, {
          signal: lifetime.signal,
          ...(guidance === '' ? {} : { instructions: guidance }),
        })
        // The request is stored; fold it in now so the log has it, and the transcript's
        // `manualCompaction` goes pending — which is what the status line's "Compacting…" is
        // drawn from, in both frontends. The outcome the brain writes arrives on the stream.
        apply(request)
      } catch (error) {
        if (!lifetime.signal.aborted) {
          setState({ notice: noticeFor(error) })
        }
      }
    },

    setModel(modelId) {
      // Picking a model is activity: it dismisses the armed exit, like typing does. It also
      // clears a pending mode (#245, M6): a chat follows a mode or a plain model, never both.
      armedAt = null
      setState({ pendingModel: modelId, pendingMode: null, notice: null })
    },

    setMode(modeId) {
      armedAt = null
      setState({ pendingMode: modeId, pendingModel: null, notice: null })
    },

    async listModels() {
      return (await client.models.list()).data
    },

    async listModes() {
      return (await client.modes.list()).data
    },

    reportError(error) {
      setState({ notice: noticeFor(error) })
    },

    showNotice(notice) {
      // A command is activity, the way picking a model is: it disarms an armed exit.
      armedAt = null
      setState({ notice })
    },

    async interrupt() {
      if (transcript.getState().status !== 'running') return
      // Said at once rather than when the server answers: the interrupt is the user's own
      // action, and a status line that took a round trip to say so would look like nothing
      // had happened (#208). The turn is over either way — a failed interrupt says so in a
      // notice beside this.
      interrupted = true
      setState({ interrupted: true })
      try {
        await client.interrupt(sessionId, { signal: lifetime.signal })
      } catch (error) {
        if (!lifetime.signal.aborted) setState({ notice: noticeFor(error) })
      }
    },

    pressCtrlC(): CtrlCAction {
      const decision = decideCtrlC({
        running: transcript.getState().status === 'running',
        now: now(),
        armedAt,
        windowMs: options.ctrlCWindowMs ?? CTRL_C_WINDOW_MS,
      })
      armedAt = decision.armedAt

      switch (decision.action) {
        case 'interrupt':
          setState({ notice: null })
          void chat.interrupt()
          break
        case 'arm':
          setState({
            notice: { kind: 'hint', text: 'Press Ctrl+C again to exit.', hints: [] },
          })
          break
        case 'exit':
          setState({ notice: null })
          break
      }

      return decision.action
    },

    dismissHint() {
      if (state.notice?.kind === 'hint') {
        armedAt = null
        setState({ notice: null })
      }
    },

    dispose() {
      streamAbort?.abort()
      streamAbort = undefined
      if (!lifetime.signal.aborted) lifetime.abort()
      if (state.phase !== 'closed') setState({ phase: 'closed' })
    },
  }

  /** Follow the log until {@link ChatSession.dispose} aborts it. */
  async function follow(): Promise<void> {
    const controller = new AbortController()
    streamAbort = controller

    try {
      const events = client.sessions.events.stream(sessionId, {
        deltas: true,
        afterSeq: transcript.getState().lastSeq,
        signal: controller.signal,
      })

      for await (const event of events) {
        apply(event)
      }
    } catch (error) {
      // An abort is the normal way out. Anything else — a key the server will not take, a
      // validation failure — is worth showing, and the transcript keeps what arrived.
      if (!controller.signal.aborted) setState({ notice: noticeFor(error) })
    } finally {
      if (streamAbort === controller) streamAbort = undefined
    }
  }

  return chat
}

/**
 * The reply whose metadata has not landed yet, or `null` (issue #208).
 *
 * The transcript tracks a model request until its `span.model_request_end` folds that
 * request's tokens and duration into the reply it belongs to, so the last request that names
 * a message is a reply still waiting for its span end. Requests that name no message — a
 * failed attempt a retry has yet to fold in — say nothing about what is on screen.
 */
function awaitingMeta(transcript: TranscriptState): string | null {
  return transcript.pendingRequests.reduce<string | null>(
    (last, request) => request.messageId ?? last,
    null,
  )
}

/** A timestamp as epoch milliseconds, or `undefined` when it is not a date at all. */
function epochMs(timestamp: string): number | undefined {
  const ms = Date.parse(timestamp)
  return Number.isNaN(ms) ? undefined : ms
}
