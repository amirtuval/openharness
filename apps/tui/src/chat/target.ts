import { ApiError, type Client } from '@openharness/client'
import {
  isAgentId,
  isModeId,
  type Agent,
  type Mode,
  type ModelEntry,
  type Session,
} from '@openharness/protocol'

import { listAllAgents } from '../paging'

/** What the CLI worked out to do before the chat screen can exist. */
export type TargetResolution =
  /** Chat in this session — resumed, continued, or freshly created. */
  | { kind: 'session'; readonly session: Session }
  /** A new chat from a model the user has not chosen yet: ask, with the catalog. */
  | { kind: 'choose-model'; readonly models: readonly ModelEntry[] }
  /** The account has no provider keys, so there is no model to chat with (epic #92). */
  | { kind: 'no-models' }

/** The flags that decide where a chat starts. */
export interface TargetOptions {
  /** `--session <id>`. */
  readonly session?: string | undefined
  /** `--continue`. */
  readonly continue: boolean
  /** `--agent <id|name>`. */
  readonly agent?: string | undefined
  /** `--model <provider/model>`. */
  readonly model?: string | undefined
  /** `--mode <name>`: one of the user's modes a new chat follows (#245, M6). */
  readonly mode?: string | undefined
}

/**
 * Work out which session to open, and open it if it does not exist yet.
 *
 * The rules, in the order they are tried:
 *
 * 1. `--session <id>` names one: use it, whatever else the server has.
 * 2. `--continue` takes the newest session the server lists, or falls through to a new one
 *    when there is nothing to continue.
 * 3. Otherwise start a new session. Model-first (epic #92): `--agent` presets the session,
 *    `--model` names the model directly and skips everything else. With neither, the stored
 *    **default model** (`preferences.get`, epic #116 U1) is used with no picker at all —
 *    that is what makes a new chat immediate. Only when there is no default either is the
 *    catalog offered to choose from, or — when the account has no provider keys — nothing
 *    is: the caller says how to add one. An account with keys but an empty catalog is the
 *    same case, because there is nothing to start a chat with either way.
 *
 * `--model` with `--agent` is legal and not a contradiction: the session is created from the
 * agent preset with its model overridden, which is exactly what the protocol allows.
 *
 * Every agent the server has is considered, not just the first page of them: `--agent` reads
 * an id straight from the server, and matches a name against the whole list (`listAllAgents`
 * walks `next_page`).
 *
 * An agent that cannot be resolved is an error rather than a fallback: silently chatting
 * with a different agent than the one that was asked for is worse than not starting.
 */
export async function resolveTarget(
  client: Client,
  options: TargetOptions,
): Promise<TargetResolution> {
  if (options.session !== undefined) {
    return { kind: 'session', session: await client.sessions.get(options.session) }
  }

  if (options.continue) {
    const page = await client.sessions.list({ limit: 1 })
    const recent = page.data[0]
    if (recent !== undefined) {
      return { kind: 'session', session: recent }
    }
  }

  return startNew(client, options)
}

async function startNew(client: Client, options: TargetOptions): Promise<TargetResolution> {
  const model = options.model?.trim()
  // `--mode` names a preset rather than a model (#245, M6), so it is resolved first and the
  // session is created on it — the server resolves the mode's model from the user's own
  // settings, which is exactly what "my default model" means.
  if (options.mode !== undefined) {
    const mode = await resolveMode(client, options.mode)
    return { kind: 'session', session: await client.sessions.create({ mode: mode.id }) }
  }
  const agent = options.agent === undefined ? undefined : await resolveAgent(client, options.agent)

  if (agent !== undefined) {
    const request =
      model === undefined ? { agent: agent.id } : { agent: agent.id, model: { id: model } }
    return { kind: 'session', session: await client.sessions.create(request) }
  }

  // An explicit --model beats the stored default, and neither is consulted on the way: the
  // router accepts ids the catalog does not know (C5), so nothing else needs reading.
  if (model !== undefined) {
    return { kind: 'session', session: await client.sessions.create({ model: { id: model } }) }
  }

  const preferences = await client.preferences.get()
  if (preferences.default_model !== null) {
    return {
      kind: 'session',
      session: await client.sessions.create({ model: { id: preferences.default_model } }),
    }
  }

  const catalog = await client.models.list()
  if (catalog.data.length === 0) {
    return { kind: 'no-models' }
  }

  return { kind: 'choose-model', models: catalog.data }
}

