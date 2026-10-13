import {
  CREDENTIAL_TARGETS,
  clearedResultsNotice,
  compactionThreshold,
  contextMeter,
  mcpFailureNotice,
  modelSupportsTools,
  pendingCalls,
  pendingCallsNotice,
  sessionCost,
  stepLimitNotice,
  stuckNotice,
  truncatedResultsNotice,
} from '@openharness/client'
import type {
  CredentialTarget,
  ModelPriceLookup,
  TaskCard,
  TranscriptMessage,
} from '@openharness/client'
import type { Mode, UserToolConfirmationEventInput } from '@openharness/protocol'
import { Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useClient } from '../client-provider'
import type { DeleteSessionResult } from '../../hooks/use-sessions'
import type { ModesView } from '../../hooks/use-modes'
import { useSession } from '../../hooks/use-session'
import { useSessionBreadcrumb } from '../../hooks/use-session-breadcrumb'
import type { ModelsView } from '../../hooks/use-models'
import { usePreferences } from '../../hooks/use-preferences'
import { useSubtreeUsage } from '../../hooks/use-subtree-usage'
import { parseComposerInput } from '../../lib/commands'
import { readTodoPanelCollapsed, writeTodoPanelCollapsed } from '../../lib/todo-panel'
import {
  formatCostTotal,
  formatCount,
  shortId,
  sessionLabel,
  unpricedExplanation,
} from '../../lib/format'
import { providerOf, type ModelNameLookup } from '../../lib/models'
import { modeNameOf } from '../../lib/modes'
import { showNotice } from '../../lib/notice'
import { ModelPicker } from '../models/model-picker'
import { AddProviderDialog } from '../providers/add-provider-dialog'
import { Button } from '../ui/button'
import { Composer, focusComposer } from './composer'
import { ContextMeter } from './context-meter'
import { ErrorBanner } from './error-banner'
import { McpNotice } from './mcp-notice'
import { MessageList } from './message-list'
import { StatusIndicator } from './status-indicator'
import { SubagentHeader } from './subagent-header'
import { TodoPanel } from './todo-panel'
import { workingState } from './working-row'

/**
 * An open session: header, conversation, errors, composer.
 *
 * All of it is `useSession(client, sessionId)` — the hook loads the history, follows the live
 * stream, and owns the transcript; this screen only decides what it looks like.
 *
 * Two things of its own since epic #116:
 *
 * - **The composer's model switch (U3).** The selector shows the session's current model —
 *   the log's last `user.message.model`, else the model the session was created with. A
 *   pick that differs is held here and sent with the *next* message (`{ model }`); the
 *   transcript then moves the session's model, so the selector and the "Switched to …"
 *   marker both follow the log rather than this state.
 * - **Delete (U5).** The header's action confirms in the page — a `window.confirm` would
 *   block the page and cannot be styled or tested like the rest of the app — and the shell
 *   leaves the chat after it (the open chat goes to New chat). A chat deleted somewhere else
 *   announces itself through the stream's `session.deleted`: the app shows the notice and
 *   leaves, so the reader is never left typing into a log that no longer exists.
 * - **The draft is the screen's (#212).** The composer has been able to take its text from
 *   the caller since U10; what needed it here is Edit and resend, which puts a message that is
 *   already in the transcript back in the box. A send clears it the same way the composer's
 *   own text used to be cleared — through `onValueChange('')` — so there is still exactly one
 *   rule about what is in the box.
 * - **Edit and resend rewinds (#238).** Putting the words back in the box also remembers
 *   *which* message they came from, and that is what the send that follows rewinds the session
 *   to: the conversation restarts from the edited message, the transcript drops what it
 *   replaced, and the model never sees it. The memory is dropped when the box is **cleared**
 *   (how an edit is cancelled — a cancelled edit must not rewind, and Cancel and Escape are
 *   spelled as clearing it) and after a send, so the composer is never left in an editing mode
 *   the reader cannot see: the indicator the composer draws from it says what a send will do.
 *   The action is disabled — and a send withheld — whenever the session is **not idle**: the
 *   server takes a rewind only from an idle session (409 otherwise), because the turn in
 *   flight owns the branch being taken back.
 */
