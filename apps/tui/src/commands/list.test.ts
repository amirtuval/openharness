import { ApiError, AuthenticationError, type Client } from '@openharness/client'
import { createFakeClient, type FakeClient } from '@openharness/client/testing'
import { makeAgent, makeSession } from '@openharness/protocol/fixtures'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { MAX_LIST_PAGES } from '../paging'
import { pagedAgents, pagedSessions, seedAgents, seedSessions } from '../test-support/fake'
import {
  formatAgents,
  formatSessions,
  runAgents,
  runSessionDelete,
  runSessions,
  type CommandIo,
  type SessionDeleteIo,
} from './list'

/** Collect what a command wrote, and how it left. */
function recorder() {
  const out: string[] = []
  const err: string[] = []
  const prompts: string[] = []

  return {
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      prompt: (text: string) => prompts.push(text),
      context: { server: 'http://localhost:3000' },
    } satisfies Omit<SessionDeleteIo, 'stdin'>,
    out,
    err,
    prompts,
  }
}

/** A stdin that answers the confirmation with `answer`, or nothing at all at end of input. */
function answering(answer: string | undefined): NodeJS.ReadStream {
  return Readable.from(answer === undefined ? [] : [`${answer}\n`]) as unknown as NodeJS.ReadStream
}

/**
 * A fake whose `list` — the agents' or the sessions' walk — fails with `error`.
 *
 * `runSessions` and `runAgents` differ only in which list they walk, so one helper spells
 * the failure for both.
 */
function failingList(fake: FakeClient, resource: 'sessions' | 'agents', error: unknown): Client {
  const list = () => Promise.reject(error instanceof Error ? error : new Error(String(error)))
  return resource === 'sessions'
    ? { ...fake, sessions: { ...fake.sessions, list } }
    : { ...fake, agents: { ...fake.agents, list } }
}

describe('formatSessions', () => {
  it('prints id, title, status and updated', () => {
    const session = makeSession({
      title: 'A chat about nothing',
      status: 'idle',
      updated_at: '2026-09-28T10:00:00.000Z',
    })

    const [line] = formatSessions([session])

    expect(line).toContain(session.id)
    expect(line).toContain('A chat about nothing')
    expect(line).toContain('idle')
    expect(line).toContain('2026-09-28T10:00:00.000Z')
  })

  it('labels an untitled session by the model it runs', () => {
    const session = makeSession({
      title: null,
      agent: null,
      model: { id: 'openai/gpt-4.1-mini' },
    })

    expect(formatSessions([session])[0]).toContain('openai/gpt-4.1-mini')
  })

  it('cuts a title too long for the column', () => {
    const [line] = formatSessions([makeSession({ title: 'x'.repeat(80) })])

    expect(line).toContain(`${'x'.repeat(31)}…`)
    expect(line).not.toContain('x'.repeat(40))
  })

  it('says how to start one when there are none', () => {
    expect(formatSessions([])).toEqual(['No sessions yet. Start one with `oh`.'])
  })
})

describe('formatAgents', () => {
  it('prints id, name and model', () => {
    const agent = makeAgent({ name: 'Summarizer', model: { id: 'anthropic/claude-sonnet-5' } })
    const [line] = formatAgents([agent])

    expect(line).toContain(agent.id)
    expect(line).toContain('Summarizer')
    expect(line).toContain('anthropic/claude-sonnet-5')
  })

  it('says where to create one when there are none', () => {
    expect(formatAgents([])[0]).toContain('web app')
  })
})

/**
 * The two listings are one walk over two resources, so the tests that spell the walk run
 * once per command rather than being copied with a noun swapped (review of #105, P3).
 */
interface ListingCase {
  readonly what: string
  readonly run: (client: Client, io: CommandIo) => Promise<number>
  /** The client serving `count` rows a page at a time. */
  readonly manyPages: (fake: FakeClient, count: number) => Promise<Client>
  readonly count: number
  readonly first: string
  readonly last: string
  /** A row the plain fake already has, for the not-paged case. */
  readonly seeded: (fake: FakeClient) => string
}

const LISTINGS: readonly ListingCase[] = [
  {
    what: 'sessions',
    run: runSessions,
    manyPages: async (fake, count) => pagedSessions(fake, await seedSessions(fake, count)),
    count: 120,
    first: 'Session 01',
    last: 'Session 120',
    seeded: (fake) => fake.session.id,
  },
  {
    what: 'agents',
    run: runAgents,
    manyPages: async (fake, count) => pagedAgents(fake, await seedAgents(fake, count)),
    count: 45,
    first: 'Agent 01',
    last: 'Agent 45',
    seeded: (fake) => fake.agent.name,
  },
]

