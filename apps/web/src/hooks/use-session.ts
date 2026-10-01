import {
  createTranscript,
  type Client,
  type TranscriptError,
  type TranscriptMessage,
} from '@openharness/client'
import type { Session, SessionStatus } from '@openharness/protocol'
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
  /** Send a message. While the agent is running this is a steering message. */
  readonly send: (text: string) => Promise<void>
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
    async (text: string): Promise<void> => {
      const body = text.trim()
      if (body === '') {
        return
      }
      setRequestError(null)
      try {
        const stored = await client.sendMessage(sessionId, body)
        // Show the message at once instead of waiting for the stream to echo it: the client
        // returns the stored event, and the reducer drops the stream's copy of it (same `seq`).
        transcript.apply(stored)
      } catch (caught) {
        if (!noteAuthenticationError(client, caught)) {
          setRequestError(describeError(caught, { serverUrl }))
        }
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
    status: state.status,
    lastError: state.lastError,
    lastSeq: state.lastSeq,
    loadingHistory,
    requestError,
    send,
    interrupt,
    dismissError,
  }
}
