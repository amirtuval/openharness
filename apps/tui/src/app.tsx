import type { Client } from '@openharness/client'
import type { ModelEntry, Session } from '@openharness/protocol'
import { Box, Text, useApp, useInput } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { ChatOptions } from './args'
import { ChatScreen } from './chat/screen'
import { createChatSession, type ChatSession } from './chat/session'
import { resolveTarget } from './chat/target'
import { ModelPicker } from './components/model-picker'
import { ThemeProvider } from './components/theme'
import { describeError, type ErrorContext, type ErrorReport } from './errors'
import type { PromptHistory } from './history'
import { DEFAULT_THEME, type TerminalTheme } from './markdown/theme'

/** What the CLI should do once the app is done, and which session to point at on the way out. */
export interface ExitPayload {
  /** The process exit code: 0 for a chat the user ended, 1 for one that could not start. */
  readonly code: number
  /** The session that was in use, for the `oh -s <id>` hint; absent if none was opened. */
  readonly sessionId?: string | undefined
  /**
   * The chat was deleted while it was open (#114, epic #116 U5): there is no session to
   * point at, and the process says so instead of printing a resume hint.
   */
  readonly deleted?: boolean | undefined
}

/** Where the app is in its short life. */
type Screen =
  /** Resuming, continuing, or creating the session. */
  | { readonly kind: 'resolving' }
  /**
   * No `--agent`, no `--model` and no stored default: asking which catalog model to chat
   * with — the one screen that asks, and only until the default is set (#116, U1).
   */
  | { readonly kind: 'choose-model'; readonly models: readonly ModelEntry[] }
  /** The picker answered a chat that has no default: offer to remember the choice. */
  | { readonly kind: 'save-default'; readonly modelId: string; readonly error?: string | undefined }
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
  /**
   * Build the prompt history ↑ and ↓ walk (#206); omitted, there is none and the arrows only
   * move between the buffer's lines.
   *
   * A function rather than a value because one is keyed by the *user*, which means a
   * `client.me()` — and taking that round trip before the screen was drawn would leave `oh`
   * silent, instead of saying "connecting to <server>…", for as long as the server takes to
   * answer. This way it starts beside the session lookup and arrives when it arrives.
   */
  readonly loadHistory?: (() => Promise<PromptHistory | undefined>) | undefined
  /**
   * The theme the transcript is drawn with (epic #201, X4): the config file's `theme`, the
   * environment's `NO_COLOR`, and the background the terminal reports, resolved once at
   * startup. Omitted, it is the dark one in colour — what a component rendered on its own
   * gets, and what a terminal that reports nothing falls back to.
   */
  readonly theme?: TerminalTheme | undefined
  /** How to leave; Ink's `exit` by default. Tests pass a spy to observe the payload. */
  readonly onExit?: ((payload: ExitPayload) => void) | undefined
}

/**
 * The whole `oh` chat, and the theme everything under it draws with (epic #201, X4).
 *
 * A two-line component on purpose: the theme is context rather than a prop because of where
 * it is *used* — the message view, which Ink's `<Static>` renders once per settled message —
 * and threading it down would mean the transcript view and the chat screen both carrying a
 * value neither of them reads.
 */
export function App({ theme = DEFAULT_THEME, ...rest }: AppProps) {
  return (
    <ThemeProvider theme={theme}>
      <AppScreen {...rest} />
    </ThemeProvider>
  )
}

/**
 * The whole `oh` chat: work out which session to use, then render it.
 *
 * Resolving happens once, on mount. It is a one-shot because a fresh `client` is built per
 * process and nothing it reads can change under it, and because doing it again would open a
 * second session — so the guard is a ref rather than a dependency list that object
 * identities would keep re-triggering.
 */
