/**
 * `@openharness/client` — the typed SDK for the openharness API, for browsers and for Node.
 *
 * Five things live here:
 *
 * - **the client** — {@link createClient}, and the `Client` interface it and the fake client
 *   both implement: agents, sessions, the session event log, the provider credentials, the
 *   caller's preferences, usage and cost, the auth helpers, and helpers for sending a message
 *   (optionally switching the model) and interrupting a turn;
 * - **streaming** — `client.sessions.events.stream`, an async iterable of `StreamEvent`s that
 *   reconnects and resumes by `seq`, so no stored event is delivered twice or skipped;
 * - **the transcript** — {@link createTranscript}, a pure reducer from those events to UI
 *   state, shared by the web app and the TUI;
 * - **authentication** — a cookie in the browser and a bearer token (the `token` option) for
 *   the CLI, plus the device-code flow ({@link OPENHARNESS_CLI_CLIENT_ID}) `oh login` runs;
 * - **errors** — {@link ApiError} for a non-2xx answer, built from the protocol's error
 *   envelope, with {@link AuthenticationError} (401) as its own type.
 *
 * Everything crossing the boundary is typed by `@openharness/protocol`, which owns the wire
 * contract; this package adds I/O, not schemas. The one exception is Better Auth's
 * `/api/auth/*` surface, which is not part of the protocol and is typed here.
 *
 * `@openharness/client/testing` has `createFakeClient()` — the same interface, backed by an
 * in-memory server, with a scriptable brain, credentials and device flow.
 */

/** This package's name; lets a dependent prove the import resolved. */
export const PACKAGE_NAME = '@openharness/client'

export { createClient } from './client'
export type { Client, ClientOptions, RequestOptions, SendMessageOptions } from './client'

export type { AgentsResource } from './resources/agents'
export type {
  CompactSessionOptions,
  SessionEventsResource,
  SessionsResource,
} from './resources/sessions'
export type { ProviderCredentialsResource } from './resources/provider-credentials'
export type { ModesResource } from './resources/modes'
export type { ModelsResource } from './resources/models'
export type { PreferencesResource } from './resources/preferences'
export type { ToolsResource } from './resources/tools'
export type { UsageResource } from './resources/usage'

export {
  CREDENTIAL_TARGETS,
  PROVIDERS,
  credentialDisplayName,
  credentialFacts,
  credentialRowLabel,
  credentialTargetFor,
  providerInfo,
  providerName,
} from './providers'
export type { CredentialRowLabel, CredentialTarget, ProviderInfo } from './providers'

export { DeviceLoginError, OPENHARNESS_CLI_CLIENT_ID } from './resources/auth'
export type { AuthResource, DeviceLoginStart, PollDeviceLoginOptions } from './resources/auth'

export type { DebugHook, FetchLike, RawResponse } from './http'

export {
  ApiError,
  AuthenticationError,
  ResponseValidationError,
  errorTypeForStatus,
} from './errors'

export {
  createTranscript,
  initialTranscriptState,
  reduceTranscript,
  reduceTranscriptAll,
  selectClearedToolResults,
  selectContext,
  selectIsRunning,
  selectLastMessage,
  selectManualCompaction,
  selectMessages,
  selectConfirmation,
  selectConfirmations,
  selectSessionUsage,
  selectStreamingMessage,
  selectSummaries,
  selectSummarizing,
  selectSearchCount,
  selectToolCalls,
  selectTodos,
  selectTranscriptEntries,
  selectTruncatedToolResults,
  selectTruncation,
  replyCost,
  sessionCost,
  sessionUsageOf,
  transcriptEntries,
} from './transcript'
export type {
  MessagePart,
  ModelPriceLookup,
  PendingModelRequest,
  SessionModelUsage,
  SessionUsage,
  SessionUsageTotals,
  TextPart,
  Transcript,
  TranscriptConfirmation,
  TranscriptContext,
  TranscriptEntry,
  TranscriptError,
  TranscriptManualCompaction,
  TranscriptMessage,
  TranscriptMessageMeta,
  TranscriptSeed,
  TranscriptState,
  TranscriptSummarizing,
  TranscriptSummary,
  TranscriptTruncation,
  TranscriptUsage,
} from './transcript'

export {
  CHARS_PER_TOKEN,
  COMPACTING_LABEL,
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  OUTPUT_RESERVE_RATIO,
  compactionThreshold,
  contextAfterSummary,
  contextMeter,
  contextTokenBudget,
  estimateTokens,
  manualCompactionNotice,
  modelContextBudget,
  summaryDescription,
  summaryModelFallback,
} from './compaction'
export type {
  ContextMeter,
  ManualCompactionNotice,
  ManualCompactionTone,
  SummaryModelFallback,
} from './compaction'

export {
  TOOL_STEPS_EXHAUSTED_NOTICE,
  TOOLS_UNSUPPORTED_NOTICE,
  clearedResultsNotice,
  formatToolInput,
  modelSupportsTools,
  searchCount,
  stepLimitNotice,
  toolCallStatus,
  toolCallSummary,
  toolStatusLabel,
  truncatedResultsNotice,
} from './tools'
export type {
  ClearedToolResults,
  ToolCallResult,
  ToolCallStatus,
  ToolResultsNotice,
  TranscriptToolCall,
  TruncatedToolResult,
} from './tools'

export {
  APPROVAL_CHOICES,
  OTHER_CHOICE_LABEL,
  answerConfirmation,
  answersFrom,
  approvalChoiceLabel,
  approvalConfirmation,
  approvalConfirmations,
  askUserQuestions,
  confirmationSummary,
  declineConfirmation,
  draftComplete,
  draftProblems,
  emptyDraft,
  emptyDrafts,
  pendingCallKind,
  pendingCalls,
  pendingCallsNotice,
  withConfirmed,
  withLabel,
  withOther,
  withText,
} from './approvals'
export type { ApprovalChoice, PendingCall, PendingCallKind, QuestionDraft } from './approvals'

export type { StreamOptions } from './events/stream'
