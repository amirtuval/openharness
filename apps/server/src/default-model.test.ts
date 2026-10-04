import { describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  type ListModelsResponse,
  type ProviderCatalogStatus,
} from '@openharness/protocol'
import { InMemorySessionStore } from '@openharness/session'

import type { ModelCatalog } from './catalog/catalog'
import type { ModelRegistry } from './catalog/registry'
import {
  DefaultModelPicker,
  RECOMMENDED_DEFAULT_MODELS,
  isEverydayModel,
  newestModelId,
} from './default-model'
import { createTestApp, type TestContext } from './test-support'

/**
 * The automatic default model (epic #116, U4): a saved credential sets one when the user has
 * none, the user's own choice is never overridden while its provider has a key, and deleting
 * a credential re-picks (an automatic default) or clears (an explicit one) a default whose
 * provider is gone. The fallback half picks the newest non-expensive, non-reasoning registry
 * model when no curated recommendation is in the live catalog.
 */

// ---------------------------------------------------------------- the fakes

/** The catalogue the picker reads, with mutable `models` the test rewrites. */
interface FakeCatalog extends Pick<ModelCatalog, 'list' | 'invalidate'> {
  models: string[]
}

/** A catalogue that lists exactly these router ids, one `ok` status per provider in them. */
function fakeCatalog(models: string[] = []): FakeCatalog {
  const catalog: FakeCatalog = {
    models,
    invalidate: () => {},
    // Through the property, so a test that rewrites `models` is seen by the next read.
    list: () => Promise.resolve(listedOf(catalog.models)),
  }
  return catalog
}

/** The `GET /v1/models` response for a set of ids. */
function listedOf(models: readonly string[]): ListModelsResponse {
  const providers = [...new Set(models.map(providerOfId))].sort()
  return {
    data: models.map((id) => ({
      id,
      provider: providerOfId(id),
      name: id,
      context_window: null,
      max_output_tokens: null,
      source: 'provider' as const,
    })),
    providers: providers.map((provider): ProviderCatalogStatus => ({
      provider,
      status: 'ok',
      fetched_at: null,
      message: null,
    })),
  }
}

function providerOfId(id: string): string {
  return id.slice(0, id.indexOf('/'))
}

/** A registry that knows these ids per provider, and nothing else about them. */
function registryOf(byProvider: Record<string, readonly string[]>): ModelRegistry {
  return {
    models: (provider) => (byProvider[provider] ?? []).map((id) => ({ id })),
  }
}

function picker(
  catalog: FakeCatalog,
  registry: ModelRegistry = registryOf({}),
): {
  picker: DefaultModelPicker
  store: InMemorySessionStore
} {
  const store = new InMemorySessionStore()
  return { picker: new DefaultModelPicker({ store, catalog, registry }), store }
}

// ---------------------------------------------------------------- the picker

