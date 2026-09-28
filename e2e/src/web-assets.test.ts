import { describe, expect, it } from 'vitest'

import { e2eHarness, webAppDir } from './harness'

/**
 * One process serving both halves of the product: the API under `/v1` and the built web app
 * at `/`.
 *
 * This is the shape a deployment has — and the shape `docker compose up` has — so it is worth
 * a test of its own: the web app is a static build (Vite) that routes in the URL hash, the
 * server decides between a file, the app's `index.html` and the API, and a mistake in that
 * order breaks either the app or the API. The directory comes from `@openharness/web`'s
 * exports, so building the app is what makes this test possible, and it is the same directory
 * the container points `OPENHARNESS_WEB_DIR` at.
 */

const harness = e2eHarness('web-assets')

describe('a server serving the built web app', () => {
  it('serves the app at /, its assets, its deep links — and the API beside them', async () => {
    const server = await harness.server({ webDir: webAppDir() })

    const index = await fetch(`${server.baseUrl}/`)
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toContain('text/html')
    const html = await index.text()
    expect(html).toContain('<div id="root">')
    expect(html).toContain('<title>openharness</title>')

    // A file the app asks for is served as a file, from the directory the app was built into
    // (the asset's name is a hash, so the test reads it out of the HTML rather than guessing).
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1]
    expect(asset).toBeDefined()
    const script = await fetch(`${server.baseUrl}${asset ?? ''}`)
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toContain('javascript')
    expect((await script.text()).length).toBeGreaterThan(0)

    // The app routes in the hash, so every other GET outside `/v1` is the app itself — a
    // deep link a user pasted must not 404.
    const deepLink = await fetch(`${server.baseUrl}/sessions/not-a-real-route`)
    expect(deepLink.status).toBe(200)
    expect(await deepLink.text()).toBe(html)

    // The API is still the API: `/v1` is not a file and not a fallback.
    const agents = await fetch(`${server.baseUrl}/v1/agents`)
    expect(agents.status).toBe(200)
    expect(agents.headers.get('content-type')).toContain('application/json')
    expect(await agents.json()).toEqual({ data: [], next_page: null })
  })
})
