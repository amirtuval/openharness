import type {
  Agent,
  AgentId,
  CreateAgentRequest,
  CreateModeRequest,
  EventId,
  ListAgentsResponse,
  ListEventsResponse,
  ListOrder,
  ListSessionsResponse,
  Metadata,
  Mode,
  ModeId,
  ModelConfig,
  ModelRequestStartEvent,
  ModelUsage,
  Session,
  SessionId,
  SessionRewindEvent,
  SessionRewindEventInput,
  StoredEvent,
  StoredEventType,
  StreamEvent,
  Timestamp,
  UpdateAgentRequest,
  UpdateModeRequest,
  UserEvent,
  UserEventInput,
  UserId,
  UserPreferences,
} from '@openharness/protocol'

/**
 * A user's stored preferences (#111, epic #116 U1; theme: #203, epic #201 X3): the
 * `provider/model` a new chat starts with, or `null` for no default, and the web app's theme.
 *
 * The protocol defines it; it is re-exported here because it is the vocabulary of
 * {@link SessionStore.getPreferences} and {@link SessionStore.putPreferences}, so an
 * implementation of this contract — or a caller of it — can name the type beside the method.
 */
export type { UserPreferences } from '@openharness/protocol'

/**
 * A user's mode (epic #245, M6): a named preset of a model, a reasoning effort and a
 * system-prompt addition.
 *
 * The protocol defines it; it is re-exported here because it is the vocabulary of the mode
 * methods below ({@link SessionStore.createMode}, `getMode`, `listModes`, `updateMode`,
 * `deleteMode`), so an implementation of this contract — or a caller of it — can name the
 * type beside the method.
 */
export type { Mode } from '@openharness/protocol'

/**
 * The storage and signaling contract the brain and the server code against.
 *
 * A session is a durable, append-only event log, and this interface is the only way to read or
 * write one. Two implementations exist: `InMemorySessionStore` — the test fake every other
 * package uses, and the reference behaviour — and `PostgresSessionStore`, which passes the
 * same conformance suite.
 *
 * ## What every implementation must guarantee
 *
 * - **Ordering.** Events are appended with a per-session `seq` that starts at `1` and increases
 *   by one, in the order the events were given. `seq` is the only ordering key: timestamps are
 *   metadata, not order. Reads return events in `seq` order (ascending by default), and a
 *   subscription delivers stored events in `seq` order with no gaps and no duplicates.
 * - **Atomically assigned fields.** `seq` and the event's internal creation time are assigned
 *   inside one transaction — and so is `id`, unless the caller supplied one, which is stored
 *   as given (see {@link SessionStore.appendEvents}) — so a turn can never observe half an
 *   append. The events returned to the caller are the stored events: `StoredEvent` exactly,
 *   with no extra field (notably no `created_at` — the protocol has none).
 * - **Immutability.** No stored event is ever modified: the log is append-only, appends are
 *   the only way in, and the two deletions — {@link SessionStore.compact}, which removes
 *   superseded stream chunks, and {@link SessionStore.deleteSession}, which removes a whole
 *   session and its log — are the deliberate, documented exceptions, and nothing else is ever
 *   deleted. Every implementation hands out events it will never change, and both
 *   implementations deep-freeze what they return, so a caller that tries to write to one
 *   throws instead of forking the log it was handed. The event types are deep-readonly
 *   (`StoredEvent` and every member, D9, issue #46), so a write is a compile error too.
 * - **Claims.** A turn's claim on the user events it answers is itself in the log: the append
 *   of an event carrying `consumes` claims those ids — `span.model_request_start` for the
 *   messages a request folds in, `span.model_request_end` for an interrupt that cut its
 *   request short, `session.status_idle` for an interrupt that arrived with nothing running
 *   (P4). A claim is recorded once and never removed; `processed_at` on a user event is
 *   derived from it on every read. An event that is claimed cannot be claimed again — and
 *   neither can one a recorded `supersedes` range covers, so nothing outside a rewound range
 *   claims into it (#238).
 * - **Durability per append.** An append is one transaction. `initial_events` on
 *   {@link SessionStore.createSession} are part of the session's creation transaction, not
 *   appends that follow it.
 * - **Fencing.** A write that carries `fence: { partition, epoch }` is accepted only while the
 *   lease on that partition is live and holds that epoch; otherwise it fails with
 *   {@link FencedError}. Fencing is opt-in: a write without a fence is never refused. The brain
 *   always fences; the API server, which appends a user message before it knows who owns the
 *   partition, does not have to.
 * - **Turn state.** {@link SessionStore.getTurnState} answers from the log alone — no lease, no
 *   clock, no in-memory bookkeeping — so it means the same thing in every implementation, and
 *   a server that just took a partition over can ask it before it has done anything.
 * - **Signals are hints.** {@link SessionStore.signalPartition} delivers at most once, to the
 *   listeners attached at that moment; a signal nobody is listening for is dropped. Nothing may
 *   depend on receiving one: recovery runs {@link SessionStore.findSessionsNeedingWork}. The
 *   same holds for the auth-session revocation channel
 *   ({@link SessionStore.notifyAuthSessionRevoked}, epic #65, issue #76): it is what makes a
 *   revocation prompt across instances, and a holder of an open response still re-validates
 *   the session periodically in case the notification was missed.
 * - **Membership is bookkeeping** (#122). {@link SessionStore.heartbeatInstance},
 *   {@link SessionStore.listLiveInstances} and {@link SessionStore.removeInstance} are the
 *   explicit membership the partition scheduler's fair share is computed from: an instance
 *   announces itself on every heartbeat, a membership is live while `last_seen` is within the
 *   window the reader asks for, and a graceful `stop()` removes its row. Like
 *   {@link SessionStore.signalPartition} this is liveness, not durability — losing a row costs
 *   one heartbeat's announcement — and like the leases it is bookkeeping beside the log, never
 *   part of it.
 * - **Ownership** (epic #65, A4). Every agent and session belongs to exactly one user:
 *   {@link SessionStore.createAgent} and {@link SessionStore.createSession} take the owner's
 *   `user.id` and the stored resource carries it as `owner_id`. The reads a user-facing route
 *   makes take an {@link OwnerScope} `{ ownerId }` — **required**, so forgetting it is a
 *   compile error — and answer `null` (or throw {@link SessionNotFoundError} on a
 *   session-scoped read) for a resource that belongs to somebody else: a 404 on the wire,
 *   never a 403, so another user's resource does not even leak that it exists. The brain and
 *   the scheduler act *for* a session, not for a user, and use the explicitly named unscoped
 *   methods ({@link SessionStore.getSessionUnscoped}, {@link SessionStore.listEventsUnscoped})
 *   that no user-facing route may call.
 * - **Preferences** (#111, epic #116 U1; theme: #203, epic #201 X3).
 *   {@link SessionStore.getPreferences} and {@link SessionStore.putPreferences} are the
 *   per-user settings beside the log: one value per user — `{ default_model, theme }` — and a
 *   user who has never saved one reads the protocol's defaults rather than a `null` or a
 *   throw. The answer is deep-frozen, like a credential, because it is a value a caller owns.
 * - **Deletion** (#111, epic #116 U5). {@link SessionStore.deleteSession} removes a session
 *   and its whole log — owner-scoped, and irreversible — and a subscription to it ends with a
 *   final `session.deleted` stream event instead of starving.
 * - **Usage is one read per user** (epic #245, A2; issue #247).
 *   {@link SessionStore.listModelRequests} pairs each `span.model_request_end` with the
 *   `span.model_request_start` that names its model, for one owner and one UTC window, without
 *   walking the owner's sessions — the read a per-user usage report is assembled from, and the
 *   reason it does not have to read every event of a month of use.
 * - **Async.** Every method is asynchronous. Nothing may assume synchronous delivery: a store
 *   built on `LISTEN`/`NOTIFY`, or one that commits a transaction before it notifies, delivers
 *   subscriptions and signals a tick later than it stored the event.
 *
 * See `AGENTS.md` for how to run the conformance suite against a new implementation. This
 * interface is a contract between packages: the Postgres store, the brain and the server are
 * written against it, so it changes only when v1 as a whole does.
 */
