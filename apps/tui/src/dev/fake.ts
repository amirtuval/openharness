import type { FakeClient } from '@openharness/client/testing'
import type { ModelEntry } from '@openharness/protocol'

/** Set this (to `1`, `true` or `yes`) and `oh` runs against the in-memory fake client. */
export const FAKE_MODE_ENV = 'OPENHARNESS_FAKE'

/** What the status line says while the fake is answering: nobody should mistake it for real. */
export const FAKE_BANNER = 'fake client (dev)'

/** Is the CLI in fake mode? Empty, `0` and `false` all mean "no". */
export function isFakeMode(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[FAKE_MODE_ENV]?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

/**
 * The catalog the dev fake serves: three providers, so the model picker's grouping and
 * context windows are visible without a server or a key.
 */
export const DEV_MODELS: readonly ModelEntry[] = [
  {
    id: 'anthropic/claude-sonnet-5',
    provider: 'anthropic',
    name: 'Claude Sonnet 5',
    context_window: 200_000,
    max_output_tokens: 64_000,
    source: 'provider',
  },
  {
    id: 'anthropic/claude-opus-5-5',
    provider: 'anthropic',
    name: 'Claude Opus 5.5',
    context_window: 200_000,
    max_output_tokens: 64_000,
    source: 'provider',
  },
  {
    id: 'openai/gpt-4.1-mini',
    provider: 'openai',
    name: 'GPT-4.1 Mini',
    context_window: 1_000_000,
    max_output_tokens: 32_768,
    source: 'provider',
  },
  {
    id: 'openai/o3',
    provider: 'openai',
    name: 'o3',
    context_window: 200_000,
    max_output_tokens: 100_000,
    source: 'registry',
  },
  {
    id: 'google/gemini-2.5-pro',
    provider: 'google',
    name: 'Gemini 2.5 Pro',
    context_window: 1_048_576,
    max_output_tokens: 65_536,
    source: 'provider',
  },
]

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
 * - a three-provider model catalog ({@link DEV_MODELS}), so a new chat's picker has
 *   groups and context windows to show;
 * - three agents, for `oh agents` and the `--agent` preset path — a new chat without
 *   `--agent` picks a model, not an agent;
 * - a scripted conversation, so replies stream in visibly;
 * - a second session with history in it, so `oh --continue` and `oh -s <id>` have something
 *   to resume.
 *
 * @see {@link FAKE_MODE_ENV}
 */
export async function createDevClient(): Promise<FakeClient> {
  const { createFakeClient } = await import('@openharness/client/testing')
  const fake = createFakeClient({ delayMs: 12, models: DEV_MODELS })

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
