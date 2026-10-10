import { providerName, selectSessionUsage, sessionCost } from '@openharness/client'
import type { Client, TranscriptError } from '@openharness/client'
import type { ModelEntry } from '@openharness/protocol'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { ModelPicker } from '../components/model-picker'
import { NoticeView } from '../components/notice-view'
import { PromptInput } from '../components/prompt-input'
import { usePromptSlot } from '../components/prompt-slot'
import { ProviderSetup } from '../components/provider-setup'
import { formatCostTotal } from '../components/reply-meta'
import { InputRule, modelLabel, modelPriceLookup, StatusLine } from '../components/status-line'
import { lastDrawn, TranscriptView } from '../components/transcript-view'
import type { PromptHistory } from '../history'
import type { ErrorContext } from '../errors'
import { clearScreen } from '../terminal'
import {
  CHAT_COMMANDS,
  currentModelOf,
  parseChatInput,
  unknownCommandNotice,
  type ChatCommand,
  type CommandContext,
} from './commands'
import type { ChatSession, Notice } from './session'

export interface ChatScreenProps {
  /** The running chat: transcript, stream, and the operations on them. */
  readonly session: ChatSession
  /**
   * The client the chat talks to — the same one the session was built over. `/providers`
   * (#210) needs it directly: the credential write and the catalog refresh are not things the
   * session runtime does.
   */
  readonly client: Client
  /** What the error messages should mention — the provider flow's failures among them. */
  readonly context: ErrorContext
  /** Open a URL in the browser; the provider flow's "get a key" page (`o`). */
  readonly openUrl: (url: string) => boolean
  /**
   * The session was refused as stale while connecting a provider (#210): leave so the run can
   * offer to sign in again, exactly as a 401 before the chat does.
   */
  readonly onSignIn: () => void
  /** Shown in the status line, e.g. that this is the dev fake. */
  readonly banner?: string | undefined
  /** What ↑ and ↓ in the prompt walk back through (#206). */
  readonly history?: PromptHistory | undefined
  /**
   * The model catalog, when the app has already read it (issue #208): the status line names
   * the model by its display name when it can. A chat that started without one — `--model`,
   * a stored default — has none, and names the model by its id until a `/model` pick loads
   * the list (see {@link modelLabel}).
   */
  readonly catalog?: readonly ModelEntry[] | undefined
  /** Called when the user has asked to leave: `/exit`, the second idle Ctrl+C, a deleted chat. */
  readonly onExit: () => void
  /**
   * Start a new chat on `modelId` — `/new`. The app opens the session and replaces this
   * screen with one for it; disposing this chat is the app's business, not this screen's.
   */
  readonly onNewChat: (modelId: string) => void
}

/**
 * The chat screen: transcript, status line, prompt.
 *
 * All the state lives in {@link ChatSession}; this is the rendering of it, plus the pieces of
 * interaction that belong to the screen rather than the prompt — Ctrl+C, Ctrl+L, and the
 * slash commands (#207), which are parsed here against `chat/commands.ts` and run with a
 * {@link CommandContext} this screen builds.
 *
 * The input area is a *slot*: the prompt usually, and a flow (`components/prompt-slot.tsx`)
 * while one is up. The model picker is the first flow — `/model` fetches the catalog and asks
 * through the slot, which is what the `/providers` key entry (#210) and the phase-5 question
 * and approval prompts will do too.
 */
