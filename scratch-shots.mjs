/**
 * Scratch: the hands-on pass's screenshots (deleted before committing).
 *
 * Signs in with the dev login, registers the loopback stub servers through the real API (the
 * page's own cookie does the authenticating), and shoots Settings → MCP servers in the three
 * themes at desktop and at a narrow width, plus the chat's MCP failure notice.
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const OUT = process.env.SHOTS_DIR ?? '/tmp/shots'
mkdirSync(OUT, { recursive: true })

const urls = JSON.parse(process.env.STUBS ?? '{}')
const THEMES = ['light', 'dim', 'dark']

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' })
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
const page = await context.newPage()
page.on('console', (message) => {
  if (message.type() === 'error') console.log('[console]', message.text())
})

await page.goto('http://localhost:3000/#/signin')
await page.fill('#sign-in-email', 'dev@localhost')
await page.fill('#sign-in-password', 'dev')
await page.click('button[type="submit"]')
await page.waitForURL(/#\/(new|settings)?$/, { timeout: 20000 }).catch(() => {})
await page.waitForTimeout(1000)

/** Register one server through the API the app itself uses. */
async function register(body) {
  const response = await page.evaluate(async (payload) => {
    const answer = await fetch('/v1/me/mcp_servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return { status: answer.status, body: await answer.json() }
  }, body)
  console.log('register', body.name, '->', response.status, response.body.status ?? '')
  return response.body
}

await register({ auth: 'none', name: 'notes', url: urls.open })
await register({
  auth: 'headers',
  name: 'wiki',
  url: urls.secured,
  headers: { Authorization: 'Bearer stub-token' },
})
await register({
  auth: 'headers',
  name: 'flaky',
  url: urls.broken,
  headers: { Authorization: 'Bearer whatever' },
})
await register({ auth: 'oauth', name: 'oauth-notes', url: urls.oauth, enabled: false })

/** Open settings, expand the card's tools, and shoot the three themes at one width. */
async function shots(name, width) {
  await page.setViewportSize({ width, height: width < 500 ? 900 : 1000 })
  await page.goto('http://localhost:3000/#/settings')
  await page.waitForSelector('[data-slot="mcp-server-row"]')
  // Open the first server's tools, so the permissions and the cost are on screen.
  await page.click('[data-slot="mcp-tools-trigger"]')
  await page.waitForTimeout(300)

  for (const theme of THEMES) {
    await page.evaluate((picked) => {
      localStorage.setItem('openharness:theme', picked)
      document.documentElement.dataset.theme = picked
    }, theme)
    await page.waitForTimeout(250)
    const card = await page.$('div:has(> [data-slot="mcp-server-list"])')
    await card.scrollIntoViewIfNeeded()
    await page.waitForTimeout(200)
    const target = `#/settings → MCP servers (${theme})`
    await card.screenshot({ path: `${OUT}/mcp-${name}-${theme}.png` })
    console.log('shot', target, `${width}px`)
  }
}

await shots('desktop', 1280)
await shots('narrow', 420)

await browser.close()
console.log('done')