export interface SessionStore {
  // ------------------------------------------------------------------ agents

  /**
   * Create an agent owned by `ownerId`, with `created_at` and `updated_at` set to the clock's
   * current instant.
   *
   * The stored agent carries the owner as `owner_id`, which never changes: an agent belongs to
   * the user who created it for as long as it exists (epic #65, A4). Ownership is the store's,
   * not the caller's to choose — the server passes the authenticated caller's id, and the
   * protocol has no `owner_id` in a request body.
   *
   * @param input the agent's fields, as `POST /v1/agents` receives them
   * @param ownerId the `user.id` the agent belongs to
   */
  createAgent(input: CreateAgentRequest, ownerId: UserId): Promise<Agent>

  /**
   * Read one agent, or `null` when no agent has that id.
   *
   * **Owner-scoped, and the owner is required** (epic #65, A4): an agent that belongs to
   * somebody else answers `null`, exactly as one that does not exist, so the caller turns both
   * into the same 404. Requiring the scope is deliberate — a read without it cannot be
   * written, so a route cannot forget it and leak another user's agent by accident. There is
   * no unscoped form: nothing internal reads an agent without already knowing its owner.
   */
  getAgent(agentId: AgentId, options: OwnerScope): Promise<Agent | null>

  /**
   * List agents, oldest first, ordered by `(created_at, id)`.
   *
   * **Owner-scoped, and the owner is required** (epic #65, A4): only that owner's agents come
   * back — `data: []` for a user with none, never somebody else's.
   *
   * `page` and `next_page` are the protocol's opaque keyset cursor, passed through untouched.
   */
  listAgents(options: ListAgentsOptions): Promise<ListAgentsResponse>

  /**
   * Apply a partial update to an agent and return it, or `null` when no agent has that id.
   *
   * An omitted field keeps its stored value; `null` clears a nullable one. `updated_at` is set
   * from the clock. Sessions snapshot the agent at creation, so this never rewrites the
   * configuration an existing session runs with.
   *
   * This method is **not owner-scoped**, because it is not a read: a user-facing route checks
   * ownership with {@link SessionStore.getAgent} first and answers 404 for a null. The check
   * cannot go stale between the two calls — `owner_id` never changes, and no store method
   * writes it.
   */
  updateAgent(agentId: AgentId, update: UpdateAgentRequest): Promise<Agent | null>

  // ------------------------------------------------------------------- modes

  /**
   * Create a mode owned by `ownerId`, with `created_at` and `updated_at` set to the clock's
   * current instant (epic #245, M6).
   *
   * A mode is a user's own named preset — a model, a reasoning effort and a system-prompt
   * addition behind a stable name — so it is created like the other per-user resources: the
   * owner comes from the caller (the server passes the authenticated user), never from the
   * request, and it is stored as the mode's `owner_id`, which never changes.
   *
   * A name is unique among its owner's modes and a user may hold at most
   * `MAX_MODES_PER_USER` of them; both are enforced here rather than only checked by the
   * caller, so two concurrent creates cannot both take the same name and a create cannot slip
   * past the limit.
   *
   * @param input the mode's fields, as `POST /v1/me/modes` receives them
   * @param ownerId the `user.id` the mode belongs to
   * @throws DuplicateModeNameError when the owner already has a mode with that name
   * @throws ModeLimitReachedError when the owner already holds `MAX_MODES_PER_USER` modes
   */
  createMode(input: CreateModeRequest, ownerId: UserId): Promise<Mode>

  /**
   * Read one mode, or `null` when no mode has that id.
   *
   * **Owner-scoped, and the owner is required** (epic #65, A4): a mode that belongs to
   * somebody else answers `null`, exactly as one that does not exist, so a user-facing route
   * turns both into the same 404.
   */
  getMode(modeId: ModeId, options: OwnerScope): Promise<Mode | null>

  /**
   * List one owner's modes, oldest first, ordered by `(created_at, id)`.
   *
   * **Owner-scoped, and the owner is required** (epic #65, A4): only that owner's modes come
   * back, `[]` for a user with none. No pagination: a user holds at most `MAX_MODES_PER_USER`
   * of them, so the list is bounded and a picker can show them all at once.
   */
  listModes(options: OwnerScope): Promise<Mode[]>

  /**
   * Apply a partial update to a mode and return it, or `null` when the owner has no mode with
   * that id.
   *
   * An omitted field keeps its stored value; `null` clears a nullable one
   * (`reasoning_effort`, `system_prompt_addition`); `updated_at` is set from the clock. A chat
   * that follows the mode picks the change up on its next request — this is what makes a mode
   * live rather than a snapshot.
   *
   * **Owner-scoped**, unlike {@link SessionStore.updateAgent}: the scope is what makes another
   * user's mode answer `null` rather than be edited, in the same call.
   *
   * @throws DuplicateModeNameError when a rename collides with another of the owner's modes
   */
  updateMode(modeId: ModeId, update: UpdateModeRequest, options: OwnerScope): Promise<Mode | null>

  /**
   * Delete a mode, returning whether one was deleted.
   *
   * **Owner-scoped** (epic #65, A4): `true` when the mode existed and belonged to
   * `options.ownerId`, `false` otherwise — the same answer either way, so nothing leaks.
   *
   * Deleting a mode lands the chats that followed it on the model each last ran: in the same
   * transaction, every session of the owner whose `mode` is this id has it cleared, so a chat
   * that ran the mode is afterwards an ordinary chat with no mode, still running the model its
   * `model` projection holds. A chat is never deleted with a mode.
   */
  deleteMode(modeId: ModeId, options: OwnerScope): Promise<boolean>

  // ---------------------------------------------------------------- sessions

