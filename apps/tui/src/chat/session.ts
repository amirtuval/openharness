import { createTranscript } from '@openharness/client'
import type { Client, Transcript, TranscriptState } from '@openharness/client'
import type { Session } from '@openharness/protocol'

import { describeError, type ErrorContext } from '../errors'
import { CTRL_C_WINDOW_MS, decideCtrlC, type CtrlCAction } from './ctrl-c'

/** A line the chat shows above the status bar: a hint, or something that went wrong. */
export interface Notice {
  readonly kind: 'hint' | 'error'
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
  const transcript: Transcript = createTranscript()

  // Aborted by `dispose()`: every request the session owns hangs off it, so exiting cannot
  // leave a socket, a timer or a reconnect loop behind.
  const lifetime = new AbortController()
  let streamAbort: AbortController | undefined
  let state: ChatViewState = { transcript: transcript.getState(), phase: 'loading', notice: null }
  let armedAt: number | null = null
  const listeners = new Set<(state: ChatViewState) => void>()

  transcript.subscribe(() => {
    setState({ transcript: transcript.getState() })
  })

  function setState(patch: Partial<ChatViewState>): void {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  function noticeFor(error: unknown): Notice {
    const report = describeError(error, options.context)
    return { kind: 'error', text: report.message, hints: report.hints }
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
          transcript.apply(event)
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
      try {
        const stored = await client.sendMessage(sessionId, text, { signal: lifetime.signal })
        // Fold the stored event in now rather than waiting for the stream: the message shows
        // immediately, and the stream's copy of it is dropped as already seen.
        transcript.apply(stored)
        setState({ notice: null })
      } catch (error) {
        if (!lifetime.signal.aborted) setState({ notice: noticeFor(error) })
      }
    },

    async interrupt() {
      if (transcript.getState().status !== 'running') return
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
        transcript.apply(event)
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
