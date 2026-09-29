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

/** What one list request was asked for. */
export interface ListRequest {
  readonly limit: number | undefined
  readonly page: string | undefined
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
