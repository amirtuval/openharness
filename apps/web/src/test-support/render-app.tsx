import {
  createFakeClient,
  type FakeClient,
  type FakeClientOptions,
} from '@openharness/client/testing'
import { render, screen, type RenderResult } from '@testing-library/react'
import type userEvent from '@testing-library/user-event'

import { App } from '../App'

/**
 * Render the app against a fake server.
 *
 * The hash is set before the render, because that is the app's route: `#/s/<id>` opens a
 * chat, `#/new` and `#/settings` open the others. Changing it later and letting the
 * `hashchange` event do the rest is how a test navigates.
 */
export function renderApp(
  fake: FakeClient,
  options: { hash?: string; fakeClient?: boolean } = {},
): RenderResult {
  window.location.hash = options.hash ?? `#/s/${fake.session.id}`
  return render(<App client={fake} fakeClient={options.fakeClient} />)
}

/**
 * A fake server.
 *
 * `localStorage` is cleared for every test by `vitest.setup.ts`'s global `afterEach`, not
 * here: this is not the only way a test builds a client (`createFakeClient()` directly, to
 * keep what a previous visit stored), and leaving the reset where it is never missed is the
 * point.
 */
export function makeFake(options: FakeClientOptions = {}): FakeClient {
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
 * Wrap the fake's session-list endpoint so a test can see what the app asked it for.
 *
 * Paging is invisible from the rendered DOM — a list that followed `next_page` and one that
 * happened to fit in a single page look the same — so the assertion "the requests carried the
 * cursor" needs the requests themselves. (The agents list was the second caller until #91
 * deleted the agents screen; a wrapper for it outlived its consumer and is gone with it.)
 */
export function recordListRequests(fake: FakeClient): { readonly sessions: ListRequest[] } {
  const sessions: ListRequest[] = []
  const listSessions = fake.sessions.list.bind(fake.sessions)

  fake.sessions.list = (params, options) => {
    sessions.push({ limit: params?.limit, page: params?.page })
    return listSessions(params, options)
  }

  return { sessions }
}

/** The sidebar's list of chats, as the elements it renders. */
export function sessionRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('nav[aria-label="Chats"] li')]
}

/**
 * Open the account menu at the foot of the sidebar (U10).
 *
 * Settings, the theme and Sign out live inside it, and a Radix menu keeps its content out of
 * the DOM until it opens — so a test that wants one of them has to open it the way a reader
 * does, and this is that one step in one place. The menu itself is portalled to `document.body`,
 * which is why its items are queried with `screen`, not `within` the sidebar.
 */
export async function openAccountMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  // `findBy`, not `getBy`: the shell is behind the session check, so the sidebar — and the menu
  // in its foot — does not exist for the first frames of a render.
  await user.click(await screen.findByRole('button', { name: 'Account menu' }))
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

/**
 * The row at the foot of the transcript — "Working…", "Retrying…" or "Interrupted" — or `null`
 * when there is none (U10).
 *
 * Read off `data-slot` rather than by role: it is a `role="status"` live region, and so is the
 * header's indicator, so a role query would find whichever came first in the document.
 */
export function workingRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="working-row"]')
}