for (const listing of LISTINGS) {
  describe(`run${listing.what}`, () => {
    it(`lists the ${listing.what} the server has`, async () => {
      const fake = createFakeClient()
      const { io, out, err } = recorder()

      const code = await listing.run(fake, io)

      expect(code).toBe(0)
      expect(err).toEqual([])
      expect(out.join('\n')).toContain(listing.seeded(fake))
    })

    it(`lists every ${listing.what.slice(0, -1)}, not just the first page`, async () => {
      const fake = createFakeClient()
      const { io, out } = recorder()

      const code = await listing.run(await listing.manyPages(fake, listing.count), io)

      expect(code).toBe(0)
      expect(out).toHaveLength(listing.count)
      expect(out.join('\n')).toContain(listing.first)
      expect(out.join('\n')).toContain(listing.last)
    })

    it('reports a not-signed-in failure on stderr and exits 1', async () => {
      const fake = createFakeClient()
      const { io, out, err } = recorder()

      const code = await listing.run(
        failingList(fake, listing.what as 'sessions', new AuthenticationError('Not signed in.')),
        io,
      )

      expect(code).toBe(1)
      expect(out).toEqual([])
      expect(err.join('\n')).toContain('not signed in to http://localhost:3000')
      expect(err.join('\n')).toContain('oh login')
    })

    it('reports a server failure on stderr and exits 1', async () => {
      const fake = createFakeClient()
      const { io, out, err } = recorder()

      const code = await listing.run(
        failingList(fake, listing.what as 'sessions', new ApiError(500, 'boom')),
        io,
      )

      expect(code).toBe(1)
      expect(out).toEqual([])
      expect(err.join('\n')).toContain('boom')
    })

    it('reports a server that is not there, with the URL', async () => {
      const failure = new TypeError('fetch failed')
      Object.assign(failure, {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      })
      const fake = createFakeClient()
      const { io, err } = recorder()

      const code = await listing.run(failingList(fake, listing.what as 'sessions', failure), io)

      expect(code).toBe(1)
      expect(err.join('\n')).toContain('http://localhost:3000')
      expect(err.join('\n')).toContain('--server')
    })
  })
}

describe('runAgents', () => {
  it('gives up on a server that never runs out of pages', async () => {
    const fake = createFakeClient()
    let answer = 0
    const client = {
      ...fake,
      agents: {
        ...fake.agents,
        list: () => {
          answer += 1
          return Promise.resolve({ data: [], next_page: `cursor-${String(answer)}` })
        },
      },
    }
    const { io, out, err } = recorder()

    const code = await runAgents(client, io)

    expect(code).toBe(1)
    expect(out).toEqual([])
    expect(answer).toBe(MAX_LIST_PAGES)
    expect(err.join('\n')).toContain(`more than ${String(MAX_LIST_PAGES)} pages`)
  })
})

describe('runSessionDelete', () => {
  /** The delete io: output recorded, and `answer` (or end of input) on stdin. */
  function deleteIo(answer: string | undefined) {
    const recorded = recorder()
    return {
      ...recorded,
      io: { ...recorded.io, stdin: answering(answer) } satisfies SessionDeleteIo,
    }
  }

  it('deletes right away with --yes, asking nothing', async () => {
    const fake = createFakeClient()
    const { io, out, err, prompts } = deleteIo(undefined)

    const code = await runSessionDelete(fake, io, fake.session.id, { yes: true })

    expect(code).toBe(0)
    expect(prompts).toEqual([])
    expect(err).toEqual([])
    expect(out).toEqual([`Deleted chat ${fake.session.id}.`])
    await expect(fake.sessions.get(fake.session.id)).rejects.toMatchObject({
      type: 'not_found_error',
    })
  })

  it('asks first, and deletes on a yes', async () => {
    const fake = createFakeClient()
    const { io, out, prompts } = deleteIo('y')

    const code = await runSessionDelete(fake, io, fake.session.id, { yes: false })

    expect(code).toBe(0)
    expect(prompts).toEqual([`Delete chat ${fake.session.id}? This cannot be undone [y/N] `])
    expect(out).toEqual([`Deleted chat ${fake.session.id}.`])
    await expect(fake.sessions.get(fake.session.id)).rejects.toMatchObject({
      type: 'not_found_error',
    })
  })

  it('takes a spelled-out yes, any case', async () => {
    const fake = createFakeClient()
    const { io } = deleteIo('YES')

    expect(await runSessionDelete(fake, io, fake.session.id, { yes: false })).toBe(0)
    await expect(fake.sessions.get(fake.session.id)).rejects.toMatchObject({
      type: 'not_found_error',
    })
  })

  it('deletes nothing on a no', async () => {
    const fake = createFakeClient()
    const { io, out } = deleteIo('n')

    const code = await runSessionDelete(fake, io, fake.session.id, { yes: false })

    expect(code).toBe(0)
    expect(out).toEqual(['Not deleted.'])
    expect((await fake.sessions.get(fake.session.id)).id).toBe(fake.session.id)
  })

  it('treats end of input as a no: a pipe nobody answered cannot delete', async () => {
    const fake = createFakeClient()
    const { io, out } = deleteIo(undefined)

    const code = await runSessionDelete(fake, io, fake.session.id, { yes: false })

    expect(code).toBe(0)
    expect(out).toEqual(['Not deleted.'])
    expect((await fake.sessions.get(fake.session.id)).id).toBe(fake.session.id)
  })

  it('reports a session that is not there, with the id hint', async () => {
    const fake = createFakeClient()
    const { io, err, prompts } = deleteIo(undefined)

    const code = await runSessionDelete(fake, io, 'sesn_missing', { yes: true })

    expect(code).toBe(1)
    expect(prompts).toEqual([])
    expect(err.join('\n')).toContain('not found')
    expect(err.join('\n')).toContain('oh sessions')
  })

  it('reports a not-signed-in delete', async () => {
    const fake = createFakeClient({ authenticated: false })
    const { io, err } = deleteIo(undefined)

    const code = await runSessionDelete(fake, io, fake.session.id, { yes: true })

    expect(code).toBe(1)
    expect(err.join('\n')).toContain('not signed in to http://localhost:3000')
  })
})
