import type { Session } from '@openharness/protocol'

import { type ModelNameLookup } from './models'

/**
 * A session's label in the sidebar and the chat header: its title, else its model.
 *
 * Since #91 the fallback is the **model's** display name — never the agent's, now that a
 * chat is started from a model (epic #92): the catalog's name when the catalog knows the id
 * (`nameOf`), and the `provider/model` id itself otherwise.
 */
export function sessionLabel(session: Session, nameOf?: ModelNameLookup): string {
  if (session.title !== null && session.title.trim() !== '') {
    return session.title
  }
  return nameOf?.(session.model.id) ?? session.model.id
}

/**
 * A model id as a reader sees it: the catalog's display name, or the id when unknown.
 */
export function modelLabel(modelId: string, nameOf?: ModelNameLookup): string {
  return nameOf?.(modelId) ?? modelId
}

/**
 * A context window in tokens, short: `128K`, `1M`, `512`.
 *
 * The picker shows it as "128K context" next to the model id (issue #91); values that are not
 * whole millions get one decimal (`1048576` → `1.0M`), and anything under a thousand stays
 * itself.
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`
  }
  return `${tokens}`
}

/**
 * A timestamp as "just now", "12m ago", "3h ago", "5d ago", or a date.
 *
 * `now` is a parameter so a test can pin the clock.
 */
export function relativeTime(timestamp: string, now: number = Date.now()): string {
  const then = Date.parse(timestamp)
  if (Number.isNaN(then)) {
    return timestamp
  }
  const seconds = Math.round((now - then) / 1000)
  if (seconds < 45) {
    return 'just now'
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m ago`
  }
  if (seconds < 86400) {
    return `${Math.round(seconds / 3600)}h ago`
  }
  if (seconds < 604800) {
    return `${Math.round(seconds / 86400)}d ago`
  }
  return new Date(then).toLocaleDateString()
}

/** The last path segment of a resource id, for a compact label. */
export function shortId(id: string): string {
  const [prefix = '', suffix = ''] = id.split('_')
  return suffix === '' ? id : `${prefix}_…${suffix.slice(-6)}`
}
