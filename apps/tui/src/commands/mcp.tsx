import {
  estimatedTokensLabel,
  mcpAuthLabel,
  mcpStatusDetail,
  mcpStatusLabel,
} from '@openharness/client'
import type { Client } from '@openharness/client'
import type { McpServer } from '@openharness/protocol'
import { Box, Text, render, useApp } from 'ink'
import { useCallback } from 'react'

import { McpServersScreen } from '../components/mcp-servers'
import type { ErrorContext } from '../errors'
import { restoreTerminal } from '../terminal'
import { installSignals } from '../signals'
import { reportFailure, type CommandIo } from './io'

/**
 * `oh mcp` (epic #303, X10; the screen is #313) — the terminal's remote-MCP-server settings.
 *
 * With a terminal it opens `McpServersScreen`, the one place a reader registers a server, edits
 * it, turns it on or off, tests it, connects or reconnects an OAuth one, deletes it, and sets
 * the permission each of its tools runs under. That is the whole of the issue's first two
 * points, and it is the same screen `/mcp` opens inside a chat.
 *
 * Piped — no TTY to read a key from — it prints the servers instead, because a `yarn oh mcp |
 * cat` that opened an interactive screen would hang: the listing is what a script and a
 * terminal-less session can use.
 */
export async function runMcp(
  client: Client,
  io: CommandIo,
  options: {
    readonly stdin: NodeJS.ReadStream
    readonly stdout: NodeJS.WriteStream
    readonly stderr: NodeJS.WriteStream
    readonly openUrl: (url: string) => boolean
  },
): Promise<number> {
  if (!options.stdin.isTTY) {
    try {
      const { data } = await client.mcpServers.list()
      for (const line of formatMcpServers(data)) {
        io.stdout(line)
      }
      return 0
    } catch (error) {
      return reportFailure(io, error)
    }
  }
  return mountMcpServers({ client, context: io.context, ...options })
}

/** What mounting the screen needs. */
export interface McpMountOptions {
  readonly client: Client
  readonly context: ErrorContext
  readonly openUrl: (url: string) => boolean
  readonly stdin: NodeJS.ReadStream
  readonly stdout: NodeJS.WriteStream
  readonly stderr: NodeJS.WriteStream
}

/**
 * Run the servers screen in its own Ink app.
 *
 * The terminal hygiene is the chat's in miniature, and `exitOnCtrlC: false` is the same
 * decision: a Ctrl+C inside the screen is the screen's own cancel, so Ink must not tear the
 * process down with the terminal in raw mode.
 */
export async function mountMcpServers(options: McpMountOptions): Promise<number> {
  const { stdin, stdout, stderr } = options
  const restore = (): void => {
    restoreTerminal({ stdin, stdout })
  }

  let instance: ReturnType<typeof render> | undefined
  const settle = (code: number): void => {
    restore()
    if (instance === undefined) {
      process.exit(code)
    }
    instance.unmount()
  }

  const stopSignals = installSignals(process, {
    onInterrupt: () => {
      settle(130)
    },
    onTerminate: () => {
      settle(143)
    },
  })
  const onProcessExit = (): void => {
    restore()
  }
  process.once('exit', onProcessExit)

  try {
    instance = render(
      <McpServersApp client={options.client} context={options.context} openUrl={options.openUrl} />,
      { stdin, stdout, stderr, exitOnCtrlC: false },
    )
    const result = await instance.waitUntilExit()
    return typeof result === 'number' ? result : 0
  } finally {
    stopSignals()
    process.off('exit', onProcessExit)
    restore()
  }
}

/**
 * The Ink app: the servers screen, and nothing else.
 *
 * Exported so a test can render it through `ink-testing-library` — the mount above is the
 * terminal plumbing around it, and this is the screen itself.
 */
export function McpServersApp({
  client,
  context,
  openUrl,
}: {
  readonly client: Client
  readonly context: ErrorContext
  readonly openUrl: (url: string) => boolean
}) {
  const { exit } = useApp()
  const done = useCallback((): void => {
    exit()
  }, [exit])

  return (
    <Box flexDirection="column">
      <Text dimColor>
        Your remote MCP servers. Their tools are offered to your chats while a server is on, and
        every call asks you first until you change it under its tools.
      </Text>
      <McpServersScreen client={client} context={context} openUrl={openUrl} onDone={done} />
    </Box>
  )
}

/**
 * The servers as the lines `oh mcp` prints when there is no terminal.
 *
 * Three lines per server: what it is called with how it authenticates, what state it is in and
 * whether it is on; its address; and the status detail a screen shows — the last error, or the
 * tools its last check listed and what they cost. A reader with no servers is told how they are
 * added, because an empty listing is otherwise indistinguishable from a command that did
 * nothing.
 */
export function formatMcpServers(servers: readonly McpServer[]): readonly string[] {
  if (servers.length === 0) {
    return ['No MCP servers. Run `oh mcp` in a terminal to add one.']
  }
  const lines: string[] = []
  for (const server of servers) {
    lines.push(
      `${server.name} · ${mcpAuthLabel(server.auth)} · ${mcpStatusLabel(server.status)}` +
        `${server.enabled ? '' : ' · off'} · ${
          server.tools.length === 0
            ? 'no tools listed'
            : `${server.tools.length} tools, about ${estimatedTokensLabel(server.definition_tokens)}`
        }`,
    )
    lines.push(`  ${server.url}`)
    lines.push(`  ${mcpStatusDetail(server)}`)
  }
  return lines
}
