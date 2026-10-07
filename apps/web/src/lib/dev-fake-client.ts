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
 * `false`, which leaves the branch below statically dead so (and the dynamic import inside it)
 * is dropped, and the fake itself is a dynamic import, so it can only ever be a separate chunk.
 */
export function isFakeMode(): boolean {
  return import.meta.env.DEV && import.meta.env.VITE_OPENHARNESS_FAKE === '1'
}

/**
 * Which fake account to run: the seeded one, or a first run with nothing configured.
 *
 * `VITE_OPENHARNESS_FAKE_STATE=empty` is the state the first-run screen exists for (epic #201,
 * X5): an account with no provider key, so no catalog, no default and no chat that could run.
 * Without it fake mode is the seeded account (`seedFakeScenario`), which is the state to
 * *develop* in — the empty one is the state to look at.
 */
function fakeState(): 'seeded' | 'empty' {
  return import.meta.env.VITE_OPENHARNESS_FAKE_STATE === 'empty' ? 'empty' : 'seeded'
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

  if (fakeState() === 'empty') {
    const fresh = createFakeClient({
      // No credentials and no default: the first-run screen is decided by the credentials list
      // alone (#209), so this is the state it exists for.
      //
      // The catalog is seeded anyway, which a real server would not do (C5 lists models for
      // the providers the caller has a key for) — the fake's catalog is a fixed list that a
      // saved key cannot change, and without it the screen *after* the flow would have
      // nothing to name and nothing to run: `createFakeClient` picks the first catalog model
      // of the provider just saved, the way the server does (U4). Clicking the flow through
      // therefore ends where it would against a real server, which is the point of the state.
      models: [
        {
          id: 'anthropic/claude-sonnet-5',
          provider: 'anthropic',
          name: 'Claude Sonnet 5',
          context_window: 200_000,
          max_output_tokens: 64_000,
          source: 'provider',
        },
        {
          id: 'openai/gpt-5.1-mini',
          provider: 'openai',
          name: 'GPT-5.1 mini',
          context_window: 400_000,
          max_output_tokens: 128_000,
          source: 'provider',
        },
        {
          id: 'google/gemini-2.5-pro',
          provider: 'google',
          name: 'Gemini 2.5 Pro',
          context_window: 1_000_000,
          max_output_tokens: 65_536,
          source: 'provider',
        },
      ],
      preferences: { default_model: null },
    })
    Object.assign(globalThis, { __openharnessFake: fresh })
    return fresh
  }

  // A small catalog across two providers — one of them fallen back to the registry — so the
  // New chat picker's grouping, context windows and fallback note are all visible in fake
  // mode (#91), not just a single row.
  const fake = createFakeClient({
    // New chat opens on the default (epic #116): the seeded catalog is three models, so
    // without one fake mode would start in the "pick a model" state (#146) instead of an
    // immediate chat — a state worth clicking through, but not the one to start on.
    preferences: { default_model: 'openai/gpt-5.1-mini' },
    models: [
      {
        id: 'anthropic/claude-sonnet-5',
        provider: 'anthropic',
        name: 'Claude Sonnet 5',
        context_window: 200_000,
        max_output_tokens: 64_000,
        source: 'provider',
      },
      {
        id: 'openai/gpt-5.1',
        provider: 'openai',
        name: 'GPT-5.1',
        context_window: 400_000,
        max_output_tokens: 128_000,
        source: 'registry',
      },
      {
        id: 'openai/gpt-5.1-mini',
        provider: 'openai',
        name: 'GPT-5.1 mini',
        context_window: 400_000,
        max_output_tokens: 128_000,
        source: 'registry',
      },
    ],
    providers: [
      {
        provider: 'anthropic',
        status: 'ok',
        fetched_at: '2026-10-04T10:00:00.000Z',
        message: null,
      },
      {
        provider: 'openai',
        status: 'fallback',
        fetched_at: null,
        message: 'The provider timed out.',
      },
    ],
  })
  await seedFakeScenario(fake)

  // Handy while clicking through the UI: `__openharnessFake.history()` in the console.
  Object.assign(globalThis, { __openharnessFake: fake })

  return fake
}

/**
 * The markdown the seeded session's reply is made of.
 *
 * Everything the chat's renderer has to get right, in one message: a heading, a list, a table
 * that is wider than the bubble, inline code, and two fenced blocks with different languages.
 * Keeping it in the seeded reply means fake mode opens on a finished, fully rendered message
 * — which is also what the screenshots in the QA pass are taken of (#204, epic #201 X9).
 */
const SEEDED_REPLY = [
  'I answer from the fake client: a scripted stream, no server involved.',
  '',
  '## What this reply shows',
  '',
  '- a heading, a list and some `inline code`',
  '- a table, which scrolls sideways rather than squashing the message',
  '- two code blocks, highlighted per theme, each with a **Copy** button',
  '',
  '| package | what it holds | where it is |',
  '| --- | --- | --- |',
  '| `@openharness/client` | the transcript reducer every frontend reads | `packages/client` |',
  '| `@openharness/protocol` | the event and session schemas | `packages/protocol` |',
  '| `@openharness/session` | the append-only event log | `packages/session` |',
  '',
  '```typescript',
  'export function greeting(name: string): string {',
  '  return `hello ${name}`',
  '}',
  '```',
  '',
  '```bash',
  'yarn install --immutable',
  'yarn turbo run build test --filter=@openharness/web...',
  '```',
  '',
  '- press **Stop** while a reply is running',
  '- reload the page: the history is replayed from the log',
].join('\n')

/**
 * The scenario the fake starts with.
 *
 * The smallest one that exercises the UI: a second agent, a second session created from it —
 * an agent-created session still has to open and work (#91) — a turn already in its log so
 * the sidebar is not empty, and two scripted replies so the first messages stream instead of
 * arriving whole. When the scripts run out the fake answers `Fake reply: <your message>` on
 * its own.
 *
 * Exported so a test can seed one and read the scenario back.
 */
export async function seedFakeScenario(fake: FakeClient): Promise<void> {
  const assistant = await fake.agents.create({
    name: 'Assistant',
    description: 'A second agent, so the new-chat picker has something to pick.',
    // A catalog model, so the seeded session's label is a display name, not an id.
    model: { id: 'openai/gpt-5.1-mini' },
    system: 'You are a helpful assistant.',
  })

  const seeded = await fake.sessions.create({
    agent: assistant.id,
    title: 'What can you do?',
  })
  fake.respondWith(SEEDED_REPLY, { sessionId: seeded.id, chunks: 16, delayMs: 5 })
  await fake.sendMessage(seeded.id, 'What can you do?')
  await fake.waitForIdle(seeded.id)

  // Slow enough to watch arrive, and cut so that a fence is open part-way through: the
  // second message is what a screenshot of the mid-stream state is taken of.
  fake.respondWith(
    'Fake client again: still no server, still streaming.\n\n' +
      '```bash\nkubectl apply -f deploy.yaml\nkubectl rollout status deploy/web\n```\n\n' +
      'That is the whole of it — nothing here reached a server.',
    { chunks: 18, delayMs: 120 },
  )
}
