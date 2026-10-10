import {
  createTranscript,
  selectSessionUsage,
  type Client,
  type SessionUsage,
  type TranscriptError,
  type TranscriptMessage,
} from '@openharness/client'
import type { ModeId, Session, SessionStatus } from '@openharness/protocol'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { describeError } from '../lib/errors'
import { noteAuthenticationError } from '../lib/auth-store'
import { useSessionRefresh } from './use-session-refresh'
import { useSettings } from './use-settings'

/**
 * One open session: its transcript, its status, and the two things a user can do to it.
 *
 * The state flow is the one the client's transcript reducer is written for:
 *
 * 1. on mount (and whenever the session changes), load the log with `events.iterate` and fold
 *    it into a fresh transcript;
 * 2. then follow live with `events.stream(sessionId, { deltas: true, afterSeq: lastSeq })`,
 *    starting exactly where the history stopped, so nothing is replayed and nothing is missed;
 * 3. on unmount (leaving the session), abort the stream — the client ends the iteration
 *    quietly, so there is nothing to catch.
 *
 * Reloading the page is the same code path as opening the session for the first time, which is
 * why a reload restores the full history and resumes the stream: the log is the state.
 *
 * `send` and `interrupt` are the only writes. Both report failure through {@link requestError}
 * (an `ApiError` from the server) rather than throwing, so a screen can render it inline.
 */
export interface SessionView {
  /** The session resource: title, agent, timestamps. `null` until it has loaded. */
  readonly session: Session | null
  /** The conversation, in order. */
  readonly messages: readonly TranscriptMessage[]
  /** Whether the agent is working. */
  readonly status: SessionStatus
  /** The latest `session.error` in the log, until a reply supersedes it. */
  readonly lastError: TranscriptError | null
  /** The `seq` the transcript has folded in: where a resumed stream would pick up. */
  readonly lastSeq: number
  /** The history is still being loaded. */
  readonly loadingHistory: boolean
  /** A failed request — history, send or interrupt — as shown inline. */
  readonly requestError: string | null
  /** Whether the session was deleted (#111, epic #116, U5): its stream ended, its log is gone. */
  readonly deleted: boolean
  /**
   * The model the log last said the session runs (epic #116, U1): the id a `user.message`
   * switched it to, or the one the newest request ran, seeded from the session's own model
   * (#268). `null` only for a transcript nothing has told anything.
   */
  readonly model: string | null
  /**
   * What the session has spent (epic #245, A2; issue #247): the running totals the log reports,
   * or the same totals derived from the replies in it — a session stored before `session.usage`
   * existed has none of those events and still answers.
   *
   * Tokens only: the money is computed where the catalog's prices are, which is the screen's
   * business and not this hook's.
   */
  readonly usage: SessionUsage
  /**
   * Send a message. While the agent is running this is a steering message.
   *
   * `options.model` (`{ id }`) switches the session's model from this message on (U3), and
   * `options.rewindTo` restarts the session from a message the reader edited (#238,
   * "edit and resend"): the rewind and the message are one request, so the transcript is never
   * left without the edit. The answer says whether the message was stored, so a composer can
   * keep the text on a failure — including the 409 a rewind gets while a turn is running.
   */
  readonly send: (text: string, options?: { model?: string; rewindTo?: number }) => Promise<boolean>
  /**
   * Ask the brain to compact the older history now — `/compact [instructions]` (#283).
   *
   * `instructions` is the reader's guidance for the summary, or `undefined` for none. The
   * stored request is folded into the transcript at once, so the composer clears and the log
   * shows the ask; the outcome arrives on the stream like any other event. Answers whether the
   * request was stored, so the composer keeps the text on a failure.
   */
  readonly compact: (instructions?: string) => Promise<boolean>
  /** Ask the running session to stop. */
  readonly interrupt: () => Promise<void>
  /** Clear {@link requestError}. */
  readonly dismissError: () => void
}

/**
 * Follow one session: history into the transcript, then the live stream.
 *
 * The caller is expected to remount (or change `sessionId`) when the user opens a different
 * session; the transcript lives exactly as long as the hook call does.
 */
