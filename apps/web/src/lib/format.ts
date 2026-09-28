import type { Session } from '@openharness/protocol'

/** A session's label in the sidebar: its title, or the agent it runs. */
export function sessionLabel(session: Session): string {
  if (session.title !== null && session.title.trim() !== '') {
    return session.title
  }
  return session.agent.name
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