  /**
   * Create a session owned by `options.ownerId`, from an agent, a model, or both (issue #93).
   *
   * The stored session always carries the configuration it runs — `model` and `system` — and,
   * when it was created from an agent, the preset it snapshotted (`{ id, name, model,
   * system }`); a model-first session has `agent: null`. `options.model` and `options.system`
   * are that effective configuration: an explicit value wins, and what is omitted falls back
   * to the agent's (`system` to `null` when there is no agent — and `model` is then required,
   * because there is nothing to fall back to).
   *
   * Passing an `agentId` **checks the agent belongs to the same owner** as the session: a
   * session is the owner's, and snapping somebody else's agent into it would hand its
   * configuration over (epic #65, A4). The stored session carries the owner as `owner_id`,
   * which never changes.
   *
   * `initial_events` are appended in the creation transaction, with `seq` starting at `1` and
   * `processed_at: null`. They go through the same append path a later append does, so a
   * `user.message` among them that carries a `model` sets the created session's `model` to it
   * — the same projection {@link SessionStore.appendEvents} describes. The session is `idle`
   * with no status events.
   *
   * @param agentId the agent whose configuration the session snapshots, or `null` for a
   *   model-first session — one created from `options.model` alone
   * @throws AgentNotFoundError when `agentId` names no agent, or one owned by somebody else —
   *   the same answer either way, so the error does not leak that the agent exists
   * @throws RangeError when there is no agent and no `options.model` either — the protocol
   *   requires one of the two, and the store refuses to invent a configuration
   */
  createSession(agentId: AgentId | null, options: CreateSessionOptions): Promise<Session>

  /**
   * Read a session's header (the log's metadata, not its events), or `null` when it does not
   * exist.
   *
   * **Owner-scoped, and the owner is required** (epic #65, A4): somebody else's session
   * answers `null`, exactly as one that does not exist, so a user-facing route turns both into
   * the same 404. Requiring the scope is deliberate — a route that forgets it does not
   * compile. Server internals that act *for a session, not for a user* — the brain recovering
   * a turn, the credential resolver looking up the session's owner — use the explicitly named
   * {@link SessionStore.getSessionUnscoped} instead.
   */
  getSession(sessionId: SessionId, options: OwnerScope): Promise<Session | null>

  /**
   * Read a session's header **without** an owner scope: any owner's session comes back.
   *
   * This is the internal form, and deliberately a different name rather than an optional
   * argument (epic #65, A4): the brain, the scheduler and the server's credential resolver act
   * for a session rather than for a user, and a user-facing route must not reach for it. A
   * route scopes with {@link SessionStore.getSession} first and answers 404 for a `null`.
   */
  getSessionUnscoped(sessionId: SessionId): Promise<Session | null>

  /**
   * List sessions, newest first, ordered by `(created_at, id)` descending.
   *
   * **Owner-scoped, and the owner is required** (epic #65, A4): only that owner's sessions
   * come back, and the `agentId` filter narrows inside them.
   *
   * `page` and `next_page` are the protocol's opaque keyset cursor, passed through untouched.
   */
  listSessions(options: ListSessionsOptions): Promise<ListSessionsResponse>

  /**
   * Change a session's title, and return the session as it is afterwards — or `null` when no
   * session has that id.
   *
   * The title is the session's label: what a session list shows to tell one chat from another.
   * A frontend that knows it at creation passes it to {@link SessionStore.createSession}; one
   * that does not — anything that names a chat after the first message — sets it here once the
   * message is stored. An omitted `title` keeps the stored one, and `null` clears it, exactly
   * as {@link SessionStore.updateAgent} treats its nullable fields.
   *
   * `updated_at` is set from the clock. Nothing else moves: not the status, not the agent
   * snapshot, and not the log — a title is metadata about a session, never a reason to run one.
   *
   * The title is stored as given, like every other input (see the notes on validation below):
   * a caller sets it from the protocol's `Session.title`, and one that derives a title from a
   * message is the one that has to fit it into `SESSION_TITLE_MAX_LENGTH`.
   *
   * Like {@link SessionStore.updateAgent} this method is **not owner-scoped** — it is not a
   * read. A user-facing route checks ownership with {@link SessionStore.getSession} first and
   * answers 404 for a null; the check cannot go stale, because `owner_id` never changes.
   */
  updateSession(sessionId: SessionId, update: UpdateSessionRequest): Promise<Session | null>

  /**
   * Delete a session and its whole log, returning whether one was deleted.
   *
   * **Owner-scoped** (epic #65, A4): `true` when the session existed and belonged to
   * `options.ownerId`, and `false` when there is no such session or it belongs to somebody
   * else — exactly the same answer either way, so nothing leaks, just as
   * {@link SessionStore.getSession} answers `null` for both.
   *
   * This is the deliberate second exception to "events are never deleted", beside
   * {@link SessionStore.compact} (epic #116 U5, issue #111), and unlike compaction it is
   * **irreversible**: one transaction removes the session's row and every row keyed by the
   * session in every table that has a session column — its `events`, their `event_claims` and
   * their `event_supersessions` — so after it answers `true` the session is gone from every
   * read. {@link SessionStore.getSession} and {@link SessionStore.getSessionUnscoped} answer
   * `null`, and {@link SessionStore.listEvents}, {@link SessionStore.appendEvents},
   * {@link SessionStore.getPendingUserEvents} and {@link SessionStore.getTurnState} throw
   * {@link SessionNotFoundError} as if the id had never existed. Nothing is recoverable — and
   * because an event id identifies one event for the whole store, an id the deleted session
   * held is free again for a later append.
   *
   * The deletion is announced to the session's subscribers: each one receives a final
   * `session.deleted` `StreamEvent` naming the session, and the subscription ends with it —
   * see {@link SessionStore.subscribe}.
   *
   * @returns `true` when the caller's own session was deleted, `false` otherwise
   */
  deleteSession(sessionId: SessionId, options: OwnerScope): Promise<boolean>

  // ------------------------------------------------------------- preferences

  /**
   * Read a user's stored preferences (#111, epic #116 U1; theme: #203, epic #201 X3;
   * compaction: epic #277 C3, #282), or the protocol's defaults when there are none.
   *
   * Preferences are per user, not per session: the settings a user applies to their chats —
   * the `provider/model` a new chat starts with, the web theme, and the three compaction
   * controls (the share of the budget that triggers a summary, the model that writes it, and
   * the passes it may take). A user who has never saved any has no stored value, and that
   * reads as `{ default_model: null, theme: 'system', compaction_threshold: null,
   * summary_model: 'same-as-chat', summary_max_passes: null }`: the absence of a choice, never
   * `null` and never a throw, so a settings screen always has a value to render. The two
   * `null` numbers mean "follow the default" — the deployment's trigger share and the engine's
   * pass limit, neither of which is this package's to know. The answer is deep-frozen, like a
   * credential — a caller owns it, and writing to it throws.
   */
  getPreferences(userId: UserId): Promise<UserPreferences>

