/**
 * Scratch: the rest of the hands-on pass (deleted before committing).
 *
 * Shoots the add/edit dialog, the OAuth flow end to end (Connect in the page, the authorization
 * page in the new tab, the callback landing back on Settings with its confirmation), and the
 * chat's MCP failure notice with its Reconnect action.
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const OUT = process.env.SHOTS_DIR ?? '/tmp/shots'
mkdirSync(OUT, { recursive: true })
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
await page.waitForTimeout(1500)

async function theme(name, width = 1280) {
  await page.setViewportSize({ width, height: 1000 })
  for (const picked of THEMES) {
    await page.evaluate((value) => {
      localStorage.setItem('openharness:theme', value)
      document.documentElement.dataset.theme = value
    }, picked)
    await page.waitForTimeout(250)
    const target = await page.$(name.selector)
    if (target === null) throw new Error(`${name.selector} is not on screen`)
    await target.screenshot({ path: `${OUT}/${name.file}-${picked}.png` })
    console.log('shot', `${name.file}-${picked}`)
  }
}

// 1. The add-server dialog, with the OAuth auth type chosen so its hint is visible.
await page.goto('http://localhost:3000/#/settings')
await page.waitForSelector('[data-slot="mcp-server-row"]')
await page.click('button:has-text("Add server")')
await page.waitForSelector('[role="dialog"]')
await page.selectOption('#mcp-auth', 'oauth')
await page.selectOption('#mcp-auth', 'headers')
await page.click('button:has-text("Add header")')
await page.waitForTimeout(200)
await theme({ file: 'mcp-dialog', selector: '[role="dialog"]' }, 900)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// 2. The OAuth flow end to end: Connect opens the authorization page in a new tab, the stub
//    authorizes, the callback lands back on Settings.
const [popup] = await Promise.all([
  context.waitForEvent('page'),
  page.click('[data-slot="mcp-server-row"]:has-text("oauth-notes") button:has-text("Connect")'),
])
// The stub's authorization page authorizes and redirects at once, so the tab that ends up
// holding the flow is the app's own settings screen with the callback's query.
await popup.waitForLoadState()
console.log('landed on:', popup.url())
await popup.waitForSelector('[data-slot="mcp-connected"]', { timeout: 15000 })
await popup.waitForTimeout(800)
console.log('confirmation:', await popup.textContent('[data-slot="mcp-connected"]'))
for (const picked of THEMES) {
  await popup.evaluate((value) => {
    localStorage.setItem('openharness:theme', value)
    document.documentElement.dataset.theme = value
  }, picked)
  await popup.waitForTimeout(250)
  const list = await popup.$('[data-slot="mcp-server-list"]')
  await list.screenshot({ path: `${OUT}/mcp-connected-${picked}.png` })
  console.log('shot', `mcp-connected-${picked}`)
}
await popup.close()

// The tab the reader started from reads the list again and shows the new status.
await page.reload()
await page.waitForSelector('[data-slot="mcp-server-row"]')
await page.waitForTimeout(500)
const connected = await page.textContent(
  '[data-slot="mcp-server-row"]:has-text("oauth-notes") [data-slot="mcp-status"]',
)
console.log('reloaded status:', connected)

// 3. The chat's MCP failure notice: the `flaky` server is on, so a turn that lists it fails.
await page.evaluate(async () => {
  const list = await (await fetch('/v1/me/mcp_servers')).json()
  const flaky = list.data.find((server) => server.name === 'flaky')
  await fetch(`/v1/me/mcp_servers/${flaky.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  })
})
const session = await page.evaluate(async () => {
  const answer = await fetch('/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: { id: 'anthropic/claude-sonnet-5' } }),
  })
  return (await answer.json()).id
})
await page.goto(`http://localhost:3000/#/s/${session}`)
await page.waitForSelector('textarea')
await page.fill('textarea', 'hello there')
await page.keyboard.press('Enter')
await page.waitForSelector('[data-slot="mcp-notice"]', { timeout: 20000 })
await page.waitForTimeout(1200)
console.log('notice:', (await page.textContent('[data-slot="mcp-notice"]'))?.slice(0, 120))
await theme({ file: 'mcp-chat-notice', selector: '[data-slot="mcp-notice"]' })
await theme({ file: 'mcp-chat-narrow', selector: '[data-slot="mcp-notice"]' }, 420)

await browser.close()
console.log('done')
