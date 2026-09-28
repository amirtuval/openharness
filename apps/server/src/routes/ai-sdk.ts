import type { Context, Hono } from 'hono'
import type { UIMessageStreamWriter } from 'ai'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import {
  API_VERSION_PREFIX,
  EVENT_TYPES,
  type AgentMessageEvent,
  type SessionId,
  type StreamEvent,
} from '@openharness/protocol'
import type { SessionStore } from '@openharness/session'

import type { AppEnv } from '../types'
import { invalidRequest, notFoundError } from '../http/errors'
import { sessionIdParam } from '../http/request'
import type { RouteDeps } from './deps'

/**
 * `POST /v1/sessions/{id}/ai-sdk/chat` — a compatibility extension, not part of the protocol.
 *
 * The AI SDK's `useChat` hook speaks its own protocol: it POSTs the whole UI message list and
 * expects a UI message stream back. This endpoint is that shape, translated onto a session —
 * so a React app built on `useChat` can talk to an openharness session without knowing about
 * the event log. It is an extension because the protocol does not describe it: nothing in
 * `@openharness/protocol` mentions UI message chunks, and `packages/client` does not use it.
 *
 * What it does, in order:
 *
 * 1. take the last `user` message's text from the request;
 * 2. append it to the session as a `user.message`, then signal the scheduler;
 * 3. follow the session's live events and translate them into UI message chunks until
 *    `session.status_idle` closes the turn.
 *
 * The translation is deliberately thin. A text chunk becomes `text-start` / `text-delta` /
 * `text-end`, keyed by the `sevt_` id the brain announced, so the reply streams as it is
 * generated and the stored `agent.message` that follows reconciles with it exactly (see
 * `packages/brain`, "Preview and stored ids"). A `session.error` becomes an `error` chunk;
 * everything else in the log — spans, status transitions, the user's own events — has no UI
 * message equivalent and is skipped.
 */
export function registerAiSdkRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const chat = `${API_VERSION_PREFIX}/sessions/:session_id/ai-sdk/chat`

  app.post(chat, async (c) => {
    const sessionId = sessionIdParam(c, 'session_id')
    const session = await deps.store.getSession(sessionId)
    if (session === null) {
      throw notFoundError(`no session with id ${sessionId}`)
    }
    const body = await parseChatRequest(c)
    const text = lastUserMessageText(body.messages)
    if (text === undefined) {
      throw invalidRequest('the request must carry a user message with text')
    }

    // Follow the session before the message is appended: the turn may start — and finish —
    // before this handler returns, and a subscription established later would miss it.
    const live = await openSessionLive(deps.store, sessionId, c.req.raw.signal)
    try {
      await deps.store.appendEvents(sessionId, [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }] },
      ])
      if (await hasWork(deps.store, sessionId)) {
        deps.scheduler.signal(sessionId, 'work')
      }
      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          writer.write({ type: 'start' })
          await pumpTurn({ writer, live, signal: c.req.raw.signal })
        },
        onError: (error) => errorMessageOf(error),
      })
      return createUIMessageStreamResponse({ stream })
    } catch (error) {
      live.close()
      throw error
    }
  })
}

/** The AI SDK's chat request: the UI messages, and nothing this endpoint needs beyond them. */
interface ChatRequest {
  readonly messages: readonly unknown[]
}

/**
 * Read the request the way `DefaultChatTransport` writes it.
 *
 * The body is `{ id, messages, trigger, messageId }` (plus whatever the caller adds), and
 * only `messages` matters here: the trigger is `submit-message` for everything the endpoint
 * supports. A `regenerate-message` request appends the last user message again — v1 has no
 * regenerate semantics, and answering the same prompt again is the closest honest reading.
 *
 * The messages are UI messages, which the protocol has no schema for, so they are read
 * structurally rather than validated: a body that carries no user text at all is refused, but
 * an unknown part type is simply not text.
 */
async function parseChatRequest(c: Context<AppEnv>): Promise<ChatRequest> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw invalidRequest('the request body must be JSON')
  }
  if (!isRecord(raw)) {
    throw invalidRequest('the request body must be an object')
  }
  const messages = raw['messages']
  if (!Array.isArray(messages)) {
    throw invalidRequest('`messages` must be an array')
  }
  return { messages }
}

/** The text of the last `user` message that carries any. */
function lastUserMessageText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || message['role'] !== 'user') {
      continue
    }
    const text = textOfUiMessage(message)
    if (text !== undefined && text.length > 0) {
      return text
    }
  }
  return undefined
}

/**
 * The text of one UI message: its `parts` joined, or a `content` string for a client that
 * still sends the older shape.
 */
function textOfUiMessage(message: Record<string, unknown>): string | undefined {
  const parts = message['parts']
  if (Array.isArray(parts)) {
    const text = parts.flatMap((part) => (isTextPart(part) ? [part.text] : [])).join('')
    return text.length > 0 ? text : undefined
  }
  const content = message['content']
  return typeof content === 'string' ? content : undefined
}

/** Whether an unknown value is a UI message `text` part. */
function isTextPart(part: unknown): part is { readonly text: string } {
  return isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string'
}

/** Whether an unknown value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Whether anything would run the session right now: queued events, or a turn already open. */
async function hasWork(store: SessionStore, sessionId: SessionId): Promise<boolean> {
  const pending = await store.getPendingUserEvents(sessionId)
  if (pending.length > 0) {
    return true
  }
  const turn = await store.getTurnState(sessionId)
  return turn.state !== 'idle'
}