  /**
   * Write a user's preferences whole, replacing what was stored, and answer what was stored
   * (#111, epic #116 U1; compaction: epic #277 C3, #282).
   *
   * One value per user, so a second put replaces the first in place rather than accumulating.
   * There is no partial update at this layer: a caller always writes the complete value it
   * wants, and a `null` field (`default_model`, `compaction_threshold`, `summary_max_passes`)
   * is how it clears that choice back to the default. The merge a `PUT /v1/me/preferences`
   * performs is the **route's** (`apps/server/src/routes/me.ts`), which reads the stored value
   * and writes both — that is what keeps one setting from clearing another, rather than a
   * half-value this store would have to guess at. `updated_at` moves to the injected clock's
   * instant; the answer is the preferences as written, deep-frozen.
   */
  putPreferences(userId: UserId, preferences: UserPreferences): Promise<UserPreferences>

  // ----------------------------------------------------------------- events

  /**
   * Append events to a session's log, in order, and return them as stored.
   *
   * The store assigns `seq` and the internal creation time in one transaction, and `id` too
   * unless the event carries one of its own. A user event is stored with `processed_at: null`;
   * every other event is stored with `processed_at` set to the clock's current instant. The
   * session's `status` follows `session.status_running` and `session.status_idle` in the same
   * transaction, its `updated_at` advances, and subscribers are notified after the append is
   * committed.
   *
   * ## The model and mode projections (#111, #245)
   *
   * A `user.message` carrying a `model` also sets the session's `model` to it, in the same
   * transaction as the append — a projection of the event log onto the session's header, like
   * `status`, so the log stays the source of truth for what the session runs. The session
   * keeps that model until another message changes it: within one batch the later message
   * wins, and a message without a `model` leaves the session's model alone. A message's
   * `model` is stored on the event either way.
   *
   * The same walk projects the **mode** a chat follows (#245, M6): a message carrying a
   * `mode` sets the session's `mode` to it, `null` clears it, and — because a chat follows
   * either a mode or a plain model, never both — a message that carries a `model` but no
   * `mode` clears it too. A message that carries neither leaves the mode alone.
   *
   * A `span.model_request_start` carrying a `model` also updates the session's `model` to it:
   * that field is the model the request **actually ran**, which for a chat on a mode is the
   * mode's resolved model rather than the session's stored one. Projecting it is what keeps
   * `model` meaning "the model this chat last ran", so a chat whose mode is deleted afterwards
   * continues on the model it last ran.
   *
   * A span with `purpose: 'summary'` is the exception (epic #277, C2): it is the compaction
   * engine's own request, its `model` is the summarizer's, and projecting it would move the chat
   * onto the model that summarized it. Its tokens are still in the log and still count in the
   * usage read — the projection is about which model the chat runs, not about what was spent.
   *
   *
   * The input carries only the fields the caller owns — an `AppendableEvent` is a `StoredEvent`
   * without the assigned ones. Inputs are stored as given and not validated: callers validate
   * with the protocol schemas.
   *
   * ## Stored chunks, claims and supersession
   *
   * Three of the shapes an append can carry since D9 (issue #46) do more than land in the log
   * — each in the same transaction as the events themselves, so a reader never sees half of
   * any of them:
   *
   * - **Stored chunks.** An `event_start` or `event_delta` is an ordinary event: it gets a
   *   `seq` and a `processed_at` like everything else, is delivered to subscribers like
   *   everything else, and is skipped by replay once superseded.
   * - **`consumes`.** An event whose `consumes` names user events claims them: the store
   *   records a claim per id, and from then on those events read with `processed_at` set and
   *   no longer count as pending. Three event types carry the list — a
   *   `span.model_request_start` claims the `user.message`s the request folds in, a
   *   `span.model_request_end` claims the `user.interrupt`s that cut its request short, and a
   *   `session.status_idle` claims the `user.interrupt`s an idle turn ended on. Every id must
   *   be a pending `user.message` / `user.interrupt` of this session that no earlier claim
   *   took, or the whole append is refused with {@link ClaimConflictError} and nothing is
   *   stored.
   * - **`supersedes`.** An `agent.message` or `span.model_request_end` that carries
   *   `supersedes` records the chunk range it replaces: replay skips the range and
   *   {@link SessionStore.compact} deletes it after the retention window. The range has to lie
   *   within this session and end before the superseding event's own `seq`, or the append is
   *   refused with a `RangeError`.
   * - **A rewind** (#238). A {@link AppendableRewind} — a `session.rewind` naming the
   *   `user.message` the session restarts from — is stored as a `session.rewind` whose
   *   `supersedes` range runs from that message through the end of the log ahead of it
   *   (`seq - 1`), which this store fills in and the caller does not. `from_seq` has to name a
   *   `user.message` of this session that no recorded range already covers, or the append is
   *   refused with a `RangeError`. Both the event and anything beside it land in one
   *   transaction, so a session is never rewound without the message the reader sent with it.
   *
   * ## Supplying an id
   *
   * An event may bring its own `id` (see {@link AppendableEvent}), and the store then writes it
   * under exactly that id. This is what lines a stored `agent.message` up with the chunks that
   * came before it: the brain generates a `sevt_` id, appends the `event_start` and
   * `event_delta` chunks under it, and appends the finished message with the same id — so a
   * client matches what it accumulated to what was stored, and the whole reply is one event
   * throughout.
   *
   * An id has to be one the store can use, and an append that carries one it cannot is refused
   * whole — nothing from that batch is stored:
   *
   * - it must be a valid `sevt_` id; anything else is a `RangeError`;
   * - it must not already be in the store, and must not appear twice in this batch; either way
   *   the append fails with {@link DuplicateEventIdError}. An event id identifies one event for
   *   the whole store rather than one per session, so the id of an event in another session is
   *   taken too — `PostgresSessionStore` enforces that with a unique constraint on `events.id`.
   *
   * `seq` stays the store's either way: a supplied id changes which event an append writes,
   * not where in the log it lands.
   *
   * @throws SessionNotFoundError when the session does not exist
   * @throws FencedError when `options.fence` is not the partition's current live lease
   * @throws DuplicateEventIdError when an event id is already stored, or repeated in the batch
   * @throws ClaimConflictError when a `consumes` id is not a pending user event of this session
   * @throws RangeError when an event's `id` is not a valid event id, when a `supersedes` range
   *   does not lie within this session before the superseding event's own `seq`, or when a
   *   rewind's `from_seq` does not name a `user.message` this session still has
   */
  appendEvents(
    sessionId: SessionId,
    events: AppendableEvent[],
    options?: AppendEventsOptions,
  ): Promise<StoredEvent[]>

