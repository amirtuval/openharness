import type { Client } from '@openharness/client'
import type { Agent, Session } from '@openharness/protocol'

import { listAllAgents, listAllSessions } from '../paging'
import { isYes, readLine, reportFailure, type CommandIo } from './io'

export type { CommandIo }

/** How wide a column gets before it is cut short; ids and timestamps are never cut. */
const TITLE_WIDTH = 32
const NAME_WIDTH = 24

/**
 * `oh sessions` — the sessions the server has, newest first.
 *
 * Every session the server has, not just the first page of them: a listing that silently
 * stopped at twenty is how a session the user is looking for appears not to exist. A
 * terminal can display far more rows than it shows at once.
 */
export async function runSessions(client: Client, io: CommandIo): Promise<number> {
  try {
    writeLines(io.stdout, formatSessions(await listAllSessions(client)))
    return 0
  } catch (error) {
    return reportFailure(io, error)
  }
}

/** `oh agents` — the agents a new session can run, oldest first. */
export async function runAgents(client: Client, io: CommandIo): Promise<number> {
  try {
    writeLines(io.stdout, formatAgents(await listAllAgents(client)))
    return 0
  } catch (error) {
    return reportFailure(io, error)
  }
}

/** What `oh sessions delete` needs on top of {@link CommandIo}. */
export interface SessionDeleteIo extends CommandIo {
  /** Write the question without a trailing newline: the answer belongs on the same line. */
  readonly prompt: (text: string) => void
  /** Where the answer is read from; one line, `y`/`yes` (any case) deletes. */
  readonly stdin: NodeJS.ReadStream
}

/**
 * `oh sessions delete <id>` (#114, epic #116 U5) — delete a chat and everything in it.
 *
 * The question is asked unless `--yes` was given, because the delete is irreversible:
 * stopping at `[y/N]` is the whole safeguard. A line that is not a yes — including an
 * end-of-input from a pipe nobody wrote to — answers no and changes nothing.
 */
export async function runSessionDelete(
  client: Client,
  io: SessionDeleteIo,
  id: string,
  options: { readonly yes: boolean },
): Promise<number> {
  if (!options.yes) {
    io.prompt(`Delete chat ${id}? This cannot be undone [y/N] `)
    if (!isYes(await readLine(io.stdin))) {
      io.stdout('Not deleted.')
      return 0
    }
  }

  try {
    await client.sessions.delete(id)
    io.stdout(`Deleted chat ${id}.`)
    return 0
  } catch (error) {
    return reportFailure(io, error)
  }
}

/**
 * One line per session: id, title, status, updated — the columns the issue asks for.
 *
 * An untitled session is labelled by the model it runs (issue #95), which is what a
 * model-first chat has to identify itself with; `(untitled)` said nothing about it.
 */
export function formatSessions(sessions: readonly Session[]): readonly string[] {
  if (sessions.length === 0) {
    return ['No sessions yet. Start one with `oh`.']
  }

  return sessions.map((session) =>
    [
      session.id,
      pad(session.title ?? session.model.id, TITLE_WIDTH),
      pad(session.status, 7),
      session.updated_at,
    ].join('  '),
  )
}

/** One line per agent: id, name, model. */
export function formatAgents(agents: readonly Agent[]): readonly string[] {
  if (agents.length === 0) {
    return ['No agents yet. Create one in the web app, then run `oh` again.']
  }

  return agents.map((agent) => [agent.id, pad(agent.name, NAME_WIDTH), agent.model.id].join('  '))
}

/** Pad to a width, cutting with an ellipsis when the value is longer. */
export function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width)
}

function writeLines(write: (line: string) => void, lines: readonly string[]): void {
  for (const line of lines) write(line)
}
