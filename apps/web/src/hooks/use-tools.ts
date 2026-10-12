import type { Client } from '@openharness/client'
import type {
  BuiltinToolSetting,
  ListToolSettingsResponse,
  ModeId,
  ToolName,
} from '@openharness/protocol'
import { useCallback, useEffect, useState } from 'react'

import { noteAuthenticationError } from '../lib/auth-store'
import { describeError } from '../lib/errors'
import { useSettings } from './use-settings'

/** Why a tool-settings write did not happen. */
export type SaveToolsResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string }

/** The caller's tool settings (epic #303, X4; #307; the screen is #308). */
export interface ToolsView {
  /** The effective entries, once the server has answered. */
  readonly tools: ListToolSettingsResponse | null
  /** The first read is still in flight. */
  readonly loading: boolean
  /** A failed read or write, as shown inline. */
  readonly error: string | null
  /** A write is in flight. */
  readonly saving: boolean
  /**
   * Merge one tool's whole setting over what is stored, and read the result back.
   *
   * The write is per tool (`PUT /v1/me/tools` merges), so a card that flips one switch never
   * disturbs another. The server's answer replaces what this view holds, so the entries always
   * show the effective state — a mode's override included, when one was named.
   */
  readonly save: (name: ToolName, setting: BuiltinToolSetting) => Promise<SaveToolsResult>
  /** Read the entries again, after a write another tab made. */
  readonly reload: () => Promise<void>
  /** Clear the error. */
  readonly dismissError: () => void
}

/**
 * `GET`/`PUT /v1/me/tools` for the settings screen (epic #303, X4; #307; #308).
 *
 * Read once per mount, like the other resource hooks. `modeId` answers the read as a chat on
 * that mode would see it — the mode's on/off override applied over the reader's choices — which
 * is what the mode editor's "what this mode would get" view needs; the Settings card leaves it
 * out and shows the reader's own choices.
 */
export function useTools(client: Client, modeId?: ModeId): ToolsView {
  const [tools, setTools] = useState<ListToolSettingsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const { serverUrl } = useSettings()

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const loaded = await client.tools.list(
          modeId === undefined ? {} : { mode_id: modeId },
          signal === undefined ? undefined : { signal },
        )
        setTools(loaded)
        setError(null)
      } catch (caught) {
        if (signal?.aborted === true) {
          return
        }
        if (!noteAuthenticationError(client, caught)) {
          setError(describeError(caught, { serverUrl }))
        }
      }
    },
    [client, modeId, serverUrl],
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

  const reload = useCallback(async (): Promise<void> => {
    await load()
  }, [load])

  const save = useCallback(
    async (name: ToolName, setting: BuiltinToolSetting): Promise<SaveToolsResult> => {
      setSaving(true)
      try {
        const saved = await client.tools.put({ builtin: { [name]: setting } })
        setTools(saved)
        setError(null)
        return { ok: true }
      } catch (caught) {
        // A 401 still signs the app out — the shell takes it from here — but the caller wants
        // an answer either way, so the message is returned as well as noted.
        noteAuthenticationError(client, caught)
        return { ok: false, message: describeError(caught, { serverUrl }) }
      } finally {
        setSaving(false)
      }
    },
    [client, serverUrl],
  )

  const dismissError = useCallback(() => {
    setError(null)
  }, [])

  return { tools, loading, error, saving, save, reload, dismissError }
}