export function useSession(client: Client, sessionId: string): SessionView {
  const transcript = useMemo(() => createTranscript(), [client, sessionId])
  // `useSyncExternalStore` wants the two functions as values; taken off the store they would
  // be unbound methods, so hand it closures over this transcript instead.
  const subscribe = useCallback(
    (listener: () => void) => transcript.subscribe(listener),
    [transcript],
  )
  const getSnapshot = useCallback(() => transcript.getState(), [transcript])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const [loaded, setLoaded] = useState<Session | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [requestError, setRequestError] = useState<string | null>(null)
  // A failure of our own is described with the server the client is pointed at, so a request
  // that never arrived can say where it did not arrive.
  const { serverUrl } = useSettings()
  // The session as the freshest read of it: the mount fetch below, or — once this chat has
  // said something — the re-read that turns the agent's name into the title the server
  // derived (#35). Both the sidebar row and this header read that one copy.
  const { sessions: fresh, refresh } = useSessionRefresh(client)
  const session = fresh.get(sessionId) ?? loaded

  useEffect(() => {
    const controller = new AbortController()

    const follow = async (): Promise<void> => {
      setLoadingHistory(true)
      try {
        const opened = await client.sessions.get(sessionId, { signal: controller.signal })
        if (controller.signal.aborted) {
          return
        }
        setLoaded(opened)
        // Seed the transcript with the model the session runs before replaying its log (#268):
        // the first message a reader switches the model on then has something to differ from,
        // so the marker the composer draws matches the one a live view drew. The replay
        // corrects the baseline from each request's span, so a resumed chat lands on the same
        // markers however much history it loaded.
        transcript.reset({ model: opened.model.id })

        for await (const event of client.sessions.events.iterate(
          sessionId,
          {},
          { signal: controller.signal },
        )) {
          transcript.apply(event)
        }
      } catch (caught) {
        if (!controller.signal.aborted && !noteAuthenticationError(client, caught)) {
          setRequestError(describeError(caught, { serverUrl }))
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoadingHistory(false)
        }
      }

      if (controller.signal.aborted) {
        return
      }

      try {
        for await (const event of client.sessions.events.stream(sessionId, {
          deltas: true,
          afterSeq: transcript.getState().lastSeq,
          signal: controller.signal,
        })) {
          transcript.apply(event)
        }
      } catch (caught) {
        // An abort ends the iteration quietly; anything else — a revoked session, an unknown
        // session — is worth showing, because the stream is not coming back on its own. A
        // 401 is not shown at all: it signs the app out and the sign-in page takes over.
        if (!controller.signal.aborted && !noteAuthenticationError(client, caught)) {
          setRequestError(describeError(caught, { serverUrl }))
        }
      }
    }

    void follow()
    return () => controller.abort()
  }, [client, sessionId, transcript, serverUrl])

  // A session is named by the request that stores its first message (`lib/session-refresh`),
  // so a chat that has said something and still shows no title is one whose copy predates it:
  // this tab's own send, or a first message another tab just streamed in. Ask for a re-read —
  // the store decides whether there is one to make, and never makes a second.
  const saidSomething = state.messages.some((message) => message.role === 'user')
  const titled = session !== null && session.title !== null
  useEffect(() => {
    if (saidSomething && !titled) {
      refresh(sessionId)
    }
  }, [saidSomething, titled, refresh, sessionId])

  const send = useCallback(
    async (
      text: string,
      options?: { model?: string; mode?: ModeId | null; rewindTo?: number },
    ): Promise<boolean> => {
      const body = text.trim()
      if (body === '') {
        return false
      }
      setRequestError(null)
      try {
        const stored = await client.sendMessage(sessionId, body, {
          ...(options?.model === undefined ? {} : { model: { id: options.model } }),
          // A mode rides the message the way a model does (#245, M6): the log records the
          // choice, and the session follows the mode from here on. `null` detaches.
          ...(options?.mode === undefined ? {} : { mode: options.mode }),
          ...(options?.rewindTo === undefined ? {} : { rewindTo: options.rewindTo }),
        })
        // Show the message at once instead of waiting for the stream to echo it: the client
        // returns the stored event, and the reducer drops the stream's copy of it (same `seq`).
        transcript.apply(stored)
        return true
      } catch (caught) {
        if (!noteAuthenticationError(client, caught)) {
          setRequestError(describeError(caught, { serverUrl }))
        }
        return false
      }
    },
    [client, sessionId, transcript, serverUrl],
  )

  const compact = useCallback(
    async (instructions?: string): Promise<boolean> => {
      setRequestError(null)
      try {
        const request = await client.sessions.compact(sessionId, {
          ...(instructions === undefined ? {} : { instructions }),
        })
        // The request shows at once, like a sent message: the reducer folds the stored event in
        // and the stream's echo of it is dropped by the `seq` rule. The outcome the brain writes
        // arrives later, on the stream.
        transcript.apply(request)
        return true
      } catch (caught) {
        if (!noteAuthenticationError(client, caught)) {
          setRequestError(describeError(caught, { serverUrl }))
        }
        return false
      }
    },
    [client, sessionId, transcript, serverUrl],
  )

  const interrupt = useCallback(async (): Promise<void> => {
    setRequestError(null)
    try {
      await client.interrupt(sessionId)
    } catch (caught) {
      if (!noteAuthenticationError(client, caught)) {
        setRequestError(describeError(caught, { serverUrl }))
      }
    }
  }, [client, sessionId, serverUrl])

  const dismissError = useCallback(() => {
    setRequestError(null)
  }, [])

  return {
    session,
    messages: state.messages,
    usage: selectSessionUsage(state),
    status: state.status,
    lastError: state.lastError,
    lastSeq: state.lastSeq,
    loadingHistory,
    requestError,
    deleted: state.deleted,
    model: state.model,
    send,
    compact,
    interrupt,
    dismissError,
  }
}
