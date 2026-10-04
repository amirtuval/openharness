import type { TranscriptError } from '@openharness/client'
import type { ModelEntry } from '@openharness/protocol'
import { Box, Text, useInput } from 'ink'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

import { ModelPicker } from '../components/model-picker'
import { NoticeView } from '../components/notice-view'
import { PromptInput } from '../components/prompt-input'
import { StatusLine } from '../components/status-line'
import { TranscriptView } from '../components/transcript-view'
import type { ChatSession, Notice } from './session'

/** What the in-chat model picker is doing: `/model` fetches the catalog first. */
type ModelChooser =
  | { readonly kind: 'closed' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'open'; readonly models: readonly ModelEntry[] }

export interface ChatScreenProps {
  /** The running chat: transcript, stream, and the operations on them. */
  readonly session: ChatSession
  /** Shown in the status line, e.g. that this is the dev fake. */
  readonly banner?: string | undefined
  /** Called when the user has asked to leave — the second idle Ctrl+C, or a deleted chat. */
  readonly onExit: () => void
}

/**
 * The chat screen: transcript, status line, prompt.
 *
 * All the state lives in {@link ChatSession}; this is the rendering of it, plus the two
 * pieces of interaction that belong to the screen rather than the prompt — Ctrl+C, and the
 * `/model` command, which opens the picker over the prompt (#114, epic #116 U3).
 */
export function ChatScreen({ session, banner, onExit }: ChatScreenProps) {
  const view = useSyncExternalStore(session.subscribe, session.getState, session.getState)
  const [chooser, setChooser] = useState<ModelChooser>({ kind: 'closed' })

  // A model-first session has no agent to name (issues #93, #95): the status line shows the
  // model that session runs. A pick that has not been sent yet is the model it *will* run,
  // so the line names it too and says when it applies.
  const agentName = session.session.agent?.name
  const currentModel = view.transcript.model ?? session.session.model.id
  const model = view.pendingModel === null ? currentModel : `${view.pendingModel} (next message)`

  const openChooser = useCallback((): void => {
    setChooser({ kind: 'loading' })
    void (async () => {
      try {
        setChooser({ kind: 'open', models: await session.listModels() })
      } catch (error) {
        setChooser({ kind: 'closed' })
        session.reportError(error)
      }
    })()
  }, [session])

  // The chat's own keys stay quiet while the picker is up: Ctrl+C belongs to the picker
  // then, and cancelling it must not also arm (or trigger) the chat's exit.
  useInput((input, key) => {
    if (chooser.kind !== 'closed') return
    if (!key.ctrl || input !== 'c') return
    if (session.pressCtrlC() === 'exit') onExit()
  })

  // A chat deleted elsewhere is over (#114, epic #116 U5): the runtime has already said so
  // in the notice; leaving is immediate, and the caller prints where the session went.
  useEffect(() => {
    if (view.transcript.deleted) onExit()
  }, [view.transcript.deleted, onExit])

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
      {chooser.kind === 'open' ? (
        <ModelPicker
          models={chooser.models}
          onSelect={(modelId) => {
            session.setModel(modelId)
            setChooser({ kind: 'closed' })
          }}
          onCancel={() => {
            setChooser({ kind: 'closed' })
          }}
        />
      ) : (
        <PromptInput
          onSubmit={(text) => {
            if (text.trim() === '/model') {
              openChooser()
              return
            }
            void session.send(text)
          }}
          onActivity={() => {
            session.dismissHint()
          }}
        />
      )}
      {chooser.kind === 'loading' && <Text dimColor>loading models…</Text>}
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
