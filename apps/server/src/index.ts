import { pathToFileURL } from 'node:url'

import { main } from './main'

/**
 * `@openharness/server` — the runnable openharness server.
 *
 * The HTTP API the protocol describes, the SSE stream over a session's event log, and the
 * scheduler that runs brains against it. `node dist/index.js` reads the environment and starts
 * everything (see `AGENTS.md` for the variables and `docs/api.md` for the routes).
 *
 * ```ts
 * import { createApp, createAuth, createSessionCredentialResolver } from '@openharness/server'
 *
 * const auth = createAuth(authConfig, database, logger)
 * const app = createApp({ store, scheduler, auth: { instance: auth.auth, … }, credentialRoutes })
 * ```
 *
 * The pieces a host wires together:
 *
 * - **{@link createApp}** — the routes, against any `SessionStore`, `SessionScheduler` and
 *   Better Auth instance.
 * - **{@link createAuth}** — Better Auth configured for this server (A1/A2/A3/A7).
 * - **{@link createSessionCredentialResolver}** — the session owner's stored key, opened per
 *   request (A5).
 * - **{@link LocalScheduler}** — the single-process scheduler, on top of {@link SessionRunner},
 *   which owns the per-session turn loop.
 * - **{@link startServer}** (and {@link main}) — the whole thing: store, migrations, sign-in,
 *   model, credentials, scheduler, listener and a graceful shutdown.
 */

/** This package's name; a cheap way for a dependent to prove the import resolved. */
export const PACKAGE_NAME = '@openharness/server'

