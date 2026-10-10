import { DEFAULT_CONTEXT_TOKEN_BUDGET, contextTokenBudget } from '@openharness/client'
import { newProviderCredentialId } from '@openharness/protocol'
import type { ModelEntry, ProviderCatalogStatus, ProviderCredential } from '@openharness/protocol'

/**
 * Catalog fixtures, shared by the tests that render a model picker: the shell's one catalog
 * (`useModels`) is what the composer's selector, the Settings default and — for labels — the
 * sidebar all read, so several test files want the same two-provider catalog.
 */

/**
 * A catalog entry with the fields a test does not care about filled in.
 *
 * `context_budget` is stamped from the limits the way a real server stamps it (#280): the
 * window less `min(maxOutput, 25% of it)`, or the brain's own 32,768 when there is no window to
 * derive one from. A test may pin it in `overrides` — a meter reads this field and not the
 * window, so a fixture that left it out would not be a shape the server ever sends.
 */
export function modelEntry(
  overrides: Partial<ModelEntry> & Pick<ModelEntry, 'id' | 'provider' | 'name'>,
): ModelEntry {
  const entry = {
    context_window: null,
    max_output_tokens: null,
    // Unpriced unless a test says otherwise: a fixture that invented rates would make a cost
    // assertion pass for the wrong reason (#247).
    cost: null,
    source: 'provider' as const,
    ...overrides,
  }
  const window = entry.context_window
  const budget =
    window === null || window <= 0
      ? DEFAULT_CONTEXT_TOKEN_BUDGET
      : contextTokenBudget({
          contextWindow: window,
          ...(entry.max_output_tokens === null ? {} : { maxOutput: entry.max_output_tokens }),
        })
  return { ...entry, context_budget: entry.context_budget ?? budget }
}

/** One provider's catalog status, `ok` unless overridden. */
export function providerStatus(
  provider: string,
  overrides: Partial<ProviderCatalogStatus> = {},
): ProviderCatalogStatus {
  return {
    provider,
    status: 'ok',
    fetched_at: '2026-10-04T10:00:00.000Z',
    message: null,
    ...overrides,
  }
}

export const ANTHROPIC: ModelEntry = modelEntry({
  id: 'anthropic/claude-sonnet-5',
  provider: 'anthropic',
  name: 'Claude Sonnet 5',
  context_window: 200_000,
})

export const OPENAI: ModelEntry = modelEntry({
  id: 'openai/gpt-4.1-mini',
  provider: 'openai',
  name: 'GPT-4.1 mini',
  context_window: 128_000,
})

/**
 * A stored credential, metadata only.
 *
 * What a screen with a key decides differently is whether the reader has one at all — the
 * first-run check (#209) — so a fixture that means "this account can run chats" seeds these
 * rather than putting them, which a synchronous `makeFake` cannot do.
 */
export function credential(
  name: string,
  last4 = 'ab12',
  overrides: Partial<ProviderCredential> = {},
): ProviderCredential {
  return {
    // A real `pcred_` id: the schemas that parse a credential back (the fake's own `put`)
    // reject anything that is not a ULID, and a fixture that cannot round-trip is a trap.
    id: newProviderCredentialId(),
    type: 'api_key',
    name,
    last4,
    created_at: '2026-10-01T10:00:00.000Z',
    updated_at: '2026-10-01T10:00:00.000Z',
    validated_at: '2026-10-01T10:00:00.000Z',
    ...overrides,
  }
}

/** Two providers, so grouping, search and switching have something to tell apart. */
export const TWO_PROVIDERS = {
  models: [ANTHROPIC, OPENAI],
  providers: [providerStatus('anthropic'), providerStatus('openai')],
  credentials: [credential('anthropic', '1111'), credential('openai', '2222')],
} as const

/** Two providers plus the server's default: an account that can start a chat immediately. */
export const WITH_DEFAULT = {
  ...TWO_PROVIDERS,
  preferences: { default_model: ANTHROPIC.id },
} as const
