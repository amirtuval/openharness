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
  [
    '## Markdown, rendered',
    '',
    'A scripted reply that exercises the renderer — **strong**, *emphasis*, `inline code`, a',
    '[link](https://github.com/amirtuval/openharness), a list, a quote, a table and a fenced',
    'code block. Replies are Markdown; what you type is not.',
    '',
    '- a list item',
    '  - nested one level deeper',
    '- and a second one',
    '',
    '> Quoted, dimmed, behind its own bar.',
    '',
    '| what | where |',
    '| --- | --- |',
    '| the renderer | `src/markdown/render.ts` |',
    '| the theme | `src/markdown/theme.ts` |',
    '',
    '```ts',
    'export function markdownLines(text: string, layout: RenderLayout) {',
    '  return renderBlocks(parseMarkdown(text).children, layout)',
    '}',
    '```',
    '',
    'And a paragraph long enough that it has to wrap, so that the hanging indent under the',
    '`agent › ` label is visible on every one of its lines rather than only the first.',
  ].join('\n'),
]

/** The default model the dev fake stores, so a new chat starts without the picker (#114). */
export const DEV_DEFAULT_MODEL = 'anthropic/claude-sonnet-5'

/**
 * The dev-mode client: the fake client from `@openharness/client/testing`, seeded so the
 * CLI has something to show.
 *
 * It is loaded lazily, so a normal `oh` never even reads the testing entry point. What it
 * seeds is what a session needs to exercise the interesting paths:
 *
 * - a three-provider model catalog ({@link DEV_MODELS}), so the model picker — `/model` in
 *   a chat, and a new chat whose default is cleared — has groups and context windows;
 * - the stored default model ({@link DEV_DEFAULT_MODEL}), the way a real account that has
 *   saved one looks: `oh` starts chatting on it, no picker;
 * - three agents, for `oh agents` and the `--agent` preset path — a new chat without
 *   `--agent` runs a model, not an agent;
 * - a scripted conversation ({@link DEV_REPLIES}), so replies stream in visibly — scripted
 *   on the session with history, which is the one `oh --continue` opens, because that is the
 *   only session a dev can name: a chat the CLI opens is a session of its own, created at
 *   run time, with an id nobody could have scripted for;
 * - a session with history in it, so `oh --continue` and `oh -s <id>` have something to
 *   resume.
 *
 * @see {@link FAKE_MODE_ENV}
 */
export async function createDevClient(): Promise<FakeClient> {
  const { createFakeClient } = await import('@openharness/client/testing')
  const fake = createFakeClient({
    delayMs: 12,
    models: DEV_MODELS,
    preferences: { default_model: DEV_DEFAULT_MODEL },
  })

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

  // Created after the fake's own session, so `oh --continue` finds it (the list is newest
  // first) — and the replies are scripted on it once its history is settled, so that a dev
  // running `oh -c` gets the conversation below rather than an echo.
  const resumed = await fake.sessions.create({
    agent: fake.agent.id,
    title: 'A session with history',
    initial_events: [
      { type: 'user.message', content: [{ type: 'text', text: 'Hello from a previous run.' }] },
    ],
  })
  await fake.waitForIdle(resumed.id)

  for (const reply of DEV_REPLIES) {
    fake.respondWith(reply, { sessionId: resumed.id, chunks: 8, delayMs: 20 })
  }

  return fake
}
