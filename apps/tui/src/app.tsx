import { AuthenticationError, type Client } from '@openharness/client'
import type { ModelEntry, Session } from '@openharness/protocol'
import { Box, Text, useApp, useInput } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { ChatOptions } from './args'
import { openBrowser } from './browser'
import { ChatScreen } from './chat/screen'
import { createChatSession, type ChatSession } from './chat/session'
import { resolveTarget } from './chat/target'
import { ModelPicker } from './components/model-picker'
import { ProviderSetup } from './components/provider-setup'
import { modelLabel } from './components/status-line'
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
  /**
   * The chat could not start because the session was rejected (a 401), and this run can sign
   * in (#210, epic #201 X7): leave, ask `Sign in now? [Y/n]`, run the device flow outside the
   * UI, and mount the chat again on the token it stored. Only set when
   * {@link AppProps.offerSignIn} said so; otherwise a 401 is the error screen it always was.
   */
  readonly needsSignIn?: boolean | undefined
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
  /**
   * The account has no usable model. With no provider keys that means connecting one from the
   * terminal (#210): the explanation, the provider list, the hidden key entry. With keys but
   * an empty catalog it is the old message — there is nothing here to connect.
   */
  | { readonly kind: 'provider-setup' }
  /** A provider's first key was saved: name the default model the server picked, then chat. */
  | { readonly kind: 'provider-saved'; readonly modelId: string }
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
  /**
   * Open a URL in the browser — the provider setup's "get a key" page (#210, epic #201 X8).
   * Returns whether a browser was launched, so the flow can say "no browser here" when there
   * was nothing to open it with. Injectable so a test never starts one; the default is the
   * CLI's own {@link openBrowser} against `process.env`.
   */
  readonly openUrl?: ((url: string) => boolean) | undefined
  /**
   * Whether this run may sign in from the chat (#210, epic #201 X7): a 401 before the chat
   * starts then leaves with `needsSignIn` — "ask, run the device flow, try again" — instead of
   * rendering the error screen. Off by default, so a component rendered on its own (a test,
   * a story) shows the 401 it always did, and the caller that can sign in turns it on.
   */
  readonly offerSignIn?: boolean | undefined
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
  openUrl = defaultOpenUrl,
  offerSignIn = false,
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
  const leave = useCallback(
    (payload: ExitPayload): void => {
      if (left.current) return
      left.current = true
      if (onExit === undefined) {
        exit(payload)
      } else {
        onExit(payload)
      }
    },
    [exit, onExit],
  )

  /**
   * Leave so the run can offer the device-flow sign-in (#210) — the 401 the chat cannot get
   * past without a session. Stable, because the screens that call it are mounted once.
   */
  const leaveToSignIn = useCallback((): void => {
    leave({ code: 1, needsSignIn: true })
  }, [leave])

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

  /**
   * A provider key was saved (#210): the server picks a default model when the first one is
   * saved (U4), so read it back — and the catalog, so the confirmation and the chat name the
   * model the way the picker does. A save that left no model at all (a provider whose catalog
   * is empty) falls back to the screen that says so rather than opening a chat on nothing.
   */
  const providerSaved = useCallback((): void => {
    void (async () => {
      try {
        const [preferences, catalog] = await Promise.all([
          client.preferences.get(),
          client.models.list(),
        ])
        const modelId = preferences.default_model ?? catalog.data[0]?.id
        if (modelId === undefined) {
          setScreen({ kind: 'provider-setup' })
          return
        }
        setCatalog(catalog.data)
        setScreen({ kind: 'provider-saved', modelId })
      } catch (error) {
        if (offerSignIn && error instanceof AuthenticationError) {
          leaveToSignIn()
          return
        }
        setScreen({ kind: 'failed', report: describeError(error, context) })
      }
    })()
  }, [client, context, offerSignIn, leaveToSignIn])

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
            setScreen({ kind: 'provider-setup' })
            break
        }
      } catch (error) {
        // A 401 before the chat exists is the sign-in case (#210): when the run can sign in,
        // leave and let it ask, rather than showing the message `oh login` used to be the only
        // answer to. Without that (a component on its own), the error screen is unchanged.
        if (offerSignIn && error instanceof AuthenticationError) {
          leaveToSignIn()
          return
        }
        setScreen({ kind: 'failed', report: describeError(error, context) })
      }
    })()
    // Nothing to cancel: the app is mounted for the life of the process, and the requests
    // resolve into it.
  }, [])

  // The screens that have nothing to offer render once and then give the terminal back.
  const doneForGood = screen.kind === 'failed'
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
          client={client}
          context={context}
          openUrl={openUrl}
          onSignIn={leaveToSignIn}
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

    case 'provider-setup':
      return (
        <ProviderOnboarding
          client={client}
          context={context}
          openUrl={openUrl}
          offerSignIn={offerSignIn}
          onSignIn={leaveToSignIn}
          onSaved={providerSaved}
          onCancel={() => {
            // Declining the setup is the old no-key ending: nothing was connected, and there
            // is no model to chat with — exit 1, the code for "there is nothing here to do".
            leave({ code: 1 })
          }}
        />
      )

    case 'provider-saved':
      return (
        <ProviderSaved
          modelId={screen.modelId}
          catalog={catalog}
          onStart={() => {
            openModel(screen.modelId)
          }}
          onCancel={() => {
            leave({ code: 0 })
          }}
        />
      )

    case 'failed':
      return <ErrorScreen report={screen.report} />
  }
}

