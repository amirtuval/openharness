import type { ModelEntry, ProviderCatalogStatus } from '@openharness/protocol'

/**
 * Catalog fixtures, shared by the tests that render a model picker: the shell's one catalog
 * (`useModels`) is what the composer's selector, the Settings default and — for labels — the
 * sidebar all read, so several test files want the same two-provider catalog.
 */

/** A catalog entry with the fields a test does not care about filled in. */
export function modelEntry(
  overrides: Partial<ModelEntry> & Pick<ModelEntry, 'id' | 'provider' | 'name'>,
): ModelEntry {
  return {
    context_window: null,
    max_output_tokens: null,
    source: 'provider',
    ...overrides,
  }
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

/** Two providers, so grouping, search and switching have something to tell apart. */
export const TWO_PROVIDERS = {
  models: [ANTHROPIC, OPENAI],
  providers: [providerStatus('anthropic'), providerStatus('openai')],
} as const

/** Two providers plus the server's default: an account that can start a chat immediately. */
export const WITH_DEFAULT = {
  ...TWO_PROVIDERS,
  preferences: { default_model: ANTHROPIC.id },
} as const
