import type { TranscriptError } from '@openharness/client'
import { Box, useInput } from 'ink'
import { useSyncExternalStore } from 'react'

import { NoticeView } from '../components/notice-view'
import { PromptInput } from '../components/prompt-input'
import { StatusLine } from '../components/status-line'
import { TranscriptView } from '../components/transcript-view'
import type { ChatSession, Notice } from './session'

export interface ChatScreenProps {
  /** The running chat: transcript, stream, and the operations on them. */
  readonly session: ChatSession
  /** Shown in the status line, e.g. that this is the dev fake. */
  readonly banner?: string | undefined
  /** Called when the user has asked to leave — the second idle Ctrl+C. */
  readonly onExit: () => void
}

/**
 * The chat screen: transcript, status line, prompt.
 *
 * All the state lives in {@link ChatSession}; this is the rendering of it, plus the one
 * piece of interaction that belongs to the screen rather than the prompt — Ctrl+C. Ink
 * delivers it as input rather than as a signal while the terminal is in raw mode, which is
 * what lets one key both interrupt a reply and, pressed again, leave.
 */
export function ChatScreen({ session, banner, onExit }: ChatScreenProps) {
  const view = useSyncExternalStore(session.subscribe, session.getState, session.getState)
  // A model-first session has no agent to name (issues #93, #95): the status line shows the
  // model that session runs, which is its own field either way.
  const agentName = session.session.agent?.name
  const model = session.session.model.id

  useInput((input, key) => {
    if (!key.ctrl || input !== 'c') return
    if (session.pressCtrlC() === 'exit') onExit()
  })

  return (
    <Box flexDirection="column">
      <TranscriptView messages={view.transcript.messages} />
      {view.notice !== null && <NoticeView notice={view.notice} />}
      {view.transcript.lastError !== null && (
        <NoticeView notice={turnErrorNotice(view.transcript.lastError)} />
      )}
      <StatusLine
        agentName={agentName}
        model={model}
        sessionId={session.session.id}
        status={view.transcript.status}
        phase={view.phase}
        banner={banner}
      />
      <PromptInput
        onSubmit={(text) => {
          void session.send(text)
        }}
        onActivity={() => {
          session.dismissHint()
        }}
      />
    </Box>
  )
}

/**
 * The transcript's own error — a `session.error` in the log, which is the brain saying the
 * turn failed rather than the client failing to reach it.
 *
 * It clears itself when a reply arrives; a `retrying` one is worth a word, because the
 * session has gone back to running and the wait would otherwise look like nothing happening.
 */
function turnErrorNotice(error: TranscriptError): Notice {
  return {
    kind: 'error',
    text:
      error.retryStatus === 'retrying'
        ? `${error.message} — the server is retrying`
        : error.message,
    hints: [],
  }
}