  /**
   * Read a page of the log.
   *
   * `order` defaults to `asc` (oldest first). `after_seq` keeps only events with a greater
   * `seq`, whatever the order; `types` keeps only those event types (`[]` keeps none). `page`
   * resumes at a `seq` position. `next_page` is `null` on the last page.
   *
   * This is the replay read, so since D9 (issue #46) it **skips superseded events**: a stored
   * `event_start` / `event_delta` whose `seq` a reply's recorded range covers is left out,
   * which is what lets a client resuming by `seq` see a reply once, whole, however far into the
   * stream it was when it disconnected — and every event a `session.rewind` replaced (#238) is
   * left out too, whatever its type, so a reader loading the session after an edit sees the
   * conversation as if the edited message had been the one sent. The chunks of a message still
   * in flight are not superseded by anything, so they are included. Cursors stay `seq`
   * positions and skipping leaves gaps in them; nothing else about reading changes. Pass
   * `includeSuperseded: true` to read the raw log instead — for debugging and tests.
   *
   * **Owner-scoped, and the owner is required** (epic #65, A4): somebody else's session is
   * answered with {@link SessionNotFoundError}, exactly like a session that does not exist, so
   * a 404 on the wire leaks nothing. Requiring the scope is deliberate — the user-facing route
   * for a session's events (and the SSE replay it drives) cannot forget it. The brain's replay
   * uses {@link SessionStore.listEventsUnscoped}, the explicitly named internal form.
   *
   * @throws SessionNotFoundError when the session does not exist, or belongs to another owner
   *   than `options.ownerId` names
   * @throws RangeError when `page` is not a `seq` cursor
   */
  listEvents(sessionId: SessionId, options: ListEventsOptions): Promise<ListEventsResponse>

  /**
   * Read a page of the log **without** an owner scope: any owner's session's log comes back.
   *
   * This is the internal form, and deliberately a different name rather than an optional
   * argument (epic #65, A4): the brain replays the log of the session it is acting for, and
   * the SSE route that has already answered 404 for a session it does not own may replay
   * through it. A user-facing read must not reach for it — pass the caller's `ownerId` to
   * {@link SessionStore.listEvents} instead, and a leak becomes a compile error.
   *
   * Everything else about the read is {@link SessionStore.listEvents}'s: the same filtering,
   * cursors and supersession rules.
   *
   * @throws SessionNotFoundError when the session does not exist
   * @throws RangeError when `page` is not a `seq` cursor
   */
  listEventsUnscoped(
    sessionId: SessionId,
    options?: UnscopedListEventsOptions,
  ): Promise<ListEventsResponse>

  /**
   * The user events waiting to be folded into a turn: `processed_at` is `null`, ordered by `seq`.
   *
   * An event a recorded range supersedes is not among them (#238): a message a rewind replaced
   * is not waiting for an answer and never will be, so a session the reader restarted from an
   * edit is not permanently "needing work" for the message the edit replaced.
   *
   * The brain reads these at the start of every iteration of its loop, and the append that
   * follows claims them: the events it answers are named in its `consumes` list, and the store
   * takes them in the same transaction as the append (see {@link SessionStore.appendEvents}).
   *
   * @throws SessionNotFoundError when the session does not exist
   */
  getPendingUserEvents(sessionId: SessionId): Promise<UserEvent[]>

  /**
   * What the session's turn looks like, from the log alone.
   *
   * `idle` when no turn is open — the last status event is `session.status_idle`, or there is
   * none. Otherwise a turn is open, and `state` says which kind it is:
   *
   * - `running` — a model request is in flight (a `span.model_request_start` with no matching
   *   `span.model_request_end`). `openSpan` is that start event.
   * - `unfinished` — nothing is in flight. Either the brain holding the turn is gone, or it
   *   wrote `session.status_rescheduled` and never came back — a reschedule does not end a turn,
   *   only a `session.status_idle` does.
   *
   * A brain that finds anything other than `idle` is looking at a turn it did not start: it
   * closes `openSpan` if there is one (`span.model_request_end` with `error.type: "brain_lost"`,
   * pointing at it) and runs the turn again.
   *
   * @throws SessionNotFoundError when the session does not exist
   */
  getTurnState(sessionId: SessionId): Promise<TurnState>

  // ------------------------------------------------------------- usage reads

  /**
   * Every model request one user's sessions recorded in a UTC window, in **one** read
   * (epic #245, A2; issue #247).
   *
   * A model request is a `span.model_request_start` — which names the model it ran on —
   * bracketed by the `span.model_request_end` that reports its tokens, and this is the pairing
   * the per-user usage report needs. Answering "what did this user spend between these two
   * instants" by walking the user's sessions and reading each log page by page would read every
   * event of a month of heavy use on every request; this answers it in one query, and it is a
   * store method rather than a caller's loop for exactly that reason.
   *
   * The window is half-open: an end event at exactly `from` is in the answer, one at exactly
   * `to` is not. Which local day each request fell on is the caller's question — the instants
   * here are UTC, and the days are the reader's zone — so a caller converts its local days into
   * a window like this one and groups what comes back.
   *
   * **Owner-scoped, and the owner is required** (epic #65, A4): only the owner's sessions are
   * read, so another user's requests cannot be in the answer — the same refusal by omission the
   * other scoped reads make.
   *
   * A request a `session.rewind` replaced is **not** in the answer (#238), exactly as it is not
   * in a replay: what a recorded range covers is not billed, and a `span.model_request_end` is
   * never a chunk, so only a rewind's range can cover one.
   *
   * The answer is ordered by `(session_id, seq)` — the log's own order, session by session —
   * so two reads of an unchanged log hand back the same list.
   *
   * @param options.from the window's start, inclusive
   * @param options.to the window's end, exclusive
   * @throws RangeError when a bound is not an instant, or `from` is after `to`
   */
  listModelRequests(options: ListModelRequestsOptions): Promise<ModelRequestUsage[]>

  /**
   * Delete the stored events a supersession covers — older than the retention window — and
   * return how many went.
   *
   * This is physical compaction: with {@link SessionStore.deleteSession} — which removes a
   * whole session and its log, and only the owner may ask — it is one of the only two ways
   * anything is ever deleted (D9, issue #46). It deletes what a recorded `supersedes` range
   * covers and nothing else, ever: the `event_start` / `event_delta` chunks a reply's range
   * replaces, and — since #238 — every event in the tail a `session.rewind` replaced, whatever
   * its type. A chunk that is not superseded (one still in flight) and a superseded event
   * inside the window stay where they are.
   *
   * Deleting changes no reader's answer: replay with
   * {@link SessionStore.listEvents} already skips superseded chunks, so correctness does not
   * depend on this having run, or on the window's length. The window is what keeps raw chunks
   * around for debugging and what keeps deletes off the append path; a server runs this
   * periodically with its retention window (`OPENHARNESS_DELTA_RETENTION_MS`).
   *
   * Idempotent, and safe to run from several instances at once: whoever deletes a row first
   * owns it, and everyone else simply finds fewer rows. `seq` values are never reused — a
   * superseded chunk is always followed by the event that superseded it, which is not a chunk
   * and which compaction never deletes — so gaps in the sequence are the normal state of a
   * compacted log.
   *
   * @param options.olderThan the cutoff: only a chunk the store wrote strictly before this
   *   instant is deleted. A `Date`, or milliseconds since the Unix epoch.
   * @throws RangeError when `olderThan` is not a valid instant
   */
  compact(options: CompactOptions): Promise<number>

