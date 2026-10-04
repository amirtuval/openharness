import type { SessionStatus } from '@openharness/protocol'
import { Text } from 'ink'

import type { ChatViewState } from '../chat/session'

export interface StatusLineProps {
  /**
   * Who is answering: the name of the agent the session snapshotted — absent for a
   * model-first session, which has none and is named by its model instead (issues #93, #95).
   */
  readonly agentName?: string | undefined
  /** The model, a `provider/model` router string. */
  readonly model: string
  /** The session's id, for `oh -s <id>`. */
  readonly sessionId: string
  /** What the transcript says the session is doing. */
  readonly status: SessionStatus
  /** Whether the history and the stream are in place yet. */
  readonly phase: ChatViewState['phase']
  /** Extra context, e.g. that this is the dev fake. */
  readonly banner?: string | undefined
}

/**
 * The one line above the prompt: who is answering, in which session, and whether they are
 * working — the three things a chat UI has to be able to answer at a glance.
 *
 * It is one `<Text>` for the same reason a message is: a frame with escape sequences in the
 * middle of a line is a frame a test cannot read.
 */
export function StatusLine({
  agentName,
  model,
  sessionId,
  status,
  phase,
  banner,
}: StatusLineProps) {
  const state = phase === 'loading' ? 'loading history' : status
  const parts =
    agentName === undefined ? [model, sessionId, state] : [agentName, model, sessionId, state]

  if (banner !== undefined) {
    parts.push(banner)
  }

  return <Text dimColor>{parts.join(' · ')}</Text>
}