describe('the automatic default picker (U4)', () => {
  it('sets the first key’s recommendation and marks the pick as its own', async () => {
    const catalog = fakeCatalog(['openai/gpt-5-mini', 'openai/gpt-4o-mini'])
    const { picker: choose, store } = picker(catalog)

    await choose.onCredentialAdded('user_a', 'openai')

    expect(await store.getPreferences('user_a')).toEqual({ default_model: 'openai/gpt-5-mini' })
    expect(choose.isAutomatic('user_a')).toBe(true)
  })

  it('never overrides a choice the user made, while its provider has a key', async () => {
    const catalog = fakeCatalog(['openai/gpt-5-mini', 'anthropic/claude-haiku-4-5'])
    const { picker: choose, store } = picker(catalog)
    await store.putPreferences('user_a', { default_model: 'openai/my-own-choice' })

    await choose.onCredentialAdded('user_a', 'openai')
    await choose.onCredentialAdded('user_a', 'anthropic')

    expect(await store.getPreferences('user_a')).toEqual({ default_model: 'openai/my-own-choice' })
    expect(choose.isAutomatic('user_a')).toBe(false)
  })

  it('keeps an automatic default when another provider’s key is added', async () => {
    const catalog = fakeCatalog(['openai/gpt-5-mini', 'anthropic/claude-haiku-4-5'])
    const { picker: choose, store } = picker(catalog)

    await choose.onCredentialAdded('user_a', 'openai')
    await choose.onCredentialAdded('user_a', 'anthropic')

    expect(await store.getPreferences('user_a')).toEqual({ default_model: 'openai/gpt-5-mini' })
  })

  it('re-picks an automatic default from the remaining providers when its provider is deleted', async () => {
    const catalog = fakeCatalog(['openai/gpt-5-mini', 'anthropic/claude-haiku-4-5'])
    const { picker: choose, store } = picker(catalog)

    await choose.onCredentialAdded('user_a', 'openai')
    // The openai key is deleted: the live catalog no longer holds any of its models.
    catalog.models = ['anthropic/claude-haiku-4-5']
    await choose.onCredentialRemoved('user_a', 'openai')

    expect(await store.getPreferences('user_a')).toEqual({
      default_model: 'anthropic/claude-haiku-4-5',
    })
    expect(choose.isAutomatic('user_a')).toBe(true)
  })

  it('clears an automatic default when no provider remains', async () => {
    const catalog = fakeCatalog(['openai/gpt-5-mini'])
    const { picker: choose, store } = picker(catalog)

    await choose.onCredentialAdded('user_a', 'openai')
    catalog.models = []
    await choose.onCredentialRemoved('user_a', 'openai')

    expect(await store.getPreferences('user_a')).toEqual({ default_model: null })
    expect(choose.isAutomatic('user_a')).toBe(false)
  })

  it('clears an explicit default whose provider is deleted, instead of re-picking', async () => {
    const catalog = fakeCatalog(['openai/gpt-5-mini', 'anthropic/claude-haiku-4-5'])
    const { picker: choose, store } = picker(catalog)
    await store.putPreferences('user_a', { default_model: 'openai/my-own-choice' })

    catalog.models = ['anthropic/claude-haiku-4-5']
    await choose.onCredentialRemoved('user_a', 'openai')

    expect(await store.getPreferences('user_a')).toEqual({ default_model: null })
  })

  it('leaves a default alone when the deleted key is a different provider’s', async () => {
    const catalog = fakeCatalog(['openai/gpt-5-mini', 'anthropic/claude-haiku-4-5'])
    const { picker: choose, store } = picker(catalog)

    await choose.onCredentialAdded('user_a', 'openai')
    catalog.models = ['openai/gpt-5-mini']
    await choose.onCredentialRemoved('user_a', 'anthropic')

    expect(await store.getPreferences('user_a')).toEqual({ default_model: 'openai/gpt-5-mini' })
  })

  it('treats a default written through the preferences route as explicit', async () => {
    const catalog = fakeCatalog(['openai/gpt-5-mini', 'anthropic/claude-haiku-4-5'])
    const { picker: choose, store } = picker(catalog)

    await choose.onCredentialAdded('user_a', 'openai')
    choose.markExplicit('user_a')
    catalog.models = ['anthropic/claude-haiku-4-5']
    await choose.onCredentialRemoved('user_a', 'openai')

    expect(await store.getPreferences('user_a')).toEqual({ default_model: null })
  })

  it('falls back to the registry’s newest everyday model when no recommendation is listed', async () => {
    const catalog = fakeCatalog([])
    const registry = registryOf({
      openai: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5-pro', 'o3-mini', 'text-embedding-3-large'],
    })
    const { picker: choose, store } = picker(catalog, registry)

    await choose.onCredentialAdded('user_a', 'openai')

    // 4.1 beats 4o by version; the pro tier, the reasoning tier and the embedding are all out.
    expect(await store.getPreferences('user_a')).toEqual({ default_model: 'openai/gpt-4.1-mini' })
  })

  it('has a recommendation table with everyday entries for the main providers', () => {
    for (const provider of ['anthropic', 'openai', 'google', 'openrouter', 'groq', 'deepseek']) {
      const recommendations = RECOMMENDED_DEFAULT_MODELS[provider]
      expect(recommendations, provider).toBeDefined()
      expect(recommendations?.length, provider).toBeGreaterThan(0)
    }
    expect(isEverydayModel('gpt-5-mini', undefined)).toBe(true)
    expect(isEverydayModel('gpt-5-pro', undefined)).toBe(false)
    expect(isEverydayModel('o4-mini', undefined)).toBe(false)
    expect(isEverydayModel('text-embedding-3-large', undefined)).toBe(false)
  })
})

