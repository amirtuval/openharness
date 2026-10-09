import type { Client } from '@openharness/client'
import type { ModeId, Session } from '@openharness/protocol'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { describeError } from '../lib/errors'
import { noteAuthenticationError } from '../lib/auth-store'
import { appendUnseen, listAllPages } from '../lib/paging'
import { withFreshSessions } from '../lib/session-refresh'
import { useSessionRefresh } from './use-session-refresh'
import { useSettings } from './use-settings'

/** Why a delete did not happen. */
export type DeleteSessionResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string }

/** Everything the session list needs, plus creating one and deleting one. */
export interface SessionsView {
  /** The sessions, newest first. */
  readonly sessions: readonly Session[]
  /** The list is still loading for the first time. */
  readonly loading: boolean
  /** The list hit the safety cap; the server has more sessions than are shown. */
  readonly truncated: boolean
  /** A failed list or create, as shown inline. */
  readonly error: string | null
  /** Create a model-first (or mode-first) session, refresh the list, and return it (`null` on failure). */
  readonly create: (options: CreateChatOptions) => Promise<CreateChatResult>
  /**
   * Delete a session and everything in it (epic #116, U5), removing its row.
   *
   * The failure is returned rather than put on the list error: the list is fine — one
   * delete failed — and the screen that asked shows it next to the row it was about.
   */
  readonly remove: (sessionId: string) => Promise<DeleteSessionResult>
  /**
   * Drop a session from the list without calling the server: another writer deleted it and
   * the stream said so (`session.deleted`), so the row has to go too (U5).
   */
  readonly forget: (sessionId: string) => void
  /** Load the list again. */
  readonly refresh: () => void
}

/** The session list, and creating a model-first session. */
export function useSessions(client: Client): SessionsView {
  const [listed, setSessions] = useState<readonly Session[]>([])
  const [loading, setLoading] = useState(true)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  // A session re-read after its first message (#35, `lib/session-refresh`) is the fresher
  // copy of its row: the title the server derived is not in the list this hook loaded. This
  // is how the row changes without the list being fetched again — the shell's list, the
  // open chat's header, one read.
  const { sessions: fresh } = useSessionRefresh(client)
  const sessions = useMemo(() => withFreshSessions(listed, fresh), [listed, fresh])
  // A failure of our own is described with the server the client is pointed at, so a request
  // that never arrived can say where it did not arrive.
  const { serverUrl } = useSettings()

  useEffect(() => {
    const controller = new AbortController()
    const load = async (): Promise<void> => {
      setLoading(true)
      // All of them, one page at a time: the sidebar is the only way to an older chat, so a
      // list that stops after the first page hides those chats for good.
      let firstPage = true
      try {
        const result = await listAllPages(
          (query, options) => client.sessions.list(query, options),
          {
            signal: controller.signal,
            onPage: (page) => {
              if (controller.signal.aborted) {
                return
              }
              // The first page shows as soon as it arrives — the sidebar stays usable while
              // the rest of a long list loads behind it.
              if (firstPage) {
                firstPage = false
                setSessions(page)
              } else {
                setSessions((current) => appendUnseen(current, page))
              }
            },
          },
        )
        if (controller.signal.aborted) {
          return
        }
        setTruncated(result.truncated)
        setError(null)
      } catch (caught) {
        if (!controller.signal.aborted && !noteAuthenticationError(client, caught)) {
          setError(describeError(caught, { serverUrl }))
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    }

    void load()
    return () => controller.abort()
  }, [client, revision, serverUrl])

  const refresh = useCallback(() => {
    setRevision((current) => current + 1)
  }, [])

  const create = useCallback(
    async (options: CreateChatOptions): Promise<CreateChatResult> => {
      try {
        // Model-first (epic #92, #93): a session is created from a model — or, since #245 (M6),
        // from a mode, which the server resolves to the session's header model.
        const session = await client.sessions.create({
          ...(options.model === undefined ? {} : { model: { id: options.model } }),
          ...(options.mode === undefined ? {} : { mode: options.mode }),
        })
        setSessions((current) => [session, ...current])
        setError(null)
        return { ok: true, session }
      } catch (caught) {
        if (noteAuthenticationError(client, caught)) {
          return { ok: false, message: 'Your session ended. Sign in again to continue.' }
        }
        const message = describeError(caught, { serverUrl })
        setError(message)
        return { ok: false, message }
      }
    },
    [client, serverUrl],
  )

  const remove = useCallback(
    async (sessionId: string): Promise<DeleteSessionResult> => {
      try {
        await client.sessions.delete(sessionId)
        setSessions((current) => current.filter((session) => session.id !== sessionId))
        return { ok: true }
      } catch (caught) {
        // A 401 still signs the app out; the message is what a caller shows if it does not.
        if (noteAuthenticationError(client, caught)) {
          return { ok: false, message: 'Your session ended. Sign in again to continue.' }
        }
        return { ok: false, message: describeError(caught, { serverUrl }) }
      }
    },
    [client, serverUrl],
  )

  const forget = useCallback((sessionId: string): void => {
    setSessions((current) => current.filter((session) => session.id !== sessionId))
  }, [])

  return { sessions, loading, truncated, error, create, remove, forget, refresh }
}

/** The outcome of creating a chat: the session, or why it could not be created. */
export type CreateChatResult =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly message: string }

/** What a new chat is created from (#245, M6): a model id, or one of the reader's modes. */
export interface CreateChatOptions {
  /** The `provider/model` a model-first session runs. */
  readonly model?: string
  /** The mode the session follows, instead of a model. The server resolves its model. */
  readonly mode?: ModeId
}