  // ------------------------------------------------------- live subscription

  /**
   * Listen to everything that happens in a session: every stored event, in the order it was
   * appended.
   *
   * Delivery may be asynchronous, and a listener is never called for an event that was already
   * in the log when the subscription was established: a client that needs the history reads it
   * with {@link SessionStore.listEvents} first (or passes `after_seq`) and subscribes after.
   * Every listener is called for every event, in `seq` order; the order the listeners are
   * called in is not part of the contract, and a listener that throws does not affect the store
   * or the other listeners.
   *
   * A deleted session ends its subscriptions: when {@link SessionStore.deleteSession} removes
   * it, each listener receives one final `session.deleted` `StreamEvent` naming the session,
   * and the subscription ends with it. That event has no `seq` and is therefore outside the
   * "delivered in `seq` order" rule — it is the last delivery a subscriber sees for the
   * session, and nothing stored is fetched for it afterwards.
   *
   * @returns the function that ends the subscription
   */
  subscribe(sessionId: SessionId, listener: SessionEventListener): Promise<Unsubscribe>

  // -------------------------------------------------------- scheduler support

  /**
   * Signal a partition that a session needs attention: new user events to run (`work`), or a
   * turn to abort (`interrupt`).
   *
   * The signal reaches the listeners attached to that partition at that moment, once each; if
   * none are attached it is dropped, because signals are a latency optimization and not a
   * durable queue. Nothing may depend on one arriving — see
   * {@link SessionStore.findSessionsNeedingWork}.
   */
  signalPartition(partition: number, signal: PartitionSignalInput): Promise<void>

  /**
   * Listen to the signals of one partition, which is what a partition's owner does.
   *
   * @returns the function that ends the subscription
   */
  onPartitionSignal(partition: number, listener: PartitionSignalListener): Promise<Unsubscribe>

  /**
   * The sessions in `partitions` that need work: pending user events, or an open turn.
   *
   * This is recovery's starting point, and it is deliberately log-derived — it does not consult
   * leases, signals or any other transient state, so it answers the same thing for a partition
   * that has just been taken over as it does for one that is running normally. A session with
   * pending user events *and* an open turn is returned once.
   *
   * The result is ordered by `(created_at, id)` ascending: oldest session first.
   */
  findSessionsNeedingWork(partitions: readonly number[]): Promise<SessionId[]>

  // ------------------------------------------------- auth-session revocation

  /**
   * Announce that a Better Auth session was revoked (epic #65, A2; issue #76): its row is
   * gone, and everything authenticated by it — an open stream included — must stop.
   *
   * This is the store's second hint channel, next to {@link SessionStore.signalPartition}, and
   * it behaves the same way: it reaches the listeners attached at that moment, once each, and
   * a revocation nobody is listening for is dropped. Nothing may depend on receiving one,
   * because a server that holds an open response for an auth session re-validates the session
   * periodically (`apps/server`'s re-check); that is what recovers a missed notification.
   *
   * The notification carries the auth session's **id** and never its token: an id is not a
   * credential, a token is, and the payload of a `NOTIFY` is plaintext on a channel every
   * listener sees.
   *
   * @param authSessionId the `id` of the revoked Better Auth `session` row
   */
  notifyAuthSessionRevoked(authSessionId: AuthSessionId): Promise<void>

  /**
   * Listen for revocations of auth sessions (epic #65, A2; issue #76).
   *
   * What a server uses to close the responses it still has open for a revoked session — SSE
   * streams in particular, which are one long request and are never re-validated by the guard.
   * The Postgres store announces on a dedicated `NOTIFY` channel, so **every instance** hears a
   * revocation whichever instance handled the sign-out.
   *
   * Delivery may be asynchronous, and a revocation announced before the subscription was
   * established — or while a lost listening connection was reconnecting — is not replayed: a
   * revocation is a hint, and the holder of an open response re-validates the session
   * periodically anyway (see {@link SessionStore.notifyAuthSessionRevoked}).
   *
   * @returns the function that ends the subscription
   */
  onAuthSessionRevoked(listener: AuthSessionRevocationListener): Promise<Unsubscribe>

  // ------------------------------------------------------------ partition leases

  /**
   * Take the lease on a partition, or return `null` when a live lease holds it.
   *
   * The lease is granted when the partition is unleased, when the previous lease has expired,
   * or when the same owner asks again — in which case the epoch still advances, because every
   * successful acquire opens a new tenure. The returned epoch is what a fenced write must
   * carry, and the lease expires `ttlMs` after the clock's current instant (a lease is expired
   * from the instant `expires_at` names, inclusive).
   *
   * @throws RangeError when `ttlMs` is not a positive, finite number
   */
  acquirePartition(partition: number, owner: string, ttlMs: number): Promise<PartitionLease | null>

  /**
   * Extend a lease by `ttlMs`, from the clock's current instant.
   *
   * A lapse makes a lease **stealable, not lost**: this extends a lease whose row still names
   * this owner at this epoch whether or not it has expired. `expires_at` is what lets *another*
   * owner `acquire` the partition — which opens a new tenure and so changes both the owner and
   * the epoch — not what makes the lease un-renewable for the owner that still has it. Nothing
   * can be written while a lease is lapsed (a fenced write needs a live lease at its epoch), so
   * an owner that comes back before anybody takes the partition over has lost nothing.
   *
   * @returns `false` when the lease is no longer this owner's at this epoch — released, or taken
   *   over past its expiry — in which case the owner has been fenced and must re-acquire
   */
  renewPartition(partition: number, owner: string, epoch: number, ttlMs: number): Promise<boolean>

  /**
   * Give a lease up, and advance the partition's epoch so that writes still in flight with the
   * released epoch are fenced.
   *
   * Releasing a lease this owner does not hold is a no-op: release is not an assertion, so a
   * shutdown path can call it unconditionally.
   */
  releasePartition(partition: number, owner: string, epoch: number): Promise<void>

  /**
   * The partition's current epoch: the one a fenced write must carry.
   *
   * It starts at `1` on the first acquire and advances on every acquire and every release, so it
   * never repeats a tenure. `0` means the partition has never been leased, and no fence can
   * match it: an epoch has to have been handed out by a successful acquire.
   */
  currentEpoch(partition: number): Promise<number>

  // ------------------------------------------------------ scheduler membership

  /**
   * Announce this instance as alive: upsert its row in `scheduler_instances` with `last_seen`
   * at the clock's current instant (issue #122).
   *
   * Part of the partition scheduler's explicit membership: an instance heartbeats on every
   * tick, so a live member is a row seen within one lease TTL, and "how many instances share
   * the space?" is answered by {@link SessionStore.listLiveInstances} instead of being
   * inferred from the leases an instance failed to take. Announcing again only moves
   * `last_seen` forward, so the call is idempotent.
   */
  heartbeatInstance(instanceId: string): Promise<void>

