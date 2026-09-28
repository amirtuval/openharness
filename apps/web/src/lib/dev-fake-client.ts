import type { Client } from '@openharness/client'
import type { FakeClient } from '@openharness/client/testing'

/**
 * The dev-only fake client.
 *
 * With `VITE_OPENHARNESS_FAKE=1`, `yarn dev` runs the whole UI against
 * `@openharness/client/testing`'s in-memory server instead of a real one: the same `Client`
 * interface, the same event order per turn, the same `after_seq` backlog — so the chat can be
 * developed, clicked through and QA'd before the server exists.
 *
 * Two things keep the fake out of a production build: `import.meta.env.DEV` is replaced by
 * `false`, which leaves the branch below statically dead so it (and the dynamic import inside
 * it) is dropped, and the fake itself is a dynamic import, so it can only ever be a separate
 * chunk.
 */
export function isFakeMode(): boolean {
  return import.meta.env.DEV && import.meta.env.VITE_OPENHARNESS_FAKE === '1'
}

/**
 * Build the fake client for a dev run, or `null` when the app is talking to a real server.
 *
 * The condition is written out here rather than hidden in a helper: it has to be statically
 * false in a production build for the import below to be tree-shaken away.
 */
export async function createDevFakeClient(): Promise<Client | null> {
  if (!import.meta.env.DEV || import.meta.env.VITE_OPENHARNESS_FAKE !== '1') {
    return null
  }

  const { createFakeClient } = await import('@openharness/client/testing')
  const fake = createFakeClient()
  await seedFakeScenario(fake)

  // Handy while clicking through the UI: `__openharnessFake.history()` in the console.
  Object.assign(globalThis, { __openharnessFake: fake })

  return fake
}

/**
 * The scenario the fake starts with.
 *
 * The smallest one that exercises the UI: a second agent so the new-chat picker has a choice,
 * a second session with a turn already in its log so the sidebar is not empty, and two
 * scripted replies so the first messages stream instead of arriving whole. When the scripts
 * run out the fake answers `Fake reply: <your message>` on its own.
 *
 * Exported so a test can seed one and read the scenario back.
 */
export async function seedFakeScenario(fake: FakeClient): Promise<void> {
  const assistant = await fake.agents.create({
    name: 'Assistant',
    description: 'A second agent, so the new-chat picker has something to pick.',
    model: { id: 'anthropic/claude-opus-5-5' },
    system: 'You are a helpful assistant.',
  })

  const seeded = await fake.sessions.create({
    agent: assistant.id,
    title: 'What can you do?',
  })
  fake.respondWith(
    'I answer from the fake client: a scripted stream, no server involved.\n\n' +
      '- send a message and watch it stream (deltas are on)\n' +
      '- press **Stop** while one is running\n' +
      '- reload the page: the history is replayed from the log',
    { sessionId: seeded.id, chunks: 16, delayMs: 5 },
  )
  await fake.sendMessage(seeded.id, 'What can you do?')
  await fake.waitForIdle(seeded.id)

  fake.respondWith('Fake client again: still no server, still streaming.', {
    chunks: 10,
    delayMs: 20,
  })
}