function AppScreen({
  client,
  options,
  context,
  banner,
  loadHistory,
  onExit,
}: Omit<AppProps, 'theme'>) {
  const { exit } = useApp()
  const [screen, setScreen] = useState<Screen>({ kind: 'resolving' })
  const [history, setHistory] = useState<PromptHistory | undefined>(undefined)
  // The catalog, when resolving the target happened to read it (#116 U1) — the picker a chat
  // with no default opens on. It rides down to the chat so the status line can name the model
  // the way the picker did (#208); a chat that started from `--model` or a stored default
  // never read a catalog and has none, which is why nothing is fetched for this.
  const [catalog, setCatalog] = useState<readonly ModelEntry[]>([])
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

  /** Open a model-first session on a chosen model, then chat. */
  const openModel = useCallback(
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

  /**
   * The picker answered a chat that had no default: offer to save the choice, then open the
   * session either way — the offer is an offer, not a gate on chatting (#114, U1).
   */
  const chooseModel = useCallback((modelId: string): void => {
    setScreen({ kind: 'save-default', modelId })
  }, [])

  const answerSaveDefault = useCallback(
    (save: boolean): void => {
      if (screen.kind !== 'save-default') return
      const { modelId } = screen
      if (!save) {
        openModel(modelId)
        return
      }

      void (async () => {
        try {
          await client.preferences.put({ default_model: modelId })
        } catch (error) {
          // Chatting must not wait on the preference: say what happened and let the next
          // keypress continue without the save.
          setScreen({ kind: 'save-default', modelId, error: describeError(error, context).message })
          return
        }
        openModel(modelId)
      })()
    },
    [client, context, openModel, screen],
  )

  // The prompt's history (#206), started beside the session lookup rather than before the
  // screen exists — nobody waits for it, and ↑ has it by the time a message could have been
  // sent. A history that could not be built is no history; see `loadHistory`.
  useEffect(() => {
    if (loadHistory === undefined) return
    let live = true
    void (async () => {
      const loaded = await loadHistory()
      if (live) setHistory(loaded)
    })()
    return () => {
      live = false
    }
  }, [loadHistory])

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
            setCatalog(target.models)
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

    case 'save-default':
      return (
        <SaveDefaultPrompt
          modelId={screen.modelId}
          error={screen.error}
          onAnswer={answerSaveDefault}
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
          history={history}
          catalog={catalog}
          // `/new` opens a session the way a first chat does — `openModel` — and the screen
          // for the old one unmounts with it, which disposes its stream (the effect below).
          onNewChat={openModel}
          onExit={() => {
            const { session } = screen
            session.dispose()
            // A deleted chat has no session to resume (epic #116 U5): say so instead of
            // printing a hint for an id the server no longer has.
            leave(
              session.getState().transcript.deleted
                ? { code: 0, deleted: true }
                : { code: 0, sessionId: session.session.id },
            )
          }}
        />
      )

    case 'no-models':
      return <NoModels server={context.server} />

    case 'failed':
      return <ErrorScreen report={screen.report} />
  }
}

/**
 * The one question a chat with no default asks after the picker: remember this choice?
 *
 * `y` saves it (`preferences.put`) and `n`/Enter skips; either way the chat opens. A save
 * that failed says so and steps out of the way on the next Enter — the chat is the point,
 * and the default can be set any time with `oh default-model`.
 */
function SaveDefaultPrompt({
  modelId,
  error,
  onAnswer,
  onCancel,
}: {
  readonly modelId: string
  readonly error?: string | undefined
  readonly onAnswer: (save: boolean) => void
  readonly onCancel: () => void
}) {
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onCancel()
      return
    }

    if (error !== undefined) {
      if (key.return) onAnswer(false)
      return
    }

    const answer = input.toLowerCase()
    if (answer === 'y') {
      onAnswer(true)
      return
    }
    if (answer === 'n' || key.return || key.escape) {
      onAnswer(false)
    }
  })

  if (error !== undefined) {
    return (
      <Box flexDirection="column">
        <Text color="red">{`could not save the default model: ${error}`}</Text>
        <Text dimColor>{`Press Enter to chat on ${modelId} without saving it.`}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>{`Save ${modelId} as your default model for new chats? [y/N]`}</Text>
      <Text dimColor>It is stored on the server, and the web app's Settings show it too.</Text>
    </Box>
  )
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