export { alwaysReady, createApp, isApiPath, type AppOptions, type Readiness } from './app'
export {
  DEVICE_CODE_EXPIRES_IN,
  DEVICE_CODE_EXPIRES_IN_MS,
  DEV_LOGIN_EMAIL,
  DEV_LOGIN_NAME,
  DEV_LOGIN_PASSWORD,
  DEV_LOGIN_STORED_EMAIL,
  OPENHARNESS_CLI_CLIENT_ID,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_FRESH_AGE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  createAuth,
  createDevLoginUser,
  deviceVerificationUri,
  deviceVerificationUriComplete,
  refuseUnverifiedUser,
  rewriteDevLoginRequest,
  type Auth,
  type AuthConfig,
  type AuthDatabase,
  type BetterAuthInstance,
} from './auth'
export { createAuthGuard, type AuthGuardOptions } from './auth-guard'
export {
  MICROSOFT_REFUSAL_LOG,
  SOCIAL_PROVIDERS,
  affirmativeClaim,
  githubVerifiedPrimaryEmail,
  googleEmailVerified,
  microsoftClaimType,
  microsoftEmailVerified,
  microsoftRefusalDetail,
  providerOptions,
  refusedEmailError,
  xmsEdovLogValue,
  type GoogleClaims,
  type GithubEmail,
  type GithubProfile,
  type MicrosoftClaims,
  type MicrosoftRefusalDetail,
  type SocialProviderCredentials,
  type SocialProviderName,
} from './auth-profile'
export {
  CLIENT_IP_HEADER,
  FORWARDED_FOR_HEADER,
  resolveClientIp,
  withClientIpHeader,
  type ClientIpInput,
} from './client-ip'
export {
  createSessionCredentialResolver,
  credentialAad,
  credentialPayload,
  credentialUpsert,
  lastFour,
  modelCredential,
  openCredential,
  sealCredential,
  type CredentialResolverDeps,
  type ResolveSessionCredential,
} from './credentials'
export {
  DEFAULT_COMPACT_INTERVAL_MS,
  DEFAULT_DELTA_RETENTION_MS,
  DeltaCompactor,
  type DeltaCompactorOptions,
} from './compaction'
export {
  ENV_VARS,
  DEFAULT_KEY_PROVIDER,
  DEFAULT_LOG_FORMAT,
  DEFAULT_PORT,
  DEFAULT_SCHEDULER,
  DEFAULT_TRACE_SAMPLE_RATE,
  DEFAULT_TRACING,
  DEFAULT_TRUSTED_PROXY_HOPS,
  defaultInstanceId,
  describeConfig,
  readSecret,
  readServerConfig,
  secretFileVar,
  usesTestModel,
  type KeyProviderKind,
  type LogFormat,
  type SchedulerKind,
  type ServerConfig,
} from './config'
export { createConfigVault } from './key-provider'
export {
  HttpError,
  authenticationError,
  invalidProviderCredential,
  invalidRequest,
  notFoundError,
  permissionError,
  rateLimitError,
} from './http/errors'
export {
  DEFAULT_CATALOG_TTL_MS,
  DEFAULT_REFRESH_INTERVAL_MS,
  CatalogCache,
  RefreshLimiter,
  type CachedProviderCatalog,
  type CatalogCacheKey,
} from './catalog/cache'
export {
  CatalogRefreshLimitedError,
  ModelCatalog,
  type ModelCatalogOptions,
} from './catalog/catalog'
export {
  adapterFor,
  adaptedProviders,
  type ProviderAdapter,
  type ProviderModel,
} from './catalog/adapters'
export { isChatModel, isNonChatFamily, type ChatVerdicts } from './catalog/filter'
export {
  OUTPUT_RESERVE_RATIO,
  contextTokenBudget,
  createTokenBudgetResolver,
} from './catalog/context-budget'
export {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  createProviderFetch,
  type ProviderFetch,
  type ProviderResponse,
} from './catalog/provider-fetch'
export {
  createBundledRegistry,
  emptyRegistry,
  SNAPSHOT_DATE,
  type ModelRegistry,
  type RegistryModel,
} from './catalog/registry'
export {
  READINESS_QUERY_TIMEOUT_MS,
  checkDatabase,
  main,
  startServer,
  type ReadinessPool,
  type StartServerOptions,
  type StartedServer,
} from './main'
export {
  createMockModelFactory,
  MOCK_ECHO_CHUNKS,
  MOCK_MODEL_ENV_VALUE,
  MOCK_MODEL_USAGE,
  MOCK_RETRYABLE_MARKER,
  MOCK_SLOW_CHUNKS,
  MOCK_SLOW_MARKER,
  MOCK_SLOW_TOTAL_MS,
  MOCK_TERMINAL_MARKER,
  planFor,
} from './mock-model'
export {
  MOCK_CREDENTIAL,
  resolveMockCredential,
  resolveModelFactory,
  type ResolvedModel,
} from './model'
export {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_SWEEP_MS,
  PostgresPartitionScheduler,
  type PostgresPartitionSchedulerOptions,
} from './partition-scheduler'
export { DEFAULT_MAX_CONCURRENT_PASSES, PassQueue, type PassContext } from './pass-queue'
export { DEFAULT_DRAIN_TIMEOUT_MS, SessionRunner } from './runner'
export type { RunSessionOptions, SessionRunnerOptions } from './runner'
export {
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  LocalScheduler,
  partitions,
  type LocalSchedulerOptions,
  type SessionScheduler,
  type StopSchedulerOptions,
  type StopSessionOptions,
} from './scheduler'
export {
  DefaultModelPicker,
  RECOMMENDED_DEFAULT_MODELS,
  isEverydayModel,
  isExpensiveModel,
  isReasoningModel,
  newestModelId,
  type DefaultModelPickerOptions,
} from './default-model'
export {
  VALIDATABLE_PROVIDERS,
  createProviderCredentialValidator,
  validateProviderCredential,
  type AzureValidatorFetch,
  type ProviderCredentialValidator,
  type ProviderCredentialValidatorOptions,
  type ValidatableProvider,
} from './provider-validation'
export {
  SESSION_INVALID_MESSAGE,
  SSE_KEEPALIVE,
  SSE_KEEPALIVE_MS,
  SSE_SESSION_INVALID,
  createSessionEventStream,
  type SessionEventStreamOptions,
} from './sse'
export {
  DEFAULT_SESSION_RECHECK_MS,
  createSessionRevocations,
  startSessionRecheck,
  type SessionRecheck,
  type SessionRecheckOptions,
  type SessionRevocations,
  type SessionRevocationsOptions,
} from './session-watch'
export { consoleLogger, silentLogger, type AppEnv, type Logger } from './types'
// Observability (issue #158): the Cloud Logging JSON logger and its redaction, the trace
// context logs and spans share, the tracer seam (a no-op when tracing is off), and the
// session log as spans.
export {
  REDACTED,
  SessionTraces,
  activeTraceContext,
  detailFields,
  initTracing,
  isSensitiveKey,
  jsonLogger,
  loggerFor,
  noopTracer,
  parseCloudTraceContext,
  parseTraceContext,
  parseTraceparent,
  redact,
  redactError,
  runWithTraceContext,
  withSessionTraces,
  type AttributeValue,
  type JsonLoggerOptions,
  type Span,
  type SpanKind,
  type StartSpanOptions,
  type TraceContext,
  type Tracer,
  type TracingMode,
  type TracingOptions,
} from './observability'

// `node dist/index.js` starts the server; importing this module never does.
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error('the server could not start', error)
    process.exitCode = 1
  })
}