export function ChatScreen({
  session,
  client,
  context,
  openUrl,
  onSignIn,
  banner,
  history,
  catalog: known,
  onExit,
  onNewChat,
}: ChatScreenProps) {
  const view = useSyncExternalStore(session.subscribe, session.getState, session.getState)
  const { request, element } = usePromptSlot()
  // The names the status line can use (issue #208): whatever the app already read, plus
  // whatever a `/model` pick reads later through the slot. Nothing is fetched for this on
  // its own — a chat opened on `--model` or a stored default must not pay for a catalog it
  // does not need.
  const [catalog, setCatalog] = useState<readonly ModelEntry[] | null>(known ?? null)
  const { stdout } = useStdout()
  const { suspendTerminal } = useApp()
  // A clear is in flight. A second Ctrl+L while the first is being handed over has nowhere
  // to go — Ink refuses to suspend a suspended terminal — so it is dropped instead.
  const clearing = useRef(false)

  /**
   * Read the catalog once, in the background, for the two things beyond the picker it is good
   * for (#247): the **prices** a cost is computed with, and the display names the status line
   * prefers over the raw id.
   *
   * It is deliberately not awaited, and a failure is silent. A chat opened on `--model` or on
   * a stored default starts immediately — that is the point of never paying for a catalog up
   * front — and a chat that cannot read one still chats: it just shows no cost.
   *
   * `null` is "not read yet", which is not the same statement as "read, and it lists nothing":
   * nothing is priced until the list arrives (see {@link costOf}), so a screen that has not
   * read a catalog shows no costs rather than showing every one of them as unknown.
   */
  useEffect(() => {
    if (known !== undefined) return undefined
    let cancelled = false
    void session
      .listModels()
      .then((models) => {
        if (!cancelled) setCatalog(models)
      })
      .catch(() => {
        // A read that failed is still an answered question: the transcript settles (see
        // `holdAll`), and a cost it cannot compute reads `—` rather than never arriving.
        if (!cancelled) setCatalog([])
      })
    return () => {
      cancelled = true
    }
  }, [session, known])

  // The catalog's prices: what every cost on screen — a reply's, the session's — is computed
  // with. A model the catalog does not carry has none, and its cost reads `—`; a catalog that
  // has not been read yet leaves the costs off entirely, because "—" would be a claim about a
  // price nobody looked up.
  //
  // A reply that settles before the list arrives therefore keeps whatever line it had — Ink's
  // `<Static>` writes a settled message once (#208, X2) — while the status line, which is
  // live, picks the cost up the moment it can.
  const costOf = useMemo(
    () => (catalog === null ? undefined : modelPriceLookup(catalog)),
    [catalog],
  )

  // A model-first session has no agent to name (issues #93, #95): the status line shows the
  // model that session runs. A pick that has not been sent yet is the model it *will* run,
  // so the line names it too and says when it applies.
  const agentName = session.session.agent?.name
  const currentModel = currentModelOf(session)
  // The model the line shows, named the way the catalog names it when the catalog is known
  // (issue #208) — and the model a pending `/model` pick *will* run, said so.
  const model =
    view.pendingModel === null
      ? modelLabel(currentModel, catalog ?? [])
      : `${modelLabel(view.pendingModel, catalog ?? [])} (next message)`

  // What the session has spent (#247), priced from the transcript's own totals — the running
  // ones the log reported, or the ones derived from its replies for a session stored before
  // they existed. Nothing until a request has run: a chat that has not answered has no cost
  // to report rather than a `$0.00` that claims its model is free.
  //
  // The total sums the requests the catalog could price and counts the rest (`$1.23 + 4
  // unpriced`, decided 2026-10-09); `—` is reserved for a session where nothing could be priced.
  // The compact form is what the status line falls back to when the terminal has no room for
  // the words: `$1.23+`.
  const usage = selectSessionUsage(view.transcript)
  const costTotal =
    costOf === undefined || usage.models.length === 0 ? undefined : sessionCost(usage, costOf)
  const cost = costTotal === undefined ? undefined : formatCostTotal(costTotal)
  const costCompact =
    costTotal === undefined ? undefined : formatCostTotal(costTotal, { compact: true })

  // A turn the server is retrying says so in the status line rather than in a notice of its
  // own (#208) — one line, not two about the same thing. An error that outlives its turn,
  // which is how a `session.error` reads back out of history, keeps the notice.
  const retrying =
    view.transcript.status === 'running' && view.transcript.lastError?.retryStatus === 'retrying'
      ? view.transcript.lastError.message
      : undefined

  // The two notices that sit under the transcript: what a command printed or a hint, and the
  // turn's own error when the status line is not already saying it (#208).
  const error = view.transcript.lastError
  const failure = error !== null && retrying === undefined ? turnErrorNotice(error) : null
  const hasNotice = view.notice !== null || failure !== null

  /**
   * Whether the transcript owes the block under it a blank line (issue #233).
   *
   * A user's message is banded, and its band ends in a blank line of its own
   * (`message-view.tsx`), so it owes nothing; an agent's reply ends in its last line or in its
   * metadata, and owes the line. An empty transcript — a session that has not started, or one
   * whose history is still loading — has nothing to be set off from at all, which is what keeps
   * the first frame free of a leading blank line. The question is about the last message
   * *drawn*: a reply that has been announced but has not produced a token yet is not there
   * (`transcript-view.tsx`), so the band above it is what the section is set off from.
   */
  const above = lastDrawn(view.transcript.messages)
  const owesBlank = above !== undefined && above.role !== 'user'

  /**
   * Wipe the screen, keeping the session (#206) — Ctrl+L, and `/clear` by another name.
   *
   * The wipe goes *through* Ink rather than around it: `suspendTerminal` erases the frame
   * Ink owns, hands the terminal over for the callback, and forces a full redraw on the way
   * back. Writing the escape sequence by hand would clear the screen and then leave it
   * blank, because the frame that followed is one Ink has already drawn and so never writes
   * again. Settled messages are `Static` output and are not replayed, which is the point:
   * the session keeps them, the view of it does not.
   */
  const clear = useCallback((): void => {
    if (clearing.current) return
    clearing.current = true
    void suspendTerminal(() => {
      clearScreen({ stdout })
    }).finally(() => {
      clearing.current = false
    })
  }, [stdout, suspendTerminal])

  /**
   * Ask for a model through the slot. The pick is pending rather than applied (#114, U3):
   * the next message carries it, and the status line says so until then.
   *
   * The slot also hands back the catalog it reads (#208), which is what lets the status line
   * name the model the way the picker just did.
   */
  const openModelPicker = useCallback((): void => {
    void (async () => {
      const modelId = await request<string | null>((settle) => (
        <ModelSlot session={session} settle={settle} onCatalog={setCatalog} />
      ))
      if (modelId !== null) session.setModel(modelId)
    })()
  }, [request, session])

  /**
   * Connect a provider without leaving the chat (#210, epic #201 X7) — `/providers`, the flow
   * the prompt slot was built for.
   *
   * After a save the catalog is read again, so `/model` offers the models the provider just
   * connected (the server has already dropped that provider's cache entry, so a plain read is
   * enough — see the client's model-catalog note), and the default the server picked for an
   * account that had none (U4) is named in a notice, which is the same "You're set" the
   * first-run flow ends on. The prompt comes back either way: a cancelled flow settles `null`
   * and changes nothing.
   */
  const openProviders = useCallback(
    (provider?: string): void => {
      void (async () => {
        const saved = await request<string | null>((settle) => (
          <ProviderSetup
            client={client}
            context={context}
            initialProvider={provider}
            openUrl={openUrl}
            onSaved={settle}
            onCancel={() => {
              settle(null)
            }}
            onStaleSession={onSignIn}
          />
        ))
        if (saved === null) return

        try {
          const catalog = await session.listModels()
          setCatalog(catalog)
          const { default_model: picked } = await client.preferences.get()
          session.showNotice({
            kind: 'info',
            text: `Connected ${providerName(saved)}.`,
            hints:
              picked === null ? [] : [`You're set: default model ${modelLabel(picked, catalog)}`],
          })
        } catch (error) {
          session.reportError(error)
        }
      })()
    },
    [client, context, onSignIn, openUrl, request, session],
  )

  /** Run a command the prompt parsed, with what only this screen can do (#207). */
  const runCommand = (command: ChatCommand, args: string): void => {
    const commandContext: CommandContext = {
      session,
      pickModel: openModelPicker,
      newChat: onNewChat,
      setupProviders: openProviders,
      clearScreen: clear,
      exit: onExit,
      showNotice: session.showNotice,
    }
    void command.run(commandContext, args)
  }

  /**
   * What the prompt submitted: a command to run, or a message to send.
   *
   * An unknown command is neither — it is named back to the user with the closest match and
   * sent nowhere, because the model would answer about a command nobody has (#207).
   */
  const onSubmit = (text: string): void => {
    const parsed = parseChatInput(text, CHAT_COMMANDS)
    switch (parsed.kind) {
      case 'message':
        void session.send(parsed.text)
        return
      case 'command':
        runCommand(parsed.command, parsed.args)
        return
      case 'unknown':
        session.showNotice(unknownCommandNotice(parsed.name, parsed.suggestion))
        return
    }
  }

  // The chat's own keys stay quiet while a flow has the input area: Ctrl+C belongs to the
  // picker then, and cancelling it must not also arm (or trigger) the chat's exit.
  useInput((input, key) => {
    if (element !== null) return
    if (!key.ctrl) return

    if (input === 'l') {
      clear()
      return
    }

    if (input !== 'c') return
    if (session.pressCtrlC() === 'exit') onExit()
  })

  // A chat deleted elsewhere is over (#114, epic #116 U5): the runtime has already said so
  // in the notice; leaving is immediate, and the caller prints where the session went.
  useEffect(() => {
    if (view.transcript.deleted) onExit()
  }, [view.transcript.deleted, onExit])

  return (
    <Box flexDirection="column">
      <TranscriptView
        messages={view.transcript.messages}
        currentModel={currentModel}
        costOf={costOf}
        // A reply settles into Ink's static output once and never redraws (#208, X2), so it is
        // held live until *everything* its footer needs has arrived: its own metadata, and —
        // while the prices are still being read (#247) — the rates that footer's cost is
        // computed from. That second half is `holdAll`: it covers the replies loaded from
        // history too, which would otherwise settle uncosted the instant they are drawn.
        holdLive={view.awaitingMetaId ?? undefined}
        holdAll={catalog === null}
      />
      {hasNotice && (
        <>
          {owesBlank && <Text> </Text>}
          {view.notice !== null && <NoticeView notice={view.notice} />}
          {failure !== null && <NoticeView notice={failure} />}
        </>
      )}
      {/* The input area is its own section (issue #233): a blank line, a dim full-width rule,
          and everything the console is — the status line, the prompt, and whatever has taken
          the prompt's place — under it. */}
      <InputRule blankAbove={owesBlank || hasNotice} />
      <StatusLine
        agentName={agentName}
        model={model}
        sessionId={session.session.id}
        status={view.transcript.status}
        phase={view.phase}
        cost={cost}
        costCompact={costCompact}
        banner={banner}
        runningSince={view.runningSince}
        lastTextAt={view.lastTextAt}
        retrying={retrying}
        interrupted={view.interrupted}
      />
      {element ?? (
        <PromptInput
          commands={CHAT_COMMANDS}
          history={history}
          onSubmit={onSubmit}
          onActivity={() => {
            session.dismissHint()
          }}
        />
      )}
    </Box>
  )
}

