import type { FakeClient } from '@openharness/client/testing'
import { MODE_DEFAULT_MODEL, type CreateModeRequest, type ModelEntry } from '@openharness/protocol'
import { makeProviderCredential } from '@openharness/protocol/fixtures'

/** Set this (to `1`, `true` or `yes`) and `oh` runs against the in-memory fake client. */
export const FAKE_MODE_ENV = 'OPENHARNESS_FAKE'

/**
 * Set this beside {@link FAKE_MODE_ENV} and the dev fake seeds **provider credentials** — and,
 * with them, the {@link DEV_MODES} modes, whose models are only usable when a credential for
 * their provider exists (#245, M6).
 *
 * **Off by default, on purpose.** A key behind every provider makes the *first-run* flow — the
 * connect-a-provider screen a signed-in account with no credentials lands on — unreachable in
 * plain fake mode, and that flow is a thing a dev needs to look at. So the default fake is the
 * account with no credentials, exactly as it was before modes, and the keyed account is this
 * switch.
 */
export const FAKE_CREDENTIALS_ENV = 'OPENHARNESS_FAKE_CREDENTIALS'

/**
 * Set this beside {@link FAKE_MODE_ENV} and the dev fake starts **signed out** (#210).
 *
 * The fake is signed in by default, which is the state to develop in — but the sign-in a chat
 * offers when it finds no session, and the 401 a stale one gets, are paths a dev otherwise
 * cannot see without a server and a second terminal. With this, `oh` asks `Sign in now? [Y/n]`
 * against the fake's scripted device flow, which approves it.
 */
export const FAKE_SIGNED_OUT_ENV = 'OPENHARNESS_FAKE_SIGNED_OUT'

/** What the status line says while the fake is answering: nobody should mistake it for real. */
export const FAKE_BANNER = 'fake client (dev)'

/** Is the CLI in fake mode? Empty, `0` and `false` all mean "no". */
export function isFakeMode(env: Record<string, string | undefined> = process.env): boolean {
  return isTruthy(env[FAKE_MODE_ENV])
}

/** Does the dev fake seed credentials and modes? The same spelling as {@link isFakeMode}. */
export function isFakeWithCredentials(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isTruthy(env[FAKE_CREDENTIALS_ENV])
}

/** Does the dev fake start signed out? The same spelling as {@link isFakeMode}. */
export function isFakeSignedOut(env: Record<string, string | undefined> = process.env): boolean {
  return isTruthy(env[FAKE_SIGNED_OUT_ENV])
}

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
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
    cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
    source: 'provider',
  },
  {
    id: 'anthropic/claude-opus-5-5',
    provider: 'anthropic',
    name: 'Claude Opus 5.5',
    context_window: 200_000,
    max_output_tokens: 64_000,
    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    source: 'provider',
  },
  {
    id: 'openai/gpt-4.1-mini',
    provider: 'openai',
    name: 'GPT-4.1 Mini',
    context_window: 1_000_000,
    max_output_tokens: 32_768,
    cost: { input: 0.4, output: 1.6, cache_read: 0.1, cache_write: null },
    source: 'provider',
  },
  {
    id: 'openai/o3',
    provider: 'openai',
    name: 'o3',
    context_window: 200_000,
    max_output_tokens: 100_000,
    cost: { input: 2, output: 8, cache_read: 0.5, cache_write: null },
    source: 'registry',
  },
  {
    id: 'google/gemini-2.5-pro',
    provider: 'google',
    name: 'Gemini 2.5 Pro',
    context_window: 1_048_576,
    max_output_tokens: 65_536,
    cost: { input: 1.25, output: 10, cache_read: 0.31, cache_write: null },
    source: 'provider',
  },
]

/**
 * The modes the dev fake seeds (#245, M6): a `smart` preset on the default model, a `fast` one
 * on a cheap model, and one that follows the account's default — so `oh --mode <name>`, the
 * picker's Modes group and the status line have all three shapes to show.
 */
export const DEV_MODES: readonly CreateModeRequest[] = [
  {
    name: 'smart',
    model: 'anthropic/claude-sonnet-5',
    reasoning_effort: 'high',
    system_prompt_addition: 'Think step by step before answering.',
  },
  { name: 'fast', model: 'openai/gpt-4.1-mini' },
  { name: 'mine', model: MODE_DEFAULT_MODEL },
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
    '```rust',
    'fn main() {',
    '    println!("every line of this starts at column 0");',
    '}',
    '```',
    '',
    'And a paragraph long enough that it has to wrap, so that a wrapped line is visible —',
    'and so is the fact that it starts at column 0 like the line before it.',
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
 * - **no provider credentials**, so the first-run flow is what plain fake mode shows; under
 *   {@link FAKE_CREDENTIALS_ENV} a key per provider and the {@link DEV_MODES} modes are seeded
 *   instead, which is the account that can actually run one;
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
export async function createDevClient(
  env: Record<string, string | undefined> = process.env,
): Promise<FakeClient> {
  const { createFakeClient } = await import('@openharness/client/testing')
  const withCredentials = isFakeWithCredentials(env)
  const fake = createFakeClient({
    delayMs: 12,
    models: DEV_MODELS,
    preferences: { default_model: DEV_DEFAULT_MODEL },
    // Keys for every provider the catalog lists — but only under
    // {@link FAKE_CREDENTIALS_ENV}: without it, a signed-in account with no credentials is
    // the state a dev needs, because that is what the first-run flow is for.
    ...(withCredentials
      ? {
          credentials: [...new Set(DEV_MODELS.map((model) => model.provider))].map((provider) =>
            makeProviderCredential({ name: provider }),
          ),
        }
      : {}),
    // The seeded order is the order they were created in, and the fake orders a list by
    // `(created_at, id)`. A clock that only moves when it is asked — `new Date()` returns the
    // same millisecond twice under a fast seeding run — leaves the two agents below tied, and
    // the tie broken by the random half of their ids: a coin flip a test would flake on.
    now: tickingClock(),
  })

  // The modes ride with the credentials: a mode's model is only usable when the account has a
  // credential for its provider, so seeding one without the other would offer a dev a preset
  // every chat refuses.
  if (withCredentials) {
    for (const mode of DEV_MODES) {
      await fake.modes.create(mode)
    }
  }
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

  // Signing out happens last, on purpose: a signed-out fake refuses every `/v1` call, so the
  // seeding above could not have run. What is left is an account with the dev catalog and the
  // dev default model that still has to be signed into — the state `oh`'s sign-in offer is for
  // (#210), and the one the fake's scripted device flow can approve.
  if (isFakeSignedOut(env)) {
    await fake.auth.signOut()
  }

  return fake
}

/**
 * A clock that advances a millisecond per call, for seeding order that does not depend on how
 * fast the machine is. See {@link createDevClient}.
 */
function tickingClock(): () => Date {
  let at = Date.now()
  return () => {
    at += 1
    return new Date(at)
  }
}
