import { ApiError, type Client } from '@openharness/client'
import type {
  CreateMcpServerRequest,
  McpOAuthClient,
  McpServer,
  UpdateMcpServerRequest,
} from '@openharness/protocol'
import { useCallback, useEffect, useState } from 'react'

import { noteAuthenticationError } from '../lib/auth-store'
import { describeError } from '../lib/errors'
import { useSettings } from './use-settings'

/**
 * Why an MCP write did not happen.
 *
 * - `conflict` — the server refused it as a conflict (epic #303, X10): a name the reader already
 *   has, or the twenty-first server. The message belongs beside the form, because renaming or
 *   deleting fixes it.
 * - `session` — a 401: the reader has to sign in again.
 * - `error` — anything else, as one line.
 */
export type McpFailureKind = 'conflict' | 'session' | 'error'

/** The outcome of a write that keeps the resource, or of a `connect` start. */
export type McpWriteResult =
  | { readonly ok: true; readonly server: McpServer }
  | { readonly ok: false; readonly kind: McpFailureKind; readonly message: string }

/** The outcome of a delete. */
export type McpDeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: McpFailureKind; readonly message: string }

/** Where an OAuth flow was started, as {@link McpServersView.connect} takes it. */
export type McpConnectClient = McpOAuthClient

/** The outcome of starting an OAuth flow: the URL to open, or why there is none. */
export type McpConnectStart =
  | { readonly ok: true; readonly authorizationUrl: string }
  | { readonly ok: false; readonly kind: McpFailureKind; readonly message: string }

/** The reader's remote MCP servers, and the operations a settings screen offers (epic #303, X10). */
export interface McpServersView {
  /** The reader's servers, oldest first, as the server sorted them. */
  readonly servers: readonly McpServer[]
  /** The first read is still in flight. */
  readonly loading: boolean
  /** A failed read or write, as shown inline. */
  readonly error: string | null
  /** A write is in flight — one at a time, which is what the buttons are disabled for. */
  readonly busy: boolean
  /** Register a server; the save-time check runs, so the answer carries its status and tools. */
  readonly create: (body: CreateMcpServerRequest) => Promise<McpWriteResult>
  /** Change a server; `headers` replaces the sealed map, an omitted field keeps its value. */
  readonly update: (id: string, body: UpdateMcpServerRequest) => Promise<McpWriteResult>
  /** Remove a server and its pending OAuth states. */
  readonly remove: (id: string) => Promise<McpDeleteResult>
  /** Run the connection check now, and keep the refreshed server. */
  readonly test: (id: string) => Promise<McpWriteResult>
  /** Start an OAuth flow and answer the authorization URL to open. */
  readonly connect: (id: string, client?: McpConnectClient) => Promise<McpConnectStart>
  /** Drop an `oauth` server's tokens; it lands on `needs_reconnect`. */
  readonly disconnect: (id: string) => Promise<McpWriteResult>
  /** Read the list again — after an OAuth callback, or a change another tab made. */
  readonly reload: () => Promise<void>
  /** Clear the error. */
  readonly dismissError: () => void
}

/**
 * The reader's remote MCP servers (epic #303, X10; the screen is #313).
 *
 * Read once per mount, like the other resource hooks, and every write replaces the row it
 * touched with what the server answered — so the status, the tools a check listed and the
 * estimated cost are always the server's own answer rather than something this tab computed.
 * A write that changes which rows exist (a create, a delete) re-reads the list instead, because
 * the server is the one that orders it.
 */
export function useMcpServers(client: Client): McpServersView {
  const [servers, setServers] = useState<readonly McpServer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { serverUrl } = useSettings()

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const { data } = await client.mcpServers.list(signal === undefined ? undefined : { signal })
        setServers(data)
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
    [client, serverUrl],
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

  /**
   * The failure a write leaves, in the three classes the routes have.
   *
   * A 409 (`conflict_error`) is a name the reader already has or the twentieth-plus-one server,
   * which the form says beside the field; a 401 signs the app out through the auth store and is
   * reported as `session`; everything else is one line.
   */
  const classify = useCallback(
    (caught: unknown): { kind: McpFailureKind; message: string } => {
      if (noteAuthenticationError(client, caught)) {
        return { kind: 'session', message: describeError(caught, { serverUrl }) }
      }
      const kind: McpFailureKind =
        caught instanceof ApiError && caught.type === 'conflict_error' ? 'conflict' : 'error'
      return { kind, message: describeError(caught, { serverUrl }) }
    },
    [client, serverUrl],
  )

  /** Replace one row in place from a write's answer, or append it when it is new. */
  const keep = useCallback((server: McpServer): void => {
    setServers((current) => {
      const index = current.findIndex((each) => each.id === server.id)
      if (index === -1) {
        return [...current, server]
      }
      return current.map((each) => (each.id === server.id ? server : each))
    })
  }, [])

  const write = useCallback(
    async (run: () => Promise<McpServer>): Promise<McpWriteResult> => {
      setBusy(true)
      setError(null)
      try {
        const server = await run()
        keep(server)
        return { ok: true, server }
      } catch (caught) {
        const failure = classify(caught)
        return { ok: false, ...failure }
      } finally {
        setBusy(false)
      }
    },
    [classify, keep],
  )

  const create = useCallback(
    (body: CreateMcpServerRequest): Promise<McpWriteResult> =>
      write(() => client.mcpServers.create(body)),
    [client, write],
  )

  const update = useCallback(
    (id: string, body: UpdateMcpServerRequest): Promise<McpWriteResult> =>
      write(() => client.mcpServers.update(id, body)),
    [client, write],
  )

  const test = useCallback(
    (id: string): Promise<McpWriteResult> => write(() => client.mcpServers.test(id)),
    [client, write],
  )

  const disconnect = useCallback(
    (id: string): Promise<McpWriteResult> => write(() => client.mcpServers.disconnect(id)),
    [client, write],
  )

  const connect = useCallback(
    async (id: string, flow: McpConnectClient = 'web'): Promise<McpConnectStart> => {
      setBusy(true)
      setError(null)
      try {
        const started = await client.mcpServers.connect(id, { client: flow })
        return { ok: true, authorizationUrl: started.authorization_url }
      } catch (caught) {
        return { ok: false, ...classify(caught) }
      } finally {
        setBusy(false)
      }
    },
    [classify, client],
  )

  const remove = useCallback(
    async (id: string): Promise<McpDeleteResult> => {
      setBusy(true)
      setError(null)
      try {
        await client.mcpServers.delete(id)
        // A delete changes the list's order the server owns, and the row is gone: re-read rather
        // than guess.
        await load()
        return { ok: true }
      } catch (caught) {
        return { ok: false, ...classify(caught) }
      } finally {
        setBusy(false)
      }
    },
    [classify, client, load],
  )

  const reload = useCallback(async (): Promise<void> => {
    await load()
  }, [load])

  const dismissError = useCallback(() => {
    setError(null)
  }, [])

  return {
    servers,
    loading,
    error,
    busy,
    create,
    update,
    remove,
    test,
    connect,
    disconnect,
    reload,
    dismissError,
  }
}
