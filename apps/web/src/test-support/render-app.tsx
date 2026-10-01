import {
  createFakeClient,
  type FakeClient,
  type FakeClientOptions,
} from '@openharness/client/testing'
import { render, type RenderResult } from '@testing-library/react'

import { App } from '../App'

/**
 * Render the app against a fake server.
 *
 * The hash is set before the render, because that is the app's route: `#/s/<id>` opens a
 * chat, `#/new`, `#/agents` and `#/settings` open the others. Changing it later and letting
 * the `hashchange` event do the rest is how a test navigates.
 */
export function renderApp(
  fake: FakeClient,
  options: { hash?: string; fakeClient?: boolean } = {},
): RenderResult {
  window.location.hash = options.hash ?? `#/s/${fake.session.id}`
  return render(<App client={fake} fakeClient={options.fakeClient} />)
}

/** A fake server with a clean `localStorage`, so one test's settings never reach the next. */
export function makeFake(options: FakeClientOptions = {}): FakeClient {
  localStorage.clear()
  return createFakeClient(options)
}

/**
 * Sign a signed-out fake back in, the way the server does once a sign-in succeeds.
 *
 * A fake's session is its `authenticated` flag, and the device flow is the one path that
 * turns it on (`oh login`'s approval — see `@openharness/client/testing`); a test whose UI
 * signs in calls this from the mocked Better Auth call to stand in for the cookie the server
 * would have set.
 */
export async function signInFake(fake: FakeClient): Promise<void> {
  fake.scriptDeviceLogin({ pendingPolls: 0 })
  const start = await fake.auth.startDeviceLogin()
  await fake.auth.pollDeviceLogin(start.deviceCode)
}

/** What one list request was asked for. */
export interface ListRequest {
  readonly limit: number | undefined
  readonly page: string | undefined
}

/**
 * Make the fake derive a session's title from its first `user.message`, the way the server
 * does.
 *
 * The fake predates the server's naming (PR #32): it stores events and answers
 * `sessions.get` with the session it created, whose title stays whatever `create` was given,
 * where the real server names the session inside the request that stores the first message
 * (`apps/server/src/titles.ts`). A test about #35 needs a server that has a title to hand
 * over once the message is in, so this plays that part — after `sendMessage` stores a
 * message, `sessions.get` answers with the session named by it.
 *
 * Only `get` is patched, deliberately: the sidebar is supposed to get the new title from the
 * re-read (the header reads the same copy), and leaving `sessions.list` alone is what lets a
 * test assert that no second walk of the list was needed to show it.
 *
 * The rule is the server's, without the length cut a long title would take: tests here send
 * one short line.
 */
export function deriveSessionTitles(fake: FakeClient): void {
  const titles = new Map<string, string>()
  const get = fake.sessions.get.bind(fake.sessions)
  const send = fake.sendMessage.bind(fake)

  fake.sendMessage = async (sessionId, text, options) => {
    const stored = await send(sessionId, text, options)
    if (!titles.has(sessionId)) {
      const line = text.split(/\r\n|\r|\n/).find((candidate) => candidate.trim() !== '')
      if (line !== undefined) {
        titles.set(sessionId, line.trim().replace(/\s+/gu, ' '))
      }
    }
    return stored
  }

  fake.sessions.get = async (sessionId, options) => {
    const session = await get(sessionId, options)
    const title = titles.get(sessionId)
    return title === undefined ? session : { ...session, title }
  }
}

/**
 * Wrap a fake's two list endpoints so a test can see what the app asked them for.
 *
 * Paging is invisible from the rendered DOM — a list that followed `next_page` and one that
 * happened to fit in a single page look the same — so the assertion "the requests carried the
 * cursor" needs the requests themselves.
 */
export function recordListRequests(fake: FakeClient): {
  readonly agents: ListRequest[]
  readonly sessions: ListRequest[]
} {
  const agents: ListRequest[] = []
  const sessions: ListRequest[] = []
  const listAgents = fake.agents.list.bind(fake.agents)
  const listSessions = fake.sessions.list.bind(fake.sessions)

  fake.agents.list = (params, options) => {
    agents.push({ limit: params?.limit, page: params?.page })
    return listAgents(params, options)
  }
  fake.sessions.list = (params, options) => {
    sessions.push({ limit: params?.limit, page: params?.page })
    return listSessions(params, options)
  }

  return { agents, sessions }
}

/** The sidebar's list of chats, as the elements it renders. */
export function sessionRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('nav[aria-label="Chats"] li')]
}

/** The message element for a role — the first one, for the single-message cases. */
export function messageElement(role: 'user' | 'agent'): Element | null {
  return document.querySelector(`[data-role="${role}"]`)
}

/**
 * A message's text as a reader sees it.
 *
 * `textContent` would also pick up the screen-reader note next to a streaming reply ("The
 * assistant is replying…"), which is not part of what the model wrote.
 */
export function visibleText(element: Element | null): string {
  if (element === null) {
    return ''
  }
  const clone = element.cloneNode(true) as Element
  for (const hidden of clone.querySelectorAll('.sr-only')) {
    hidden.remove()
  }
  return clone.textContent ?? ''
}

/** The text of the agent's reply as it stands right now. */
export function agentText(): string {
  return visibleText(messageElement('agent'))
}

/** Whether a reply is on screen and still arriving. */
export function isStreaming(): boolean {
  return document.querySelector('[data-role="agent"][data-streaming="true"]') !== null
}