/**
 * The model picker as a flow in the prompt slot: read the catalog, then ask.
 *
 * The fetching is the flow's own business — the slot takes one element and one result,
 * however many steps happen in between — and a catalog that will not load settles `null`
 * with the error already reported, so the prompt comes back either way.
 *
 * `onCatalog` is how the catalog gets back out of the flow: the status line names models the
 * way the picker does, and the picker is the only thing here that ever reads the list (#208).
 */
function ModelSlot({
  session,
  settle,
  onCatalog,
}: {
  readonly session: ChatSession
  readonly settle: (modelId: string | null) => void
  readonly onCatalog: (models: readonly ModelEntry[]) => void
}) {
  const [models, setModels] = useState<readonly ModelEntry[] | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const catalog = await session.listModels()
        if (live) {
          onCatalog(catalog)
          setModels(catalog)
        }
      } catch (error) {
        if (live) {
          session.reportError(error)
          settle(null)
        }
      }
    })()
    return () => {
      live = false
    }
  }, [session, settle, onCatalog])

  if (models === null) {
    return <Text dimColor>loading models…</Text>
  }

  return <ModelPicker models={models} onSelect={settle} onCancel={() => settle(null)} />
}

/**
 * The transcript's own error — a `session.error` in the log, which is the brain saying the
 * turn failed rather than the client failing to reach it.
 *
 * It clears itself when a reply arrives. A *retrying* error on a turn that is still running
 * is not this line's business any more (#208): the status line says "Retrying…" with the
 * reason, which is the same fact in the place a reader is already looking, and printing both
 * would be two lines about one thing. What is left here is every error the status line cannot
 * say itself — one that ended its turn, and one read back out of history.
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
