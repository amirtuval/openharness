import { ApiError, type Client } from '@openharness/client'
import type { CreateModeRequest, Mode, UpdateModeRequest } from '@openharness/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'

import { noteAuthenticationError } from '../lib/auth-store'
import { describeError } from '../lib/errors'
import { useSettings } from './use-settings'

/**
 * Why a mode write did not happen.
 *
 * - `conflict` — the server refused it as a conflict (#245, M6): a name the reader already has,
 *   or the twenty-first mode. The message belongs beside the form, because editing the name (or
 *   deleting one) fixes it.
 * - `session` — a 401: the reader has to sign in again.
 * - `error` — anything else, as one line.
 */
export type ModeFailureKind = 'conflict' | 'session' | 'error'

/** The outcome of a create, update or delete. */
export type ModeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: ModeFailureKind; readonly message: string }

/** The outcome of a write, carrying what was stored — so the list can be updated in place. */
export type ModeWriteResult =
  | { readonly ok: true; readonly mode: Mode }
  | { readonly ok: false; readonly kind: ModeFailureKind; readonly message: string }

/** The modes the shell reads: the list, and creating, editing and deleting one. */
export interface ModesView {
  /** The reader's own modes, oldest first, as the server sorted them. */
  readonly modes: readonly Mode[]
  /** The first load is still in flight. */
  readonly loading: boolean
  /** A failed load, as shown inline. */
  readonly error: string | null
  /** Create a mode; a duplicate name or the twentieth-plus-one is `conflict`. */
  readonly create: (body: CreateModeRequest) => Promise<ModeWriteResult>
  /** Edit a mode; omitted fields keep their value, `null` clears a nullable one. */
  readonly update: (modeId: string, body: UpdateModeRequest) => Promise<ModeWriteResult>
  /** Delete a mode; the chats that followed it continue on the model they last ran. */
  readonly remove: (modeId: string) => Promise<ModeResult>
  /** Read the list again. */
  readonly reload: () => Promise<void>
  /** Clear the load error. */
  readonly dismissError: () => void
}

/**
 * The reader's modes (#245, M6), loaded once for the whole shell.
 *
 * Modes are small and per user (at most twenty), and the surfaces that need them — Settings,
 * both model pickers and the chat header — all want the same copy, so this is loaded in the
 * shell beside the catalog and threaded down the same way. Every write updates the list in
 * place, so the picker offers a mode the moment it is saved and drops one the moment it is
 * deleted, with no read of its own.
 */
export function useModes(client: Client): ModesView {
  const [modes, setModes] = useState<readonly Mode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // An answer that arrives after the hook unmounted — or after a settings save rebuilt the
  // client, which re-runs the effect below — must not be applied.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const { serverUrl } = useSettings()

  const apply = useCallback((next: readonly Mode[]): void => {
    if (!mounted.current) {
      return
    }
    setModes(next)
    setError(null)
  }, [])

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const response = await client.modes.list(signal === undefined ? undefined : { signal })
        apply(response.data)
      } catch (caught) {
        if (signal?.aborted === true) {
          return
        }
        if (!noteAuthenticationError(client, caught)) {
          setError(describeError(caught, { serverUrl }))
        }
      }
    },
    [client, serverUrl, apply],
  )

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void load(controller.signal).finally(() => {
      if (!controller.signal.aborted) {
        setLoading(false)
      }
    })
    return () => controller.abort()
  }, [load])

  const failureOf = useCallback(
    (caught: unknown): { ok: false; kind: ModeFailureKind; message: string } => {
      if (caught instanceof ApiError && caught.type === 'conflict_error') {
        return { ok: false, kind: 'conflict', message: caught.message }
      }
      return { ok: false, kind: 'error', message: describeError(caught, { serverUrl }) }
    },
    [serverUrl],
  )

  const create = useCallback(
    async (body: CreateModeRequest): Promise<ModeWriteResult> => {
      try {
        const mode = await client.modes.create(body)
        setModes((current) => [...current, mode])
        return { ok: true, mode }
      } catch (caught) {
        if (noteAuthenticationError(client, caught)) {
          return { ok: false, kind: 'session', message: 'Your session ended. Sign in again.' }
        }
        return failureOf(caught)
      }
    },
    [client, failureOf],
  )

  const update = useCallback(
    async (modeId: string, body: UpdateModeRequest): Promise<ModeWriteResult> => {
      try {
        const mode = await client.modes.update(modeId, body)
        setModes((current) => current.map((stored) => (stored.id === modeId ? mode : stored)))
        return { ok: true, mode }
      } catch (caught) {
        if (noteAuthenticationError(client, caught)) {
          return { ok: false, kind: 'session', message: 'Your session ended. Sign in again.' }
        }
        return failureOf(caught)
      }
    },
    [client, failureOf],
  )

  const remove = useCallback(
    async (modeId: string): Promise<ModeResult> => {
      try {
        await client.modes.delete(modeId)
        setModes((current) => current.filter((mode) => mode.id !== modeId))
        return { ok: true }
      } catch (caught) {
        if (noteAuthenticationError(client, caught)) {
          return { ok: false, kind: 'session', message: 'Your session ended. Sign in again.' }
        }
        return failureOf(caught)
      }
    },
    [client, failureOf],
  )

  const reload = useCallback(async (): Promise<void> => {
    await load()
  }, [load])

  const dismissError = useCallback(() => {
    setError(null)
  }, [])

  return { modes, loading, error, create, update, remove, reload, dismissError }
}