/** The real "open a URL": the CLI's browser opener, against this process's environment. */
function defaultOpenUrl(url: string): boolean {
  return openBrowser(url).opened
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

/**
 * The screen an account with no usable model lands on (#210, epic #201 X7).
 *
 * It reads the credentials list once, because the two states behind "there is no model" need
 * different answers: **no keys at all** is the case the terminal can fix — connect a provider
 * right here, with the hidden key entry — while **keys but an empty catalog** is not something
 * this screen can help with, and keeps the message that says where a model comes from.
 *
 * The read is what decides, and it decides once: saving a key makes the list non-empty, and a
 * live condition would swap the screen out from under the reader mid-flow.
 */
function ProviderOnboarding({
  client,
  context,
  openUrl,
  offerSignIn,
  onSignIn,
  onSaved,
  onCancel,
}: {
  readonly client: Client
  readonly context: ErrorContext
  readonly openUrl: (url: string) => boolean
  readonly offerSignIn: boolean
  readonly onSignIn: () => void
  readonly onSaved: () => void
  readonly onCancel: () => void
}) {
  const [state, setState] = useState<OnboardingState>({ kind: 'loading' })

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const { data } = await client.providerCredentials.list()
        if (live) setState(data.length === 0 ? { kind: 'connect' } : { kind: 'keys' })
      } catch (error) {
        if (!live) return
        // The list needs a session like everything else: a stale one is the sign-in case.
        if (offerSignIn && error instanceof AuthenticationError) {
          onSignIn()
          return
        }
        setState({ kind: 'failed', report: describeError(error, context) })
      }
    })()
    return () => {
      live = false
    }
  }, [client, context, offerSignIn, onSignIn])

  // Two of the three answers have nothing to offer: keys without a model, and a list that
  // could not be read. They render once — the message or the error — and then give the
  // terminal back the way the screen they replace always did, exit 1.
  useEffect(() => {
    if (state.kind === 'keys' || state.kind === 'failed') onCancel()
  }, [state.kind, onCancel])

  switch (state.kind) {
    case 'loading':
      return <Text dimColor>checking your model providers…</Text>
    case 'keys':
      return <NoModels server={context.server} />
    case 'failed':
      return <ErrorScreen report={state.report} />
    case 'connect':
      return (
        <ProviderSetup
          client={client}
          context={context}
          openUrl={openUrl}
          onSaved={onSaved}
          onCancel={onCancel}
          onStaleSession={onSignIn}
        />
      )
  }
}

/** What {@link ProviderOnboarding} has worked out so far. */
type OnboardingState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'connect' }
  | { readonly kind: 'keys' }
  | { readonly kind: 'failed'; readonly report: ErrorReport }

/**
 * What to say when there are keys but still no model — a provider whose list came back empty,
 * or one the catalog has nothing for. The CLI can no longer be the answer for "no key yet"
 * (it can add one), so this points at the command that replaces one.
 */
function NoModels({ server }: { server?: string | undefined }) {
  return (
    <Box flexDirection="column">
      <Text>No model yet — your keys did not list one to chat with.</Text>
      <Text dimColor>
        {`Add or replace a key with \`oh providers add\` (or /providers in a chat)${
          server === undefined ? '' : `, on ${server}`
        }, then run \`oh\` again.`}
      </Text>
      <Text dimColor>Every model the picker offers is one your own key can use.</Text>
    </Box>
  )
}

/**
 * The confirmation after a first provider key is saved (#210): the default model the server
 * picked, said back before the chat opens on it — the same sentence the web app's first-run
 * flow ends on. Enter starts the chat; Ctrl+C leaves without one.
 */
function ProviderSaved({
  modelId,
  catalog,
  onStart,
  onCancel,
}: {
  readonly modelId: string
  readonly catalog: readonly ModelEntry[]
  readonly onStart: () => void
  readonly onCancel: () => void
}) {
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onCancel()
      return
    }
    if (key.return) onStart()
  })

  return (
    <Box flexDirection="column">
      <Text>{`You're set: default model ${modelLabel(modelId, catalog)}.`}</Text>
      <Text dimColor>Press Enter to start chatting, Ctrl+C to stop here.</Text>
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
