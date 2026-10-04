import type { Client } from '@openharness/client'
import type { ModelEntry, Session } from '@openharness/protocol'
import { Box, Text, useApp } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { ChatOptions } from './args'
import { ChatScreen } from './chat/screen'
import { createChatSession, type ChatSession } from './chat/session'
import { resolveTarget } from './chat/target'
import { ModelPicker } from './components/model-picker'
import { describeError, type ErrorContext, type ErrorReport } from './errors'

/** What the CLI should do once the app is done, and which session to point at on the way out. */
export interface ExitPayload {
  /** The process exit code: 0 for a chat the user ended, 1 for one that could not start. */
  readonly code: number
  /** The session that was in use, for the `oh -s <id>` hint; absent if none was opened. */
  readonly sessionId?: string | undefined
}

/** Where the app is in its short life. */
type Screen =
  /** Resuming, continuing, or creating the session. */
  | { readonly kind: 'resolving' }
  /** No `--agent` and no `--model`: asking which catalog model to chat with. */
  | { readonly kind: 'choose-model'; readonly models: readonly ModelEntry[] }
  /** The account has no provider keys: there is no model to chat with (epic #92). */
  | { readonly kind: 'no-models' }
  /** Chatting. */
  | { readonly kind: 'chat'; readonly session: ChatSession }
  /** Something failed before the chat could start. */
  | { readonly kind: 'failed'; readonly report: ErrorReport }

export interface AppProps {
  /** The client to talk to — the real one, or the fake in dev mode. */
  readonly client: Client
  /** The parsed `oh` flags: `--session`, `--continue`, `--agent`, `--model`. */
  readonly options: ChatOptions
  /** Which server this is, and whether to keep stacks: what the error messages need. */
  readonly context: ErrorContext
  /** Extra words in the status line, e.g. that this is the dev fake. */
  readonly banner?: string | undefined
  /** How to leave; Ink's `exit` by default. Tests pass a spy to observe the payload. */
  readonly onExit?: ((payload: ExitPayload) => void) | undefined
}

/**
 * The whole `oh` chat: work out which session to use, then render it.
 *
 * Resolving happens once, on mount. It is a one-shot because a fresh `client` is built per
 * process and nothing it reads can change under it, and because doing it again would open a
 * second session — so the guard is a ref rather than a dependency list that object
 * identities would keep re-triggering.
 */
export function App({ client, options, context, banner, onExit }: AppProps) {
  const { exit } = useApp()
  const [screen, setScreen] = useState<Screen>({ kind: 'resolving' })
  const resolved = useRef(false)
  const left = useRef(false)

  /** Leave the app exactly once, whoever asks: the user, or a screen with nothing to do. */
  const leave = (payload: ExitPayload): void => {
    if (left.current) return
    left.current = true
    if (onExit === undefined) {
      exit(payload)
    } else {
      onExit(payload)
    }
  }

  const beginChat = useCallback(
    (session: Session): void => {
      const chat = createChatSession({ client, session, context })
      setScreen({ kind: 'chat', session: chat })
      void chat.start()
    },
    [client, context],
  )

  /** The picker answered: open a model-first session on the chosen model, then chat. */
  const chooseModel = useCallback(
    (modelId: string): void => {
      void (async () => {
        try {
          beginChat(await client.sessions.create({ model: { id: modelId } }))
        } catch (error) {
          setScreen({ kind: 'failed', report: describeError(error, context) })
        }
      })()
    },
    [beginChat, client, context],
  )

  useEffect(() => {
    if (resolved.current) return
    resolved.current = true

    void (async () => {
      try {
        const target = await resolveTarget(client, options)
        switch (target.kind) {
          case 'session':
            beginChat(target.session)
            break
          case 'choose-model':
            setScreen({ kind: 'choose-model', models: target.models })
            break
          case 'no-models':
            setScreen({ kind: 'no-models' })
            break
        }
      } catch (error) {
        setScreen({ kind: 'failed', report: describeError(error, context) })
      }
    })()
    // Nothing to cancel: the app is mounted for the life of the process, and the requests
    // resolve into it.
  }, [])

  // The screens that have nothing to offer render once and then give the terminal back.
  const doneForGood = screen.kind === 'no-models' || screen.kind === 'failed'
  useEffect(() => {
    if (doneForGood) leave({ code: 1 })
  }, [doneForGood])

  // Leaving the chat aborts its stream — the one thing that must not outlive the screen.
  useEffect(() => {
    if (screen.kind !== 'chat') return
    const { session } = screen
    return () => {
      session.dispose()
    }
  }, [screen])

  switch (screen.kind) {
    case 'resolving':
      return <Text dimColor>{`connecting to ${context.server ?? 'the server'}…`}</Text>

    case 'choose-model':
      return (
        <ModelPicker
          models={screen.models}
          onSelect={chooseModel}
          onCancel={() => {
            leave({ code: 0 })
          }}
        />
      )

    case 'chat':
      return (
        <ChatScreen
          session={screen.session}
          banner={banner}
          onExit={() => {
            screen.session.dispose()
            leave({ code: 0, sessionId: screen.session.session.id })
          }}
        />
      )

    case 'no-models':
      return <NoModels server={context.server} />

    case 'failed':
      return <ErrorScreen report={screen.report} />
  }
}

/** What to say when the account has no provider keys: where a key comes from, and that's it. */
function NoModels({ server }: { server?: string | undefined }) {
  return (
    <Box flexDirection="column">
      <Text>No model providers yet — there is no model to chat with.</Text>
      <Text dimColor>
        {`Add a key in the web app${server === undefined ? '' : ` at ${server}`} under Settings → Model providers, then run \`oh\` again.`}
      </Text>
      <Text dimColor>Every model the picker offers is one your own key can use.</Text>
    </Box>
  )
}

/** A failure that stopped the chat before it started. */
function ErrorScreen({ report }: { report: ErrorReport }) {
  return (
    <Box flexDirection="column">
      <Text color="red">{`error: ${report.message}`}</Text>
      {report.hints.map((hint) => (
        <Text key={hint} dimColor>
          {`  ${hint}`}
        </Text>
      ))}
      {report.stack !== undefined && <Text dimColor>{report.stack}</Text>}
      <Text dimColor>Run with --debug for the full error.</Text>
    </Box>
  )
}