describe('newestModelId', () => {
  it('compares the version numbers in the id, newest first', () => {
    expect(newestModelId(['gpt-4o-mini', 'gpt-4.1-mini'])).toBe('gpt-4.1-mini')
    expect(newestModelId(['claude-3-5-haiku', 'claude-haiku-4-5'])).toBe('claude-haiku-4-5')
    expect(newestModelId(['gpt-5.1-mini', 'gpt-5-mini'])).toBe('gpt-5.1-mini')
  })

  it('ranks an id with no version below every versioned one, and answers null for none', () => {
    expect(newestModelId(['deepseek-chat', 'llama-3.1-8b'])).toBe('llama-3.1-8b')
    expect(newestModelId([])).toBeNull()
  })
})

// ---------------------------------------------------------------- the routes

describe('the automatic default over HTTP', () => {
  /** `PUT /v1/provider-credentials/{provider}`. */
  function putCredential(test: TestContext, provider: string): Promise<Response> {
    return test.request(`${API_VERSION_PREFIX}/provider-credentials/${provider}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'api_key', api_key: 'sk-test-0000000000001234' }),
    })
  }

  /** The caller's stored `default_model`. */
  async function storedDefault(test: TestContext): Promise<string | null> {
    const response = await test.request(`${API_VERSION_PREFIX}/me/preferences`)
    const body = (await response.json()) as { default_model: string | null }
    return body.default_model
  }

  it('sets one on the first key, keeps it when a second arrives, re-picks or clears on delete', async () => {
    const catalog = fakeCatalog(['openai/gpt-5-mini', 'anthropic/claude-haiku-4-5'])
    const test = createTestApp({ catalog })

    expect((await putCredential(test, 'openai')).status).toBe(200)
    expect(await storedDefault(test)).toBe('openai/gpt-5-mini')

    // A second provider does not move it.
    expect((await putCredential(test, 'anthropic')).status).toBe(200)
    expect(await storedDefault(test)).toBe('openai/gpt-5-mini')

    // Deleting the default's provider re-picks from the one that remains.
    catalog.models = ['anthropic/claude-haiku-4-5']
    expect(
      (
        await test.request(`${API_VERSION_PREFIX}/provider-credentials/openai`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(204)
    expect(await storedDefault(test)).toBe('anthropic/claude-haiku-4-5')

    // Deleting the last key clears it: there is nothing left to run.
    catalog.models = []
    expect(
      (
        await test.request(`${API_VERSION_PREFIX}/provider-credentials/anthropic`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(204)
    expect(await storedDefault(test)).toBeNull()
  })

  it('does not touch a default the user set from the settings screen', async () => {
    const catalog = fakeCatalog(['openai/gpt-5-mini', 'anthropic/claude-haiku-4-5'])
    const test = createTestApp({ catalog })

    const written = await test.request(`${API_VERSION_PREFIX}/me/preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ default_model: 'openai/my-own-choice' }),
    })
    expect(written.status).toBe(200)

    expect((await putCredential(test, 'openai')).status).toBe(200)
    expect(await storedDefault(test)).toBe('openai/my-own-choice')

    // Deleting the key that carried it clears it — the model cannot run without the key, and
    // substituting another for the user's own choice is not the server's to do.
    expect(
      (
        await test.request(`${API_VERSION_PREFIX}/provider-credentials/openai`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(204)
    expect(await storedDefault(test)).toBeNull()
  })
})