/** Write the turn's events out as UI message chunks until the session is idle again. */
async function pumpTurn(options: {
  readonly writer: UIMessageStreamWriter
  readonly live: SessionLive
  readonly signal: AbortSignal | undefined
}): Promise<void> {
  const { writer, live, signal } = options
  const translator = new TurnTranslator()
  for (;;) {
    if (signal?.aborted === true) {
      return
    }
    const event = await live.next()
    if (event === null) {
      return
    }
    if (translator.apply(event, writer)) {
      return
    }
  }
}

/**
 * A session's live events, as the adapter reads them: stored events and previews, in order,
 * with the subscriber established before the first call to {@link SessionLive.next}.
 */
interface SessionLive {
  /** The next event, `null` once the stream is closed or the subscriber goes away. */
  next(): Promise<StreamEvent | null>
  /** End the subscription; a pending {@link SessionLive.next} resolves to `null`. */
  close(): void
}

/** Subscribe to a session's live events, buffering them until they are read. */
async function openSessionLive(
  store: SessionStore,
  sessionId: SessionId,
  signal: AbortSignal | undefined,
): Promise<SessionLive> {
  const queued: StreamEvent[] = []
  let waiter: ((event: StreamEvent | null) => void) | null = null
  let closed = false

  const unsubscribe = await store.subscribe(sessionId, (event) => {
    const waiting = waiter
    if (waiting === null) {
      queued.push(event)
    } else {
      waiter = null
      waiting(event)
    }
  })

  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    unsubscribe()
    const waiting = waiter
    waiter = null
    waiting?.(null)
  }
  signal?.addEventListener('abort', close, { once: true })

  return {
    next: () => {
      const buffered = queued.shift()
      if (buffered !== undefined) {
        return Promise.resolve(buffered)
      }
      if (closed) {
        return Promise.resolve(null)
      }
      return new Promise((resolve) => {
        waiter = resolve
      })
    },
    close,
  }
}

/** The text of a stored message's content blocks. v1 content is text-only. */
function textOfContent(content: AgentMessageEvent['content']): string {
  return content.map((block) => block.text).join('')
}

/** A message being streamed to the client, and the preview text it has seen so far. */
interface OpenText {
  readonly id: string
  text: string
}

/**
 * Turns session events into UI message chunks.
 *
 * One text block is open at a time, named by the `sevt_` id of the message it previews. The
 * previews (`event_start` / `event_delta`) open it and extend it; the stored `agent.message`
 * either closes it — streaming the tail the previews did not carry, which is how a shed delta
 * still ends up on screen — or, when no preview was ever seen (the adapter arrived
 * mid-request, or deltas were dropped), writes the whole message at once.
 */
class TurnTranslator {
  #open: OpenText | null = null

  /**
   * Translate one event.
   *
   * @returns whether the response is finished — `session.status_idle`, the end of the turn
   */
  apply(event: StreamEvent, writer: UIMessageStreamWriter): boolean {
    switch (event.type) {
      case EVENT_TYPES.eventStart:
        this.#close(writer)
        this.#open = { id: event.event.id, text: '' }
        writer.write({ type: 'text-start', id: event.event.id })
        return false
      case EVENT_TYPES.eventDelta:
        this.#append(event.event_id, event.delta.content.text, writer)
        return false
      case EVENT_TYPES.agentMessage:
        this.#store(event, writer)
        return false
      case EVENT_TYPES.sessionError:
        writer.write({ type: 'error', errorText: event.error.message })
        return false
      case EVENT_TYPES.sessionStatusIdle:
        this.#close(writer)
        return true
      default:
        return false
    }
  }

  #append(id: string, text: string, writer: UIMessageStreamWriter): void {
    if (this.#open === null || this.#open.id !== id) {
      this.#close(writer)
      this.#open = { id, text: '' }
      writer.write({ type: 'text-start', id })
    }
    this.#open.text += text
    writer.write({ type: 'text-delta', id, delta: text })
  }

  #store(event: AgentMessageEvent, writer: UIMessageStreamWriter): void {
    const text = textOfContent(event.content)
    if (this.#open !== null && this.#open.id === event.id) {
      const streamed = this.#open.text
      // Previews are a prefix of the stored text unless deltas were shed, so the tail is all
      // that is missing. A preview that is not a prefix at all is left alone: the stored event
      // is the record, and re-ordering the display to fix it would be worse than the gap.
      if (text.startsWith(streamed) && text.length > streamed.length) {
        writer.write({ type: 'text-delta', id: event.id, delta: text.slice(streamed.length) })
      }
      this.#close(writer)
      return
    }
    this.#close(writer)
    if (text.length > 0) {
      writer.write({ type: 'text-start', id: event.id })
      writer.write({ type: 'text-delta', id: event.id, delta: text })
      writer.write({ type: 'text-end', id: event.id })
    }
  }

  #close(writer: UIMessageStreamWriter): void {
    if (this.#open === null) {
      return
    }
    writer.write({ type: 'text-end', id: this.#open.id })
    this.#open = null
  }
}

/** The message an `error` chunk carries: the error's own, never a stack trace. */
function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }
  return 'the turn failed'
}
