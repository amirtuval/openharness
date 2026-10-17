import { describe, expect, it } from 'vitest'

import { encodeKeyCursor } from '@openharness/protocol'
import { makeChildSession, makeSession } from '@openharness/protocol/fixtures'
import type { ListSessionsQuery, ListSessionsResponse, Session } from '@openharness/protocol'

import { listChildren, sessionBreadcrumb } from './session-tree'
import type { SessionTreeSource } from './session-tree'

/** A `client.sessions` double: a list served a page at a time, and a store to get one from. */
function sessionsOf(options: {
  readonly pages?: readonly ListSessionsResponse[]
  readonly byId?: ReadonlyMap<string, Session>
}) {
  const queries: ListSessionsQuery[] = []
  const pages = options.pages ?? [{ data: [], next_page: null }]
  let page = 0
  return {
    queries,
    source: {
      list(params?: ListSessionsQuery) {
        queries.push(params ?? {})
        const response = pages[Math.min(page, pages.length - 1)] as ListSessionsResponse
        page += 1
        return Promise.resolve(response)
      },
      get(sessionId: string) {
        const session = options.byId?.get(sessionId)
        return session === undefined
          ? Promise.reject(new Error(`no such session: ${sessionId}`))
          : Promise.resolve(session)
      },
    } satisfies SessionTreeSource,
  }
}

/** One page of children, with the cursor that continues it. */
function page(data: readonly Session[], next: string | null): ListSessionsResponse {
  return { data: [...data], next_page: next }
}

describe('listChildren (#340, S3; #345)', () => {
  const parent = makeSession()
  const first = makeChildSession(parent)
  const second = makeChildSession(parent)

  it('asks for one session’s children, newest first', async () => {
    const { queries, source } = sessionsOf({ pages: [page([first, second], null)] })

    const children = await listChildren(source, parent.id)

    expect(children).toEqual([first, second])
    expect(queries).toEqual([{ parent_session_id: parent.id, limit: 100 }])
  })

  it('walks the pages to the end', async () => {
    const cursor = encodeKeyCursor({ created_at: first.created_at, id: first.id })
    const { queries, source } = sessionsOf({
      pages: [page([first], cursor), page([second], null)],
    })

    const children = await listChildren(source, parent.id)

    expect(children).toEqual([first, second])
    expect(queries[1]).toEqual({ parent_session_id: parent.id, limit: 100, page: cursor })
  })

  it('stops on a cursor the server has already given', async () => {
    // A server that repeats a cursor would otherwise be paged for ever. The walk has to end
    // where the repeat starts rather than adding a second copy of the same page.
    const cursor = encodeKeyCursor({ created_at: first.created_at, id: first.id })
    const { source } = sessionsOf({
      pages: [page([first], cursor), page([first], cursor)],
    })

    expect(await listChildren(source, parent.id)).toEqual([first])
  })

  it('is empty for a session with no children', async () => {
    const { source } = sessionsOf({ pages: [page([], null)] })

    expect(await listChildren(source, parent.id)).toEqual([])
  })
})

describe('sessionBreadcrumb (#340, S1/S3; #345)', () => {
  it('is just the session when it is a top-level chat', async () => {
    const root = makeSession()
    const { source } = sessionsOf({ byId: new Map([[root.id, root]]) })

    expect(await sessionBreadcrumb(source, root)).toEqual([root])
  })

  it('walks from a child up to the root, root first', async () => {
    const root = makeSession()
    const middle = makeChildSession(root)
    const leaf = makeChildSession(middle)
    const byId = new Map([
      [root.id, root],
      [middle.id, middle],
    ])
    const { source } = sessionsOf({ byId })

    expect((await sessionBreadcrumb(source, leaf)).map((session) => session.id)).toEqual([
      root.id,
      middle.id,
      leaf.id,
    ])
    expect((await sessionBreadcrumb(source, leaf)).map((session) => session.depth)).toEqual([
      0, 1, 2,
    ])
  })

  it('stops when a session names a parent the walk has already seen', async () => {
    // A cycle is not a tree, and a breadcrumb is not worth a hang: the walk ends where it
    // meets itself rather than following the loop for ever.
    const root = makeSession()
    const child = makeChildSession(root)
    const looped = makeSession({ ...root, parent_session_id: child.id })
    const byId = new Map([
      [root.id, looped],
      [child.id, child],
    ])
    const { source } = sessionsOf({ byId })

    expect((await sessionBreadcrumb(source, child)).map((session) => session.id)).toEqual([
      looped.id,
      child.id,
    ])
  })
})
