import type { FakeClient } from '@openharness/client/testing'

/** Set this (to `1`, `true` or `yes`) and `oh` runs against the in-memory fake client. */
export const FAKE_MODE_ENV = 'OPENHARNESS_FAKE'

/** What the status line says while the fake is answering: nobody should mistake it for real. */
export const FAKE_BANNER = 'fake client (dev)'

/** Is the CLI in fake mode? Empty, `0` and `false` all mean "no". */
export function isFakeMode(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[FAKE_MODE_ENV]?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

/** The replies the seeded session is scripted with, in order, before echoing. */
export const DEV_REPLIES: readonly string[] = [
  'Hello from the openharness dev fake. Nothing here leaves your machine: no server, no model, just a scripted reply stream.',
  'While this streams you can steer it: type another message and press Enter before the reply finishes, and it is queued for the next request. Ctrl+J (or Alt+Enter) inserts a newline instead.',
  'Ctrl+C interrupts a reply in flight and keeps what it has produced. Press it twice when idle to leave — the CLI then prints the exact `oh -s <id>` that resumes this session.',
]

/**
 * The dev-mode client: the fake client from `@openharness/client/testing`, seeded so the
 * CLI has something to show.
 *
 * It is loaded lazily, so a normal `oh` never even reads the testing entry point. What it
 * seeds is what a session needs to exercise the interesting paths:
 *
 * - three agents, which is one more than `oh` will pick from on its own — so the picker
 *   comes up until `--agent` names one;
 * - a scripted conversation, so replies stream in visibly;
 * - a second session with history in it, so `oh --continue` and `oh -s <id>` have something
 *   to resume.
 *
 * @see {@link FAKE_MODE_ENV}
 */
export async function createDevClient(): Promise<FakeClient> {
  const { createFakeClient } = await import('@openharness/client/testing')
  const fake = createFakeClient({ delayMs: 12 })

  await fake.agents.create({
    name: 'Reviewer',
    description: 'Reviews a diff and says what is wrong with it.',
    model: { id: 'anthropic/claude-opus-5-5' },
    system: 'You are a careful reviewer.',
  })
  await fake.agents.create({
    name: 'Namer',
    description: 'Names things.',
    model: { id: 'anthropic/claude-haiku-4-5' },
    system: null,
  })

  for (const reply of DEV_REPLIES) {
    fake.respondWith(reply, { chunks: 8, delayMs: 20 })
  }

  // Created last, so `oh --continue` finds it: the list is newest first.
  const resumed = await fake.sessions.create({
    agent: fake.agent.id,
    title: 'A session with history',
    initial_events: [
      { type: 'user.message', content: [{ type: 'text', text: 'Hello from a previous run.' }] },
    ],
  })
  await fake.waitForIdle(resumed.id)

  return fake
}
