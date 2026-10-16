import type { Session } from '@openharness/protocol'
import { makeChildSession, makeSession } from '@openharness/protocol/fixtures'
import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ClientProvider, useClient } from '../components/client-provider'
import { makeFake } from '../test-support/render-app'
import { useSessionTree, type SessionTreeView } from './use-session-tree'

/**
 * The read behind the sidebar's nesting (epic #340, S1/S3; issue #346).
 *
 * The sidebar's own tests hand the tree in, so what is under test here is the hook: which chats
 * it asks about, that an answer is remembered rather than re-asked, and that `refresh` really
 * re-reads one chat — which is why the hook does the reading itself rather than flagging a re-run
 * of its sweep. A chat's group has to appear the moment its tasks move, and a flagged re-run races
 * the sweep's own in-flight answer for the same chat (it did: the group was missing on the first
 * run against an empty store, which is what this file now pins).
 */

/** The view the last render produced, for the calls a test makes by hand. */
let view: SessionTreeView | null = null

/** A component that only renders each chat's children, so the hook can be read. */
function TreeProbe({ sessions }: { readonly sessions: readonly Session[] }) {
  const client = useClient()
  const tree = useSessionTree(client, sessions)
  view = tree
  return (
    <ul>
      {sessions.map((session) => (
        <li key={session.id} data-chat={session.id}>
          {tree
            .childrenOf(session.id)
            .map((child) => child.id)
            .join(',')}
        </li>
      ))}
    </ul>
  )
}

/** What one chat's row reads: the ids of the children the tree knows about, or nothing. */
function childrenText(sessionId: string): string {
  return document.querySelector(`[data-chat="${sessionId}"]`)?.textContent ?? ''
}

/** The chats a fake was asked about, in order. */
function recordChildReads(fake: ReturnType<typeof makeFake>): string[] {
  const asked: string[] = []
  const list = fake.sessions.list.bind(fake.sessions)
  fake.sessions.list = (params, options) => {
    if (params?.parent_session_id !== undefined) {
      asked.push(params.parent_session_id)
    }
    return list(params, options)
  }
  return asked
}

describe('the session tree (#346)', () => {
  it('asks each listed chat once, and remembers one that has no children', async () => {
    const fake = makeFake()
    const parent = makeSession({ title: 'Release notes' })
    const other = makeSession({ title: 'A chat with no helpers' })
    fake.addSession(makeChildSession(parent, { title: 'Check the changelog' }))
    const asked = recordChildReads(fake)

    const first = render(
      <ClientProvider client={fake}>
        <TreeProbe sessions={[parent, other]} />
      </ClientProvider>,
    )

    await waitFor(() => {
      expect(childrenText(parent.id)).not.toBe('')
    })
    expect(childrenText(other.id)).toBe('')
    expect(asked).toContain(parent.id)
    expect(asked).toContain(other.id)

    // The same chats again — a re-render with a rebuilt array, which is what the sidebar does
    // every time the list it reads is refreshed — and nothing is read twice: the answer is
    // remembered, "no children" included.
    const reads = asked.length
    first.rerender(
      <ClientProvider client={fake}>
        <TreeProbe sessions={[...[parent, other]]} />
      </ClientProvider>,
    )
    await waitFor(() => {
      expect(childrenText(parent.id)).not.toBe('')
    })
    expect(asked.length).toBe(reads)
  })

  it('re-reads one chat on demand, which is what nests a helper the moment it starts', async () => {
    const fake = makeFake()
    const parent = makeSession({ title: 'Release notes' })

    render(
      <ClientProvider client={fake}>
        <TreeProbe sessions={[parent]} />
      </ClientProvider>,
    )

    // Asked once at the start, when there was nothing to find.
    await waitFor(() => {
      expect(document.querySelectorAll('[data-chat]')).toHaveLength(1)
    })
    expect(childrenText(parent.id)).toBe('')

    // The chat starts a helper, and the shell asks that one chat again.
    const child = makeChildSession(parent, { title: 'Check the changelog' })
    fake.addSession(child)
    view?.refresh(parent.id)

    await waitFor(() => {
      expect(childrenText(parent.id)).toBe(child.id)
    })
  })

  it('says nothing about a chat a read could not answer', async () => {
    const fake = makeFake()
    const parent = makeSession({ title: 'Release notes' })
    fake.sessions.list = vi.fn(() => Promise.reject(new Error('nope')))

    render(
      <ClientProvider client={fake}>
        <TreeProbe sessions={[parent]} />
      </ClientProvider>,
    )

    // A sidebar that cannot nest is still a sidebar: the chat draws no group, and nothing is
    // raised about it.
    await waitFor(() => {
      expect(document.querySelectorAll('[data-chat]')).toHaveLength(1)
    })
    expect(childrenText(parent.id)).toBe('')
  })
})
