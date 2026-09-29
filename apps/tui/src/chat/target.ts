import { ApiError, type Client } from '@openharness/client'
import { isAgentId, type Agent, type Session } from '@openharness/protocol'

import { listAllAgents } from '../paging'

/** What the CLI worked out to do before the chat screen can exist. */
export type TargetResolution =
  /** Chat in this session — resumed, continued, or freshly created. */
  | { readonly kind: 'session'; readonly session: Session }
  /** Several agents and no `--agent`: ask which one. */
  | { readonly kind: 'choose'; readonly agents: readonly Agent[] }
  /** No agents at all: there is nothing to chat with. */
  | { readonly kind: 'none' }

/** The flags that decide where a chat starts. */
export interface TargetOptions {
  /** `--session <id>`. */
  readonly session?: string | undefined
  /** `--continue`. */
  readonly continue: boolean
  /** `--agent <id|name>`. */
  readonly agent?: string | undefined
}

/**
 * Work out which session to open, and open it if it does not exist yet.
 *
 * The rules, in the order they are tried:
 *
 * 1. `--session <id>` names one: use it, whatever else the server has.
 * 2. `--continue` takes the newest session the server lists, or falls through to a new one
 *    when there is nothing to continue.
 * 3. Otherwise start a new session — with `--agent` if it was given, with the only agent if
 *    the server has exactly one, by asking if it has several, and by failing with something
 *    to read if it has none.
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

  return startNew(client, options.agent)
}

async function startNew(client: Client, query: string | undefined): Promise<TargetResolution> {
  if (query !== undefined) {
    const wanted = query.trim()

    // An id is worth reading directly: one request instead of a walk, and it finds the agent
    // whatever else the list holds. A value that looks like an id but names nothing falls
    // through to the name match below, so `--agent <name>` is never narrowed by its shape.
    if (isAgentId(wanted)) {
      const direct = await getAgentOrUndefined(client, wanted)
      if (direct !== undefined) {
        return { kind: 'session', session: await client.sessions.create({ agent: direct.id }) }
      }
    }

    const selection = selectAgent(await listAllAgents(client), query)
    if (!selection.ok) throw new Error(selection.error)
    return { kind: 'session', session: await client.sessions.create({ agent: selection.agent.id }) }
  }

  const agents = await listAllAgents(client)
  const only = agents[0]
  if (agents.length === 1 && only !== undefined) {
    return { kind: 'session', session: await client.sessions.create({ agent: only.id }) }
  }

  if (agents.length === 0) {
    return { kind: 'none' }
  }

  return { kind: 'choose', agents }
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