/**
 * Resolve `--mode` against the user's modes, or fail with something to read (#245, M6).
 *
 * A `mode_` id is read straight from the server (one request), and anything else is matched
 * against the user's modes by name — exactly, then ignoring case. Ambiguity is an error rather
 * than a guess, the same rule `--agent` follows: naming a mode is how a user says which one.
 */
async function resolveMode(client: Client, query: string): Promise<Mode> {
  const wanted = query.trim()
  const modes = (await client.modes.list()).data

  if (isModeId(wanted)) {
    const direct = modes.find((mode) => mode.id === wanted)
    if (direct !== undefined) return direct
  }

  const byName = modes.find((mode) => mode.name === wanted)
  if (byName !== undefined) return byName

  const folded = wanted.toLowerCase()
  const caseInsensitive = modes.filter((mode) => mode.name.toLowerCase() === folded)
  const match = caseInsensitive[0]
  if (caseInsensitive.length === 1 && match !== undefined) return match

  if (caseInsensitive.length > 1) {
    throw new Error(`'${wanted}' matches ${caseInsensitive.length} modes. Use an id.`)
  }

  throw new Error(
    modes.length === 0
      ? `no mode matches '${wanted}': this account has no modes yet. Create one in the web app's Settings, then run \`oh\` again.`
      : `no mode matches '${wanted}'. This account has: ${modes.map((mode) => mode.name).join(', ')}. Run \`oh modes\` to list them.`,
  )
}

/** Resolve `--agent` against every agent the server has, or fail with something to read. */
async function resolveAgent(client: Client, query: string): Promise<Agent> {
  const wanted = query.trim()

  // An id is worth reading directly: one request instead of a walk, and it finds the agent
  // whatever else the list holds. A value that looks like an id but names nothing falls
  // through to the name match below, so `--agent <name>` is never narrowed by its shape.
  if (isAgentId(wanted)) {
    const direct = await getAgentOrUndefined(client, wanted)
    if (direct !== undefined) return direct
  }

  const selection = selectAgent(await listAllAgents(client), query)
  if (!selection.ok) throw new Error(selection.error)
  return selection.agent
}

/**
 * `agents.get`, with "there is no such agent" answering `undefined` instead of throwing.
 *
 * Only a 404 is read that way. Anything else — a refused connection, a bad key, a server
 * that answered with something unreadable — is a failure worth reporting, not a reason to
 * fall back to matching a name.
 */
async function getAgentOrUndefined(client: Client, id: string): Promise<Agent | undefined> {
  try {
    return await client.agents.get(id)
  } catch (error) {
    if (error instanceof ApiError && error.type === 'not_found_error') return undefined
    throw error
  }
}

/** The outcome of matching `--agent` against the agents the server listed. */
export type AgentSelection =
  { readonly ok: true; readonly agent: Agent } | { readonly ok: false; readonly error: string }

/**
 * Match an `--agent` value: by id first, then by exact name, then by name ignoring case.
 *
 * A query that matches several agents is an error rather than a coin toss — the point of
 * naming an agent is to get that agent.
 */
export function selectAgent(agents: readonly Agent[], query: string): AgentSelection {
  const wanted = query.trim()

  const byId = agents.find((agent) => agent.id === wanted)
  if (byId !== undefined) return { ok: true, agent: byId }

  const byName = agents.find((agent) => agent.name === wanted)
  if (byName !== undefined) return { ok: true, agent: byName }

  const folded = wanted.toLowerCase()
  const caseInsensitive = agents.filter((agent) => agent.name.toLowerCase() === folded)
  const match = caseInsensitive[0]
  if (caseInsensitive.length === 1 && match !== undefined) {
    return { ok: true, agent: match }
  }

  if (caseInsensitive.length > 1) {
    return {
      ok: false,
      error: `'${wanted}' matches ${caseInsensitive.length} agents: ${caseInsensitive
        .map((agent) => `${agent.name} (${agent.id})`)
        .join(', ')}. Use an id.`,
    }
  }

  return {
    ok: false,
    error:
      agents.length === 0
        ? `no agent matches '${wanted}': this server has no agents yet. Create one in the web app, then run \`oh\` again.`
        : `no agent matches '${wanted}'. This server has: ${agents
            .map((agent) => agent.name)
            .join(', ')}. Run \`oh agents\` for the ids.`,
  }
}
