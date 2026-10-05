import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { API_VERSION_PREFIX } from '@openharness/protocol'

import { createTestApp, type TestContext } from './test-support'

/**
 * What every route class tells a shared cache (#151, deployment epic #148).
 *
 * The deployment runs Cloud CDN in front of this origin with `cacheMode: USE_ORIGIN_HEADERS`,
 * so the `Cache-Control` a response carries is the whole caching decision. Three classes of
 * static response — the content-hashed assets, the shell, the other root files — and one rule
 * for everything dynamic: `no-store`, errors and redirects included, so nothing
 * user-specific can ever come out of a cache.
 */

let context: TestContext | undefined

afterEach(async () => {
  await context?.close()
  context = undefined
})

function setup(options: Parameters<typeof createTestApp>[0] = {}): TestContext {
  context = createTestApp(options)
  return context
}

const IMMUTABLE = 'public, max-age=31536000, immutable'
const SHORT = 'public, max-age=3600'

describe('cache headers for a built web app (#151)', () => {
  let directory: string | undefined

  afterEach(async () => {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true })
      directory = undefined
    }
  })

  /** A web directory with the three classes of file Vite's build produces. */
  async function webDir(): Promise<string> {
    directory = await mkdtemp(join(tmpdir(), 'openharness-web-'))
    await writeFile(join(directory, 'index.html'), '<html><script src="/assets/index-a1b2c3d4.js">')
    await mkdir(join(directory, 'assets'))
    await writeFile(join(directory, 'assets', 'index-a1b2c3d4.js'), 'console.log(1)')
    await writeFile(join(directory, 'assets', 'theme-e5f6a7b8.css'), 'body{}')
    await writeFile(join(directory, 'favicon.ico'), 'icon')
    await writeFile(join(directory, 'logo.svg'), '<svg/>')
    return directory
  }

  it('gives the content-hashed assets a year of immutable caching', async () => {
    const test = setup({ webDir: await webDir() })

    for (const path of ['/assets/index-a1b2c3d4.js', '/assets/theme-e5f6a7b8.css']) {
      const response = await test.request(path)
      expect(response.status, path).toBe(200)
      expect(response.headers.get('cache-control'), path).toBe(IMMUTABLE)
    }
  })

  it('makes the shell and the SPA fallback revalidate', async () => {
    const test = setup({ webDir: await webDir() })

    for (const path of ['/', '/sessions/abc', '/device-approval?user_code=X']) {
      const response = await test.request(path)
      expect(response.status, path).toBe(200)
      expect(response.headers.get('cache-control'), path).toBe('no-cache')
    }
  })

  it('gives the other root files a short public max-age', async () => {
    const test = setup({ webDir: await webDir() })

    for (const path of ['/favicon.ico', '/logo.svg']) {
      const response = await test.request(path)
      expect(response.status, path).toBe(200)
      expect(response.headers.get('cache-control'), path).toBe(SHORT)
    }
  })

  it('caches a missing asset request like the shell it falls back to', async () => {
    const test = setup({ webDir: await webDir() })

    // The request named `assets/`, the response *is* `index.html`: the file served decides
    // the class, never the path that asked for it.
    const response = await test.request('/assets/gone-00000000.js')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-cache')
  })

  it('marks the /device redirect no-store', async () => {
    const test = setup({ webDir: await webDir() })

    const response = await test.request('/device?user_code=WXYZ-1234')

    expect(response.status).toBe(302)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})

describe('cache headers for the API (#151)', () => {
  it('marks the API no-store, authenticated or not', async () => {
    const test = setup()

    const open = await test.anonymous(`${API_VERSION_PREFIX}/auth-config`)
    expect(open.status).toBe(200)
    expect(open.headers.get('cache-control')).toBe('no-store')

    const me = await test.request(`${API_VERSION_PREFIX}/me`)
    expect(me.status).toBe(200)
    expect(me.headers.get('cache-control')).toBe('no-store')
  })

  it('marks Better Auth’s route no-store and says what it varies by', async () => {
    const test = setup()

    const response = await test.anonymous('/api/auth/get-session')

    expect(response.headers.get('cache-control')).toBe('no-store')
    // The response was built from the request's cookie: anything that looked at it without
    // honouring `no-store` is told so.
    expect(response.headers.get('vary')?.toLowerCase()).toContain('cookie')
  })

  it('marks the probes no-store', async () => {
    const test = setup()

    for (const path of ['/health', '/ready']) {
      const response = await test.anonymous(path)
      expect(response.status, path).toBe(200)
      expect(response.headers.get('cache-control'), path).toBe('no-store')
    }
  })

  it('marks error responses no-store, wherever they come from', async () => {
    const test = setup()

    // An unknown API path (401 ahead of the router), and a path that is not the API at all
    // (404): neither may be stored by a shared cache, whatever produced it.
    const unauthorized = await test.anonymous(`${API_VERSION_PREFIX}/nope`)
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('cache-control')).toBe('no-store')

    const unknown = await test.anonymous('/not-a-route')
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('cache-control')).toBe('no-store')
  })

  it('says Vary: Origin on responses that vary by origin', async () => {
    const test = setup({ corsOrigins: ['http://localhost:5173'] })

    const response = await test.anonymous('/health', {
      headers: { origin: 'http://localhost:5173' },
    })

    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(response.headers.get('vary')?.toLowerCase()).toContain('origin')
  })
})