  /**
   * The ids of the instances seen within `withinMs` of the clock's current instant, in
   * instance-id order — this instance included once it has announced itself.
   *
   * A membership is live while `last_seen` is strictly after `now - withinMs`; at exactly the
   * edge it is gone, the same inclusive expiry a lease has at `expires_at`. A caller that
   * passes its lease TTL therefore counts exactly the instances whose leases are being
   * renewed, and an instance that stops heartbeating — or dies — drops out at the instant its
   * held leases stop being live.
   *
   * @throws RangeError when `withinMs` is not a positive, finite number
   */
  listLiveInstances(withinMs: number): Promise<string[]>

  /**
   * Remove this instance's membership row — a graceful `stop()` says goodbye, so peers stop
   * counting the instance at once instead of after its last heartbeat ages out.
   *
   * Removing a membership that is not there is a no-op, so a shutdown path can call it
   * unconditionally; a removed instance is live again the moment it heartbeats.
   */
  removeInstance(instanceId: string): Promise<void>
}

/**
 * The events a caller may append.
 *
 * Two shapes, and between them they are everything a log can receive:
 *
 * - **A stored event**, minus the fields the store assigns. Derived from the protocol's union
 *   rather than restated, so adding an event type to the protocol makes it appendable without
 *   touching this package. The omitted fields are the store's to write — `seq` identifies the
 *   event's position in the log, and `processed_at` is `null` for user events and the clock's
 *   instant for everything else — with one exception: `id`, which a caller may supply and the
 *   store then stores as given. Supplying an id is how a reply's chunks and its message are
 *   one identity: the brain mints a `sevt_` id, appends the `event_start` and `event_delta`
 *   chunks under it, and appends the finished `agent.message` carrying the same id.
 * - **A `session.rewind`** (#238) as a client sends one: {@link AppendableRewind}, which names
 *   the message the session restarts from instead of carrying the range the stored event will
 *   have. A rewind reaches to the end of the log, and only the store knows where that is.
 *
 * The id a caller supplies has to be a valid event id and one the store does not already
 * hold, or the append is refused whole; see {@link SessionStore.appendEvents}.
 */
export type AppendableEvent = AppendableStoredEvent | AppendableRewind

/** A stored event a caller may append: the protocol's shape without the fields the store assigns. */
export type AppendableStoredEvent = DistributiveOmit<
  Exclude<StoredEvent, SessionRewindEvent>,
  'id' | 'seq' | 'processed_at'
> & {
  /**
   * The event's id, when the caller already has one — the id its previews were published
   * under. Omitted, the store generates one, as it does for every event that does not
   * preview itself.
   */
  readonly id?: EventId
}

/**
 * A `session.rewind` as a caller appends it (#238): the `user.message` the session restarts
 * from, and nothing else.
 *
 * A rewind always covers through the end of the log, so `to_seq` is not the caller's to say:
 * the store records the range on the stored `session.rewind` — from `from_seq` to the `seq`
 * the rewind event itself follows — in the same append that writes it. That is what makes the
 * rule exact under concurrency: the end of the log is read inside the append's transaction,
 * with the session's row locked, so no event can slip between the range a caller imagined and
 * the range the log gets.
 *
 * `from_seq` has to name a `user.message` of this session that no recorded range already
 * covers, or the append is refused whole with a `RangeError` — see
 * {@link SessionStore.appendEvents}.
 */
export interface AppendableRewind extends SessionRewindEventInput {
  /** The event's id, when the caller already has one. Omitted, the store generates one. */
  readonly id?: EventId
}

/** `Omit` that distributes over a union, so the members of a discriminated union stay discriminated. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** What {@link SessionStore.updateSession} changes. */
export interface UpdateSessionRequest {
  /**
   * The session's title: a string to set, `null` to clear, or omitted to keep what is stored.
   * It is written as given; the protocol's `SESSION_TITLE_MAX_LENGTH` is the caller's business.
   */
  readonly title?: string | null
}

/** Fields to give {@link SessionStore.createSession} beyond the agent. */
export interface CreateSessionOptions {
  /** The `user.id` the session belongs to (epic #65, A4); required — nothing is unowned. */
  readonly ownerId: UserId
  /**
   * The effective model the session runs (issue #93): the request's inline model, or a
   * per-session override of the agent's. Omitted, the agent's model is copied; without an
   * agent there is nothing to copy and a missing `model` is a `RangeError`.
   */
  readonly model?: ModelConfig
  /**
   * The effective system prompt (issue #93): the request's override, `null` for none.
   * Omitted, the agent's `system` is copied — or `null` when the session has no agent.
   */
  readonly system?: string | null
  /**
   * The mode the session follows (#245, M6), or `null`/omitted for a chat with none.
   *
   * A session created on a mode stores it as its `mode`, and the chat follows it live: the
   * server resolves the mode for every request. The caller passes the mode's **resolved**
   * model as `options.model` too, because a mode's "my default model" is a per-request lookup
   * this store does not make — `model` is the model the session last ran, and the fallback a
   * chat lands on if the mode is later deleted.
   */
  readonly mode?: ModeId | null
  /** The session title, or `null` for none. */
  readonly title?: string | null
  /** Caller metadata, stored with the session. */
  readonly metadata?: Metadata
  /**
   * Events to append in the creation transaction, in order. They are stored exactly as events
   * sent later to the events endpoint would be, so they are user events and start unprocessed.
   */
  readonly initial_events?: UserEventInput[]
}

/**
 * How a read is scoped to one owner (epic #65, A4): **required**, so a read that forgets its
 * owner is a compile error, not a silent leak of somebody else's data.
 *
 * The read methods a user-facing route uses take this, and the server passes the authenticated
 * caller's id: an agent or session that belongs to somebody else is left out of a list, and a
 * read of one answers `null` — or `SessionNotFoundError` on a session-scoped read — exactly as
 * for an id nothing has, so the route's 404 leaks nothing.
 *
 * The brain and the scheduler do not use this: they act for a session rather than for a user,
 * and use the explicitly named unscoped methods ({@link SessionStore.getSessionUnscoped},
 * {@link SessionStore.listEventsUnscoped}) instead.
 */
export interface OwnerScope {
  /** The `user.id` the read is scoped to. */
  readonly ownerId: UserId
}

/** Query of {@link SessionStore.listAgents}. */
export interface ListAgentsOptions extends OwnerScope {
  /** Page size; defaults to `DEFAULT_PAGE_LIMIT` and is capped at `MAX_PAGE_LIMIT`. */
  readonly limit?: number
  /** `next_page` from a previous call, passed back untouched. */
  readonly page?: string
}

