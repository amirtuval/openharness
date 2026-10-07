import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeFileAtomically } from './atomic-write'
import { configDirPath } from './config'

/**
 * The prompts `oh` has sent, so that ↑ and ↓ can walk them back (#206).
 *
 * The file lives in the config directory beside `config.json` and `credentials.json`, and
 * holds one list per **server and user** — the two halves of "whose prompts are these":
 * a `--server` points the CLI at a different machine, and two accounts on one machine are
 * two people's prompts, even though the credentials file keeps only one token per server.
 *
 * ```json
 * { "servers": { "https://app.oharness.dev": { "user_123": ["first prompt", "second"] } } }
 * ```
 *
 * The list is the last {@link HISTORY_LIMIT} entries, oldest first, with a line that repeats
 * the one before it dropped rather than stored twice. A line typed into a prompt that is not
 * echoed — a secret — is kept out through {@link HistoryAddOptions.record}.
 *
 * Unlike the config and credentials files, a history file that cannot be read is **not** an
 * error: what it holds is a convenience for the next keystroke, and losing a chat over a
 * mangled cache of old prompts would be the wrong trade. A failed read starts empty, and the
 * next write replaces the file.
 */

/** The file's name under the openharness config directory. */
export const HISTORY_FILE_NAME = 'history.json'

/** How many entries one server-and-user list keeps; the oldest fall off the front. */
export const HISTORY_LIMIT = 500

/** What a caller can say about the line it is handing over. */
export interface HistoryAddOptions {
  /**
   * Whether to keep it. The hidden-input seam (#206): the API key `oh` will ask for in the
   * terminal (#207, X7) is typed into a prompt that does not echo, and passing
   * `{ record: false }` is how that call says so — a secret never reaches this file.
   *
   * `false` is the only thing that has to be said; everything else defaults to recorded.
   */
  readonly record?: boolean | undefined
}

/**
 * One user's prompts on one server, as the prompt reads and writes them.
 *
 * Every method is synchronous and small, the way {@link CredentialStore} is: the CLI is
 * short-lived, and the prompt needs the list in the same keystroke it is browsing in. A second
 * `oh` may be writing the same file: each write re-reads it and appends, so neither chat
 * erases the other's lines.
 */
export interface PromptHistory {
  /** The file this history lives in, for messages and for tests. */
  readonly path: string
  /** Every entry, oldest first. */
  entries(): readonly string[]
  /** Remember `text`, unless {@link HistoryAddOptions.record} says not to. */
  add(text: string, options?: HistoryAddOptions): void
}

/** Everything {@link openHistory} needs to find one user's list. */
export interface HistoryInputs {
  /** The environment the file's location comes from; defaults to `process.env`. */
  readonly env?: Record<string, string | undefined> | undefined
  /** Override the file's path; defaults to {@link historyFilePath}. */
  readonly path?: string | undefined
  /** The server the chat is on, as `--server` resolved it. */
  readonly server: string
  /** The signed-in user's id — `client.me()` — so two accounts do not share a list. */
  readonly user: string
}

/** Where the history file lives. */
export function historyFilePath(env: Record<string, string | undefined> = process.env): string {
  return join(configDirPath(env), HISTORY_FILE_NAME)
}

/**
 * Read the history file and hand back the store for one user on one server.
 *
 * @param inputs where the file is, and which list inside it is this chat's
 */
export function openHistory(inputs: HistoryInputs): PromptHistory {
  const env = inputs.env ?? process.env
  const path = inputs.path ?? historyFilePath(env)

  const entries = [...(readHistoryFile(path).servers[inputs.server]?.[inputs.user] ?? [])]

  // Appends `line` to what the file holds *now*, not to what it held when this chat opened:
  // two `oh` sessions open side by side are ordinary, and writing back a snapshot taken at
  // startup would erase every line the other one added since — for every server and user in
  // the file, not only this one. Each chat browses its own list; the file is the union.
  const save = (line: string): void => {
    const servers = readHistoryFile(path).servers
    const users = servers[inputs.server] ?? {}
    const stored = users[inputs.user] ?? []
    const next = stored[stored.length - 1] === line ? stored : [...stored, line]
    servers[inputs.server] = { ...users, [inputs.user]: next.slice(-HISTORY_LIMIT) }
    try {
      writeFileAtomically(path, serialize(servers))
    } catch {
      // The chat is the point. A history that cannot be written is a lost convenience, not a
      // failed command: the prompt keeps working, and the next `oh` simply walks a shorter list.
    }
  }

  return {
    path,

    entries() {
      return entries
    },

    add(text, options) {
      if (options?.record === false) return
      const line = text.trim() === '' ? undefined : text
      if (line === undefined) return
      if (entries[entries.length - 1] === line) return
      entries.push(line)
      entries.splice(0, Math.max(0, entries.length - HISTORY_LIMIT))
      save(line)
    },
  }
}

/** The servers map, as the file holds it: server → user id → that user's prompts. */
type ServerHistories = Record<string, Record<string, string[]>>

/**
 * The real file read, in the tolerant spirit of the doc comment above: anything unusable —
 * no file, unreadable, not JSON, not the shape below — answers with an empty map rather
 * than a message, and the next write replaces it.
 */
function readHistoryFile(path: string): { readonly servers: ServerHistories } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { servers: {} }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { servers: {} }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { servers: {} }
  }

  const servers = (parsed as { servers?: unknown }).servers
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    return { servers: {} }
  }

  const value: ServerHistories = {}
  for (const [server, users] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof users !== 'object' || users === null || Array.isArray(users)) continue
    const lists: Record<string, string[]> = {}
    for (const [user, entries] of Object.entries(users as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue
      // Anything that is not a string in the list is dropped rather than repaired: a history
      // is a convenience, and a wrong entry is worse than a missing one.
      lists[user] = (entries as unknown[]).filter(
        (entry): entry is string => typeof entry === 'string',
      )
    }
    value[server] = lists
  }
  return { servers: value }
}

/**
 * The file's contents for a set of lists: servers and users sorted, so the order `add` was
 * called in does not leak into a file a person opens — the same rule the credentials file
 * follows.
 */
function serialize(servers: ServerHistories): string {
  const sorted: ServerHistories = {}
  for (const server of Object.keys(servers).sort()) {
    const users = servers[server] ?? {}
    sorted[server] = Object.fromEntries(
      Object.keys(users)
        .sort()
        .map((user) => [user, users[user] ?? []]),
    )
  }
  return `${JSON.stringify({ servers: sorted }, null, 2)}\n`
}