/** The lookup a screen with no catalog prices with: nothing is known, so every cost is `—`. */
const unknownPrices: ModelPriceLookup = () => null

export function ChatView({
  sessionId,
  nameOf,
  costOf,
  catalog,
  modes,
  onDelete,
  onDeleted,
  onTasksChanged,
}: {
  sessionId: string
  /**
   * The catalog lookup behind the label (#91): an untitled session is headed by its model's
   * display name, or by the `provider/model` id when the catalog does not know it. The agent
   * is never named — a chat is started from a model now (epic #92).
   */
  nameOf?: ModelNameLookup | undefined
  /** The catalog's prices: what a reply's cost and the session's total are computed with (#247). */
  costOf?: ModelPriceLookup | undefined
  /** The shell's catalog: what the composer's model selector offers. */
  catalog: ModelsView
  /** The shell's modes (#245, M6): the presets the composer's selector offers above the models. */
  modes: ModesView
  /** Delete this chat; the shell navigates away when it was the open one. */
  onDelete: (sessionId: string) => Promise<DeleteSessionResult>
  /** This chat was deleted elsewhere: the shell drops its row and leaves it. */
  onDeleted: (sessionId: string) => void
  /**
   * This chat's tasks moved — it is opened, or a helper was started under it (epic #340, #346).
   *
   * The sidebar nests a chat's subagents under its row, and that read is the shell's
   * (`useSessionTree`); this is how the shell hears that a chat it is already showing has changed
   * what it has to nest. Omitted, nothing is reported.
   */
  onTasksChanged?: (() => void) | undefined
}) {
  const client = useClient()
  const {
    session,
    messages,
    summaries,
    summarizing,
    context,
    truncation,
    manualCompaction,
    toolCalls,
    todos,
    tasks,
    truncatedToolResults,
    clearedToolResults,
    confirmations,
    answering,
    searches,
    usage,
    status,
    lastError,
    mcpFailure: storedMcpFailure,
    loadingHistory,
    requestError,
    deleted,
    model,
    send,
    compact,
    interrupt,
    stopTask,
    respond,
    dismissError,
  } = useSession(client, sessionId)
  // The share of the budget a chat compacts at (epic #277, K10; #280), from the reader's stored
  // preference: read here rather than threaded down the shell, because the one place the lookup
  // lives is `compactionThreshold` in `@openharness/client` and a chat is where the meter is
  // drawn. A server that predates the field — or a read that failed — leaves the default.
  const { preferences } = usePreferences(client)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // The draft, owned here rather than by the composer (#212): "Edit and resend" puts the
  // reader's own words back in the box, and a screen that wants to put words in the box owns
  // its text (U10) — the composer is the box, not the thing that decides what is in it.
  const [draft, setDraft] = useState('')

  // The model the session runs: the log's last explicit switch (the transcript's `model`), the
  // model the last request **ran** (`meta.model`, off its span — which for a chat on a mode is
  // the mode's resolved model, so an edit to the mode shows here from the next reply on), or
  // the session resource's, on a chat that has not made a request yet.
  const lastReplyModel =
    [...messages]
      .reverse()
      .find((message) => message.role === 'agent' && message.meta?.model !== undefined)?.meta
      ?.model ?? null
  const sessionModel = model ?? lastReplyModel ?? session?.model.id ?? null
  // The mode the session resource says the chat follows, before this tab has sent a switch (#245,
  // M6). The tab's own memory (above) wins once it has one.
  const sessionModeId = session?.mode ?? null
  // What the session has spent, priced with the catalog's rates (#247) — computed here, never
  // stored. The total sums the requests that could be priced and counts the ones that could
  // not, and `—` is reserved for a session where nothing at all could be priced. Nothing to say
  // until a request has run.
  const sessionCostTotal =
    usage.models.length === 0 ? null : sessionCost(usage, costOf ?? unknownPrices)
  // The breadcrumb up the tree, and the two lines a child's chat owes a reader (epic #340, S9;
  // #346). `null` for a top-level chat, which is most of them — nothing is read for one.
  const breadcrumb = useSessionBreadcrumb(client, session)
  // What this chat's **descendants** spent (#344, S8; #346), read from the usage route because the
  // transcript's own totals are the session's alone. Only a chat that has run a task asks: the
  // signature is what it can see of them, so the numbers move when it learns something new about a
  // helper. See `hooks/use-subtree-usage.ts`.
  const descendants = useSubtreeUsage(client, sessionId, {
    enabled: tasks.length > 0,
    signature: tasks.map((card) => `${card.id}:${card.status}`).join('|'),
  })
  // The four counters are disjoint (the protocol's own rule), so the sum is the subtree's real
  // token total. It rides the descendants line's `title`, where it costs no pixels.
  const descendantTokens =
    descendants === null
      ? 0
      : descendants.totals.input_tokens +
        descendants.totals.output_tokens +
        descendants.totals.cache_creation_input_tokens +
        descendants.totals.cache_read_input_tokens
  // How full the context is (epic #277, K10; #280): the last real request's prompt size, measured
  // against the budget of the model the session runs **now** — so a switch re-measures from the
  // catalog's entry for the new model, and the meter moves with it. `null` until something has
  // run, which is a chat with nothing to say about its context rather than one at 0%.
  const meter = contextMeter(context, {
    model: catalog.models.find((entry) => entry.id === sessionModel),
    threshold: compactionThreshold(preferences),
  })
  // The tool half of the screen (epic #303, X2/X5/X9; #308). All of it is the client's words: the
  // step limit and the two result notices come from the transcript's records, and the model's
  // ability to call tools from its catalog entry's `tool_call` (which the server answers). The
  // step-limit sentence replaces the generic error banner — it is a notice, not a failure to
  // retry — so the reader is told once. A turn the model looped on (#331) is the same kind of
  // notice, drawn in the same place.
  const stepLimit = stepLimitNotice(lastError) ?? stuckNotice(lastError)
  // An MCP server that could not be used is a notice, not a failure (epic #303, X10; #313): the
  // chat goes on without that server's tools, and the one thing a reader can do about it is
  // reconnect it — so it is drawn with that action rather than as the generic red banner. The
  // words and the server the message names come from the client's `mcpFailureNotice`.
  // The MCP failure is the transcript's own record rather than `lastError` (#313): the turn
  // carries on without the server, so the reply that clears `lastError` must not take the notice
  // with it. See `selectMcpFailure`.
  const mcpFailure = mcpFailureNotice(storedMcpFailure)
  // Dismissing it hides that one message: a later turn's failure is a different sentence and is
  // shown again, because a reader who dismissed one notice did not ask to never hear of MCP.
  const [dismissedMcp, setDismissedMcp] = useState<string | null>(null)
  const mcpNotice = mcpFailure === null || mcpFailure.message === dismissedMcp ? null : mcpFailure
  const toolsUnsupported =
    modelSupportsTools(catalog.models.find((entry) => entry.id === sessionModel)) === false
  const truncatedResultsNoticeText = truncatedResultsNotice(truncatedToolResults)
  const clearedResultsNoticeText = clearedResultsNotice(clearedToolResults)
  // The calls waiting on the reader (epic #303, X6; #310): what the composer has to warn about,
  // because a message sent while they wait resolves every one of them.
  const waiting = pendingCalls(toolCalls).filter(
    (entry) => !confirmations.some((confirmation) => confirmation.toolUseId === entry.call.id),
  ).length
  const declineNotice = pendingCallsNotice(waiting)
  // A pick that has not been sent yet (U3): the selector shows it, the next message carries it.
  const [chosen, setChosen] = useState<string | null>(null)
  // A mode pick, held the same way (#245, M6): the next message carries it, and the chat then
  // follows the mode live.
  const [pendingMode, setPendingMode] = useState<Mode | null>(null)
  // The mode this tab believes the chat follows, once a switch has been sent. `undefined` is
  // "nothing sent yet, read the session"; `null` is "detached by a plain model switch".
  const [modeInEffect, setModeInEffect] = useState<string | null | undefined>(undefined)
  const currentModeId =
    pendingMode?.id ?? (modeInEffect === undefined ? sessionModeId : modeInEffect)
  const currentModeName = modeNameOf(modes.modes, currentModeId)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // The Add-provider dialog (X5). Three states in one value: `undefined` is closed, `null` is
  // open with the provider left to the reader (the picker's "+ Add provider"), and a provider
  // id is open on that provider's form (the missing-key banner, which knows which one failed).
  const [addingProvider, setAddingProvider] = useState<CredentialTarget | null | undefined>(
    undefined,
  )
  // The message an edit is rewriting (#238): "Edit and resend" puts the reader's own words back
  // in the box and remembers where they came from, and the send that follows rewinds the
  // session to that message. Cleared when the box is emptied (an edit the reader took back) and
  // after a send.
  const [editing, setEditing] = useState<{ readonly seq: number } | null>(null)
  // The reader has pressed Stop on this turn (U10). Nothing in the log says a request was  // interrupted *by the reader* — the log says the turn ended — so the screen remembers the one
  // action that can only have come from here, and drops it the moment a new message is sent:
  // "Interrupted" belongs to the turn it stopped, not to the chat.
  const [interrupted, setInterrupted] = useState(false)
  // The task list's fold (#314). The reader's own choice for this chat, read once from
  // `localStorage` — the screen is keyed by session, so "once" is "once per chat" — and `null`
  // while they have not chosen, which is what lets the two placements default differently: the
  // row above the composer starts folded when the list is long, the side panel does not
  // (`TodoPanel`'s own rule). Nothing is written until the reader toggles it, so a chat nobody
  // folded keeps no state at all. See `lib/todo-panel.ts` for the key and the storage rules.
  const [todosChoice, setTodosChoice] = useState<boolean | null>(() =>
    readTodoPanelCollapsed(sessionId),
  )
  const toggleTodos = useCallback(
    (collapsed: boolean): void => {
      setTodosChoice(collapsed)
      writeTodoPanelCollapsed(sessionId, collapsed)
    },
    [sessionId],
  )

  // A chat opens with the cursor in the box: whether it was picked from the sidebar or just
  // created from New chat, the next thing the user does is type.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Deleted elsewhere (#111, U5): the stream's last event says so. Leave the chat — the shell
  // drops the row and navigates — and let the screen the reader lands on say why.
  useEffect(() => {
    if (!deleted) {
      return
    }
    showNotice('This chat was deleted.')
    onDeleted(sessionId)
  }, [deleted, onDeleted, sessionId])

  // The shell hears that this chat's tasks moved (epic #340, #346): once on mount — opening a chat
  // is one of the two things that can change what the sidebar nests under it — and again whenever
  // the count changes, which is when a helper was started from here. The callback is held in a ref
  // so the effect depends on the count alone: the shell's own state moves when this report lands,
  // and a dependency on the callback's identity would be a loop.
  const taskCount = tasks.length
  const reportTasks = useRef(onTasksChanged)
  reportTasks.current = onTasksChanged
  useEffect(() => {
    reportTasks.current?.()
  }, [taskCount])

  // Whether the session is idle, which is the state the server takes a rewind in (#238). The
  // web's status is exactly that state — `running` is the whole of "not idle" — so the
  // transcript's Edit action and a send of a pending edit read it here rather than each
  // spelling out a status of their own.
  const idle = status === 'idle'
  // A pending edit whose rewind the server would refuse: the send is withheld, and the
  // composer's indicator says what to wait for.
  const editBlocked = editing !== null && !idle

  const sendFromComposer = useCallback(
    async (text: string): Promise<boolean> => {
      // A pending edit is a rewind, and the server takes one only while the session is idle
      // (#238): the turn in flight owns the branch being replaced. Keep the draft and the edit
      // — the composer's indicator says why — and send nothing, rather than fire a request
      // that comes back a 409.
      if (editBlocked) {
        return false
      }
      // A slash command is not a message (#283): `/compact [instructions]` asks the brain to
      // summarize the older history instead of sending words, so it never carries a model, a
      // mode or a rewind — and a line that names no command falls through as an ordinary send.
      const command = parseComposerInput(text)
      if (command.kind === 'compact') {
        setInterrupted(false)
        // The request is stored and folded into the transcript; the outcome arrives on the
        // stream. A failure keeps the text in the box, exactly as a failed send does.
        return await compact(command.instructions)
      }
      // Sending is the start of a new turn: whatever the last one was stopped short of is no
      // longer what the foot of the transcript is about.
      setInterrupted(false)
      // A picked model is a switch when it differs from what the session runs — or when the
      // session is on a **mode**: picking the very model the mode resolves to is still a switch
      // away from the mode, and it is what detaches the chat (#245, M6).
      const switching = chosen !== null && (chosen !== sessionModel || currentModeId !== null)
      const switchingMode = pendingMode !== null && pendingMode.id !== sessionModeId
      const stored = await send(text, {
        ...(switchingMode && pendingMode !== null ? { mode: pendingMode.id } : {}),
        ...(!switchingMode && switching && chosen !== null ? { model: chosen } : {}),
        ...(editing === null ? {} : { rewindTo: editing.seq }),
      })
      if (stored) {
        // The edit has been sent (or the message was an ordinary one): either way this is no
        // longer an edit, and the next send must not rewind the session to the same message.
        setEditing(null)
        if (switchingMode) {
          // The chat follows the mode from here; the tab remembers it because the transcript
          // tracks models, not modes, and the header reads this rather than a stale session.
          setModeInEffect(pendingMode?.id ?? null)
          setPendingMode(null)
        } else if (switching) {
          // The stored event moves the transcript's model to the pick; from here the selector
          // reads the log, and the message carries the "Switched to …" marker. A plain model
          // switch also detaches the chat from any mode (#245, M6).
          setChosen(null)
          setModeInEffect(null)
        }
      }
      return stored
    },
    [chosen, compact, editBlocked, editing, pendingMode, sessionModeId, sessionModel, send],
  )

  // Stop, and the word for it (U10): the interrupt request goes out, and the row at the foot
  // of the transcript says what was done — until the next message.
  const stop = useCallback(async (): Promise<void> => {
    setInterrupted(true)
    await interrupt()
  }, [interrupt])

  // "Edit and resend" (#238): the message goes back in the box, with the cursor in it, and the
  // screen remembers which one it was. Everything stays where it is until the reader sends —
  // an edit that is never sent is not an edit, which is why nothing is rewound here.
  const editFromTranscript = useCallback((message: TranscriptMessage): void => {
    setDraft(message.text)
    setEditing({ seq: message.position })
    focusComposer()
  }, [])

  // Answer the calls waiting on the reader (epic #303, X6; #310). The hook owns the request and
  // its failure; this only says when there is nothing to send. A message sent while calls wait
  // resolves them instead, which is what the notice above the box warns about.
  const answerPending = useCallback(
    (events: readonly UserToolConfirmationEventInput[]): void => {
      void respond(events)
    },
    [respond],
  )

  // The task whose Stop this tab has sent (epic #340, S9; #346). It is a card's own button, so the
  // "Stopping…" state belongs to the one that was pressed — and it is dropped as soon as the
  // request answers either way: the card's real state comes from the log, which the interrupt
  // makes the child write.
  const [stoppingTask, setStoppingTask] = useState<string | null>(null)
  const stopTaskFromCard = useCallback(
    (card: TaskCard): void => {
      if (card.childSessionId === null) {
        return
      }
      setStoppingTask(card.id)
      void stopTask(card.childSessionId).finally(() => {
        setStoppingTask(null)
      })
    },
    [stopTask],
  )

  // The composer's text, and the one rule about the edit: **clearing the box cancels it**. A
  // reader who empties the box and types something else is writing a new message at the end of
  // the conversation — the branch they were about to take back is theirs to keep.
  const changeDraft = useCallback((text: string): void => {
    setDraft(text)
    if (text === '') {
      setEditing(null)
    }
  }, [])

  // Cancel, and Escape beside it in the composer: leave edit mode the way clearing the box
  // does, so there is still exactly one rule about what ends an edit — the draft goes with it,
  // because a cancelled edit is not a message waiting to be sent.
  const cancelEdit = useCallback((): void => {
    changeDraft('')
  }, [changeDraft])

  // A chat's context-filled state and its tool screen are the transcript's own data, so the
  // foot is memoized: a keystroke re-renders this screen, and `statusRow` as a fresh object
  // would defeat {@link MessageList}'s memo and re-render every message in the conversation
  // (#314). Its inputs are the log's, which is what makes the identity stable between
  // keystrokes and *different* when the turn really changed — the rule `memo` compares with.
  const newest = messages.at(-1)
  const hasReplyText = newest?.role === 'agent' && newest.text.trim() !== ''
  const retrying = lastError?.retryStatus === 'retrying'
  const retryReason = lastError?.message
  const compacting = manualCompaction?.pending === true
  // The transcript's own foot (U10). "No text has arrived" means the turn has not drawn
  // anything yet: an agent message is the newest one and it is still empty, so an ordinary
  // reply in flight (which is text on screen) gets no row.
  const statusRow = useMemo(
    () =>
      workingState({
        status,
        retrying,
        retryReason,
        interrupted,
        hasReplyText,
        // A compaction in flight is what the turn is doing (epic #277, K10): it outranks a plain
        // "Working…" because it says how many passes are left, and a retry because it is the newer
        // statement about the same wait.
        summarizing,
        // The ask is stored and answered later (#283), so between the two the row says what the
        // reader is waiting for — unless the engine has already reported a pass, which is a more
        // precise statement about the same wait.
        compacting,
      }),
    [status, retrying, retryReason, interrupted, hasReplyText, summarizing, compacting],
  )

  const confirmDelete = async (): Promise<void> => {
    setDeleting(true)
    setDeleteError(null)
    const result = await onDelete(sessionId)
    setDeleting(false)
    if (result.ok) {
      // The shell navigates when this was the open chat; the row is already gone otherwise.
      return
    }
    setDeleteError(result.message)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Where this chat sits in a tree, and what being a subagent means — only ever drawn for a
          child (epic #340, S9; #346). It is chrome *about* the chat rather than part of its title,
          so it is its own strip above the header. */}
      {breadcrumb === null ? null : <SubagentHeader chain={breadcrumb} nameOf={nameOf} />}
      <header className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-medium">
            {session === null ? shortId(sessionId) : sessionLabel(session, nameOf)}
          </h1>
          <p className="truncate text-xs text-muted-foreground" data-slot="session-subtitle">
            {/* The mode the chat follows, and what it resolved to (#245, M6): the name, then
                the model the log last ran. A chat without a mode shows the model alone. */}
            {session === null ? (
              'Loading…'
            ) : (
              <>
                {currentModeName === null ? null : (
                  <span data-slot="session-mode">{currentModeName} · </span>
                )}
                {sessionModel ?? session.model.id}
              </>
            )}
            {sessionCostTotal === null ? null : (
              <>
                {' · '}
                {/* What the session spent, beside the model it spent it on (#247). The money is
                    the priced part and `+ N unpriced` names the rest — `—` only when nothing in
                    the session could be priced — and nothing at all until something has run: a
                    chat that has not answered yet has no cost to report. */}
                <span
                  data-slot="session-cost"
                  title={
                    sessionCostTotal.unpriced_requests === 0
                      ? undefined
                      : unpricedExplanation(sessionCostTotal.unpriced_requests)
                  }
                >
                  {formatCostTotal(sessionCostTotal)}
                </span>
              </>
            )}
            {/* What the chat searched for (epic #303, X5; #305; #308): the same count the usage
                routes report, read off the calls this transcript already holds. A count and never
                a price — the operator pays the search provider. Nothing is shown until one ran. */}
            {searches === 0 ? null : (
              <>
                {' · '}
                <span data-slot="session-searches">
                  {searches} {searches === 1 ? 'search' : 'searches'}
                </span>
              </>
            )}
            {/* The helpers' share of the bill (epic #340, S8; #344; #346). The number beside the
                cost above is this chat's **own** log; a chat that delegated work spent more than
                that, and the route is what says how much more. Drawn only once a task has spent
                something, so a chat that started a helper and has not been billed shows nothing
                rather than `$0.00`. */}
            {descendants === null || descendants.by_model.length === 0 ? null : (
              <>
                {' · '}
                <span
                  data-slot="session-descendants"
                  title={`${formatCount(descendantTokens)} tokens, across this chat's subagents.`}
                >
                  + subagents {formatCostTotal(descendants)}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* How full the context is (#280), beside the state of the turn: it is the other thing
              a reader checks here, and it is the one gauge in the header. It is `shrink-0`, so a
              narrow header ellipsizes the title rather than the meter — and the meter itself
              drops to its bar-less short form below `sm`. */}
          {meter === null ? null : <ContextMeter meter={meter} />}
          <StatusIndicator status={status} retrying={lastError?.retryStatus === 'retrying'} />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Delete chat"
            onClick={() => {
              setConfirmingDelete(true)
              setDeleteError(null)
            }}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      </header>

      {confirmingDelete ? (
        <div className="flex flex-wrap items-center gap-2 border-b bg-destructive/5 px-4 py-2 text-sm">
          <span>Delete this chat and all its messages?</span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={deleting}
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {/* The transcript and the composer are **one column**, and from `xl` up the task list is a
          full-height column beside them (#314; the axis: #316). The composer block — the notices,
          the banners, the box — lives inside that column rather than spanning the view, so the
          transcript and the composer are centred on the same `max-w-3xl` axis: with the panel
          drawn as a sibling of the transcript only, the composer was centred on the whole view
          while the conversation was centred on the narrower left column, and the two read as
          misaligned. Below `xl` there is no room for a column, so the panel is drawn above the
          composer instead — one instance per breakpoint, which is the same CSS switch the shell's
          sidebar uses. With no task list the single column fills the row exactly as the
          transcript did before the panel existed. */}
      <div className="flex min-h-0 flex-1">
        <div data-slot="chat-column" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MessageList
            messages={messages}
            summaries={summaries}
            toolCalls={toolCalls}
            tasks={tasks}
            onStopTask={stopTaskFromCard}
            stoppingTask={stoppingTask}
            truncation={truncation}
            compaction={manualCompaction}
            stepLimit={stepLimit}
            toolsUnsupported={toolsUnsupported}
            truncatedResults={truncatedResultsNoticeText}
            clearedResults={clearedResultsNoticeText}
            confirmations={confirmations}
            answering={answering}
            onRespond={answerPending}
            loading={loadingHistory}
            nameOf={nameOf}
            costOf={costOf}
            working={statusRow}
            onEdit={editFromTranscript}
            editDisabled={!idle}
            replacingFrom={editing?.seq}
          />
          <div className="border-t px-4 py-3">
            <div data-slot="composer-column" className="mx-auto w-full max-w-3xl space-y-2">
              {/* The chat's task list (epic #303, X5; #305; #308) below `xl`, above the composer:
                  it is chrome about the work, not part of the conversation, so it must not scroll
                  away with the transcript — and it is `null` (never an empty list) once no
                  `todo_write` call has taken effect. */}
              {todos === null ? null : (
                <TodoPanel
                  todos={todos}
                  collapsed={todosChoice}
                  onToggle={toggleTodos}
                  variant="bottom"
                />
              )}
              {/* Sending a message is allowed while calls wait — and it declines them all (epic
                  #303, X6; #310), so the box says so before the reader presses Enter rather than
                  after. The prompts above stay usable; this is only the other way out. */}
              {declineNotice === null ? null : (
                <p
                  data-slot="pending-notice"
                  className="rounded-lg border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground"
                >
                  {declineNotice}
                </p>
              )}
              {deleteError === null ? null : (
                <ErrorBanner
                  title="Could not delete the chat"
                  message={deleteError}
                  onDismiss={() => setDeleteError(null)}
                />
              )}
              {/* A step-limit error is drawn by the tool notices below the transcript — it is a
                  notice ("send a message to carry on"), not a failure — so the red banner is
                  skipped for exactly that error type rather than saying it twice. An MCP failure
                  gets the same treatment, with a Reconnect action (epic #303, X10; #313). */}
              {mcpNotice === null ? null : (
                <McpNotice
                  failure={mcpNotice}
                  onDismiss={() => setDismissedMcp(mcpNotice.message)}
                />
              )}
              {lastError === null || stepLimit !== null || mcpFailure !== null ? null : (
                <ErrorBanner
                  title={
                    lastError.retryStatus === 'retrying'
                      ? `${lastError.type} · retrying`
                      : lastError.type
                  }
                  message={lastError.message}
                  // The one error in the log the reader can fix themselves: the session's owner
                  // has no key for the model's provider (epic #65, A5), so the turn ended and no
                  // retry will help until one is saved. The fix opens **here** (X5): leaving the
                  // chat for Settings, saving, and finding the way back was the whole detour this
                  // issue removes. The provider is the one the failed model names.
                  action={
                    lastError.type === 'missing_provider_credential' ? (
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="h-auto p-0 text-destructive"
                        onClick={() => setAddingProvider(targetFor(providerOf(sessionModel)))}
                      >
                        Add a provider key
                      </Button>
                    ) : undefined
                  }
                />
              )}
              {requestError === null ? null : (
                <ErrorBanner
                  title="Request failed"
                  message={requestError}
                  onDismiss={dismissError}
                />
              )}
              <Composer
                running={status === 'running'}
                onSend={sendFromComposer}
                onStop={stop}
                inputRef={inputRef}
                value={draft}
                onValueChange={changeDraft}
                edit={editing === null ? undefined : { blocked: editBlocked, onCancel: cancelEdit }}
                modelSelector={
                  <ModelPicker
                    variant="compact"
                    placement="above"
                    models={catalog.models}
                    providers={catalog.providers}
                    modes={modes.modes}
                    selectedModeId={currentModeId}
                    onSelectMode={(mode) => {
                      // Picking a mode clears a pending plain model: the chat follows one or the
                      // other, never both (#245, M6).
                      setPendingMode(mode)
                      setChosen(null)
                    }}
                    value={chosen ?? sessionModel}
                    onChange={(modelId) => {
                      // A plain model detaches the chat from any mode, so a pending mode goes with
                      // the pick.
                      setChosen(modelId)
                      setPendingMode(null)
                    }}
                    refreshing={catalog.refreshing}
                    onRefresh={catalog.refresh}
                    // From the picker the provider is the reader's to choose, so the dialog opens
                    // on the tiles rather than on a form.
                    onAddProvider={() => setAddingProvider(null)}
                  />
                }
              />
            </div>
          </div>
        </div>
        {todos === null ? null : (
          <TodoPanel todos={todos} collapsed={todosChoice} onToggle={toggleTodos} variant="side" />
        )}
      </div>

      <AddProviderDialog
        open={addingProvider !== undefined}
        {...(addingProvider === undefined || addingProvider === null
          ? {}
          : { initialTarget: addingProvider })}
        onSaved={(name) => {
          setAddingProvider(undefined)
          showNotice(`Saved the ${name} credential.`)
          // A key that was not there a moment ago is a provider's models that were not there
          // either: the picker offers them from here, without leaving the chat (X5).
          void catalog.reload()
        }}
        onClose={() => setAddingProvider(undefined)}
      />
    </div>
  )
}

/**
 * The Add-provider target a model id's provider half names: the provider's tile, or — for a
 * named credential's default name, `azure` — the credential type's tile.
 *
 * The banner that opens the dialog knows a provider *id*; the dialog opens on a
 * {@link CredentialTarget}. A name nothing carries is left as the provider tile, which is what
 * the target list answers for everything the shared provider list knows.
 */
function targetFor(provider: string | null): CredentialTarget | undefined {
  return CREDENTIAL_TARGETS.find((target) => target.name === provider)
}