/** Query of {@link SessionStore.listSessions}. */
export interface ListSessionsOptions extends OwnerScope {
  /** Page size; defaults to `DEFAULT_PAGE_LIMIT` and is capped at `MAX_PAGE_LIMIT`. */
  readonly limit?: number
  /** `next_page` from a previous call, passed back untouched. */
  readonly page?: string
  /** Return only sessions created with this agent. The protocol's `agent_id` filter. */
  readonly agentId?: AgentId
}

/** Query of {@link SessionStore.listEvents}: owner-scoped. */
export interface ListEventsOptions extends OwnerScope, UnscopedListEventsOptions {}

/** Query of {@link SessionStore.listEventsUnscoped}: the same filters, without the owner. */
export interface UnscopedListEventsOptions {
  /** `asc` (default, oldest first) or `desc`. */
  readonly order?: ListOrder
  /** Page size; defaults to `DEFAULT_PAGE_LIMIT` and is capped at `MAX_PAGE_LIMIT`. */
  readonly limit?: number
  /** `next_page` from a previous call: a `seq` position, the last event of that page. */
  readonly page?: string
  /** Return only events with a greater `seq`; `0` means "from the start of the log". */
  readonly afterSeq?: number
  /** Return only these event types; an empty array returns none. Omit for all of them. */
  readonly types?: StoredEventType[]
  /**
   * Return superseded chunks too. `false` (the default) makes this the replay read, which
   * skips stored `event_start` / `event_delta` events a recorded `supersedes` range covers;
   * `true` reads the raw log — for debugging and tests, not for a client's transcript.
   */
  readonly includeSuperseded?: boolean
}

/** Options of {@link SessionStore.compact}. */
export interface CompactOptions {
  /**
   * The retention cutoff: a stored chunk covered by a supersession is deleted only when the
   * store wrote it strictly before this instant. A `Date`, or milliseconds since the epoch.
   */
  readonly olderThan: Date | number
}

/** Options of {@link SessionStore.appendEvents}. */
export interface AppendEventsOptions {
  /**
   * The partition lease this write is made under. Omitted, the write is not fenced — which is
   * how the API appends a user event: it does not know who owns the partition, and the owner
   * finds the event through {@link SessionStore.findSessionsNeedingWork} if the signal is lost.
   */
  readonly fence?: PartitionFence
}

/**
 * Proof that a write is made by the partition's current owner.
 *
 * `partition` is the one the protocol's `partitionOf(sessionId)` computes. `epoch` is what
 * {@link SessionStore.acquirePartition} handed out; a write carrying an older one is refused
 * with {@link FencedError}.
 */
export interface PartitionFence {
  /** The partition the writing session belongs to. */
  readonly partition: number
  /** The epoch the writer's lease gave it. */
  readonly epoch: number
}

/** A lease on a partition: who holds it, at which epoch, until when. */
export interface PartitionLease {
  /** The leased partition. */
  readonly partition: number
  /** The leaseholder's id — one per server instance, stable for its lifetime. */
  readonly owner: string
  /** The epoch of this tenure: what fenced writes must carry. */
  readonly epoch: number
  /** When the lease lapses, `ttlMs` after it was acquired or last renewed. */
  readonly expires_at: Timestamp
}

/** What a partition is being signalled about. */
export type PartitionSignalKind =
  /** The session has user events waiting: run its turn. */
  | 'work'
  /** The user asked the session to stop: abort the running turn. */
  | 'interrupt'

/** The signal to send, as {@link SessionStore.signalPartition} receives it. */
export interface PartitionSignalInput {
  /** The session the signal is about; it lives in the signalled partition. */
  readonly sessionId: SessionId
  /** What the owner should do. */
  readonly kind: PartitionSignalKind
}

/** The signal a partition's owner receives. */
export interface PartitionSignal {
  /** The partition that was signalled. */
  readonly partition: number
  /** The session the signal is about. */
  readonly sessionId: SessionId
  /** What the owner should do. */
  readonly kind: PartitionSignalKind
}

/** What `getTurnState` reports about the session's turn. */
export type TurnStateKind =
  /** No turn is open: the agent is waiting for input. */
  | 'idle'
  /** A turn is open and a model request is in flight. */
  | 'running'
  /** A turn is open with nothing in flight: the brain that opened it is gone. */
  | 'unfinished'

/** The state of a session's turn, and the span a recovering brain has to close. */
export interface TurnState {
  /** Which of the three states the log is in; see {@link SessionStore.getTurnState}. */
  readonly state: TurnStateKind
  /**
   * The `span.model_request_start` that no `span.model_request_end` has closed, or `null` when
   * there is none. It is not `null` exactly when `state` is `running`.
   */
  readonly openSpan: ModelRequestStartEvent | null
}

/** Query of {@link SessionStore.listModelRequests} (epic #245, A2; issue #247). */
export interface ListModelRequestsOptions extends OwnerScope {
  /** The window's start, inclusive — a UTC instant, as the caller's local day was converted. */
  readonly from: Date
  /** The window's end, exclusive. */
  readonly to: Date
}

/**
 * One model request the log recorded, as {@link SessionStore.listModelRequests} reads it
 * (epic #245, A2; issue #247).
 *
 * The three facts a usage report is assembled from and nothing else: the model the request ran
 * on, what it spent, and when it finished. The money is not here — prices are not in the log —
 * so a caller pairs this with its own price lookup.
 */
export interface ModelRequestUsage {
  /**
   * The `provider/model` the request's `span.model_request_start` named, or `null` when there
   * is nothing to read: a start stored before the field existed, or an end whose
   * `model_request_start_id` names no event this store has. The tokens are real either way, so
   * such a request is in the totals and in no per-model breakdown.
   */
  readonly model: string | null
  /** What the request reported, as its end event carried it. */
  readonly usage: ModelUsage
  /**
   * When the request finished: the `processed_at` of the `span.model_request_end`. It is what
   * the caller groups by — the window filters on it — and it is the end's, so a request counts
   * on the day it ended.
   */
  readonly processed_at: Timestamp
}

/**
 * A Better Auth session id (epic #65, A2): the `id` of one row in Better Auth's `session`
 * table.
 *
 * Deliberately its own name rather than a bare `string`, and deliberately not a
 * {@link SessionId}: that one identifies a conversation's event log, and confusing the two —
 * closing a log's stream because the wrong session was revoked — is exactly the bug this type
 * exists to prevent.
 */
export type AuthSessionId = string

/** Called for every revocation of an auth session (epic #65, A2; issue #76). */
export type AuthSessionRevocationListener = (authSessionId: AuthSessionId) => void | Promise<void>

/** Called for every event of a subscribed session. */
export type SessionEventListener = (event: StreamEvent) => void | Promise<void>

/** Called for every signal of a subscribed partition. */
export type PartitionSignalListener = (signal: PartitionSignal) => void | Promise<void>

/** Ends a subscription; what {@link SessionStore.subscribe} returns. Calling it twice is a no-op. */
export type Unsubscribe = () => void
